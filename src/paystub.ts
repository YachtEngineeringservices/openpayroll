/**
 * California itemized wage statements (pay stubs), Labor Code 226(a), plus the paid sick leave
 * balance required by Labor Code 246(i) ("on either the employee's itemized wage statement ... or in
 * a separate writing provided on the designated pay date").
 *
 * 226(a) items: (1) gross wages earned, (2) total hours worked, except as provided in (j),
 * (3) piece-rate units and rates if paid by piece rate, (4) all deductions, (5) net wages earned,
 * (6) inclusive dates of the pay period, (7) employee name and only the last four digits of the SSN
 * or an employee identification number other than the SSN, (8) name and address of the legal entity
 * that is the employer, (9) all applicable hourly rates and hours worked at each rate.
 * 226(j)(1): hours may be omitted when compensation is solely salary and the employee is exempt from
 * overtime (e.g. executive/administrative/professional, which requires a salary of at least twice the
 * state minimum wage for full-time work).
 * A copy of each statement must be kept for at least three years (226(a)).
 */
import { D, Dec } from "./money.js";
import { PAGE_H, PAGE_W, renderPdf, type Page } from "./pdf.js";
import type { PayRunRecord } from "./payrun.js";
import type { PayRunResult } from "./types.js";

export interface EmployerInfo { legalName: string; address: string[] }          // address lines

/**
 * California statewide minimum wage by year (DIR): 2026 $16.90 (dir.ca.gov/dlse/faq_minimumwage.htm),
 * 2027 $17.40 (DIR news release 2026-66, certified by the Department of Finance 2026-07-31).
 * The executive/administrative/professional exemption needs a monthly salary of at least twice the state
 * minimum wage for full-time employment, i.e. 2 x minimum wage x 2080 hours a year.
 */
export const CA_MIN_WAGE: Record<number, string> = { 2026: "16.90", 2027: "17.40" };
export const exemptSalaryFloor = (year: number) => CA_MIN_WAGE[year] ? D(CA_MIN_WAGE[year]!).mul("2").mul("2080").toMoney() : undefined;
export interface StubEmployee {
  employeeId: string;             // shown on the stub (226(a)(7)); never an SSN
  name: string;
  exemptFromOvertime: boolean;    // 226(j)(1): salaried + exempt -> hours not required
  hoursPerPeriod?: string;        // required when not exempt (salaried non-exempt: regular hours per period)
  annualSalary?: string;          // to check an "exempt" salary against the state floor
}
export interface SickLeave { frontloadHours: string; usedThisPeriod: string; usedYtdBefore: string }

export interface StubLine { label: string; hours?: string; rate?: string; current: string; ytd: string }
export interface Stub {
  employer: EmployerInfo;
  employee: StubEmployee;
  payDate: string; periodStart: string; periodEnd: string;
  earnings: StubLine[];
  deductions: StubLine[];          // employee taxes and any other deductions
  gross: { current: string; ytd: string };
  net: { current: string; ytd: string };
  hoursNote?: string;              // why hours are not shown (226(j))
  employerTaxes: StubLine[];       // informational
  sickLeaveAvailable: string;      // hours, after this pay period
  draft: boolean;
}

const EMPLOYEE_TAX_LABELS: Record<string, string> = {
  fit: "Federal income tax", ss_ee: "Social Security", medicare_ee: "Medicare", addl_medicare_ee: "Additional Medicare",
  ca_pit: "California income tax (PIT)", ca_sdi: "California SDI",
};
const EMPLOYER_TAX_LABELS: Record<string, string> = {
  ss_er: "Social Security (employer)", medicare_er: "Medicare (employer)", futa: "Federal unemployment (FUTA)",
  ca_ui: "California UI", ca_ett: "California ETT",
};

const sumCode = (rs: PayRunResult[], code: string) => rs.flatMap(r => r.taxes).filter(t => t.code === code).reduce((a, t) => a.add(D(t.amount)), Dec.ZERO);

/**
 * Build the stub for one employee in one run. `ytdRuns` = the employee's approved results earlier in the
 * same year (not including this one).
 */
export function buildStub(run: PayRunRecord, employeeId: string, ytdRuns: PayRunResult[], employer: EmployerInfo,
  emp: Omit<StubEmployee, "name" | "employeeId"> & { employeeNumber?: string }, sick: SickLeave): Stub {
  const pc = run.paychecks.find(p => p.employeeId === employeeId);
  if (!pc) throw new Error(`no paycheck for ${employeeId} in pay run ${run.id}`);
  const r = pc.result, all = [...ytdRuns, r];
  const ytd = (f: (x: PayRunResult) => string) => all.reduce((a, x) => a.add(D(f(x))), Dec.ZERO).toMoney();
  const hours = emp.exemptFromOvertime ? undefined : emp.hoursPerPeriod;
  if (!emp.exemptFromOvertime && !hours) throw new Error(`${pc.name} is not exempt from overtime: set hoursPerPeriod so the stub can show hours and the rate (226(a)(2),(9))`);
  const rate = hours ? D(r.gross).div(D(hours)).toMoney() : undefined;
  const lines = (labels: Record<string, string>) => Object.entries(labels)
    .map(([code, label]) => ({ label, current: sumCode([r], code).toMoney(), ytd: sumCode(all, code).toMoney() }))
    .filter(l => l.current !== "0.00" || l.ytd !== "0.00");
  const avail = D(sick.frontloadHours).sub(D(sick.usedYtdBefore)).sub(D(sick.usedThisPeriod));
  return {
    employer, employee: { exemptFromOvertime: emp.exemptFromOvertime, hoursPerPeriod: emp.hoursPerPeriod, annualSalary: emp.annualSalary, employeeId: emp.employeeNumber ?? employeeId, name: pc.name },
    payDate: run.payDate, periodStart: run.period.start, periodEnd: run.period.end,
    earnings: [{ label: emp.exemptFromOvertime ? "Salary" : "Regular", hours, rate, current: D(r.gross).toMoney(), ytd: ytd(x => x.gross) }],
    deductions: lines(EMPLOYEE_TAX_LABELS),
    gross: { current: D(r.gross).toMoney(), ytd: ytd(x => x.gross) },
    net: { current: D(r.netPay).toMoney(), ytd: ytd(x => x.netPay) },
    ...(emp.exemptFromOvertime ? { hoursNote: "Salaried, exempt from overtime: hours not shown (Labor Code 226(j))." } : {}),
    employerTaxes: lines(EMPLOYER_TAX_LABELS),
    sickLeaveAvailable: (avail.isNeg() ? Dec.ZERO : avail).toMoney(),
    draft: run.status !== "approved",
  };
}

/** The 226(a) / 246(i) checklist. Returns what's missing (empty = compliant for this employer's pay types). */
export function check226(s: Stub): string[] {
  const miss: string[] = [];
  if (!s.gross.current) miss.push("(1) gross wages earned");
  if (!s.employee.exemptFromOvertime && !s.earnings.every(e => e.hours)) miss.push("(2) total hours worked");
  if (!s.employee.exemptFromOvertime && !s.earnings.every(e => e.rate && e.hours)) miss.push("(9) hourly rates and hours at each rate");
  if (!s.deductions.length) miss.push("(4) deductions");
  if (!s.net.current) miss.push("(5) net wages earned");
  if (!s.periodStart || !s.periodEnd) miss.push("(6) inclusive dates of the pay period");
  if (!s.employee.name || !s.employee.employeeId) miss.push("(7) employee name and ID");
  if (/^\d{9}$|^\d{3}-\d{2}-\d{4}$/.test(s.employee.employeeId.replace(/\s/g, ""))) miss.push("(7) employee ID looks like an SSN: use another identifier");
  if (!s.employer.legalName || !s.employer.address.length) miss.push("(8) employer legal name and address");
  if (s.employee.exemptFromOvertime) {
    const y = Number(s.payDate.slice(0, 4)), floor = exemptSalaryFloor(y);
    if (!floor) miss.push(`exempt status: no ${y} California minimum wage on file to check the exempt salary floor`);
    else if (!s.employee.annualSalary) miss.push("exempt status: annual salary unknown, can't check the exempt salary floor");
    else if (D(s.employee.annualSalary).lt(floor)) miss.push(`exempt status: salary ${s.employee.annualSalary}/yr is below the ${y} floor ${floor} (2 x minimum wage x 2080); hours must be shown (226(a)(2)) and overtime applies`);
  }
  if (s.sickLeaveAvailable === undefined) miss.push("246(i) paid sick leave available");
  return miss;
}

const usd = (v: string) => { const [i, f] = D(v).toMoney().split("."); const neg = i!.startsWith("-"); const g = i!.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ","); return `${neg ? "-" : ""}${g}.${f}`; };
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** Lay out one stub as a one-page PDF. */
export function stubPdf(s: Stub, generated = new Date()): Buffer {
  const p: Page = { texts: [], lines: [] };
  const T = (x: number, y: number, text: string, o: Partial<Page["texts"][number]> = {}) => p.texts.push({ x, y, text, ...o });
  const L = (y: number, w = 0.5, x1 = 40, x2 = PAGE_W - 40, gray = 0) => p.lines.push({ x1, y1: y, x2, y2: y, width: w, gray });
  let y = PAGE_H - 50;
  T(40, y, s.employer.legalName, { size: 13, bold: true });
  T(PAGE_W - 40, y, "Earnings Statement", { size: 13, bold: true, align: "right" });
  s.employer.address.forEach((a, i) => T(40, y - 15 - i * 11, a));
  T(PAGE_W - 40, y - 15, `Pay date: ${mdy(s.payDate)}`, { align: "right" });
  T(PAGE_W - 40, y - 26, `Pay period: ${mdy(s.periodStart)} - ${mdy(s.periodEnd)}`, { align: "right" });
  if (s.draft) T(PAGE_W / 2, y - 48 - s.employer.address.length * 11, "DRAFT - NOT A FINAL STATEMENT", { size: 11, bold: true, align: "center", gray: 0.4 });
  y -= 30 + s.employer.address.length * 11 + (s.draft ? 16 : 0);
  L(y); y -= 16;
  T(40, y, "Employee", { bold: true }); T(120, y, s.employee.name);
  T(330, y, "Employee ID", { bold: true }); T(400, y, s.employee.employeeId);
  y -= 22;

  const cols = { label: 40, hours: 290, rate: 360, cur: 470, ytd: PAGE_W - 40 };
  const table = (title: string, rows: { label: string; hours?: string; rate?: string; current: string; ytd: string }[], showHours: boolean) => {
    T(cols.label, y, title, { bold: true });
    if (showHours) { T(cols.hours, y, "Hours", { bold: true, align: "right" }); T(cols.rate, y, "Rate", { bold: true, align: "right" }); }
    T(cols.cur, y, "This period", { bold: true, align: "right" }); T(cols.ytd, y, "Year to date", { bold: true, align: "right" });
    y -= 4; L(y, 0.3, 40, PAGE_W - 40, 0.5); y -= 12;
    for (const r of rows) {
      T(cols.label, y, r.label);
      if (showHours) { T(cols.hours, y, r.hours ?? "", { align: "right" }); T(cols.rate, y, r.rate ?? "", { align: "right" }); }
      T(cols.cur, y, usd(r.current), { align: "right" }); T(cols.ytd, y, usd(r.ytd), { align: "right" });
      y -= 13;
    }
    y -= 8;
  };
  const showHours = !s.employee.exemptFromOvertime;
  table("Earnings", s.earnings, showHours);
  T(cols.label, y + 4, "Gross wages", { bold: true }); T(cols.cur, y + 4, usd(s.gross.current), { bold: true, align: "right" }); T(cols.ytd, y + 4, usd(s.gross.ytd), { bold: true, align: "right" });
  y -= 18;
  if (s.hoursNote) { T(cols.label, y + 8, s.hoursNote, { size: 7.5, gray: 0.35 }); y -= 6; }
  table("Deductions (taxes withheld)", s.deductions, false);
  const dedCur = s.deductions.reduce((a, d) => a.add(D(d.current)), Dec.ZERO).toMoney(), dedYtd = s.deductions.reduce((a, d) => a.add(D(d.ytd)), Dec.ZERO).toMoney();
  T(cols.label, y + 4, "Total deductions", { bold: true }); T(cols.cur, y + 4, usd(dedCur), { bold: true, align: "right" }); T(cols.ytd, y + 4, usd(dedYtd), { bold: true, align: "right" });
  y -= 14; L(y + 8, 1); y -= 6;
  T(cols.label, y, "Net pay", { size: 11, bold: true }); T(cols.cur, y, usd(s.net.current), { size: 11, bold: true, align: "right" }); T(cols.ytd, y, usd(s.net.ytd), { size: 11, bold: true, align: "right" });
  y -= 28;
  T(cols.label, y, "Paid sick leave available", { bold: true }); T(cols.cur, y, `${s.sickLeaveAvailable} hours`, { align: "right" });
  y -= 26;
  if (s.employerTaxes.length) { table("Employer taxes (paid by the employer, not deducted)", s.employerTaxes, false); }
  T(40, 40, `Generated ${generated.toISOString().slice(0, 10)} by openpayroll. Keep this statement for your records.`, { size: 7, gray: 0.4 });
  return renderPdf([p], `Earnings statement ${s.employee.name} ${s.payDate}`, generated);
}
