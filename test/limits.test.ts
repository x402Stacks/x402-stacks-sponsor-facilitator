import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SponsorLimits } from '../src/limits.js';

const dirs: string[] = [];
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'x402-limits-'));
  dirs.push(dir);
  return join(dir, 'state.json');
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('SponsorLimits', () => {
  it('rejects fees that exceed the daily per-payTo budget', () => {
    const limits = new SponsorLimits({ budget: 15n, payerPerMinute: 10, stateFile: tempFile(), now: () => Date.UTC(2026, 0, 1) });
    expect(limits.check('merchant', 'payer', 10n)).toBeNull();
    limits.recordSpend('merchant', 10n);
    expect(limits.check('merchant', 'payer', 6n)).toBe('sponsor_budget_exceeded');
  });

  it('resets budget at UTC day rollover', () => {
    let now = Date.UTC(2026, 0, 1, 23, 59);
    const limits = new SponsorLimits({ budget: 10n, payerPerMinute: 10, stateFile: tempFile(), now: () => now });
    limits.recordSpend('merchant', 10n);
    now += 60_000;
    expect(limits.check('merchant', 'payer', 10n)).toBeNull();
  });

  it('persists the daily budget across instances', () => {
    const stateFile = tempFile();
    const options = { budget: 15n, payerPerMinute: 10, stateFile, now: () => Date.UTC(2026, 0, 1) };
    new SponsorLimits(options).recordSpend('merchant', 10n);
    expect(new SponsorLimits(options).check('merchant', 'payer', 6n)).toBe('sponsor_budget_exceeded');
  });

  it('limits a payer in a rolling minute', () => {
    const limits = new SponsorLimits({ budget: 100n, payerPerMinute: 2, stateFile: tempFile(), now: () => 0 });
    expect(limits.check('merchant', 'payer', 1n)).toBeNull();
    limits.recordPayerAttempt('payer');
    limits.recordPayerAttempt('payer');
    expect(limits.check('merchant', 'payer', 1n)).toBe('rate_limited');
    limits.prunePayerAttempts(60_001);
    expect(limits.check('merchant', 'payer', 1n, 60_001)).toBeNull();
  });
});
