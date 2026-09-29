/**
 * Live pay runs (B1): one pay run = one pay date for every active salaried employee.
 *
 * Lifecycle: draft -> approved (locked) -> optionally voided. Drafts can be recomputed or deleted;
 * approved runs never change. YTD taxable wages carry from run to run through the engine's ytdAfter,
 * starting from any QuickBooks pay stubs imported for the same calendar year.
 *
 * Ordering keeps YTD consistent: a run can only be created or recomputed when no LATER run exists in
 * the same year, and approved only when no EARLIER run in that year is still a draft.
 *
 * Same inputs + same rules + same engine = same fingerprint = identical results (idempotent).
 */
import { createHash } from "node:crypto";
import type { EmployeeProfile, Statement } from "./compare.js";
import { ENGINE_VERSION, runPayRun } from "./engine.js";
import { assertBalanced, buildJournal, type AccountId, type AccountMap, type Journal, type JournalLine } from "./journal.js";
import { D, Dec } from "./money.js";
import { payDatesBetween, salaryOn, type PaySchedule, type ProjectableProfile } from "./project.js";
import type { RuleSet } from "./rules.js";
import type { PayRunInput, PayRunResult } from "./types.js";

export type RunStatus = "draft" | "approved" | "voided";

export interface Paycheck { employeeId: string; name: string; input: PayRunInput; result: PayRunResult; sickHoursUsed?: string }

export interface PostingState { journalNumber: string; status: "posting" | "posted"; bigcapitalId?: number; at: string }

export interface PayRunRecord {
  id: string;                          // the pay date, e.g. "2027-01-15"
  payDate: string;
  period: { start: string; end: string };
  status: RunStatus;
  createdAt: string;
  approvedAt?: string;
  voidedAt?: string;
  voidReason?: string;
  engineVersion: string;
  rulesUsed: PayRunResult["rulesUsed"];
  fingerprint: string;
  paychecks: Paycheck[];
  totals: { gross: string; employeeTaxes: string; employerTaxes: string; net: string };
  journals: { accrual: Journal; payment?: Journal } | null;
  bigcapital?: { accrual?: PostingState; payment?: PostingState };
}

/** Accounts for posting: AccountMap plus the bank that pays net pay (QBO's second "Payroll Check" entry). */
export interface PayrollAccounts extends AccountMap { netPayPaidFrom?: AccountId }

type Profile = EmployeeProfile & Pick<ProjectableProfile, "salaryPerPeriod" | "salaryChanges" | "active">;

const year = (d: string) => d.slice(0, 4);
const live = (r: PayRunRecord) => r.status !== "voided";
const idOf = (p: Profile) => p.input.id ?? p.providerEmployeeId;

type YtdKey = keyof PayRunInput["ytd"];
const KEYS: YtdKey[] = ["ssWages", "medicareWages", "futaWages", "caUiWages", "caSdiWages"];

/**
 * YTD subject wages before `payDate`: gross of imported QuickBooks stubs earlier in the same year
 * (no pre-tax deductions, as in inputFromStatement), plus what each earlier live pay run added.
 */
export function ytdBefore(employeeId: string, payDate: string, runs: PayRunRecord[], statements: Statement[] = [], providerId = employeeId): PayRunInput["ytd"] {
  const fromQbo = statements.filter(s => s.kind !== "adjustment" && s.employeeId === providerId && year(s.period.payDate) === year(payDate) && s.period.payDate < payDate)
    .reduce((a, s) => a.add(D(s.gross)), Dec.ZERO);
  const out = Object.fromEntries(KEYS.map(k => [k, fromQbo])) as Record<YtdKey, Dec>;
  for (const r of runs.filter(r => live(r) && year(r.payDate) === year(payDate) && r.payDate < payDate)) {
    const pc = r.paychecks.find(p => p.employeeId === employeeId);
    if (!pc) continue;
    for (const k of KEYS) out[k] = out[k].add(D(pc.result.ytdAfter[k]).sub(D(pc.input.ytd[k])));
  }
  return Object.fromEntries(KEYS.map(k => [k, out[k].toMoney()])) as PayRunInput["ytd"];
}

/** Combine per-employee journals into one entry, one line per account and side. */
export function combineJournals(js: Journal[], date: string, reference: string, description: string): Journal {
  const acc = new Map<string, { account: AccountId; side: "debit" | "credit"; amt: Dec; memos: Set<string> }>();
  for (const l of js.flatMap(j => j.lines)) {
    const side = D(l.debit).isZero() ? "credit" : "debit";
    const k = `${String(l.account)}|${side}`;
    const cur = acc.get(k) ?? { account: l.account, side, amt: Dec.ZERO, memos: new Set<string>() };
    cur.amt = cur.amt.add(D(side === "debit" ? l.debit : l.credit)); l.memo.split(", ").forEach(m => cur.memos.add(m));
    acc.set(k, cur);
  }
  const lines: JournalLine[] = [...acc.values()].sort((a, b) => (a.side === b.side ? 0 : a.side === "debit" ? -1 : 1))
    .map(v => ({ account: v.account, debit: v.side === "debit" ? v.amt.toMoney() : "0.00", credit: v.side === "credit" ? v.amt.toMoney() : "0.00", memo: [...v.memos].join(", ").slice(0, 250) }));
  const j = { date, reference, description, lines };
  assertBalanced(j);
  return j;
}

function fingerprint(paychecks: Paycheck[], rulesUsed: PayRunResult["rulesUsed"]): string {
  const payload = JSON.stringify({ engine: ENGINE_VERSION, rulesUsed, inputs: paychecks.map(p => p.input), sick: paychecks.map(p => p.sickHoursUsed ?? "0.00") });
  return createHash("sha256").update(payload).digest("hex");
}

export interface BuildOptions {
  payDate: string;
  schedule: PaySchedule;
  profiles: Profile[];
  employer: PayRunInput["employer"];
  rules: RuleSet;
  prior: PayRunRecord[];               // every saved run (any status)
  statements?: Statement[];            // imported QuickBooks stubs
  accounts?: PayrollAccounts;
  /** employeeId -> paid sick leave hours used this period (salaried: pay is unchanged; tracked for 246(i)). */
  sickHoursUsed?: Record<string, string>;
  now?: string;
}

/** Compute a pay run (not saved). Throws with a plain message if it can't be run. */
export function buildPayRun(o: BuildOptions): PayRunRecord {
  const [pd] = payDatesBetween(o.payDate, o.payDate, o.schedule);
  if (!pd) throw new Error(`${o.payDate} is not a scheduled pay date (pay days: ${o.schedule.payDays.join(", ")})`);
  const later = o.prior.filter(r => live(r) && r.id !== o.payDate && year(r.payDate) === year(o.payDate) && r.payDate > o.payDate);
  if (later.length) throw new Error(`a later pay run exists (${later.map(r => r.id).join(", ")}); void or delete it first so year-to-date totals stay in order`);
  const active = o.profiles.filter(p => p.active !== false && salaryOn(p, o.payDate));
  if (!active.length) throw new Error(`no active employees with a salary in effect on ${o.payDate} (salaryPerPeriod / salaryChanges)`);

  const paychecks: Paycheck[] = active.map(p => {
    const employeeId = idOf(p);
    const paidByQbo = (o.statements ?? []).find(s => s.employeeId === p.providerEmployeeId && s.kind !== "adjustment" && s.period.payDate === o.payDate);
    if (paidByQbo) throw new Error(`${p.input.name ?? employeeId} was already paid by QuickBooks on ${o.payDate}`);
    const input: PayRunInput = {
      employer: o.employer,
      employee: { ...p.input, id: employeeId, name: p.input.name ?? employeeId } as PayRunInput["employee"],
      period: { frequency: p.frequency, start: pd.start, end: pd.end, payDate: o.payDate },
      earnings: [{ code: "salary", amount: D(salaryOn(p, o.payDate)!).toMoney() }],
      ytd: ytdBefore(employeeId, o.payDate, o.prior.filter(r => r.id !== o.payDate), o.statements, p.providerEmployeeId),
    };
    const sick = o.sickHoursUsed?.[employeeId];
    if (sick !== undefined && !/^\d+(\.\d{1,2})?$/.test(sick)) throw new Error(`sick hours for ${employeeId} must be a number like 8 or 4.5`);
    return { employeeId, name: input.employee.name, input, result: runPayRun(input, o.rules, { allowDraft: true }),
      ...(sick && !D(sick).isZero() ? { sickHoursUsed: D(sick).toMoney() } : {}) };
  });

  const sum = (f: (r: PayRunResult) => string) => paychecks.reduce((a, p) => a.add(D(f(p.result))), Dec.ZERO).toMoney();
  const rulesUsed = paychecks[0]!.result.rulesUsed;
  let journals: PayRunRecord["journals"] = null;
  if (o.accounts) {
    const accrual = combineJournals(paychecks.map(p => buildJournal(p.result, o.accounts!)), o.payDate, `PR-${o.payDate}`,
      `Payroll ${pd.start} to ${pd.end}`);
    const net = D(sum(r => r.netPay));
    const payment = o.accounts.netPayPaidFrom !== undefined && net.gt(Dec.ZERO) ? {
      date: o.payDate, reference: `PR-${o.payDate}-NET`, description: `Net pay ${pd.start} to ${pd.end}`,
      lines: [{ account: o.accounts.netPay, debit: net.toMoney(), credit: "0.00", memo: "Net pay" },
              { account: o.accounts.netPayPaidFrom, debit: "0.00", credit: net.toMoney(), memo: "Net pay transfer" }],
    } : undefined;
    journals = { accrual, ...(payment ? { payment } : {}) };
  }
  return {
    id: o.payDate, payDate: o.payDate, period: { start: pd.start, end: pd.end }, status: "draft",
    createdAt: o.now ?? new Date().toISOString(), engineVersion: ENGINE_VERSION, rulesUsed,
    fingerprint: fingerprint(paychecks, rulesUsed), paychecks,
    totals: { gross: sum(r => r.gross), employeeTaxes: sum(r => r.employeeTaxTotal), employerTaxes: sum(r => r.employerTaxTotal), net: sum(r => r.netPay) },
    journals,
  };
}

/** Approve (lock) a draft. Refuses draft rule files unless explicitly allowed. */
export function approvePayRun(run: PayRunRecord, all: PayRunRecord[], o: { allowDraftRules?: boolean; now?: string } = {}): PayRunRecord {
  if (run.status !== "draft") throw new Error(`pay run ${run.id} is ${run.status}, not a draft`);
  const earlier = all.filter(r => r.status === "draft" && year(r.payDate) === year(run.payDate) && r.payDate < run.payDate);
  if (earlier.length) throw new Error(`approve the earlier pay run(s) first: ${earlier.map(r => r.id).join(", ")}`);
  const draftRules = run.rulesUsed.filter(r => r.status !== "verified");
  if (draftRules.length && !o.allowDraftRules)
    throw new Error(`computed with DRAFT rule files (${draftRules.map(r => `${r.jurisdiction} ${r.taxYear}`).join(", ")}); verify them against the agency PDFs first`);
  return { ...run, status: "approved", approvedAt: o.now ?? new Date().toISOString() };
}

export function voidPayRun(run: PayRunRecord, all: PayRunRecord[], reason: string, now?: string): PayRunRecord {
  if (run.status === "voided") throw new Error(`pay run ${run.id} is already voided`);
  if (!reason.trim()) throw new Error("a reason is required to void a pay run");
  const later = all.filter(r => live(r) && r.id !== run.id && year(r.payDate) === year(run.payDate) && r.payDate > run.payDate);
  if (later.length) throw new Error(`void the later pay run(s) first: ${later.map(r => r.id).join(", ")}`);
  return { ...run, status: "voided", voidedAt: now ?? new Date().toISOString(), voidReason: reason.trim() };
}

export interface YtdLine { employeeId: string; name: string; payRuns: number; gross: string; net: string; taxes: Record<string, { amount: string; taxableWages: string }> }

/** Year-to-date per employee from approved pay runs (drafts and voided runs excluded). */
export function ytdReport(runs: PayRunRecord[], y: string): YtdLine[] {
  const by = new Map<string, { name: string; n: number; gross: Dec; net: Dec; taxes: Map<string, { amt: Dec; wages: Dec }> }>();
  for (const r of runs.filter(r => r.status === "approved" && year(r.payDate) === y).sort((a, b) => a.payDate.localeCompare(b.payDate)))
    for (const p of r.paychecks) {
      const cur = by.get(p.employeeId) ?? { name: p.name, n: 0, gross: Dec.ZERO, net: Dec.ZERO, taxes: new Map() };
      cur.n++; cur.gross = cur.gross.add(D(p.result.gross)); cur.net = cur.net.add(D(p.result.netPay));
      for (const t of p.result.taxes) {
        const x = cur.taxes.get(t.code) ?? { amt: Dec.ZERO, wages: Dec.ZERO };
        x.amt = x.amt.add(D(t.amount)); x.wages = x.wages.add(D(t.taxableWages)); cur.taxes.set(t.code, x);
      }
      by.set(p.employeeId, cur);
    }
  return [...by.entries()].map(([employeeId, v]) => ({
    employeeId, name: v.name, payRuns: v.n, gross: v.gross.toMoney(), net: v.net.toMoney(),
    taxes: Object.fromEntries([...v.taxes.entries()].map(([c, x]) => [c, { amount: x.amt.toMoney(), taxableWages: x.wages.toMoney() }])),
  }));
}
