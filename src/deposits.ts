/**
 * Payroll-tax deposit schedule for a monthly federal depositor in California.
 *
 * Federal (Pub 15 2026): 941 taxes (FIT + both halves of social security and Medicare + Additional
 * Medicare) for wages PAID in a month are due by the 15th of the following month. FUTA is deposited
 * when the undeposited amount is over $500 at a quarter end (by the last day of the next month);
 * otherwise it carries forward and the remainder is paid with Form 940 by January 31.
 * EFTPS: the deposit must be submitted by 8 p.m. Eastern the day before the due date; business
 * payments can be scheduled up to 120 days ahead.
 *
 * California (DE 44 2026, p.68): PIT + SDI deposits for a federal monthly depositor are due by the
 * 15th of the following month once $350+ of PIT is accumulated, otherwise quarterly. This module
 * supports "monthly" (deposit every month; early is always allowed) and "minimum". UI + ETT are due
 * quarterly with the DE 9 (last day of the month after the quarter). EDD e-Services ACH debits can
 * be scheduled up to 90 days ahead and cancelled until 3 p.m. PT the day before settlement.
 *
 * Amounts are grouped by PAY DATE (cash basis), which is what both agencies use.
 */
import { addDays, lastDayOfMonth, onOrNextBusinessDay, type Jurisdiction } from "./calendar.js";
import { D, Dec } from "./money.js";
import type { PayRunResult } from "./types.js";
import { assertBalanced, type AccountId, type AccountMap, type Journal, type JournalLine } from "./journal.js";

export type Agency = "IRS" | "EDD";
export type DepositKind = "941" | "FUTA" | "PIT+SDI" | "UI+ETT";

export interface Deposit {
  id: string;                      // stable: "IRS-941-2027-01", "EDD-UI+ETT-2027-Q1", ...
  agency: Agency;
  kind: DepositKind;
  period: string;                  // "2027-01" (month) or "2027-Q1" (quarter) or "2027" (FUTA with 940)
  amount: string;
  dueDate: string;
  /** Last day to submit/schedule: EFTPS by 8 p.m. ET the day before; EDD: cancel/settle by the day before (conservative). */
  scheduleBy: string;
  /** First day the payment can be scheduled (EFTPS 120 days, EDD 90 days before settlement). */
  scheduleFrom: string;
  payDates: string[];
  projected: boolean;              // true if any contributing pay run is a projection
  note?: string;
  /** FUTA with Form 940: the state credit-reduction part. It is never accrued per paycheck, so it is expensed when paid. */
  creditReduction?: string;
}

export interface DepositOptions {
  from: string;                    // first pay date this schedule is responsible for (e.g. "2027-01-01")
  to: string;                      // last pay date
  caSchedule?: "monthly" | "minimum";
  /** FUTA credit-reduction rate for the state and year, once DOL publishes it (November). */
  futaCreditReductionRate?: string;
  futaWageBase?: string;           // default "7000"
}

export interface PayRun extends PayRunResult { projected?: boolean }

const FED = new Set(["fit", "ss_ee", "ss_er", "medicare_ee", "medicare_er", "addl_medicare_ee"]);
const WINDOW: Record<Agency, number> = { IRS: 120, EDD: 90 };
const J: Record<Agency, Jurisdiction> = { IRS: "US", EDD: "US-CA" };

const sum = (runs: PayRun[], codes: Set<string>, f: "amount" | "taxableWages" = "amount") =>
  runs.flatMap(r => r.taxes).filter(t => codes.has(t.code)).reduce((a, t) => a.add(D(t[f])), Dec.ZERO);
const ym = (d: string) => d.slice(0, 7);
const quarterOf = (d: string) => Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
const nextMonth15 = (period: string) => { const [y, m] = period.split("-").map(Number); return m === 12 ? `${y! + 1}-01-15` : `${y}-${String(m! + 1).padStart(2, "0")}-15`; };
const afterQuarterEnd = (y: number, q: number) => q === 4 ? lastDayOfMonth(y + 1, 1) : lastDayOfMonth(y, q * 3 + 1);

function make(agency: Agency, kind: DepositKind, period: string, amount: Dec, rawDue: string, runs: PayRun[], note?: string): Deposit {
  const dueDate = onOrNextBusinessDay(rawDue, J[agency]);
  return {
    id: `${agency}-${kind}-${period}`, agency, kind, period, amount: amount.toMoney(), dueDate,
    scheduleBy: addDays(dueDate, -1), scheduleFrom: addDays(dueDate, -WINDOW[agency]),
    payDates: [...new Set(runs.map(r => r.period.payDate))].sort(), projected: runs.some(r => r.projected), ...(note ? { note } : {}),
  };
}

export function computeDeposits(all: PayRun[], o: DepositOptions): Deposit[] {
  const runs = all.filter(r => r.period.payDate >= o.from && r.period.payDate <= o.to);
  const out: Deposit[] = [];
  const months = [...new Set(runs.map(r => ym(r.period.payDate)))].sort();

  // Federal 941, monthly
  for (const m of months) {
    const rs = runs.filter(r => ym(r.period.payDate) === m);
    const amt = sum(rs, FED);
    if (amt.gt(Dec.ZERO)) out.push(make("IRS", "941", m, amt, nextMonth15(m), rs));
  }

  // California PIT + SDI
  const PITSDI = new Set(["ca_pit", "ca_sdi"]);
  if ((o.caSchedule ?? "monthly") === "monthly") {
    for (const m of months) {
      const rs = runs.filter(r => ym(r.period.payDate) === m);
      const amt = sum(rs, PITSDI);
      if (amt.gt(Dec.ZERO)) out.push(make("EDD", "PIT+SDI", m, amt, nextMonth15(m), rs));
    }
  } else {
    // Minimum (DE 44 p.68): when accumulated undeposited PIT reaches $350 in a month, deposit everything
    // accumulated by the 15th of the next month; whatever is left at quarter end goes with the quarterly.
    const quarters = [...new Set(runs.map(r => `${r.period.payDate.slice(0, 4)}-Q${quarterOf(r.period.payDate)}`))].sort();
    for (const qk of quarters) {
      const [y, q] = [Number(qk.slice(0, 4)), Number(qk.slice(6))];
      let pending: PayRun[] = [];
      for (let k = 1; k <= 3; k++) {
        const m = `${y}-${String((q - 1) * 3 + k).padStart(2, "0")}`;
        pending = pending.concat(runs.filter(r => ym(r.period.payDate) === m));
        const pit = sum(pending, new Set(["ca_pit"]));
        if (k < 3 && pit.gte("350")) { out.push(make("EDD", "PIT+SDI", m, sum(pending, PITSDI), nextMonth15(m), pending)); pending = []; }
      }
      if (pending.length && sum(pending, PITSDI).gt(Dec.ZERO)) {
        const last = `${y}-${String(q * 3).padStart(2, "0")}`;
        const pit = sum(pending, new Set(["ca_pit"]));
        // Month 3 at $350+ is due the 15th (earlier than the quarterly date); otherwise with the quarterly.
        out.push(pit.gte("350")
          ? make("EDD", "PIT+SDI", last, sum(pending, PITSDI), nextMonth15(last), pending)
          : make("EDD", "PIT+SDI", `${y}-Q${q}`, sum(pending, PITSDI), afterQuarterEnd(y, q), pending, "under $350 accumulated: quarterly"));
      }
    }
  }

  // California UI + ETT, quarterly
  const UIETT = new Set(["ca_ui", "ca_ett"]);
  for (const qk of [...new Set(runs.map(r => `${r.period.payDate.slice(0, 4)}-Q${quarterOf(r.period.payDate)}`))].sort()) {
    const [y, q] = [Number(qk.slice(0, 4)), Number(qk.slice(6))];
    const rs = runs.filter(r => `${r.period.payDate.slice(0, 4)}-Q${quarterOf(r.period.payDate)}` === qk);
    const amt = sum(rs, UIETT);
    if (amt.gt(Dec.ZERO)) out.push(make("EDD", "UI+ETT", qk, amt, afterQuarterEnd(y, q), rs, "due with the DE 9"));
  }

  // FUTA: deposit at a quarter end once the undeposited amount is over $500; the rest goes with Form 940.
  const years = [...new Set(runs.map(r => Number(r.period.payDate.slice(0, 4))))].sort();
  for (const y of years) {
    let carried = Dec.ZERO; let carriedRuns: PayRun[] = [];
    for (let q = 1; q <= 4; q++) {
      const rs = runs.filter(r => Number(r.period.payDate.slice(0, 4)) === y && quarterOf(r.period.payDate) === q);
      carried = carried.add(sum(rs, new Set(["futa"]))); carriedRuns = carriedRuns.concat(rs);
      if (q < 4 && carried.gt("500")) { out.push(make("IRS", "FUTA", `${y}-Q${q}`, carried, afterQuarterEnd(y, q), carriedRuns)); carried = Dec.ZERO; carriedRuns = []; }
    }
    let cr = Dec.ZERO; let note = "pay with Form 940";
    if (o.futaCreditReductionRate) {
      cr = sum(runs.filter(r => Number(r.period.payDate.slice(0, 4)) === y), new Set(["futa"]), "taxableWages").mul(o.futaCreditReductionRate).round(2);
      note += `; includes credit reduction ${cr.toMoney()} at ${o.futaCreditReductionRate}`;
    } else note += "; state credit reduction (if any) not included until DOL publishes the rate in November";
    const total = carried.add(cr);
    if (total.gt(Dec.ZERO)) {
      const d = make("IRS", "FUTA", String(y), total, lastDayOfMonth(y + 1, 1), carriedRuns, note);
      if (cr.gt(Dec.ZERO)) d.creditReduction = cr.toMoney();
      out.push(d);
    }
  }

  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- scheduling batches

export interface Batch {
  id: string;                      // "2027-Q1": the quarter whose wages the payments cover
  sendOn: string;                  // when to email "schedule these"
  deposits: Deposit[];
  /** Deposits that can't be scheduled yet on sendOn (outside the agency's window). */
  later: Deposit[];
}

/**
 * One batch per quarter of wages. It's sent on the first day every payment in it can be scheduled,
 * but never later than 3 days before the earliest "schedule by" date; anything still outside its
 * window on that day is listed separately and gets its own reminder.
 */
export function planBatches(deposits: Deposit[]): Batch[] {
  const key = (d: Deposit) => d.period.includes("-Q") ? d.period : d.period.length === 4 ? `${d.period}-Q4` : `${d.period.slice(0, 4)}-Q${quarterOf(`${d.period}-01`)}`;
  const groups = new Map<string, Deposit[]>();
  for (const d of deposits) groups.set(key(d), [...(groups.get(key(d)) ?? []), d]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, ds]) => {
    const allOpen = ds.map(d => d.scheduleFrom).sort().at(-1)!;
    const cap = addDays(ds.map(d => d.scheduleBy).sort()[0]!, -3);
    const sendOn = allOpen <= cap ? allOpen : cap;
    return { id, sendOn, deposits: ds.filter(d => d.scheduleFrom <= sendOn), later: ds.filter(d => d.scheduleFrom > sendOn) };
  });
}

/** Tax codes each deposit pays (the same groups the amounts above are summed from). */
const DEPOSIT_CODES: Record<DepositKind, string[]> = {
  "941": [...FED], "FUTA": ["futa"], "PIT+SDI": ["ca_pit", "ca_sdi"], "UI+ETT": ["ca_ui", "ca_ett"],
};

/**
 * Ledger entry for a tax deposit actually scheduled: Dr the liability the paychecks accrued it to / Cr the bank, dated
 * the settlement (due) date so the bank-feed debit finds it. `amount` is what was scheduled, not the computed amount.
 * A FUTA credit reduction was never accrued, so that part is Dr employer tax expense instead.
 */
export function depositJournal(d: Deposit, amount: string, accounts: AccountMap, paidFrom: AccountId): Journal {
  const accts = [...new Set(DEPOSIT_CODES[d.kind].map(c => accounts.liabilities[c]).filter(a => a !== undefined))];
  if (accts.length !== 1) throw new Error(`${d.id}: its tax codes map to ${accts.length ? "several liability accounts (" + accts.join(", ") + ")" : "no liability account"}; one deposit must clear one account`);
  const total = D(amount), cr = D(d.creditReduction ?? "0");
  if (!total.gt(Dec.ZERO) || cr.gt(total)) throw new Error(`${d.id}: bad amount ${amount}`);
  const lines: JournalLine[] = [{ account: accts[0]!, debit: total.sub(cr).toMoney(), credit: "0.00", memo: `${d.agency} ${d.kind} ${d.period}` }];
  if (cr.gt(Dec.ZERO)) lines.push({ account: accounts.employerTaxExpense, debit: cr.toMoney(), credit: "0.00", memo: "FUTA credit reduction" });
  lines.push({ account: paidFrom, debit: "0.00", credit: total.toMoney(), memo: `${d.agency === "IRS" ? "EFTPS" : "EDD"} payment` });
  const j: Journal = { date: d.dueDate, reference: `TX-${d.id}`, description: `${d.agency} ${d.kind} deposit for ${d.period}`,
    lines: lines.filter(l => l.debit !== "0.00" || l.credit !== "0.00") };
  assertBalanced(j);
  return j;
}
