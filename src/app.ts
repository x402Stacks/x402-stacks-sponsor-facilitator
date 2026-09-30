import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ExactStacksScheme } from './scheme.js';
import { NETWORK_IDS, type PaymentPayload, type PaymentRequirements } from './types.js';

interface FacilitatorRequest {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

function isRequest(b: any): b is FacilitatorRequest {
  const r = b?.paymentRequirements;
  return (
    b?.x402Version === 2 &&
    typeof b.paymentPayload === 'object' &&
    b.paymentPayload !== null &&
    typeof r === 'object' &&
    r !== null &&
    ['scheme', 'network', 'amount', 'asset', 'payTo'].every((k) => typeof r[k] === 'string')
  );
}

// Same V2 contract as the Go facilitator (and what x402-stacks X402PaymentVerifier calls).
export function createApp(scheme: ExactStacksScheme) {
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }));

  app.get('/health', (c) => c.json(scheme.health()));

  app.get('/supported', (c) =>
    c.json({
      kinds: NETWORK_IDS.map((network) => ({ x402Version: 2, scheme: 'exact', network, extra: scheme.getExtra(network) })),
      extensions: [],
      signers: Object.fromEntries(NETWORK_IDS.map((n) => [n, scheme.getSigners(n)])),
    }),
  );

  app.post('/verify', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!isRequest(b)) return c.json({ isValid: false, invalidReason: 'invalid_request' }, 400);
    return c.json(await scheme.verify(b.paymentPayload, b.paymentRequirements));
  });

  app.post('/settle', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!isRequest(b)) {
      return c.json({ success: false, errorReason: 'invalid_request', transaction: '', network: '' }, 400);
    }
    const res = await scheme.settle(b.paymentPayload, b.paymentRequirements);
    return c.json(res, res.success ? 200 : 400);
  });

  return app;
}
