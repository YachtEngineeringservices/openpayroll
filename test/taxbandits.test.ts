import { test } from "node:test";
import assert from "node:assert/strict";
import { de9Record, form941Record, jws, type TaxBanditsBusiness } from "../src/adapters/taxbandits.js";
import type { QuarterSummary } from "../src/summary.js";

// Synthetic figures only (no real pay data in the repo).
const summary = (over: Partial<QuarterSummary> = {}): QuarterSummary => ({
  year: 2026, quarter: 2, payRuns: 6, employees: ["e1"], totals: {},
  form941: {
    "2  wages, tips, other compensation": "10000.00", "3  federal income tax withheld": "1000.00",
    "5a taxable social security wages": "10000.00", "5a col 2 (x 0.124)": "1240.00",
    "5c taxable Medicare wages": "10000.00", "5c col 2 (x 0.029)": "290.00",
    "5d wages subject to Additional Medicare": "0.00", "5d col 2 (x 0.009)": "0.00",
    "7  fractions of cents adjustment": "0.00", "12 total taxes after adjustments (expected deposits)": "2530.00",
  },
  de9: { "UI taxable wages": "1000.00", "SDI taxable wages": "10000.00", "PIT wages": "10000.00", "UI contributions": "40.00",
    "ETT contributions": "1.00", "SDI withheld": "130.00", "PIT withheld": "300.00" },
  employeesOn12th: 1, employeesOn12thByMonth: [2, 1, 1],
  de9cEmployees: [{ employeeId: "e1", subjectWages: "9000.00", pitWages: "9000.00", pitWithheld: "300.00" },
                  { employeeId: "e2", subjectWages: "1000.00", pitWages: "1000.00", pitWithheld: "0.00" }],
  monthlyLiability: ["800.00", "830.00", "900.00"], ...over,
});
const biz: TaxBanditsBusiness = {
  BusinessNm: "Example LLC", EINorSSN: "000000000", IsEIN: true, Email: "a@example.com", ContactNm: "A", Phone: "0000000000",
  BusinessType: "CORP", USAddress: { Address1: "1 Main St", City: "X", State: "CA", ZipCd: "90000" },
  SigningAuthority: { Name: "A", Phone: "0000000000", BusinessMemberType: "MEMBER" },
};

test("941 record: lines 5e, 6, 10, 12, 13, 16 add up", () => {
  const r = form941Record(summary(), biz, { depositsMade: "2530.00", signatureType: "FORM_8453_EMP" });
  const f = r.ReturnData.Form941;
  assert.equal(f.TotSSMdcrTaxAmt, 1530);
  assert.equal(f.TotalTaxBeforeAdjustmentAmt, 2530);
  assert.equal(f.TotTaxAfterAdjustmentAndNonRfdCr, 2530);
  assert.equal(f.BalanceDueAmt, 0);
  assert.equal(r.ReturnData.DepositScheduleType.TotalQuarterTaxLiabilityAmt, 2530);
  assert.equal(r.ReturnHeader.Qtr, "Q2");
});

test("941 record: balance due when deposits fall short", () => {
  assert.throws(() => form941Record(summary(), biz, { depositsMade: "2500.00", signatureType: "FORM_8453_EMP" }), /balanceDuePaidBy/);
  const r = form941Record(summary(), biz, { depositsMade: "2500.00", signatureType: "FORM_8453_EMP", balanceDuePaidBy: "EFTPS" }).ReturnData;
  assert.equal(r.Form941.BalanceDueAmt, 30);
  assert.equal(r.Form941.OverpaidAmt, 0);
  assert.equal(r.IRSPaymentType, "EFTPS");
});

test("941 record: refuses when line 16 months don't total line 12", () => {
  assert.throws(() => form941Record(summary({ monthlyLiability: ["800.00", "830.00", "899.99"] }), biz,
    { depositsMade: "2530.00", signatureType: "FORM_8453_EMP" }), /line 16/);
});

test("941 record: Online Signature PIN must be 10 digits", () => {
  assert.throws(() => form941Record(summary(), biz, { depositsMade: "2530.00", signatureType: "ONLINE_SIGN_PIN", onlineSignaturePin: "123" }), /10 digits/);
});

test("JWS is HS256 with iss = sub = client id and aud = user token", () => {
  const [h, b] = jws({ clientId: "cid", clientSecret: "sec", userToken: "ut" }, 1700000000).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(b!, "base64url").toString()), { iss: "cid", sub: "cid", aud: "ut", iat: 1700000000 });
});

const ids = { e1: { ssn: "000000001", firstNm: "A", lastNm: "B" }, e2: { ssn: "000000002", firstNm: "C", lastNm: "D" } };

test("DE 9: items H, I, J and the DE 9C lines", () => {
  const d = de9Record(summary(), biz, { accNum: "00000000", uiRatePct: "4.00", depositsMade: "300.00", employees: ids }).ReturnData.FormDE9;
  assert.equal(d.TaxableWages, 10000);
  assert.equal(d.TotalTaxLiability, 471);   // 40 + 1 + 130 + 300
  assert.equal(d.TotalTaxDue, 171);
  assert.deepEqual(d.NumOfEmployees, { Month1TotEmployees: 2, Month2TotEmployees: 1, Month3TotEmployees: 1 });
  assert.equal(d.EmployeeDetails.length, 2);
});

test("DE 9: refuses a missing employee identity or a bad SSN", () => {
  assert.throws(() => de9Record(summary(), biz, { accNum: "00000000", uiRatePct: "4.00", depositsMade: "0", employees: { e1: ids.e1 } }), /no identity/);
  assert.throws(() => de9Record(summary(), biz, { accNum: "00000000", uiRatePct: "4.00", depositsMade: "0", employees: { ...ids, e2: { ...ids.e2, ssn: "12" } } }), /9 digits/);
});

import { summarizeFuta } from "../src/summary.js";
import { form940Record } from "../src/adapters/taxbandits.js";

// Synthetic: one employee 2,500 x 4 (crosses the 7,000 base in the 3rd check), one 500 x 2.
const slip = (id: string, payDate: string, gross: string) =>
  ({ employeeId: id, gross, period: { start: payDate, end: payDate, payDate }, taxes: [], preTax: [] }) as never;
const futaYear = [slip("a", "2025-01-15", "2500"), slip("a", "2025-02-15", "2500"), slip("a", "2025-04-15", "2500"),
  slip("a", "2025-11-15", "2500"), slip("b", "2025-07-15", "500"), slip("b", "2025-10-15", "500")];
const rules = { wageBase: "7000", netRate: "0.006", stateCd: "CA", creditReductionRate: "0.012" };

test("940: wage base, quarters, credit reduction in Q4", () => {
  const s = summarizeFuta(futaYear, 2025, rules);
  assert.equal(s.line3TotalPayments, "11000.00");
  assert.equal(s.line5OverBase, "3000.00");       // a: 10,000 - 7,000
  assert.equal(s.line7Taxable, "8000.00");
  assert.equal(s.line8Tax, "48.00");
  assert.equal(s.line11CreditReduction, "96.00");
  assert.deepEqual(s.quarters, ["30.00", "12.00", "3.00", "99.00"]);   // Q2: 2,000 left of the base; Q4: 3.00 + 96.00
  const r = form940Record(s, biz, { stateCd: "CA", creditReductionRate: "0.012", depositsMade: "48.00", signatureType: "FORM_8453_EMP", balanceDuePaidBy: "EFTPS" });
  assert.equal(r.ReturnData.Form940.BalanceDueAmt, 96);
  assert.equal(r.ReturnData.ScheduleA?.[0]?.CreditReductionAmt, 96);
  assert.equal("FirstQtrTaxLiabilityAmt" in r.ReturnData.Form940, false);   // line 12 = 144 <= 500: Part 5 blank
});

test("940: refuses pre-tax deductions it can't classify yet", () => {
  assert.throws(() => summarizeFuta([{ ...(futaYear[0] as unknown as object), preTax: [{ code: "125", amount: "10" }] } as never], 2025, rules), /pre-tax/);
});

import { summarizeW2 } from "../src/summary.js";
import { w2Request } from "../src/adapters/taxbandits.js";

test("W-2: boxes per employee, box 6 includes Additional Medicare, SSN required", () => {
  const t = (code: string, amount: string, taxableWages: string) => ({ code, amount, taxableWages });
  const rs = [
    { employeeId: "e1", period: { payDate: "2025-03-15" }, taxes: [t("fit", "100.00", "1000.00"), t("ss_ee", "62.00", "1000.00"), t("medicare_ee", "14.50", "1000.00"),
      t("addl_medicare_ee", "1.00", "0.00"), t("ca_pit", "20.00", "1000.00"), t("ca_sdi", "13.00", "1000.00")] },
    { employeeId: "e1", period: { payDate: "2024-12-31" }, taxes: [t("fit", "999.00", "9999.00")] },
  ] as never;
  const [w] = summarizeW2(rs, 2025);
  assert.deepEqual({ b1: w!.b1Wages, b2: w!.b2FedTaxWh, b6: w!.b6MedicareTaxWh, b14: w!.b14CaSdi, b17: w!.b17StateTax },
    { b1: "1000.00", b2: "100.00", b6: "15.50", b14: "13.00", b17: "20.00" });
  const addr = { Address1: "1 Main St", City: "X", State: "CA", ZipCd: "90000" };
  const body = w2Request([w!], biz, { taxYear: 2025, stateIdNum: "00000000", employees: { e1: { ssn: "000000001", firstNm: "A", lastNm: "B", address: addr } } });
  assert.equal(body.ReturnData[0]!.W2FormData.B14Other, "CA SDI 13.00");
  assert.throws(() => w2Request([w!], biz, { taxYear: 2025, stateIdNum: "00000000", employees: {} }), /no identity/);
});
