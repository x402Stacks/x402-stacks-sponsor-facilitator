import type { StacksNet } from './types.js';

export type BroadcastResult = { txid: string } | { error: string };
export type NonceInfo = { possibleNext: bigint; lastExecuted: bigint | null; lastMempool: bigint | null; missing: bigint[] };

export interface Chain {
  broadcast(txHex: string, net: StacksNet): Promise<BroadcastResult>;
  /** Hiro tx_status ("pending", "success", "abort_by_response", ...), null if unknown. */
  getTxStatus(txid: string, net: StacksNet): Promise<string | null>;
  getNonceInfo(address: string, net: StacksNet): Promise<NonceInfo>;
  /** asset: "STX" or "<contract>::<assetName>" */
  getBalance(address: string, asset: string, net: StacksNet): Promise<bigint>;
}

const BASE: Record<StacksNet, string> = {
  mainnet: 'https://api.hiro.so',
  testnet: 'https://api.testnet.hiro.so',
};

export function hiroChain(apiKey?: string, options: { retryDelayMs?: number } = {}): Chain {
  // HIRO_API_KEY raises Hiro's rate limits.
  const auth: Record<string, string> = apiKey ? { 'x-api-key': apiKey } : {};
  const retryDelayMs = options.retryDelayMs ?? 500;

  async function fetchWithRetry(input: string, init?: RequestInit): Promise<Response> {
    for (let retry = 0; ; retry++) {
      const res = await fetch(input, init);
      if (res.status !== 429 || retry === 3) return res;
      const retryAfter = res.headers.get('retry-after');
      const delay = retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(Number(retryAfter))
        ? Math.min(5000, Number(retryAfter) * 1000)
        : retryDelayMs * 2 ** retry;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  async function get(net: StacksNet, path: string) {
    const res = await fetchWithRetry(BASE[net] + path, { headers: auth });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`hiro ${path} -> ${res.status}`);
    return res.json();
  }

  return {
    async broadcast(txHex, net) {
      const res = await fetchWithRetry(`${BASE[net]}/v2/transactions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: Buffer.from(txHex, 'hex'),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && typeof body === 'string') return { txid: body.replace(/^0x/, '') };
      return { error: body?.reason ?? body?.error ?? `http_${res.status}` };
    },
    async getTxStatus(txid, net) {
      const tx = await get(net, `/extended/v1/tx/0x${txid}`);
      return tx?.tx_status ?? null;
    },
    async getNonceInfo(address, net) {
      const r = await get(net, `/extended/v1/address/${address}/nonces`);
      return {
        possibleNext: BigInt(r?.possible_next_nonce ?? 0),
        lastExecuted: r?.last_executed_tx_nonce == null ? null : BigInt(r.last_executed_tx_nonce),
        lastMempool: r?.last_mempool_tx_nonce == null ? null : BigInt(r.last_mempool_tx_nonce),
        missing: (r?.detected_missing_nonces ?? []).map((nonce: string | number) => BigInt(nonce)),
      };
    },
    async getBalance(address, asset, net) {
      const r = await get(net, `/extended/v1/address/${address}/balances`);
      if (!r) return 0n;
      if (asset === 'STX') return BigInt(r.stx.balance) - BigInt(r.stx.locked);
      return BigInt(r.fungible_tokens?.[asset]?.balance ?? 0);
    },
  };
}
