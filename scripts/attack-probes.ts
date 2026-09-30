import { STACKS_TESTNET } from '@stacks/network';
import {
  createLPList,
  fetchNonce,
  makeSTXTokenTransfer,
  makeUnsignedSTXTokenTransfer,
  Pc,
  PostConditionMode,
  postConditionToWire,
  privateKeyToAddress,
  privateKeyToPublic,
  TransactionSigner,
} from '@stacks/transactions';

const FACILITATOR = process.env.FACILITATOR_URL ?? 'http://localhost:8085';
const HIRO = 'https://api.testnet.hiro.so';
const HIRO_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];
const payerKey = process.env.PAYER_PRIVATE_KEY;
const payTo = process.env.PAY_TO;
if (!payerKey || !payTo) throw new Error('set PAYER_PRIVATE_KEY and PAY_TO');

const NETWORK = 'stacks:2147483648';
const payer = privateKeyToAddress(payerKey, 'testnet');
const supportedResponse = await fetch(`${FACILITATOR}/supported`);
if (!supportedResponse.ok) throw new Error(`/supported failed (${supportedResponse.status})`);
const supported = await supportedResponse.json() as { signers?: Record<string, string[]> };
const sponsor = String(supported.signers?.[NETWORK]?.[0] ?? '');
if (!sponsor) throw new Error(`no facilitator signer for ${NETWORK}`);

type Requirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { feePayer: string };
};
type SettleResult = { success?: boolean; errorReason?: string; transaction?: string; [key: string]: unknown };
type Signed = Awaited<ReturnType<typeof makeSTXTokenTransfer>>;
type ProbeVerdict = 'SAFE' | 'VULNERABLE';

const requirement = (amount = '1000', extra = true, recipient = payTo): Requirements => ({
  scheme: 'exact',
  network: NETWORK,
  amount,
  asset: 'STX',
  payTo: recipient,
  maxTimeoutSeconds: 40,
  ...(extra ? { extra: { feePayer: sponsor } } : {}),
});

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

async function stxBalance(address: string): Promise<bigint> {
  const response = await fetchHiroWithRetry(`${HIRO}/extended/v1/address/${encodeURIComponent(address)}/balances`);
  if (!response.ok) throw new Error(`balance lookup failed for ${address} (${response.status})`);
  const data = await response.json() as { stx?: { balance?: string } };
  return BigInt(data.stx?.balance ?? '0');
}

async function sign(opts: {
  sponsored: boolean;
  amount?: bigint;
  recipient?: string;
  nonce?: bigint;
  network?: typeof STACKS_TESTNET;
  memo?: string;
}): Promise<Signed> {
  const nonce = opts.nonce ?? await fetchNonce({ address: payer, network: 'testnet' });
  const base = {
    recipient: opts.recipient ?? payTo!,
    amount: opts.amount ?? 1000n,
    senderKey: payerKey!,
    network: opts.network ?? 'testnet' as const,
    memo: opts.memo ?? 'x402:attack-probe',
    nonce,
  };
  return makeSTXTokenTransfer(opts.sponsored ? { ...base, sponsored: true, fee: 0 } : base);
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
  const raw = await response.text();
  try {
    return JSON.parse(raw) as SettleResult;
  } catch {
    return { success: false, errorReason: `non-JSON HTTP ${response.status}: ${raw}` };
  }
}

function txidOf(result: SettleResult): string | undefined {
  const value = result.transaction;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function txStatus(txid: string): Promise<string> {
  const normalized = txid.startsWith('0x') ? txid : `0x${txid}`;
  const deadline = Date.now() + 60_000;
  let status = 'unknown';
  do {
    const response = await fetchHiroWithRetry(`${HIRO}/extended/v1/tx/${encodeURIComponent(normalized)}`);
    if (response.ok) {
      const data = await response.json() as { tx_status?: string };
      status = data.tx_status ?? 'unknown';
      if (status !== 'pending') return status;
    } else {
      status = `http_${response.status}`;
    }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  return status;
}

async function printProbe(
  name: string,
  results: SettleResult[],
  beforePayer: bigint,
  beforeSponsor: bigint,
  verdict: ProbeVerdict,
  extraTxids: string[] = [],
): Promise<void> {
  console.log(`\n=== ${name} ===`);
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    console.log(`Facilitator response${results.length > 1 ? ` ${i + 1}` : ''}: ${JSON.stringify(result)}`);
  }
  const txids = [...new Set([...results.map(txidOf).filter((id): id is string => !!id), ...extraTxids])];
  for (const id of txids) console.log(`txid ${id} tx_status: ${await txStatus(id)}`);
  const [afterPayer, afterSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  console.log(`STX balance deltas: payer ${afterPayer - beforePayer}; sponsor ${afterSponsor - beforeSponsor}`);
  console.log(`${verdict}`);
  verdicts.push({ name, verdict });
}

const verdicts: { name: string; verdict: ProbeVerdict }[] = [];

// P5: chain id in the signed transaction disagrees with the requested testnet network.
{
  const [beforePayer, beforeSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const wrongNetwork = { ...STACKS_TESTNET, chainId: 0x80000001 as typeof STACKS_TESTNET.chainId };
  const result = await post(requirement(), await sign({ sponsored: true, network: wrongNetwork }));
  const [afterPayer, afterSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const safe = result.success !== true && afterSponsor === beforeSponsor;
  await printProbe('P5 bogus chain id', [result], beforePayer, beforeSponsor, safe ? 'SAFE' : 'VULNERABLE');
}

// P2: an STX postcondition demands a transfer amount different from the transaction amount.
{
  const [beforePayer, beforeSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const nonce = await fetchNonce({ address: payer, network: 'testnet' });
  const tx = await makeUnsignedSTXTokenTransfer({
    recipient: payTo,
    amount: 1000n,
    publicKey: privateKeyToPublic(payerKey),
    network: 'testnet',
    memo: 'x402:fail-postcondition',
    nonce,
    sponsored: true,
    fee: 0,
  });
  tx.postConditionMode = PostConditionMode.Deny;
  tx.postConditions = createLPList([postConditionToWire(Pc.principal(payer).willSendEq(1).ustx())]);
  new TransactionSigner(tx).signOrigin(payerKey);
  const result = await post(requirement(), tx);
  const [afterPayer, afterSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const broadcastAndCharged = !!txidOf(result) && afterSponsor < beforeSponsor;
  const safe = !txidOf(result);
  await printProbe('P2 failing post-condition', [result], beforePayer, beforeSponsor, safe ? 'SAFE' : 'VULNERABLE');
  if (broadcastAndCharged) console.log(`P2 sponsor balance drop: ${beforeSponsor - afterSponsor}`);
}

// P4: submit the exact same standard transaction twice at once.
{
  const [beforePayer, beforeSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const tx = await sign({ sponsored: false, memo: 'x402:duplicate-standard' });
  const req = requirement('1000', false);
  const results = await Promise.all([post(req, tx), post(req, tx)]);
  const txidResponses = results.filter(result => !!txidOf(result)).length;
  await printProbe('P4 duplicate standard tx', results, beforePayer, beforeSponsor, txidResponses <= 1 ? 'SAFE' : 'VULNERABLE');
}

// P3: occupy the payer's next nonce with an unconfirmed drain, then request a payment
// larger than the payer's intended remaining balance while the facilitator sponsors fees.
{
  const [beforePayer, beforeSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  let drainTxid = '';
  let paymentResult: SettleResult = { success: false, errorReason: 'probe did not reach settlement' };
  try {
    const balance = beforePayer;
    const nonce = await fetchNonce({ address: payer, network: 'testnet' });
    const estimate = await makeSTXTokenTransfer({
      recipient: payTo,
      amount: balance > 200_000n ? balance - 200_000n : 1n,
      senderKey: payerKey,
      network: 'testnet',
      nonce,
      memo: 'x402:pending-drain',
    });
    const drainFee = BigInt(estimate.auth.spendingCondition.fee);
    const drainAmount = balance - 200_000n - drainFee;
    if (drainAmount <= 0n) throw new Error(`payer balance too low for planned drain (${balance})`);
    const drain = await makeSTXTokenTransfer({
      recipient: payTo,
      amount: drainAmount,
      senderKey: payerKey,
      network: 'testnet',
      nonce,
      memo: 'x402:pending-drain',
    });
    const broadcast = await fetchHiroWithRetry(`${HIRO}/v2/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from(drain.serialize(), 'hex'),
    });
    const broadcastBody = await broadcast.text();
    if (!broadcast.ok) throw new Error(`drain broadcast failed (${broadcast.status}): ${broadcastBody}`);
    try { drainTxid = JSON.parse(broadcastBody) as string; } catch { drainTxid = broadcastBody.replaceAll('"', ''); }

    const nonceDeadline = Date.now() + 30_000;
    let nextNonce: bigint | undefined;
    while (Date.now() < nonceDeadline) {
      const response = await fetchHiroWithRetry(`${HIRO}/extended/v1/address/${encodeURIComponent(payer)}/nonces`);
      if (response.ok) {
        const data = await response.json() as { possible_next_nonce?: number | string };
        if (BigInt(data.possible_next_nonce ?? 0) === nonce + 1n) {
          nextNonce = nonce + 1n;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (nextNonce === undefined) throw new Error('payer possible_next_nonce did not advance within 30 seconds');
    const payment = await sign({ sponsored: true, amount: 250_000n, nonce: nextNonce, memo: 'x402:pending-payment' });
    paymentResult = await post(requirement('250000'), payment);
  } catch (error) {
    paymentResult = { success: false, errorReason: error instanceof Error ? error.message : String(error) };
  }
  const [afterPayer, afterSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const sponsorDropped = afterSponsor < beforeSponsor;
  const paymentTxid = txidOf(paymentResult);
  const vulnerable = !!paymentTxid;
  await printProbe('P3 pending-drain', [paymentResult], beforePayer, beforeSponsor,
    vulnerable ? 'VULNERABLE' : 'SAFE', drainTxid ? [drainTxid] : []);
  console.log(`P3 drain txid: ${drainTxid || '(not broadcast)'}`);
  console.log(`P3 sponsored payment txid: ${paymentTxid ?? '(not broadcast)'}`);
  if (vulnerable) console.log(`P3 sponsor balance drop: ${beforeSponsor - afterSponsor}`);
}

// P6: a sponsored transfer requests a recipient outside the configured allowlist.
{
  const [beforePayer, beforeSponsor] = await Promise.all([stxBalance(payer), stxBalance(sponsor)]);
  const req = requirement('1000', true, payer);
  const result = await post(req, await sign({ sponsored: true, recipient: payer, memo: 'x402:disallowed-sponsor-target' }));
  const safe = result.errorReason === 'sponsorship_not_allowed' && !txidOf(result);
  await printProbe('P6 sponsored disallowed recipient', [result], beforePayer, beforeSponsor, safe ? 'SAFE' : 'VULNERABLE');
}

console.log('\nProbe summary');
console.log('Probe | Verdict');
console.log('--- | ---');
for (const item of verdicts) console.log(`${item.name} | ${item.verdict}`);
