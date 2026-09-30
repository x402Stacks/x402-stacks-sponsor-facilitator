import { afterEach, describe, expect, it, vi } from 'vitest';
import { monitorSponsorBalances } from '../src/monitor.js';
import { sponsor, sponsorKey } from './helpers.js';
import { ExactStacksScheme } from '../src/scheme.js';
import { fakeChain } from './fake-chain.js';

afterEach(() => vi.restoreAllMocks());

describe('monitorSponsorBalances', () => {
  it('logs low balances and alerts at most once per hour per network', async () => {
    let now = 0;
    const chain = fakeChain();
    chain.getBalance.mockResolvedValue(500_000n);
    const scheme = new ExactStacksScheme({ sponsorKey, fee: 10_000n, sponsorPayTo: [sponsor], chain, stateFile: '/tmp/x402-monitor-state.json' });
    const fetcher = vi.fn(async () => new Response('', { status: 200 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await monitorSponsorBalances(scheme, chain, { lowBalance: 1_000_000n, webhookUrl: 'https://hook.test', fetcher, now: () => now });
    now += 59 * 60_000;
    await monitorSponsorBalances(scheme, chain, { lowBalance: 1_000_000n, webhookUrl: 'https://hook.test', fetcher, now: () => now });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sponsor_low_balance'));
    now += 60_000;
    await monitorSponsorBalances(scheme, chain, { lowBalance: 1_000_000n, webhookUrl: 'https://hook.test', fetcher, now: () => now });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
