import { STACKS_TESTNET } from '@stacks/network';
import { Cl, deserializeTransaction, makeSTXTokenTransfer, PostConditionMode } from '@stacks/transactions';
import { describe, expect, it } from 'vitest';
import { decodePayment } from '../src/decode.js';
import { ftTx, payer, payerKey, payTo, SBTC, stxTx } from './helpers.js';

describe('decodePayment', () => {
  it('decodes a sponsored STX transfer', async () => {
    const d = decodePayment(await stxTx({ nonce: 4 }));
    expect(d).toMatchObject({
      sponsored: true,
      payer,
      network: 'testnet',
      kind: 'stx',
      recipient: payTo,
      amount: 1000n,
      nonce: 4n,
    });
  });

  it('decodes a standard STX transfer as not sponsored', async () => {
    expect(decodePayment(await stxTx({ sponsored: false })).sponsored).toBe(false);
  });

  it('decodes a sponsored SIP-010 transfer', async () => {
    const d = decodePayment(await ftTx());
    expect(d).toMatchObject({
      kind: 'ft',
      contract: SBTC,
      functionName: 'transfer',
      sender: payer,
      recipient: payTo,
      amount: 1000n,
      postConditionMode: PostConditionMode.Deny,
    });
    expect(d.postConditions[0]).toMatchObject({
      type: 'ft-postcondition',
      address: payer,
      condition: 'eq',
      amount: '1000',
      asset: `${SBTC}::sbtc-token`,
    });
  });

  it('accepts a 0x prefix', async () => {
    expect(decodePayment('0x' + (await stxTx())).payer).toBe(payer);
  });

  it('rejects a tampered transaction', async () => {
    const tx = deserializeTransaction(await stxTx());
    (tx.payload as { amount: bigint }).amount = 1n;
    expect(() => decodePayment(tx.serialize())).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => decodePayment('zz')).toThrow();
  });

  it('rejects unsupported chain ids', async () => {
    const tx = await makeSTXTokenTransfer({
      recipient: payTo,
      amount: 1000n,
      senderKey: payerKey,
      network: { ...STACKS_TESTNET, chainId: 0x80000001 },
      memo: 'x402:test',
      sponsored: true,
      fee: 0,
      nonce: 0,
    });
    expect(() => decodePayment(tx.serialize())).toThrow();
  });

  it('rejects SIP-010 memos over 34 bytes', async () => {
    const tx = await ftTx({ memo: Cl.some(Cl.buffer(new Uint8Array(35))) });
    expect(() => decodePayment(tx)).toThrow();
  });
});
