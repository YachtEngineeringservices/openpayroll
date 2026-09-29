import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, fromQuickBooks, inputFromStatement, reconcileQuarters, type QboPayslip, type Statement, type EmployeeProfile } from "../src/compare.js";
import { buildJournal, assertBalanced, type AccountMap } from "../src/journal.js";
import type { PayRunResult, TaxLine } from "../src/types.js";

const tax = (statutory_type: string, current_amount: string, current_taxable_income = "1000") =>
  ({ statutory_type, accumulation_amount: { current_amount, current_taxable_income } });

function slip(over: Partial<QboPayslip> = {}): QboPayslip {
  return {
    id: "P1", employee: { id: "E1", first_name: "Pat", last_name: "Doe" },
    pay_period: { begin_date: "2099-01-01", end_date: "2099-01-15" }, pay_date: "2099-01-15",
    payslip_type: "REGULAR",
    gross_pay: { current_amount: "1000", year_to_date_amount: "3000" }, net_pay: "900.50",
    employee_taxes: [tax("Federal Income Tax", "12.00"), tax("Social Security", "62"), tax("Medicare", "14.5"), tax("CA Income Tax", "0"), tax("CA State Disability Ins", "11")],
    employer_taxes: [tax("FUTA Employer", "0"), tax("Social Security Employer", "62"), tax("Medicare Employer", "14.5"), tax("CA ETT", "0"), tax("CA SUI Employer", "0")],
    deductions: [],
    ...over,
  };
}

function result(taxes: [string, string][], gross = "1000.00", net = "900.50", payDate = "2099-01-15"): PayRunResult {
  const er = new Set(["ss_er", "medicare_er", "futa", "ca_ui", "ca_ett"]);
  const lines: TaxLine[] = taxes.map(([code, amount]) => ({ code, label: code, payer: er.has(code) ? "employer" : "employee", taxableWages: gross, amount, ruleRefs: [] }) as TaxLine);
  return {
    engine: { name: "openpayroll", version: "test" }, rulesUsed: [], employeeId: "E1",
    period: { frequency: "semimonthly", start: payDate, end: payDate, payDate },
    gross, preTax: [], taxes: lines, employeeTaxTotal: "0.00", employerTaxTotal: "0.00", netPay: net,
    ytdAfter: { ssWages: "0", medicareWages: "0", futaWages: "0", caUiWages: "0", caSdiWages: "0" }, warnings: [],
  } as PayRunResult;
}

test("fromQuickBooks maps Intuit tax names, normalizes money, and sets kind", () => {
  const st = fromQuickBooks(slip());
  assert.equal(st.kind, "regular");
  assert.equal(st.employeeName, "Pat Doe");
  assert.equal(st.gross, "1000.00");
  assert.equal(st.grossYtd, "3000.00");
  assert.equal(st.lines.find(l => l.code === "fit")?.amount, "12.00");
  assert.equal(st.lines.find(l => l.code === "medicare_ee")?.amount, "14.50");
  assert.equal(st.lines.length, 10);
  assert.deepEqual(st.unmapped, []);
  assert.equal(fromQuickBooks(slip({ payslip_type: "ADJUSTMENT" })).kind, "adjustment");
});

test("fromQuickBooks reports unknown tax names and deductions instead of dropping them silently", () => {
  const st = fromQuickBooks(slip({ employee_taxes: [tax("NY Income Tax", "5")], employer_taxes: [], deductions: [{}] }));
  assert.deepEqual(st.lines, []);
  assert.equal(st.unmapped.length, 2);
  assert.match(st.unmapped[0]!, /NY Income Tax/);
});

test("compare: exact match, zero-dollar provider lines count as present", () => {
  const st = fromQuickBooks(slip());
  const r = result([["fit", "12.00"], ["ss_ee", "62.00"], ["medicare_ee", "14.50"], ["ca_sdi", "11.00"], ["ss_er", "62.00"], ["medicare_er", "14.50"]]);
  const c = compare(r, st);
  assert.equal(c.matches, true, c.summary);
});

test("compare: reports the signed difference (engine minus provider)", () => {
  const st = fromQuickBooks(slip());
  const r = result([["fit", "12.01"], ["ss_ee", "62.00"], ["medicare_ee", "14.50"], ["ca_sdi", "11.00"], ["ss_er", "62.00"], ["medicare_er", "14.50"], ["ca_ui", "40.00"]]);
  const c = compare(r, st);
  assert.equal(c.matches, false);
  const fit = c.rows.find(x => x.code === "fit")!;
  assert.equal(fit.status, "mismatch"); assert.equal(fit.diff, "0.01");
  assert.equal(c.rows.find(x => x.code === "ca_ui")!.diff, "40.00");
  // within tolerance
  assert.equal(compare(r, st, "0.01").rows.find(x => x.code === "fit")!.status, "match");
});

const profile: EmployeeProfile = {
  providerEmployeeId: "E1", frequency: "semimonthly",
  input: { workState: "CA", w4: { version: "2020+", filingStatus: "single", step2Checkbox: false, step3Credits: "0", step4aOtherIncome: "0", step4bDeductions: "0", step4cExtra: "0" } },
};

test("inputFromStatement derives YTD before this check from provider YTD gross", () => {
  const input = inputFromStatement(fromQuickBooks(slip()), profile, { name: "Co", caUiRate: "0.04" });
  assert.equal(input.ytd.caUiWages, "2000.00");
  assert.equal(input.employee.id, "E1");
  assert.equal(input.earnings[0]!.amount, "1000.00");
});

test("inputFromStatement falls back to prior regular statements and ignores adjustment checks", () => {
  const mk = (id: string, date: string, kind: "REGULAR" | "ADJUSTMENT", gross: string) => {
    const s = fromQuickBooks(slip({ id, pay_date: date, payslip_type: kind, gross_pay: { current_amount: gross } }));
    return s;
  };
  const prior = [mk("a", "2099-01-01", "REGULAR", "1000"), mk("b", "2099-01-10", "ADJUSTMENT", "0"), mk("c", "2098-12-15", "REGULAR", "9999")];
  const st = mk("d", "2099-01-15", "REGULAR", "1000");
  assert.equal(inputFromStatement(st, profile, { name: "Co" }, [...prior, st]).ytd.ssWages, "1000.00");
  assert.throws(() => inputFromStatement(st, profile, { name: "Co" }), /no YTD gross/);
});

test("reconcileQuarters buckets by pay date and nets provider adjustment checks", () => {
  const q1a = fromQuickBooks(slip({ id: "r1", pay_date: "2099-01-15", employer_taxes: [tax("CA SUI Employer", "49")] , employee_taxes: [] }));
  const q1b = fromQuickBooks(slip({ id: "r2", pay_date: "2099-03-15", employer_taxes: [tax("CA SUI Employer", "49")], employee_taxes: [] }));
  const adj = fromQuickBooks(slip({ id: "x1", pay_date: "2099-03-15", payslip_type: "ADJUSTMENT", employer_taxes: [tax("CA SUI Employer", "-18", "0")], employee_taxes: [] }));
  const q2 = fromQuickBooks(slip({ id: "r3", pay_date: "2099-04-01", employer_taxes: [tax("CA SUI Employer", "40")], employee_taxes: [] }));
  const recon = reconcileQuarters([
    { st: q1a, result: result([["ca_ui", "40.00"]]) },
    { st: q1b, result: result([["ca_ui", "40.00"]]) },
    { st: adj },
    { st: q2 },            // not computed
  ]);
  assert.deepEqual(recon.map(q => `${q.year}Q${q.quarter}`), ["2099Q2", "2099Q1"]);
  const q1 = recon[1]!;
  assert.deepEqual(q1.rows, [{ code: "ca_ui", provider: "80.00", engine: "80.00", diff: "0.00" }]);
  assert.equal(q1.providerAdjustments, 1);
  assert.equal(q1.uncomputed, 0);
  assert.equal(recon[0]!.uncomputed, 1);
});

test("journal for an adjustment check flips negative amounts instead of posting negative lines", () => {
  const accounts: AccountMap = { wagesExpense: 1, employerTaxExpense: 2, netPay: 3, liabilities: { ca_ui: 4 } };
  const r = result([["ca_ui", "-63.00"]], "0.00", "0.00");
  r.employerTaxTotal = "-63.00";
  const j = buildJournal(r, accounts);
  assertBalanced(j);
  assert.deepEqual(j.lines.map(l => [l.account, l.debit, l.credit]), [[2, "0.00", "63.00"], [4, "63.00", "0.00"]]);
});
