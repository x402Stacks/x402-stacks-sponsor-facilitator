import { vi } from 'vitest';
import type { BroadcastResult, Chain } from '../src/chain.js';

export function fakeChain(o: { balance?: bigint; payerNonce?: bigint; lastMempool?: bigint | null; missing?: bigint[]; statuses?: (string | null)[]; broadcast?: BroadcastResult } = {}) {
  const statuses = [...(o.statuses ?? ['success'])];
  return {
    broadcast: vi.fn(async (_hex: string) => o.broadcast ?? { txid: 'ab'.repeat(32) }),
    getTxStatus: vi.fn(async () => (statuses.length > 1 ? statuses.shift()! : statuses[0])),
    getNonceInfo: vi.fn(async (address: string) => ({
      possibleNext: address.startsWith('ST') ? (o.payerNonce ?? 0n) : 0n,
      lastExecuted: null,
      lastMempool: address.startsWith('ST') ? (o.lastMempool ?? null) : null,
      missing: address.startsWith('ST') ? (o.missing ?? []) : [],
    })),
    getBalance: vi.fn(async () => o.balance ?? 1_000_000n),
  } satisfies Chain;
}
