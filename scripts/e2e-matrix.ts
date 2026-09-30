import { fetchNonce, makeSTXTokenTransfer, privateKeyToAddress } from '@stacks/transactions';

const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:8085';
const HIRO = 'https://api.testnet.hiro.so';
const HIRO_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];
const payerKey = process.env.PAYER_PRIVATE_KEY;
const payTo = process.env.PAY_TO;
if (!payerKey || !payTo) throw new Error('set PAYER_PRIVATE_KEY and PAY_TO');

const NETWORK = 'stacks:2147483648';
const payer = privateKeyToAddress(payerKey, 'testnet');
const sponsor = String((await (await fetch(`${FACILITATOR}/supported`)).json() as any).signers?.[NETWORK]?.[0] ?? '');
if (!sponsor) throw new Error(`no facilitator signer for ${NETWORK}`);

async function fetchHiroWithRetry(input: string, init?: RequestInit): Promise<Response> {
  for (let retry = 0; ; retry++) {
    const response = await fetch(input, init);
    if (response.status !== 429 || retry === HIRO_RETRY_DELAYS_MS.length) return response;
    const retryAfter = response.headers.get('retry-after');
    const delay = retryAfter !== null && retryAfter.trim() !== '' && Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000
      : HIRO_RETRY_DELAYS_MS[retry]!;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

type Requirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { feePayer: string };
};
type SettleResult = { success?: boolean; errorReason?: string; transaction?: string };
type Signed = Awaited<ReturnType<typeof makeSTXTokenTransfer>>;

const requirement = (amount = '1000', extra = true, recipient = payTo): Requirements => ({
  scheme: 'exact', network: NETWORK, amount, asset: 'STX', payTo: recipient,
  maxTimeoutSeconds: 40,
  ...(extra ? { extra: { feePayer: sponsor } } : {}),
});

async function sign(opts: {
  sponsored: boolean;
  amount?: bigint;
  recipient?: string;
  nonce?: bigint;
  memo?: string;
}): Promise<Signed> {
  const nonce = opts.nonce ?? await fetchNonce({ address: payer, network: 'testnet' });
  const base = {
    recipient: opts.recipient ?? payTo!,
    amount: opts.amount ?? 1000n,
    senderKey: payerKey!,
    network: 'testnet' as const,
    memo: opts.memo ?? 'x402:matrix',
    nonce,
  };
  return makeSTXTokenTransfer(opts.sponsored ? { ...base, sponsored: true, fee: 0 } : base);
}

async function stxBalance(address: string): Promise<bigint> {
  const response = await fetchHiroWithRetry(`${HIRO}/extended/v1/address/${encodeURIComponent(address)}/balances`);
  if (!response.ok) throw new Error(`balance lookup failed (${response.status})`);
  const data = await response.json() as { stx?: { balance?: string } };
  return BigInt(data.stx?.balance ?? '0');
}

async function post(req: Requirements, tx: Signed): Promise<SettleResult> {
  const response = await fetch(`${FACILITATOR}/settle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted: req,
        payload: { transaction: tx.serialize() },
      },
      paymentRequirements: req,
    }),
  });
  return await response.json() as SettleResult;
}

type Outcome = { result: SettleResult; tx?: Signed; elapsed: number };
async function settle(req: Requirements, tx: Signed): Promise<Outcome> {
  const started = Date.now();
  try {
    return { result: await post(req, tx), tx, elapsed: Date.now() - started };
  } catch (error) {
    return {
      result: { success: false, errorReason: error instanceof Error ? error.message : String(error) },
      tx, elapsed: Date.now() - started,
    };
  }
}

let passed = 0;
const total = 11;
function record(name: string, expected: string, outcome: Outcome, check: boolean, details = ''): void {
  if (check) passed++;
  const actual = outcome.result.success ? 'success' : (outcome.result.errorReason ?? 'error');
  console.log(`${check ? 'PASS' : 'FAIL'} ${name} | expected: ${expected} | actual: ${actual}${details ? ` (${details})` : ''} | txid: ${outcome.result.transaction ?? ''} | ${outcome.elapsed}ms`);
}

async function caseRun(
  name: string,
  expected: string,
  req: Requirements,
  tx: Signed,
  matches: (result: SettleResult) => boolean,
  details = '',
): Promise<Outcome> {
  const outcome = await settle(req, tx);
  record(name, expected, outcome, matches(outcome.result), details);
  return outcome;
}

const reqWithExtra = requirement();
const reqWithoutExtra = requirement('1000', false);

// A: a standard transaction pays its own fee, even when no fee payer is requested.
const aBeforePayer = await stxBalance(payer);
const aBeforeSponsor = await stxBalance(sponsor);
const aTx = await sign({ sponsored: false });
const aFee = BigInt(aTx.auth.spendingCondition.fee);
const a = await settle(reqWithoutExtra, aTx);
const aAfterPayer = await stxBalance(payer);
const aAfterSponsor = await stxBalance(sponsor);
const aChecks = a.result.success === true && aBeforePayer - aAfterPayer === 1000n + aFee && aBeforeSponsor === aAfterSponsor;
record('A standard without extra', `success; payer -${1000n + aFee}, sponsor unchanged`, a, aChecks, `payer delta ${aBeforePayer - aAfterPayer}; sponsor delta ${aBeforeSponsor - aAfterSponsor}`);

// B: sponsored payment charges exactly the transfer amount to the payer.
const bBeforePayer = await stxBalance(payer);
const bBeforeSponsor = await stxBalance(sponsor);
const bTx = await sign({ sponsored: true });
const b = await settle(reqWithExtra, bTx);
const bAfterPayer = await stxBalance(payer);
const bAfterSponsor = await stxBalance(sponsor);
record('B sponsored STX', 'success; payer -1000, sponsor fee > 0', b,
  b.result.success === true && bBeforePayer - bAfterPayer === 1000n && bBeforeSponsor > bAfterSponsor,
  `payer delta ${bBeforePayer - bAfterPayer}; sponsor delta ${bBeforeSponsor - bAfterSponsor}`);

await caseRun('C replay B payload', "errorReason 'invalid_nonce'", reqWithExtra, bTx, r => r.errorReason === 'invalid_nonce');
await caseRun('D amount mismatch', "errorReason 'amount_mismatch'", reqWithExtra, await sign({ sponsored: true, amount: 999n }), r => r.errorReason === 'amount_mismatch');
await caseRun('E recipient mismatch', "errorReason 'recipient_mismatch'", reqWithExtra, await sign({ sponsored: true, recipient: payer }), r => r.errorReason === 'recipient_mismatch');
await caseRun('F sponsored without extra', "errorReason 'fee_payer_mismatch'", reqWithoutExtra, await sign({ sponsored: true }), r => r.errorReason === 'fee_payer_mismatch');

const gBeforeSponsor = await stxBalance(sponsor);
const g = await settle(reqWithExtra, await sign({ sponsored: false }));
const gAfterSponsor = await stxBalance(sponsor);
record('G standard with extra', 'success; client pays fee, sponsor unchanged', g, g.result.success === true && gBeforeSponsor === gAfterSponsor,
  `sponsor delta ${gBeforeSponsor - gAfterSponsor}`);

await caseRun('H insufficient funds', "errorReason 'insufficient_funds'", requirement('1000000000000000'), await sign({ sponsored: true, amount: 1_000_000_000_000_000n }), r => r.errorReason === 'insufficient_funds');
const iNonce = await fetchNonce({ address: payer, network: 'testnet' });
await caseRun('I future payer nonce', "errorReason 'invalid_nonce'", reqWithExtra, await sign({ sponsored: true, nonce: iNonce + 5n }), r => r.errorReason === 'invalid_nonce');

// J: race three distinct sponsored payments signed with the same payer nonce.
const jNonce = await fetchNonce({ address: payer, network: 'testnet' });
const jTxs = await Promise.all(['x402:c1', 'x402:c2', 'x402:c3'].map(memo => sign({ sponsored: true, nonce: jNonce, memo })));
const jStarted = Date.now();
const jOutcomes = await Promise.all(jTxs.map(tx => settle(reqWithExtra, tx)));
const jSuccesses = jOutcomes.filter(o => o.result.success === true).length;
const jErrors = jOutcomes.filter(o => o.result.success !== true).map(o => o.result.errorReason);
const jPass = jSuccesses === 1 && jErrors.every(reason => reason === 'duplicate_payment' || reason === 'invalid_nonce');
if (jPass) passed++;
for (let index = 0; index < jOutcomes.length; index++) {
  const outcome = jOutcomes[index]!;
  const gotSuccess = outcome.result.success === true;
  const expectedThis = gotSuccess ? 'success (the single accepted nonce)' : "'duplicate_payment' or 'invalid_nonce'";
  const validThis = gotSuccess ? jPass : jPass;
  const actual = gotSuccess ? 'success' : (outcome.result.errorReason ?? 'error');
  console.log(`${validThis ? 'PASS' : 'FAIL'} J concurrent ${index + 1} | expected: ${expectedThis}; group exactly 1 success | actual: ${actual}; group successes ${jSuccesses}/3 | txid: ${outcome.result.transaction ?? ''} | ${outcome.elapsed}ms`);
}
console.log(`${jPass ? 'PASS' : 'FAIL'} J concurrency group | expected: exactly 1 success | actual: ${jSuccesses}/3 successes | txid: ${jOutcomes.map(o => o.result.transaction ?? '').filter(Boolean).join(',')} | ${Date.now() - jStarted}ms`);

const sponsorNonceResponse = await fetchHiroWithRetry(`${HIRO}/extended/v1/address/${encodeURIComponent(sponsor)}/nonces`);
const sponsorNonces = await sponsorNonceResponse.json();
console.log(`Sponsor nonce before K: ${JSON.stringify(sponsorNonces)}`);
await caseRun('K payment after concurrency', 'success within the 40s settlement timeout', reqWithExtra, await sign({ sponsored: true, memo: 'x402:after-concurrency' }), r => r.success === true);

console.log(`${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
