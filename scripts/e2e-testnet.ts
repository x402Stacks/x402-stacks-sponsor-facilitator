import { fetchNonce, makeSTXTokenTransfer, privateKeyToAddress } from '@stacks/transactions';

const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:8085';
const payerKey = process.env.PAYER_PRIVATE_KEY!;
const payTo = process.env.PAY_TO!;
if (!payerKey || !payTo) throw new Error('set PAYER_PRIVATE_KEY and PAY_TO');

const supported = await (await fetch(`${FACILITATOR}/supported`)).json();
const feePayer = supported.signers['stacks:2147483648'][0];
const requirements = {
  scheme: 'exact',
  network: 'stacks:2147483648',
  amount: '1000',
  asset: 'STX',
  payTo,
  maxTimeoutSeconds: 60,
  extra: { feePayer },
};

const payer = privateKeyToAddress(payerKey, 'testnet');
const tx = await makeSTXTokenTransfer({
  recipient: payTo,
  amount: 1000n,
  senderKey: payerKey,
  network: 'testnet',
  memo: 'x402:e2e',
  sponsored: true,
  fee: 0,
  nonce: await fetchNonce({ address: payer, network: 'testnet' }),
});

const res = await fetch(`${FACILITATOR}/settle`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: tx.serialize() } },
    paymentRequirements: requirements,
  }),
});
console.log(res.status, await res.json());
