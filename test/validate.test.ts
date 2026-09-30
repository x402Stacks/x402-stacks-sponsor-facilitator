import { describe, expect, it } from 'vitest';
import { Pc } from '@stacks/transactions';
import { decodePayment } from '../src/decode.js';
import type { PaymentRequirements } from '../src/types.js';
import { validatePayment } from '../src/validate.js';
import { FAKE_SBTC, ftTx, payTo, requirements, SBTC, sponsor, sponsorKey, stxTx, payer } from './helpers.js';

const check = async (tx: string, req: PaymentRequirements, accepted = req) =>
  validatePayment(decodePayment(tx), req, accepted, { address: sponsor, payTo: [payTo] });

describe('validatePayment', () => {
  it('accepts a sponsored STX payment', async () => {
    expect(await check(await stxTx(), requirements())).toBeNull();
  });

  it('accepts a sponsored sBTC payment by symbol and by contract id', async () => {
    expect(await check(await ftTx(), requirements({ asset: 'SBTC' }))).toBeNull();
    expect(await check(await ftTx(), requirements({ asset: SBTC }))).toBeNull();
  });

  it('accepts a standard payment when no feePayer is offered', async () => {
    expect(await check(await stxTx({ sponsored: false }), requirements({ extra: undefined }))).toBeNull();
  });

  it.each([
    ['unsupported_scheme', () => stxTx(), requirements({ scheme: 'upto' })],
    ['invalid_network', () => stxTx(), requirements({ network: 'stacks:1' })],
    ['invalid_payment_requirements', () => stxTx(), requirements({ amount: 'abc' })],
    ['invalid_payment_requirements', () => stxTx(), requirements({ amount: '0' })],
    ['invalid_asset', () => stxTx(), requirements({ asset: 'SBTC' })],
    ['invalid_asset', () => ftTx({ contract: FAKE_SBTC }), requirements({ asset: 'SBTC' })],
    ['invalid_asset', () => ftTx({ contract: FAKE_SBTC }), requirements({ asset: FAKE_SBTC })],
    ['sender_mismatch', () => ftTx({ sender: payTo }), requirements({ asset: 'SBTC' })],
    ['recipient_mismatch', () => stxTx({ recipient: sponsor }), requirements()],
    ['amount_mismatch', () => stxTx({ amount: 999n }), requirements()],
    ['fee_payer_mismatch', () => stxTx(), requirements({ extra: { feePayer: payTo } })],
    ['fee_payer_mismatch', () => stxTx(), requirements({ extra: undefined })],
    ['invalid_post_conditions', () => ftTx({ deny: false }), requirements({ asset: 'SBTC' })],
    ['invalid_payload', () => stxTx({ key: sponsorKey }), requirements()],
  ] as const)('rejects with %s', async (reason, build, req) => {
    expect(await check(await build(), req)).toBe(reason);
  });

  it('rejects when the accepted option differs from the requirements', async () => {
    expect(await check(await stxTx(), requirements(), requirements({ amount: '1' }))).toBe(
      'invalid_payment_requirements',
    );
  });

  it('rejects sponsored STX transactions that contain post-conditions', async () => {
    const tx = await stxTx({ postConditions: [Pc.principal(payer).willSendEq(1).ustx()] });
    expect(await check(tx, requirements())).toBe('invalid_post_conditions');
  });

  it('rejects sponsored FT transactions with extra post-conditions', async () => {
    const amount = 1000n;
    const tx = await ftTx({ postConditions: [
      Pc.principal(payer).willSendEq(amount).ft(SBTC, 'sbtc-token'),
      Pc.principal(payer).willSendEq(1).ustx(),
    ] });
    expect(await check(tx, requirements({ asset: 'SBTC' }))).toBe('invalid_post_conditions');
  });
});
