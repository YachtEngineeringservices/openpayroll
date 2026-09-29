/**
 * Shadow-mode comparison against an external payroll provider's statements
 * (QuickBooks / Intuit first). A "Statement" is the provider's pay stub,
 * normalized to openpayroll tax codes.
 */
import { Dec, D } from "./money.js";
import type { PayRunInput, PayRunResult, Frequency } from "./types.js";

export interface StatementLine { code: string; label: string; amount: string; taxableWages?: string }
export interface Statement {
  source: "quickbooks" | "manual" | string;
  /** "adjustment" = provider correction check (e.g. QuickBooks re-rating UI); not recomputed, but counted in quarter totals. */
  kind?: "regular" | "adjustment";
  id: string;                    // provider's paycheck id
  employeeId: string;            // provider's employee id
  employeeName: string;
  period: { start: string; end: string; payDate: string };
  gross: string;
  grossYtd?: string;             // provider's YTD gross INCLUDING this check
  net: string;
  lines: StatementLine[];
  unmapped: string[];            // provider tax names we could not map
}

/** Intuit "statutory_type" -> openpayroll code. Extend as new names appear. */
export const QBO_TAX_MAP: Record<string, string> = {
  "Federal Income Tax": "fit",
  "Social Security": "ss_ee",
  "Medicare": "medicare_ee",
  "Additional Medicare": "addl_medicare_ee",
  "Medicare Additional": "addl_medicare_ee",
  "Social Security Employer": "ss_er",
  "Medicare Employer": "medicare_er",
  "FUTA Employer": "futa",
  "CA Income Tax": "ca_pit",
  "CA State Disability Ins": "ca_sdi",
  "CA SUI Employer": "ca_ui",
  "CA ETT": "ca_ett",
};

interface QboAmount { current_amount: string | number; current_taxable_income?: string | number }
interface QboTax { statutory_type: string; accumulation_amount: QboAmount }
/** Shape returned by Intuit's payslip list + payslip details (merged by the exporter). */
export interface QboPayslip {
  id: string;
  employee: { id: string; first_name: string; last_name: string };
  pay_period: { begin_date: string; end_date: string };
  pay_date: string;
  payslip_type?: string;
  gross_pay: { current_amount: string | number; year_to_date_amount?: string | number };
  net_pay: string | number;
  employee_taxes: QboTax[];
  employer_taxes: QboTax[];
  deductions?: unknown[];
}

const s = (v: string | number | undefined) => (v === undefined ? undefined : typeof v === "number" ? Dec.of(String(v)).toMoney() : D(v).toMoney());

export function fromQuickBooks(p: QboPayslip): Statement {
  const unmapped: string[] = [];
  const lines: StatementLine[] = [];
  for (const t of [...(p.employee_taxes ?? []), ...(p.employer_taxes ?? [])]) {
    const code = QBO_TAX_MAP[t.statutory_type];
    if (!code) { unmapped.push(t.statutory_type); continue; }
    lines.push({ code, label: t.statutory_type, amount: s(t.accumulation_amount.current_amount)!, taxableWages: s(t.accumulation_amount.current_taxable_income) });
  }
  if ((p.deductions ?? []).length) unmapped.push("deductions (pre/post-tax) present: not compared yet");
  return {
    source: "quickbooks", kind: p.payslip_type === "ADJUSTMENT" ? "adjustment" : "regular", id: p.id, employeeId: p.employee.id,
    employeeName: `${p.employee.first_name} ${p.employee.last_name}`.trim(),
    period: { start: p.pay_period.begin_date, end: p.pay_period.end_date, payDate: p.pay_date },
    gross: s(p.gross_pay.current_amount)!, grossYtd: s(p.gross_pay.year_to_date_amount), net: s(p.net_pay)!,
    lines, unmapped,
  };
}

export interface CompareRow { code: string; engine: string | null; provider: string | null; diff: string; status: "match" | "mismatch" | "engine-only" | "provider-only" }
export interface Comparison {
  statementId: string; employeeId: string; payDate: string;
  rows: CompareRow[];
  matches: boolean;
  summary: string;
  notes: string[];
}

/**
 * Compare amounts line by line. Zero-dollar lines on either side count as present
 * (QuickBooks lists FUTA/UI at $0 after the wage base; the engine may omit zero lines).
 */
export function compare(result: PayRunResult, st: Statement, tolerance = "0.00"): Comparison {
  const tol = D(tolerance);
  const eng = new Map(result.taxes.map(t => [t.code, t.amount] as const));
  const prv = new Map(st.lines.map(l => [l.code, l.amount] as const));
  eng.set("gross", result.gross); prv.set("gross", st.gross);
  eng.set("net", result.netPay); prv.set("net", st.net);
  const codes = [...new Set([...eng.keys(), ...prv.keys()])];
  const order = ["gross", "fit", "ss_ee", "medicare_ee", "addl_medicare_ee", "ca_pit", "ca_sdi", "net", "ss_er", "medicare_er", "futa", "ca_ui", "ca_ett"];
  codes.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const rows: CompareRow[] = codes.map(code => {
    const e = eng.get(code) ?? null; const p = prv.get(code) ?? null;
    const ev = D(e ?? "0"), pv = D(p ?? "0");
    const diff = ev.sub(pv);
    const within = (diff.isNeg() ? diff.neg() : diff).lte(tol);
    let status: CompareRow["status"];
    if (e === null && p !== null) status = pv.isZero() ? "match" : "provider-only";
    else if (p === null && e !== null) status = ev.isZero() ? "match" : "engine-only";
    else status = within ? "match" : "mismatch";
    return { code, engine: e, provider: p, diff: diff.toMoney(), status };
  });
  const bad = rows.filter(r => r.status !== "match");
  const notes = [...st.unmapped.map(u => `provider line not mapped: ${u}`), ...result.warnings];
  return {
    statementId: st.id, employeeId: st.employeeId, payDate: st.period.payDate, rows,
    matches: bad.length === 0,
    summary: bad.length === 0 ? "all lines match" : bad.map(r => `${r.code} ${r.status} (${r.diff})`).join("; "),
    notes,
  };
}

/** Employee profile the engine needs but provider statements don't carry. */
export interface EmployeeProfile {
  providerEmployeeId: string;
  input: Omit<PayRunInput["employee"], "id" | "name"> & { id?: string; name?: string };
  frequency: Frequency;
}

/**
 * Build the engine input for one statement. YTD taxable wages before this check are
 * derived from the provider's YTD gross (valid when there are no pre-tax deductions;
 * otherwise sum prior statements' taxable wages instead).
 */
export function inputFromStatement(st: Statement, profile: EmployeeProfile, employer: PayRunInput["employer"], prior?: Statement[]): PayRunInput {
  let ytdBefore: Dec;
  if (st.grossYtd !== undefined) ytdBefore = D(st.grossYtd).sub(D(st.gross));
  else if (prior) ytdBefore = prior.filter(p => p.kind !== "adjustment" && p.employeeId === st.employeeId && p.period.payDate < st.period.payDate && p.period.payDate.slice(0, 4) === st.period.payDate.slice(0, 4))
    .reduce((a, p) => a.add(D(p.gross)), Dec.ZERO);
  else throw new Error(`statement ${st.id}: no YTD gross and no prior statements to derive YTD`);
  const y = ytdBefore.toMoney();
  return {
    employer,
    employee: { ...profile.input, id: profile.input.id ?? st.employeeId, name: profile.input.name ?? st.employeeName } as PayRunInput["employee"],
    period: { frequency: profile.frequency, start: st.period.start, end: st.period.end, payDate: st.period.payDate },
    earnings: [{ code: "gross", amount: st.gross }],
    ytd: { ssWages: y, medicareWages: y, futaWages: y, caUiWages: y, caSdiWages: y },
  };
}

export interface QuarterRecon {
  year: number; quarter: number;
  rows: { code: string; provider: string; engine: string; diff: string }[];
  providerAdjustments: number;
  uncomputed: number;
}

/**
 * Quarter totals: provider regular checks + provider adjustments vs engine.
 * This is the level the 941 and DE 9 are filed at, so provider corrections net out here.
 */
export function reconcileQuarters(items: { st: Statement; result?: PayRunResult }[]): QuarterRecon[] {
  const byQ = new Map<string, { st: Statement; result?: PayRunResult }[]>();
  for (const it of items) {
    const d = it.st.period.payDate; const key = `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
    byQ.set(key, [...(byQ.get(key) ?? []), it]);
  }
  return [...byQ.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([key, list]) => {
    const prov = new Map<string, Dec>(); const eng = new Map<string, Dec>();
    const add = (m: Map<string, Dec>, k: string, v: string) => m.set(k, (m.get(k) ?? Dec.ZERO).add(D(v)));
    for (const { st, result } of list) {
      for (const l of st.lines) add(prov, l.code, l.amount);
      if (result) for (const t of result.taxes) add(eng, t.code, t.amount);
    }
    const codes = [...new Set([...prov.keys(), ...eng.keys()])];
    return {
      year: Number(key.slice(0, 4)), quarter: Number(key.slice(-1)),
      rows: codes.map(code => { const p = prov.get(code) ?? Dec.ZERO, e = eng.get(code) ?? Dec.ZERO;
        return { code, provider: p.toMoney(), engine: e.toMoney(), diff: e.sub(p).toMoney() }; }),
      providerAdjustments: list.filter(x => x.st.kind === "adjustment").length,
      uncomputed: list.filter(x => x.st.kind !== "adjustment" && !x.result).length,
    };
  });
}
