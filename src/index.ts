import { serve } from '@hono/node-server';
import { privateKeyToAddress } from '@stacks/transactions';
import { createApp } from './app.js';
import { hiroChain } from './chain.js';
import { ExactStacksScheme } from './scheme.js';
import { monitorSponsorBalances } from './monitor.js';

const env = process.env;
const sponsorKey = env.SPONSOR_PRIVATE_KEY ?? '';
const sponsorPayTo = (env.SPONSOR_PAY_TO ?? '').split(',').map((address) => address.trim()).filter(Boolean);
try {
  privateKeyToAddress(sponsorKey, 'mainnet');
} catch {
  console.error('SPONSOR_PRIVATE_KEY is missing or invalid');
  process.exit(1);
}

const chain = hiroChain(env.HIRO_API_KEY || undefined);
const sponsorFee = BigInt(env.SPONSOR_FEE ?? '10000');
const scheme = new ExactStacksScheme({
  sponsorKey,
  sponsorPayTo,
  fee: sponsorFee,
  maxRepairFee: BigInt(env.SPONSOR_MAX_REPAIR_FEE ?? (sponsorFee * 16n).toString()),
  settleTimeoutMs: Number(env.SETTLE_TIMEOUT_MS ?? 45_000),
  sponsorDailyBudget: BigInt(env.SPONSOR_DAILY_BUDGET ?? '1000000'),
  sponsorPayerPerMinute: Number(env.SPONSOR_PAYER_PER_MINUTE ?? 10),
  stateFile: env.STATE_FILE ?? './data/state.json',
  lowBalance: BigInt(env.SPONSOR_LOW_BALANCE ?? '1000000'),
  chain,
});

const runSponsorMaintenance = () => {
  for (const network of ['mainnet', 'testnet'] as const) {
    void scheme.repairSponsor(network).catch((error) => {
      console.error(JSON.stringify({ evt: 'error', where: `sponsor_repair:${network}`, message: error instanceof Error ? error.message : String(error) }));
    });
  }
  void monitorSponsorBalances(scheme, chain, {
    lowBalance: BigInt(env.SPONSOR_LOW_BALANCE ?? '1000000'), webhookUrl: env.ALERT_WEBHOOK_URL || undefined,
  }).catch((error) => {
    console.error(JSON.stringify({ evt: 'error', where: 'sponsor_balance', message: error instanceof Error ? error.message : String(error) }));
  });
};
runSponsorMaintenance();
const sponsorRepair = setInterval(runSponsorMaintenance, 60_000);
sponsorRepair.unref();

const port = Number(env.PORT ?? 8085);
serve({ fetch: createApp(scheme).fetch, port });
console.log(
  `x402 stacks facilitator on :${port} — sponsor mainnet ${scheme.sponsorAddress('mainnet')}, testnet ${scheme.sponsorAddress('testnet')} — ${sponsorPayTo.length} merchants allowed`,
);
