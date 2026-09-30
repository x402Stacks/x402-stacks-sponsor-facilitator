import { makeSTXTokenTransfer, privateKeyToAddress, sponsorTransaction } from '@stacks/transactions';
import type { Chain } from './chain.js';
import { type DecodedPayment, decodePayment } from './decode.js';
import { NonceAllocator } from './nonces.js';
import { SponsorLimits } from './limits.js';
import { resolveAsset } from './tokens.js';
import { type PaymentPayload, type PaymentRequirements, stacksNetworkName, type StacksNet, type VerifyResponse, type SettleResponse } from './types.js';
import { validatePayment } from './validate.js';

export interface SchemeConfig {
  sponsorKey: string;
  fee: bigint; // flat sponsor fee, microSTX
  sponsorPayTo: string[];
  chain: Chain;
  settleTimeoutMs?: number;
  pollMs?: number;
  stuckMs?: number;
  maxRepairFee?: bigint;
  sponsorDailyBudget?: bigint;
  sponsorPayerPerMinute?: number;
  stateFile?: string;
  lowBalance?: bigint;
}

type Checked = { ok: true; decoded: DecodedPayment } | { ok: false; reason: string; payer?: string };
type SponsorObservation = { lastExecuted: bigint | null; since: number; attempts: number };
type SettleObservation = { chainStatus: string | null };

// Mirrors @x402/aptos ExactAptosScheme so it can be registered with @x402/core later.
export class ExactStacksScheme {
  readonly scheme = 'exact';
  protected nonces: NonceAllocator;
  private inFlight = new Set<string>();
  private sponsorObservation = new Map<StacksNet, SponsorObservation>();
  private limits: SponsorLimits;
  private sponsorBalances = new Map<StacksNet, bigint>();

  constructor(protected cfg: SchemeConfig) {
    this.nonces = new NonceAllocator(async (net) => (await cfg.chain.getNonceInfo(this.sponsorAddress(net), net)).possibleNext);
    this.limits = new SponsorLimits({
      budget: cfg.sponsorDailyBudget ?? 1_000_000n,
      payerPerMinute: cfg.sponsorPayerPerMinute ?? 10,
      stateFile: cfg.stateFile ?? './data/state.json',
    });
  }

  sponsorAddress(net: StacksNet): string {
    return privateKeyToAddress(this.cfg.sponsorKey, net);
  }

  setSponsorBalance(net: StacksNet, balance: bigint): void {
    this.sponsorBalances.set(net, balance);
  }

  health(): { status: 'ok' | 'degraded'; sponsor: Record<StacksNet, { address: string; balance: string | null }> } {
    const sponsor = Object.fromEntries((['mainnet', 'testnet'] as const).map((network) => {
      const balance = this.sponsorBalances.get(network);
      return [network, { address: this.sponsorAddress(network), balance: balance?.toString() ?? null }];
    })) as Record<StacksNet, { address: string; balance: string | null }>;
    const degraded = [...this.sponsorBalances.values()].some((balance) => balance < this.cfg.fee);
    return { status: degraded ? 'degraded' : 'ok', sponsor };
  }

  getExtra(network: string): { feePayer: string } | undefined {
    const net = stacksNetworkName(network);
    return net && this.cfg.sponsorPayTo.length ? { feePayer: this.sponsorAddress(net) } : undefined;
  }

  getSigners(network: string): string[] {
    const net = stacksNetworkName(network);
    return net && this.cfg.sponsorPayTo.length ? [this.sponsorAddress(net)] : [];
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    const c = await this.check(payload, req);
    return c.ok ? { isValid: true, payer: c.decoded.payer } : { isValid: false, invalidReason: c.reason, payer: c.payer };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    const started = Date.now();
    const observation: SettleObservation = { chainStatus: null };
    const result = await this.performSettle(payload, req, observation);
    let decoded: DecodedPayment | undefined;
    const transaction = payload?.payload?.transaction;
    try { if (typeof transaction === 'string') decoded = decodePayment(transaction); } catch { /* invalid payload */ }
    console.log(JSON.stringify({
      evt: 'settle', network: req.network, payer: decoded?.payer ?? null, payTo: req.payTo,
      asset: req.asset, amount: req.amount, sponsored: decoded?.sponsored ?? false,
      success: result.success, errorReason: result.success ? null : result.errorReason,
      txid: result.transaction || null, chainStatus: observation.chainStatus, ms: Date.now() - started,
    }));
    return result;
  }

  private async performSettle(payload: PaymentPayload, req: PaymentRequirements, observation: SettleObservation): Promise<SettleResponse> {
    const network = req.network;
    const c = await this.check(payload, req, true);
    if (!c.ok) return { success: false, errorReason: c.reason, payer: c.payer, transaction: '', network };

    const { decoded: d } = c;
    const key = `${d.network}:${d.payer}:${d.nonce}`;
    if (this.inFlight.has(key)) return { success: false, errorReason: 'duplicate_payment', payer: d.payer, transaction: '', network };
    this.inFlight.add(key);
    try {
      const fail = (errorReason: string, transaction = '') => ({
        success: false, errorReason, payer: d.payer, transaction, network,
      });

      let tx = d.tx;
      let sent;
      try {
        if (d.sponsored) {
          sent = await this.nonces.run(d.network, async (nonce) => {
            tx = await sponsorTransaction({
              transaction: tx,
              sponsorPrivateKey: this.cfg.sponsorKey,
              fee: this.cfg.fee,
              sponsorNonce: nonce,
              network: d.network,
            });
            const result = await this.cfg.chain.broadcast(tx.serialize(), d.network);
            if (!('error' in result)) this.limits.recordSpend(req.payTo, this.cfg.fee);
            return { commit: !('error' in result), value: result };
          });
        } else {
          sent = await this.cfg.chain.broadcast(tx.serialize(), d.network);
        }
        if ('error' in sent) return fail('broadcast_failed');
      } catch (error) {
        console.error(JSON.stringify({ evt: 'error', where: 'settle', message: error instanceof Error ? error.message : String(error) }));
        return fail('unexpected_settle_error');
      }

      const txid = tx.txid();
      const status = await this.waitForFinal(txid, d.network, req.maxTimeoutSeconds);
      observation.chainStatus = status;
      if (status === 'success') return { success: true, payer: d.payer, transaction: `0x${txid}`, network };
      const definiteFailure = status === 'abort_by_response' || status === 'abort_by_post_condition' || status === 'failed';
      return fail(definiteFailure ? 'transaction_failed' : 'transaction_pending', `0x${txid}`);
    } finally {
      this.inFlight.delete(key);
    }
  }

  async repairSponsor(net: StacksNet, now = Date.now()): Promise<bigint[]> {
    if (!this.cfg.sponsorPayTo.length) return [];
    const sponsor = this.sponsorAddress(net);
    const info = await this.cfg.chain.getNonceInfo(sponsor, net);
    const replacements = new Map<bigint, bigint>();
    for (const nonce of info.missing) replacements.set(nonce, this.cfg.fee);
    let observation = this.sponsorObservation.get(net);
    if (info.lastMempool === null) {
      this.sponsorObservation.delete(net);
    } else if (!observation || observation.lastExecuted !== info.lastExecuted) {
      observation = { lastExecuted: info.lastExecuted, since: now, attempts: 0 };
      this.sponsorObservation.set(net, observation);
    } else if (now - observation.since >= (this.cfg.stuckMs ?? 120_000)) {
      const nonce = (info.lastExecuted ?? -1n) + 1n;
      const escalatedFee = this.cfg.fee * 2n ** BigInt(observation.attempts + 1);
      const maxRepairFee = this.cfg.maxRepairFee ?? this.cfg.fee * 16n;
      replacements.set(nonce, escalatedFee < maxRepairFee ? escalatedFee : maxRepairFee);
    }

    const replaced: bigint[] = [];
    for (const [nonce, fee] of [...replacements].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const tx = await makeSTXTokenTransfer({
        recipient: this.cfg.sponsorPayTo[0]!, amount: 1n, senderKey: this.cfg.sponsorKey,
        nonce, fee, network: net,
      });
      const sent = await this.cfg.chain.broadcast(tx.serialize(), net);
      if ('error' in sent) continue;
      replaced.push(nonce);
      console.log(JSON.stringify({ evt: 'sponsor_repair', network: net, nonce: nonce.toString(), fee: fee.toString(), txid: tx.txid() }));
    }
    if (info.lastMempool !== null) {
      const current = this.sponsorObservation.get(net);
      if (current && replacements.has((info.lastExecuted ?? -1n) + 1n) && replaced.includes((info.lastExecuted ?? -1n) + 1n)) {
        this.sponsorObservation.set(net, { ...current, since: now, attempts: current.attempts + 1 });
      }
    }
    return replaced;
  }

  private async waitForFinal(txid: string, net: StacksNet, maxTimeoutSeconds: number): Promise<string | null> {
    // Keep below the SDK's 50s HTTP timeout; the requirement's maxTimeoutSeconds can only shorten it.
    const budget = Math.min(this.cfg.settleTimeoutMs ?? 45_000, (maxTimeoutSeconds || Infinity) * 1000);
    const deadline = Date.now() + budget;
    let status: string | null = null;
    do {
      status = await this.cfg.chain.getTxStatus(txid, net).catch(() => status);
      if (status === 'success' || status === 'abort_by_response' || status === 'abort_by_post_condition' || status === 'failed') return status;
      await new Promise((r) => setTimeout(r, this.cfg.pollMs ?? 3000));
    } while (Date.now() < deadline);
    return status;
  }

  protected async check(payload: PaymentPayload, req: PaymentRequirements, recordAttempt = false): Promise<Checked> {
    if (payload?.x402Version !== 2) return { ok: false, reason: 'invalid_x402_version' };
    const txHex = payload.payload?.transaction;
    if (typeof txHex !== 'string' || !txHex) return { ok: false, reason: 'invalid_payload' };

    let d: DecodedPayment;
    try {
      d = decodePayment(txHex);
    } catch {
      return { ok: false, reason: 'invalid_payload' };
    }

    const net = stacksNetworkName(req.network);
    const reason = validatePayment(d, req, payload.accepted, {
      address: net ? this.sponsorAddress(net) : '',
      payTo: this.cfg.sponsorPayTo,
    });
    if (reason) return { ok: false, reason, payer: d.payer };

    if (d.sponsored) {
      const sponsorBalance = this.sponsorBalances.get(d.network);
      if (sponsorBalance !== undefined && sponsorBalance < this.cfg.fee) {
        return { ok: false, reason: 'sponsor_unavailable', payer: d.payer };
      }
      const limitReason = this.limits.check(req.payTo, d.payer, this.cfg.fee);
      if (limitReason) return { ok: false, reason: limitReason, payer: d.payer };
    }

    // On-chain preconditions: a tx with a future nonce would sit in the mempool (and hold our
    // sponsor nonce); one without funds would fail and still cost the sponsor its fee.
    const { chain } = this.cfg;
    try {
      const nonceInfo = await chain.getNonceInfo(d.payer, d.network);
      if (d.nonce !== nonceInfo.possibleNext) {
        return { ok: false, reason: 'invalid_nonce', payer: d.payer };
      }
      if (d.sponsored && nonceInfo.lastMempool !== null) {
        return { ok: false, reason: 'payer_has_pending_transactions', payer: d.payer };
      }
      const asset = resolveAsset(req.asset, d.network)!;
      const balanceKey = asset === 'STX' ? 'STX' : `${asset.contract}::${asset.assetName}`;
      if ((await chain.getBalance(d.payer, balanceKey, d.network)) < d.amount) {
        return { ok: false, reason: 'insufficient_funds', payer: d.payer };
      }
    } catch (error) {
      console.error(JSON.stringify({ evt: 'error', where: 'verify', message: error instanceof Error ? error.message : String(error) }));
      return { ok: false, reason: 'unexpected_verify_error', payer: d.payer };
    }
    if (d.sponsored && recordAttempt) this.limits.recordPayerAttempt(d.payer);
    return { ok: true, decoded: d };
  }
}
