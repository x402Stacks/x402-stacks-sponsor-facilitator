import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
type BudgetState = { day: string; spent: Record<string, string> };
type LimitsConfig = { budget: bigint; payerPerMinute: number; stateFile: string; now?: () => number };

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export class SponsorLimits {
  private state: BudgetState;
  // ponytail: payer attempts are process-local; sharing them across instances needs a shared rate-limit store.
  private payerAttempts = new Map<string, number[]>();
  private now: () => number;

  constructor(private cfg: LimitsConfig) {
    this.now = cfg.now ?? Date.now;
    this.state = { day: utcDay(this.now()), spent: {} };
    if (existsSync(cfg.stateFile)) {
      try {
        const loaded: unknown = JSON.parse(readFileSync(cfg.stateFile, 'utf8'));
        if (!loaded || typeof loaded !== 'object' || !('day' in loaded) || !('spent' in loaded) ||
          typeof loaded.day !== 'string' || !loaded.spent || typeof loaded.spent !== 'object' || Array.isArray(loaded.spent) ||
          Object.values(loaded.spent).some((amount) => typeof amount !== 'string' || !/^\d+$/.test(amount))) {
          throw new Error('invalid state file');
        }
        if (loaded.day === this.state.day) this.state = loaded as BudgetState;
      } catch (error) {
        console.error(JSON.stringify({ evt: 'error', where: 'state_load', message: error instanceof Error ? error.message : String(error) }));
      }
    } else {
      console.error(JSON.stringify({ evt: 'error', where: 'state_load', message: 'state file missing; starting empty' }));
    }
  }

  check(payTo: string, payer: string, fee: bigint, now = this.now()): string | null {
    this.rollDay(now);
    if (BigInt(this.state.spent[payTo] ?? '0') + fee > this.cfg.budget) return 'sponsor_budget_exceeded';
    this.prunePayerAttempts(now);
    if ((this.payerAttempts.get(payer)?.length ?? 0) >= this.cfg.payerPerMinute) return 'rate_limited';
    return null;
  }

  recordPayerAttempt(payer: string, now = this.now()): void {
    this.prunePayerAttempts(now);
    const attempts = this.payerAttempts.get(payer) ?? [];
    attempts.push(now);
    this.payerAttempts.set(payer, attempts);
  }

  prunePayerAttempts(now = this.now()): void {
    for (const [payer, attempts] of this.payerAttempts) {
      const active = attempts.filter((time) => time > now - 60_000);
      if (active.length) this.payerAttempts.set(payer, active);
      else this.payerAttempts.delete(payer);
    }
  }

  recordSpend(payTo: string, fee: bigint, now = this.now()): void {
    this.rollDay(now);
    this.state.spent[payTo] = (BigInt(this.state.spent[payTo] ?? '0') + fee).toString();
    mkdirSync(dirname(this.cfg.stateFile), { recursive: true });
    const tmp = `${this.cfg.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.cfg.stateFile);
  }

  private rollDay(now: number): void {
    const day = utcDay(now);
    if (this.state.day !== day) this.state = { day, spent: {} };
  }
}
