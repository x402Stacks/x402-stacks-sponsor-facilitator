import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ExactStacksScheme } from '../src/scheme.js';
import { fakeChain } from './fake-chain.js';
import { payTo, payloadFor, requirements, sponsor, sponsorKey, stxTx, testStateFile } from './helpers.js';

const app = (chain = fakeChain(), sponsorPayTo = [payTo]) =>
  createApp(new ExactStacksScheme({ sponsorKey, fee: 10_000n, chain, pollMs: 1, settleTimeoutMs: 20, sponsorPayTo, stateFile: testStateFile() }));
const post = (path: string, body: unknown, a = app()) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const body = async () => {
  const req = requirements();
  return { x402Version: 2, paymentPayload: payloadFor(await stxTx(), req), paymentRequirements: req };
};

describe('routes', () => {
  it('GET /health', async () => {
    expect(await (await app().request('/health')).json()).toEqual({
      status: 'ok', sponsor: {
        mainnet: { address: expect.any(String), balance: null },
        testnet: { address: sponsor, balance: null },
      },
    });
  });

  it('GET /supported advertises the sponsor', async () => {
    const res = await (await app().request('/supported')).json();
    expect(res.kinds).toContainEqual({ x402Version: 2, scheme: 'exact', network: 'stacks:2147483648', extra: { feePayer: sponsor } });
    expect(res.signers['stacks:2147483648']).toEqual([sponsor]);
  });

  it('GET /supported hides sponsor options when the merchant allowlist is empty', async () => {
    const res = await (await app(fakeChain(), []).request('/supported')).json();
    expect(res.kinds.find((kind: { network: string }) => kind.network === 'stacks:2147483648').extra).toBeUndefined();
    expect(res.signers['stacks:2147483648']).toEqual([]);
  });

  it('POST /verify', async () => {
    const res = await post('/verify', await body());
    expect(res.status).toBe(200);
    expect((await res.json()).isValid).toBe(true);
  });

  it('POST /verify rejects malformed bodies with 400', async () => {
    const res = await post('/verify', { nope: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ isValid: false, invalidReason: 'invalid_request' });
  });

  it('rejects request bodies larger than 64 KB', async () => {
    const res = await app().request('/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(100 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('POST /settle returns 200 on success and 400 on failure', async () => {
    expect((await post('/settle', await body())).status).toBe(200);
    const failed = await post('/settle', await body(), app(fakeChain({ balance: 0n })));
    expect(failed.status).toBe(400);
    expect(await failed.json()).toMatchObject({ success: false, errorReason: 'insufficient_funds' });
  });
});
