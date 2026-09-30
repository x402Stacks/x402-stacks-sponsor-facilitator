import { describe, expect, it } from 'vitest';
import { ExactStacksScheme } from '../src/scheme.js';
import { fakeChain } from './fake-chain.js';
import { ftTx, payer, payTo, payloadFor, requirements, SBTC, sponsor, sponsorKey, stxTx, testStateFile } from './helpers.js';

const scheme = (chain = fakeChain(), sponsorPayTo = [payTo]) => new ExactStacksScheme({ sponsorKey, fee: 10_000n, chain, sponsorPayTo, stateFile: testStateFile() });

describe('ExactStacksScheme', () => {
  it('advertises the sponsor as feePayer and signer', () => {
    expect(scheme().getExtra('stacks:2147483648')).toEqual({ feePayer: sponsor });
    expect(scheme().getSigners('stacks:2147483648')).toEqual([sponsor]);
    expect(scheme().getExtra('eip155:1')).toBeUndefined();
  });

  it('verifies a valid sponsored payment', async () => {
    const req = requirements();
    expect(await scheme().verify(payloadFor(await stxTx(), req), req)).toEqual({ isValid: true, payer });
  });

  it('checks the FT balance key', async () => {
    const chain = fakeChain();
    const req = requirements({ asset: 'SBTC' });
    await scheme(chain).verify(payloadFor(await ftTx(), req), req);
    expect(chain.getBalance).toHaveBeenCalledWith(payer, `${SBTC}::sbtc-token`, 'testnet');
  });

  it('rejects sponsored payments to merchants outside the allowlist', async () => {
    const req = requirements({ payTo: sponsor });
    expect(await scheme().verify(payloadFor(await stxTx({ recipient: sponsor }), req), req)).toMatchObject({
      isValid: false,
      invalidReason: 'sponsorship_not_allowed',
    });
  });

  it('disables sponsorship when the merchant allowlist is empty', async () => {
    const disabled = scheme(fakeChain(), []);
    const req = requirements();
    expect(disabled.getExtra('stacks:2147483648')).toBeUndefined();
    expect(disabled.getSigners('stacks:2147483648')).toEqual([]);
    expect(await disabled.verify(payloadFor(await stxTx(), req), req)).toMatchObject({
      isValid: false,
      invalidReason: 'sponsorship_not_allowed',
    });
  });

  it.each([
    ['invalid_x402_version', async () => ({ ...payloadFor(await stxTx(), requirements()), x402Version: 1 })],
    ['invalid_payload', async () => payloadFor('zz', requirements())],
    ['invalid_payload', async () => ({ ...payloadFor('', requirements()), payload: {} })],
  ])('rejects with %s', async (reason, build) => {
    expect(await scheme().verify(await build(), requirements())).toMatchObject({ isValid: false, invalidReason: reason });
  });

  it('rejects insufficient funds', async () => {
    const req = requirements();
    expect(await scheme(fakeChain({ balance: 999n })).verify(payloadFor(await stxTx(), req), req)).toEqual({
      isValid: false,
      invalidReason: 'insufficient_funds',
      payer,
    });
  });

  it('rejects sponsored payments when the known sponsor balance cannot cover the fee', async () => {
    const instance = scheme();
    instance.setSponsorBalance('testnet', 9_999n);
    expect(await instance.verify(payloadFor(await stxTx(), requirements()), requirements())).toMatchObject({
      isValid: false, invalidReason: 'sponsor_unavailable',
    });
  });

  it('returns an unexpected verify error when the balance lookup rejects', async () => {
    const req = requirements();
    const chain = {
      ...fakeChain(),
      getBalance: async () => {
        throw new Error('Hiro unavailable');
      },
    };
    expect(await scheme(chain).verify(payloadFor(await stxTx(), req), req)).toEqual({
      isValid: false,
      invalidReason: 'unexpected_verify_error',
      payer,
    });
  });

  it('rejects a nonce that is not the payer next nonce', async () => {
    const req = requirements();
    expect(await scheme(fakeChain({ payerNonce: 5n })).verify(payloadFor(await stxTx({ nonce: 2 }), req), req)).toMatchObject({
      isValid: false,
      invalidReason: 'invalid_nonce',
    });
  });
});
