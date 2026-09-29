/**
 * Project future paychecks with the engine, so deposits can be scheduled before the money is withheld.
 * Salaried employees only: gross per period comes from the profile's salaryPerPeriod.
 */
import type { EmployeeProfile } from "./compare.js";
import { runPayRun } from "./engine.js";
import { D, Dec } from "./money.js";
import type { RuleSet } from "./rules.js";
import type { PayRunInput } from "./types.js";
import type { PayRun } from "./deposits.js";
import { iso } from "./calendar.js";

/** Pay date -> pay period, as { monthOffset, day } pairs relative to the pay date's month. */
export interface PaySchedule {
  payDays: number[];                                            // e.g. [1, 15]
  periods: Record<string, { start: [number, number]; end: [number, number] }>;
}

/** QuickBooks' semimonthly pattern: pay on the 1st for the 17th..1st, on the 15th for the 2nd..16th. */
export const QBO_SEMIMONTHLY: PaySchedule = {
  payDays: [1, 15],
  periods: { "1": { start: [-1, 17], end: [0, 1] }, "15": { start: [0, 2], end: [0, 16] } },
};

export interface ProjectableProfile extends EmployeeProfile {
  salaryPerPeriod?: string;
  /** Salary changes by pay date: the latest entry with from <= pay date wins, else salaryPerPeriod. */
  salaryChanges?: { from: string; perPeriod: string }[];
  active?: boolean;
}

/** Salary per period in effect on a pay date (undefined if none). */
export function salaryOn(p: Pick<ProjectableProfile, "salaryPerPeriod" | "salaryChanges">, payDate: string): string | undefined {
  const c = [...(p.salaryChanges ?? [])].filter(x => x.from <= payDate).sort((a, b) => a.from.localeCompare(b.from)).at(-1);
  return c?.perPeriod ?? p.salaryPerPeriod;
}

const shiftMonth = (y: number, m: number, off: number): [number, number] => {
  const t = y * 12 + (m - 1) + off; return [Math.floor(t / 12), (t % 12) + 1];
};

export function payDatesBetween(from: string, to: string, s: PaySchedule): { payDate: string; start: string; end: string }[] {
  const out: { payDate: string; start: string; end: string }[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  while (iso(y, m, 1) <= to) {
    for (const day of [...s.payDays].sort((a, b) => a - b)) {
      const payDate = iso(y, m, day);
      if (payDate < from || payDate > to) continue;
      const p = s.periods[String(day)];
      if (!p) throw new Error(`pay schedule has no period for pay day ${day}`);
      const [sy, sm] = shiftMonth(y, m, p.start[0]), [ey, em] = shiftMonth(y, m, p.end[0]);
      out.push({ payDate, start: iso(sy, sm, p.start[1]), end: iso(ey, em, p.end[1]) });
    }
    [y, m] = shiftMonth(y, m, 1);
  }
  return out;
}

export interface Projection { runs: PayRun[]; errors: { payDate: string; employee: string; error: string }[] }

/**
 * Projected pay runs for every pay date in [from, to] that has no actual run yet (per employee).
 * YTD taxable wages continue from the actual runs of the same calendar year (no pre-tax deductions).
 */
export function projectPayRuns(actual: PayRun[], profiles: ProjectableProfile[], employer: PayRunInput["employer"],
  rules: RuleSet, schedule: PaySchedule, from: string, to: string): Projection {
  const runs: PayRun[] = []; const errors: Projection["errors"] = [];
  for (const p of profiles.filter(x => x.active !== false && (x.salaryPerPeriod || x.salaryChanges?.length))) {
    const id = p.input.id ?? p.providerEmployeeId;
    const mine = actual.filter(r => r.employeeId === id);
    for (const pd of payDatesBetween(from, to, schedule)) {
      if (mine.some(r => r.period.payDate === pd.payDate)) continue;
      const salary = salaryOn(p, pd.payDate);
      if (!salary) continue;
      const year = pd.payDate.slice(0, 4);
      const ytd = [...mine, ...runs.filter(r => r.employeeId === id)]
        .filter(r => r.period.payDate.startsWith(year) && r.period.payDate < pd.payDate)
        .reduce((a, r) => a.add(D(r.gross)), Dec.ZERO).toMoney();
      const input: PayRunInput = {
        employer,
        employee: { ...p.input, id, name: p.input.name ?? id } as PayRunInput["employee"],
        period: { frequency: p.frequency, start: pd.start, end: pd.end, payDate: pd.payDate },
        earnings: [{ code: "salary", amount: salary }],
        ytd: { ssWages: ytd, medicareWages: ytd, futaWages: ytd, caUiWages: ytd, caSdiWages: ytd },
      };
      try { runs.push({ ...runPayRun(input, rules, { allowDraft: true }), projected: true }); }
      catch (e) { errors.push({ payDate: pd.payDate, employee: id, error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  return { runs, errors };
}

