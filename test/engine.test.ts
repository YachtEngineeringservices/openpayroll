/**
 * Hand-checkable tests against the synthetic 2099 fixture rules.
 * Each expected value is worked out in the comment above it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runPayRun } from "../src/engine.js";
import { baseInput, fixtureRules, tax } from "./helpers.js";

const rules = fixtureRules();

test("baseline: single, semimonthly $5,000, CA single 1 allowance", () => {
  const r = runPayRun(baseInput(), rules, { trace: true });
  // FIT: 5000*24 = 120000; - line1g 5000 = 115000; single std: 1000 + 20% x (115000-15000) = 21000; /24 = 875.00
  assert.equal(tax(r, "fit")?.amount, "875.00");
  assert.equal(tax(r, "ss_ee")?.amount, "310.00");       // 5000 x 6.2%
  assert.equal(tax(r, "medicare_ee")?.amount, "72.50");  // 5000 x 1.45%
  assert.equal(tax(r, "addl_medicare_ee"), undefined);
  assert.equal(tax(r, "futa")?.amount, "30.00");         // 5000 x 0.6%
  // CA: 5000 > low income 1000; - std 200 = 4800; 10 + 2% x 3800 = 86; - 1 allowance credit 5 = 81
  assert.equal(tax(r, "ca_pit")?.amount, "81.00");
  assert.equal(tax(r, "ca_sdi")?.amount, "50.00");       // 1%
  assert.equal(tax(r, "ca_ui")?.amount, "170.00");       // 3.4%
  assert.equal(tax(r, "ca_ett")?.amount, "5.00");        // 0.1%
  assert.equal(r.employeeTaxTotal, "1388.50");
  assert.equal(r.employerTaxTotal, "587.50");
  assert.equal(r.netPay, "3611.50");
  assert.equal(r.trace?.fit?.["1i"], "115000");
  assert.deepEqual(r.ytdAfter, { ssWages: "5000.00", medicareWages: "5000.00", futaWages: "5000.00", caUiWages: "5000.00", caSdiWages: "5000.00" });
  assert.deepEqual(r.warnings, []);
});

test("wage bases: Social Security, FUTA, UI and ETT stop at their caps", () => {
  const r = runPayRun(baseInput({ ytd: { ssWages: "98000", medicareWages: "98000", futaWages: "5000", caUiWages: "5000", caSdiWages: "98000" } }), rules);
  assert.equal(tax(r, "ss_ee")?.taxableWages, "2000.00");
  assert.equal(tax(r, "ss_ee")?.amount, "124.00");
  assert.equal(tax(r, "medicare_ee")?.amount, "72.50");   // no cap
  assert.equal(tax(r, "futa")?.amount, "12.00");          // 2000 x 0.6%
  assert.equal(tax(r, "ca_ui")?.amount, "68.00");         // 2000 x 3.4%
  assert.equal(tax(r, "ca_ett")?.amount, "2.00");
  assert.equal(tax(r, "ca_sdi")?.amount, "50.00");        // SDI has no cap in the fixture
  const past = runPayRun(baseInput({ ytd: { ssWages: "150000", medicareWages: "150000", futaWages: "9000", caUiWages: "9000", caSdiWages: "150000" } }), rules);
  assert.equal(tax(past, "ss_ee")?.amount, "0.00");
  assert.equal(tax(past, "futa")?.amount, "0.00");
});

test("Additional Medicare starts at the $200,000 YTD threshold (only the excess)", () => {
  const r = runPayRun(baseInput({ ytd: { ssWages: "198000", medicareWages: "198000", futaWages: "7000", caUiWages: "7000", caSdiWages: "198000" } }), rules);
  assert.equal(tax(r, "addl_medicare_ee")?.taxableWages, "3000.00");
  assert.equal(tax(r, "addl_medicare_ee")?.amount, "27.00");   // 3000 x 0.9%
  const over = runPayRun(baseInput({ ytd: { ssWages: "250000", medicareWages: "250000", futaWages: "7000", caUiWages: "7000", caSdiWages: "250000" } }), rules);
  assert.equal(tax(over, "addl_medicare_ee")?.amount, "45.00");  // all 5000
});

test("W-4 Step 2 checkbox uses the checkbox schedule and skips line 1g", () => {
  const i = baseInput();
  i.employee.w4 = { version: "2020+", filingStatus: "single", step2Checkbox: true, step3Credits: "0", step4aOtherIncome: "0", step4bDeductions: "0", step4cExtra: "0" };
  // 120000; checkbox single: 500 + 20% x (120000-7500) = 23000; /24 = 958.333 -> 958.33
  assert.equal(tax(runPayRun(i, rules), "fit")?.amount, "958.33");
});

test("W-4 Step 3 credits and Step 4(c) extra withholding", () => {
  const i = baseInput();
  i.employee.w4 = { version: "2020+", filingStatus: "single", step2Checkbox: false, step3Credits: "2400", step4aOtherIncome: "0", step4bDeductions: "0", step4cExtra: "50" };
  // 875 - 2400/24 (=100) + 50 = 825
  assert.equal(tax(runPayRun(i, rules), "fit")?.amount, "825.00");
});

test("W-4 Step 4(a)/(b) adjust annual wages; withholding floors at zero", () => {
  const i = baseInput();
  i.employee.w4 = { version: "2020+", filingStatus: "mfj", step2Checkbox: false, step3Credits: "0", step4aOtherIncome: "6000", step4bDeductions: "20000", step4cExtra: "0" };
  // 120000 + 6000 - (20000 + 10000) = 96000; mfj: 2000 + 20% x 66000 = 15200; /24 = 633.33
  assert.equal(tax(runPayRun(i, rules), "fit")?.amount, "633.33");
  const low = baseInput({ earnings: [{ code: "salary", amount: "100" }] });
  low.employee.w4 = { version: "2020+", filingStatus: "single", step2Checkbox: false, step3Credits: "5000", step4aOtherIncome: "0", step4bDeductions: "0", step4cExtra: "0" };
  assert.equal(tax(runPayRun(low, rules), "fit")?.amount, "0.00");
});

test("pre-2020 W-4: allowances, married uses the MFJ standard schedule", () => {
  const i = baseInput();
  i.employee.w4 = { version: "legacy", maritalStatus: "married", allowances: 2, additional: "0" };
  // 120000 - 2 x 4000 = 112000; mfj: 2000 + 20% x 82000 = 18400; /24 = 766.67
  assert.equal(tax(runPayRun(i, rules), "fit")?.amount, "766.67");
});

test("pre-tax 401(k) reduces FIT and CA PIT wages but not FICA/SDI", () => {
  const r = runPayRun(baseInput({ preTax: [{ code: "401k", amount: "500", reduces: ["fit", "caPit"] }] }), rules);
  // FIT on 4500: 108000 - 5000 = 103000; 1000 + 20% x 88000 = 18600; /24 = 775.00
  assert.equal(tax(r, "fit")?.amount, "775.00");
  assert.equal(tax(r, "ss_ee")?.taxableWages, "5000.00");
  // CA on 4500: -200 = 4300; 10 + 2% x 3300 = 76; -5 = 71
  assert.equal(tax(r, "ca_pit")?.amount, "71.00");
  assert.equal(tax(r, "ca_sdi")?.amount, "50.00");
  // net = 5000 - 500 - (775 + 310 + 72.50 + 71 + 50) = 3221.50
  assert.equal(r.netPay, "3221.50");
});

test("CA: below the low income exemption withholds nothing (plus DE 4 additional)", () => {
  const r = runPayRun(baseInput({ earnings: [{ code: "salary", amount: "900" }] }), rules);
  assert.equal(tax(r, "ca_pit")?.amount, "0.00");
  const i = baseInput({ earnings: [{ code: "salary", amount: "900" }] });
  i.employee.de4 = { filingStatus: "single", regularAllowances: 1, estimatedDeductionAllowances: 0, additional: "10" };
  assert.equal(tax(runPayRun(i, rules), "ca_pit")?.amount, "10.00");
});

test("CA: married 2+ allowances, estimated deductions beyond the table use perAllowance", () => {
  const i = baseInput();
  i.employee.de4 = { filingStatus: "married", regularAllowances: 12, estimatedDeductionAllowances: 3, additional: "0" };
  // 5000 - est 3x100 - std(married_2plus) 400 = 4300; married: 20 + 2% x 2300 = 66; credit 12 x 5 = 60 -> 6
  assert.equal(tax(runPayRun(i, rules), "ca_pit")?.amount, "6.00");
});

test("exemptions skip taxes", () => {
  const i = baseInput();
  i.employee.exempt = { fica: true, futa: true };
  const r = runPayRun(i, rules);
  assert.equal(tax(r, "ss_ee"), undefined);
  assert.equal(tax(r, "futa"), undefined);
  assert.equal(r.ytdAfter.ssWages, "0.00");
});

test("guards: no rules for the year, negative net, missing DE 4", () => {
  assert.throws(() => runPayRun(baseInput({ period: { frequency: "semimonthly", start: "2098-01-01", end: "2098-01-15", payDate: "2098-01-15" } }), rules), /no US rules cover/);
  assert.throws(() => runPayRun(baseInput({ preTax: [{ code: "x", amount: "6000", reduces: [] }] }), rules), /exceed gross/);
  const i = baseInput(); delete i.employee.de4;
  assert.throws(() => runPayRun(i, rules), /DE 4/);
  const wk = baseInput({ period: { frequency: "weekly", start: "2099-01-01", end: "2099-01-07", payDate: "2099-01-07" } });
  assert.throws(() => runPayRun(wk, rules), /no weekly table transcribed/);
});
