import { AuthType, deserializeTransaction, privateKeyToAddress, randomPrivateKey } from '@stacks/transactions';
import { describe, expect, it, vi } from 'vitest';
import { ExactStacksScheme } from '../src/scheme.js';
import { fakeChain } from './fake-chain.js';
import { payTo, payer, payloadFor, requirements, sponsorKey, stxTx, testStateFile, TESTNET } from './helpers.js';

const make = (chain: ReturnType<typeof fakeChain>) =>
  new ExactStacksScheme({ sponsorKey, fee: 10_000n, chain, pollMs: 1, settleTimeoutMs: 20, sponsorPayTo: [payTo], stateFile: testStateFile() });

describe('ExactStacksScheme.settle', () => {
  it('sponsors, broadcasts and confirms', async () => {
    const chain = fakeChain({ statuses: ['pending', 'success'] });
    const req = requirements();
    const res = await make(chain).settle(payloadFor(await stxTx(), req), req);

    expect(res).toMatchObject({ success: true, payer, network: TESTNET });
    expect(res.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    const sent = deserializeTransaction(chain.broadcast.mock.calls[0][0]);
    expect(sent.auth.authType).toBe(AuthType.Sponsored);
    expect(sent.auth.authType === AuthType.Sponsored && sent.auth.sponsorSpendingCondition.fee).toBe(10_000n);
    expect(() => sent.verifyOrigin()).not.toThrow();
    expect(res.transaction).toBe(`0x${sent.txid()}`);
  });

  it('broadcasts standard transactions unchanged', async () => {
    const chain = fakeChain();
    const req = requirements({ extra: undefined });
    const hex = await stxTx({ sponsored: false });
    expect((await make(chain).settle(payloadFor(hex, req), req)).success).toBe(true);
    expect(chain.broadcast.mock.calls[0][0]).toBe(hex);
  });

  it('does not broadcast invalid payments', async () => {
    const chain = fakeChain({ balance: 0n });
    const req = requirements();
    expect(await make(chain).settle(payloadFor(await stxTx(), req), req)).toEqual({
      success: false,
      errorReason: 'insufficient_funds',
      payer,
      transaction: '',
      network: TESTNET,
    });
    expect(chain.broadcast).not.toHaveBeenCalled();
  });

  it('reports broadcast failures and re-seeds the sponsor nonce', async () => {
    const chain = fakeChain({ broadcast: { error: 'BadNonce' } });
    const scheme = make(chain);
    const req = requirements();
    expect(await scheme.settle(payloadFor(await stxTx(), req), req)).toMatchObject({
      success: false,
      errorReason: 'broadcast_failed',
    });
    await scheme.settle(payloadFor(await stxTx(), req), req);
    // payer nonce x2 + sponsor nonce fetched twice (re-seeded after the failure)
    expect(chain.getNonceInfo).toHaveBeenCalledTimes(4);
  });

  it('reports on-chain failure', async () => {
    const req = requirements();
    expect(await make(fakeChain({ statuses: ['abort_by_response'] })).settle(payloadFor(await stxTx(), req), req)).toMatchObject({
      success: false,
      errorReason: 'transaction_failed',
    });
  });

  it('keeps polling after a dropped status until the transaction succeeds', async () => {
    const req = requirements();
    const chain = fakeChain({ statuses: ['dropped_replace_across_fork', 'success'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await make(chain).settle(payloadFor(await stxTx(), req), req);

      expect(res).toMatchObject({ success: true, payer, network: TESTNET });
      expect(chain.getTxStatus).toHaveBeenCalledTimes(2);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ chainStatus: 'success' });
    } finally {
      log.mockRestore();
    }
  });

  it('keeps polling unknown dropped statuses until timeout and returns the txid', async () => {
    const req = requirements();
    const chain = fakeChain({ statuses: ['dropped_stale_garbage_collect'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await make(chain).settle(payloadFor(await stxTx(), req), req);

      expect(res).toMatchObject({ success: false, errorReason: 'transaction_pending' });
      expect(res.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ chainStatus: 'dropped_stale_garbage_collect' });
    } finally {
      log.mockRestore();
    }
  });

  it('reports pending after the timeout', async () => {
    const req = requirements();
    const res = await make(fakeChain({ statuses: ['pending'] })).settle(payloadFor(await stxTx(), req), req);
    expect(res).toMatchObject({ success: false, errorReason: 'transaction_pending' });
    expect(res.transaction).toMatch(/^0x/);
  });

  it('rejects concurrent identical settlements while one is in flight', async () => {
    const chain = fakeChain();
    let release!: () => void;
    chain.broadcast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { txid: 'ab'.repeat(32) };
    });
    const scheme = make(chain);
    const req = requirements();
    const payload = payloadFor(await stxTx(), req);
    const first = scheme.settle(payload, req);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await scheme.settle(payload, req);
    expect(second).toMatchObject({ success: false, errorReason: 'duplicate_payment' });
    release();
    expect((await first).success).toBe(true);
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it('rejects different concurrent transactions with the same payer nonce', async () => {
    const chain = fakeChain();
    let release!: () => void;
    chain.broadcast.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { txid: 'ab'.repeat(32) };
    });
    const scheme = make(chain);
    const req = requirements();
    const first = scheme.settle(payloadFor(await stxTx({ recipient: payTo }), req), req);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await scheme.settle(payloadFor(await stxTx({ memo: 'different tx' }), req), req);
    expect(second).toMatchObject({ success: false, errorReason: 'duplicate_payment' });
    release();
    await first;
    expect(chain.broadcast).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight key after settlement finishes', async () => {
    const chain = fakeChain();
    const scheme = make(chain);
    const req = requirements();
    const payload = payloadFor(await stxTx(), req);
    expect((await scheme.settle(payload, req)).success).toBe(true);
    expect((await scheme.settle(payload, req)).success).toBe(true);
    expect(chain.broadcast).toHaveBeenCalledTimes(2);
  });

  it('blocks sponsored payments when the payer has pending mempool transactions', async () => {
    const chain = fakeChain({ lastMempool: 1n });
    const req = requirements();
    const res = await make(chain).settle(payloadFor(await stxTx(), req), req);
    expect(res).toMatchObject({ success: false, errorReason: 'payer_has_pending_transactions' });
    expect(chain.broadcast).not.toHaveBeenCalled();
  });

  it('allows standard payments when the payer has pending mempool transactions', async () => {
    const chain = fakeChain({ lastMempool: 1n });
    const req = requirements({ extra: undefined });
    const res = await make(chain).settle(payloadFor(await stxTx({ sponsored: false }), req), req);
    expect(res.success).toBe(true);
  });

  it('reuses a failed sponsored broadcast nonce before proceeding to the next one', async () => {
    const chain = fakeChain();
    const scheme = make(chain);
    const sponsor = scheme.sponsorAddress('testnet');
    let sponsorPossibleNext = 5n;
    chain.getNonceInfo.mockImplementation(async (address: string) => ({
      possibleNext: address === sponsor ? sponsorPossibleNext : 0n, lastExecuted: null, lastMempool: null, missing: [],
    }));
    let broadcasts = 0;
    const sponsorNonces: bigint[] = [];
    chain.broadcast.mockImplementation(async (hex: string) => {
      const tx = deserializeTransaction(hex);
      if (tx.auth.authType === AuthType.Sponsored) {
        sponsorNonces.push(tx.auth.sponsorSpendingCondition.nonce);
      }
      broadcasts++;
      if (broadcasts === 2) return { error: 'BadNonce' };
      sponsorPossibleNext = sponsorNonces.at(-1)! + 1n;
      return { txid: broadcasts.toString(16).padStart(64, '0') };
    });
    const req = requirements();
    const payers = [randomPrivateKey(), randomPrivateKey(), randomPrivateKey()];
    const results = await Promise.all(payers.map(async (key) => {
      const tx = await stxTx({ key });
      return scheme.settle(payloadFor(tx, req), req);
    }));
    expect(results.map((r) => r.errorReason)).toEqual([undefined, 'broadcast_failed', undefined]);
    expect(sponsorNonces).toEqual([5n, 6n, 6n]);
    expect(chain.getNonceInfo.mock.calls.filter(([address]) => address === sponsor)).toHaveLength(2);
  });

  it('replaces Hiro-observed sponsor nonce after the timeout, escalating fees and resetting on execution', async () => {
    const chain = fakeChain();
    const scheme = make(chain);
    const sponsor = scheme.sponsorAddress('testnet');
    let lastExecuted: bigint | null = 3n;
    chain.getNonceInfo.mockImplementation(async (address: string) => ({
      possibleNext: address === sponsor ? 5n : 0n, lastExecuted: address === sponsor ? lastExecuted : null,
      lastMempool: address === sponsor ? 4n : null, missing: [],
    }));
    expect(await scheme.repairSponsor('testnet', 0)).toEqual([]);
    expect(await scheme.repairSponsor('testnet', 119_999)).toEqual([]);
    expect(await scheme.repairSponsor('testnet', 120_000)).toEqual([4n]);
    let tx = deserializeTransaction(chain.broadcast.mock.calls.at(-1)![0]);
    expect(tx.auth.authType === AuthType.Standard && tx.auth.spendingCondition.fee).toBe(20_000n);
    expect(await scheme.repairSponsor('testnet', 239_999)).toEqual([]);
    expect(await scheme.repairSponsor('testnet', 240_000)).toEqual([4n]);
    tx = deserializeTransaction(chain.broadcast.mock.calls.at(-1)![0]);
    expect(tx.auth.authType === AuthType.Standard && tx.auth.spendingCondition.fee).toBe(40_000n);
    lastExecuted = 4n;
    expect(await scheme.repairSponsor('testnet', 500_000)).toEqual([]);
    expect(await scheme.repairSponsor('testnet', 619_999)).toEqual([]);
    expect(await scheme.repairSponsor('testnet', 620_000)).toEqual([5n]);
  });

  it('repairs from Hiro state after a fresh scheme instance starts', async () => {
    const chain = fakeChain();
    const sponsor = make(chain).sponsorAddress('testnet');
    chain.getNonceInfo.mockImplementation(async (address: string) => ({
      possibleNext: 8n, lastExecuted: address === sponsor ? 6n : null, lastMempool: address === sponsor ? 7n : null, missing: [],
    }));
    const scheme = make(chain);
    expect(await scheme.repairSponsor('testnet', 0)).toEqual([]);
    expect(await scheme.repairSponsor('testnet', 120_000)).toEqual([7n]);
    const tx = deserializeTransaction(chain.broadcast.mock.calls[0][0]);
    expect(tx.auth.authType === AuthType.Standard && tx.auth.spendingCondition.fee).toBe(20_000n);
  });

  it('caps stuck sponsor nonce replacement fees after repeated attempts', async () => {
    const chain = fakeChain();
    const scheme = new ExactStacksScheme({
      sponsorKey, fee: 10_000n, maxRepairFee: 80_000n, chain, sponsorPayTo: [payTo], stateFile: testStateFile(),
    });
    const sponsor = scheme.sponsorAddress('testnet');
    chain.getNonceInfo.mockImplementation(async (address: string) => ({
      possibleNext: 5n, lastExecuted: address === sponsor ? 3n : null,
      lastMempool: address === sponsor ? 4n : null, missing: [],
    }));

    expect(await scheme.repairSponsor('testnet', 0)).toEqual([]);
    for (const now of [120_000, 240_000, 360_000, 480_000]) {
      expect(await scheme.repairSponsor('testnet', now)).toEqual([4n]);
      const tx = deserializeTransaction(chain.broadcast.mock.calls.at(-1)![0]);
      expect(tx.auth.authType === AuthType.Standard && tx.auth.spendingCondition.fee).toBeLessThanOrEqual(80_000n);
    }
    const last = deserializeTransaction(chain.broadcast.mock.calls.at(-1)![0]);
    expect(last.auth.authType === AuthType.Standard && last.auth.spendingCondition.fee).toBe(80_000n);
  });

  it('fills missing sponsor nonces at the configured fee', async () => {
    const chain = fakeChain({ missing: [4n] });
    const scheme = make(chain);
    expect(await scheme.repairSponsor('testnet')).toEqual([4n]);
    const tx = deserializeTransaction(chain.broadcast.mock.calls[0][0]);
    expect(tx.auth.authType === AuthType.Standard && tx.auth.spendingCondition.nonce).toBe(4n);
    expect(tx.auth.authType === AuthType.Standard && tx.auth.spendingCondition.fee).toBe(10_000n);
  });

});
