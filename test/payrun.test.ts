import { test } from "node:test";
import assert from "node:assert/strict";
import { approvePayRun, buildPayRun, voidPayRun, ytdBefore, ytdReport, type PayRunRecord, type PayrollAccounts } from "../src/payrun.js";
import { QBO_SEMIMONTHLY } from "../src/project.js";
import type { Statement } from "../src/compare.js";
import { baseInput, fixtureRules } from "./helpers.js";

const base = baseInput();
const profile = (id: string, salary: string, over: object = {}) => ({
  providerEmployeeId: id, frequency: "semimonthly" as const, salaryPerPeriod: salary,
  input: { ...base.employee, id, name: `Employee ${id}` }, ...over,
});
const accounts: PayrollAccounts = {
  wagesExpense: 1083, employerTaxExpense: 1082, netPay: 1047, netPayPaidFrom: 1034,
  liabilities: { fit: 1051, ss_ee: 1051, ss_er: 1051, medicare_ee: 1051, medicare_er: 1051, addl_medicare_ee: 1051, futa: 1052, ca_pit: 1049, ca_sdi: 1049, ca_ui: 1050, ca_ett: 1050 },
};
const opts = (payDate: string, prior: PayRunRecord[] = [], over: object = {}) => ({
  payDate, schedule: QBO_SEMIMONTHLY, profiles: [profile("E1", "5000.00")], employer: base.employer,
  rules: fixtureRules(), prior, accounts, now: "2099-01-10T00:00:00Z", ...over,
});

test("pay run: paycheck, balanced journals and totals; re-running is identical", () => {
  const a = buildPayRun(opts("2099-01-15")), b = buildPayRun(opts("2099-01-15"));
  assert.equal(a.fingerprint, b.fingerprint);
  assert.deepEqual(a.paychecks.map(p => p.result), b.paychecks.map(p => p.result));
  assert.deepEqual(a.period, { start: "2099-01-02", end: "2099-01-16" });
  assert.equal(a.totals.gross, "5000.00");
  const net = a.paychecks[0]!.result.netPay;
  assert.equal(a.totals.net, net);
  // Accrual: net pay credited to Direct Deposit Payable; payment: DD Payable -> bank.
  assert.equal(a.journals!.accrual.lines.find(l => l.account === 1047)?.credit, net);
  assert.deepEqual(a.journals!.payment!.lines.map(l => [l.account, l.debit, l.credit]), [[1047, net, "0.00"], [1034, "0.00", net]]);
  assert.equal(a.journals!.accrual.reference, "PR-2099-01-15");
});

test("pay run: YTD carries from one run to the next", () => {
  const jan15 = approvePayRun(buildPayRun(opts("2099-01-15")), [], { allowDraftRules: true });
  const feb1 = buildPayRun(opts("2099-02-01", [jan15]));
  assert.equal(feb1.paychecks[0]!.input.ytd.ssWages, "5000.00");
  assert.equal(feb1.paychecks[0]!.input.ytd.futaWages, "5000.00");
  assert.equal(feb1.period.start, "2099-01-17");
});

test("pay run: YTD starts from QuickBooks stubs imported for the same year", () => {
  const st = { id: "q1", employeeId: "E1", employeeName: "x", kind: "regular", gross: "4000.00", net: "0", lines: [], unmapped: [],
    period: { start: "2099-01-02", end: "2099-01-16", payDate: "2099-01-15" } } as unknown as Statement;
  assert.equal(ytdBefore("E1", "2099-02-01", [], [st]).caUiWages, "4000.00");
  assert.throws(() => buildPayRun(opts("2099-01-15", [], { statements: [st] })), /already paid by QuickBooks/);
});

test("pay run: order is enforced so YTD stays right", () => {
  const feb1 = buildPayRun(opts("2099-02-01"));
  assert.throws(() => buildPayRun(opts("2099-01-15", [feb1])), /a later pay run exists/);
  const jan15 = buildPayRun(opts("2099-01-15"));
  assert.throws(() => approvePayRun(feb1, [jan15, feb1], { allowDraftRules: true }), /approve the earlier/);
  assert.throws(() => buildPayRun(opts("2099-01-20")), /not a scheduled pay date/);
});

test("pay run: approval refuses draft rule files unless allowed; approved runs can't be re-approved", () => {
  const r = buildPayRun(opts("2099-01-15"));
  const draft = { ...r, rulesUsed: r.rulesUsed.map(x => ({ ...x, status: "draft" as const })) };
  assert.throws(() => approvePayRun(draft, []), /DRAFT rule files/);
  const ok = approvePayRun(draft, [], { allowDraftRules: true });
  assert.equal(ok.status, "approved");
  assert.throws(() => approvePayRun(ok, []), /not a draft/);
});

test("pay run: voiding needs a reason, goes latest-first, and drops the run from YTD", () => {
  const jan15 = approvePayRun(buildPayRun(opts("2099-01-15")), [], { allowDraftRules: true });
  const feb1 = approvePayRun(buildPayRun(opts("2099-02-01", [jan15])), [jan15], { allowDraftRules: true });
  assert.throws(() => voidPayRun(jan15, [jan15, feb1], "wrong salary"), /void the later/);
  assert.throws(() => voidPayRun(feb1, [jan15, feb1], " "), /reason/);
  const v = voidPayRun(feb1, [jan15, feb1], "wrong salary");
  const rep = ytdReport([jan15, v], "2099");
  assert.equal(rep[0]!.payRuns, 1);
  assert.equal(rep[0]!.gross, "5000.00");
});

test("pay run: two employees combine into one journal per account and side", () => {
  const r = buildPayRun(opts("2099-01-15", [], { profiles: [profile("E1", "5000.00"), profile("E2", "1000.00"), profile("E3", "9000.00", { active: false })] }));
  assert.equal(r.paychecks.length, 2);
  assert.equal(r.totals.gross, "6000.00");
  assert.equal(r.journals!.accrual.lines.filter(l => l.account === 1083).length, 1);
  assert.equal(r.journals!.accrual.lines.find(l => l.account === 1083)?.debit, "6000.00");
});

test("pay run: salary changes take effect by pay date", async () => {
  const { salaryOn } = await import("../src/project.js");
  const p = { salaryPerPeriod: "2500.00", salaryChanges: [{ from: "2027-01-01", perPeriod: "2600.00" }] };
  assert.equal(salaryOn(p, "2026-12-15"), "2500.00");
  assert.equal(salaryOn(p, "2027-01-01"), "2600.00");
  const r = buildPayRun(opts("2099-01-15", [], { profiles: [profile("E1", "5000.00", { salaryChanges: [{ from: "2099-01-15", perPeriod: "6000.00" }] })] }));
  assert.equal(r.totals.gross, "6000.00");
});
