import { describe, expect, it, vi } from 'vitest';
import { NonceAllocator } from '../src/nonces.js';

describe('NonceAllocator', () => {
  it('runs callbacks sequentially and commits consecutive nonces under concurrency', async () => {
    const fetchNext = vi.fn(async () => 7n);
    const nonces = new NonceAllocator(fetchNext);
    const got = await Promise.all([7, 8, 9].map(() => nonces.run('testnet', async (nonce) => ({ commit: true, value: nonce }))));
    expect(got).toEqual([7n, 8n, 9n]);
    expect(fetchNext).toHaveBeenCalledTimes(1);
  });

  it('keeps networks separate', async () => {
    const nonces = new NonceAllocator(async (net) => (net === 'mainnet' ? 100n : 1n));
    expect(await nonces.run('mainnet', async (nonce) => ({ commit: true, value: nonce }))).toBe(100n);
    expect(await nonces.run('testnet', async (nonce) => ({ commit: true, value: nonce }))).toBe(1n);
  });

  it('re-fetches after a non-committed callback', async () => {
    const fetchNext = vi.fn().mockResolvedValueOnce(7n).mockResolvedValueOnce(3n);
    const nonces = new NonceAllocator(fetchNext);
    expect(await nonces.run('testnet', async (nonce) => ({ commit: false, value: nonce }))).toBe(7n);
    expect(await nonces.run('testnet', async (nonce) => ({ commit: true, value: nonce }))).toBe(3n);
  });

  it('recovers after a failed fetch', async () => {
    const fetchNext = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(5n);
    const nonces = new NonceAllocator(fetchNext);
    await expect(nonces.run('testnet', async (nonce) => ({ commit: true, value: nonce }))).rejects.toThrow('down');
    expect(await nonces.run('testnet', async (nonce) => ({ commit: true, value: nonce }))).toBe(5n);
  });

  it('re-seeds after a callback throws', async () => {
    const fetchNext = vi.fn().mockResolvedValueOnce(7n).mockResolvedValueOnce(2n);
    const nonces = new NonceAllocator(fetchNext);
    await expect(nonces.run('testnet', async () => { throw new Error('broadcast'); })).rejects.toThrow('broadcast');
    expect(await nonces.run('testnet', async (nonce) => ({ commit: true, value: nonce }))).toBe(2n);
  });
});
