import { afterEach, describe, expect, it, vi } from 'vitest';
import { hiroChain } from '../src/chain.js';

const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(typeof body === 'string' && status !== 200 ? body : JSON.stringify(body), { status }));

afterEach(() => vi.unstubAllGlobals());

describe('hiroChain', () => {
  it('parses a successful broadcast and sends the api key', async () => {
    const fetch = reply('0xabc123');
    vi.stubGlobal('fetch', fetch);
    expect(await hiroChain('k').broadcast('00', 'testnet')).toEqual({ txid: 'abc123' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.testnet.hiro.so/v2/transactions');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  it('returns the rejection reason', async () => {
    vi.stubGlobal('fetch', reply({ error: 'transaction rejected', reason: 'BadNonce' }, 400));
    expect(await hiroChain().broadcast('00', 'mainnet')).toEqual({ error: 'BadNonce' });
  });

  it('handles plain-text errors', async () => {
    vi.stubGlobal('fetch', reply('Failed to decode', 400));
    expect(await hiroChain().broadcast('00', 'testnet')).toEqual({ error: 'http_400' });
  });

  it('reads tx status, null when unknown', async () => {
    vi.stubGlobal('fetch', reply({ tx_status: 'success' }));
    expect(await hiroChain().getTxStatus('ab', 'testnet')).toBe('success');
    vi.stubGlobal('fetch', reply('not found', 404));
    expect(await hiroChain().getTxStatus('ab', 'testnet')).toBeNull();
  });

  it('reads possible, mempool, and missing nonces', async () => {
    vi.stubGlobal('fetch', reply({ possible_next_nonce: 90, last_executed_tx_nonce: 89, last_mempool_tx_nonce: 92, detected_missing_nonces: [91] }));
    expect(await hiroChain().getNonceInfo('ST1', 'testnet')).toEqual({
      possibleNext: 90n, lastExecuted: 89n, lastMempool: 92n, missing: [91n],
    });
  });

  it('reads unlocked STX and FT balances', async () => {
    vi.stubGlobal(
      'fetch',
      reply({ stx: { balance: '1000', locked: '300' }, fungible_tokens: { 'A.b::c': { balance: '42' } } }),
    );
    expect(await hiroChain().getBalance('ST1', 'STX', 'testnet')).toBe(700n);
    expect(await hiroChain().getBalance('ST1', 'A.b::c', 'testnet')).toBe(42n);
    expect(await hiroChain().getBalance('ST1', 'X.y::z', 'testnet')).toBe(0n);
  });

  it('retries a Hiro GET after HTTP 429', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tx_status: 'success' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await hiroChain(undefined, { retryDelayMs: 0 }).getTxStatus('ab', 'testnet')).toBe('success');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops broadcasting after four consecutive HTTP 429 responses', async () => {
    const fetch = vi.fn(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    expect(await hiroChain(undefined, { retryDelayMs: 0 }).broadcast('00', 'testnet')).toEqual({ error: 'http_429' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('caps Retry-After waits at five seconds', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '3600' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tx_status: 'success' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    try {
      const request = hiroChain().getTxStatus('ab', 'testnet');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await request).toBe('success');
    } finally {
      vi.useRealTimers();
    }
  });
});
