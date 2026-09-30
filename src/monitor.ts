import type { Chain } from './chain.js';
import type { ExactStacksScheme } from './scheme.js';

type MonitorOptions = {
  lowBalance: bigint;
  webhookUrl?: string;
  fetcher?: typeof fetch;
  now?: () => number;
};

const lastAlert = new Map<string, number>();

export async function monitorSponsorBalances(
  scheme: ExactStacksScheme,
  chain: Chain,
  options: MonitorOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  for (const network of ['mainnet', 'testnet'] as const) {
    const address = scheme.sponsorAddress(network);
    const balance = await chain.getBalance(address, 'STX', network);
    scheme.setSponsorBalance(network, balance);
    if (balance >= options.lowBalance) continue;
    const event = { evt: 'sponsor_low_balance', network, address, balance: balance.toString() };
    console.log(JSON.stringify(event));
    if (!options.webhookUrl || now() - (lastAlert.get(network) ?? -Infinity) < 60 * 60_000) continue;
    lastAlert.set(network, now());
    try {
      const response = await (options.fetcher ?? fetch)(options.webhookUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
      });
      if (!response.ok) throw new Error(`alert webhook returned ${response.status}`);
    } catch (error) {
      console.error(JSON.stringify({ evt: 'error', where: 'sponsor_alert', message: error instanceof Error ? error.message : String(error) }));
    }
  }
}
