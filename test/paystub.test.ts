import { test } from "node:test";
import assert from "node:assert/strict";
import { approvePayRun, buildPayRun } from "../src/payrun.js";
import { QBO_SEMIMONTHLY } from "../src/project.js";
import { buildStub, check226, stubPdf } from "../src/paystub.js";
import { renderPdf } from "../src/pdf.js";
import { baseInput, fixtureRules } from "./helpers.js";

const base = baseInput();
const run = (payDate: string, prior: ReturnType<typeof buildPayRun>[] = [], sick?: Record<string, string>) => buildPayRun({
  payDate, schedule: QBO_SEMIMONTHLY, employer: base.employer, rules: fixtureRules(), prior, sickHoursUsed: sick,
  profiles: [{ providerEmployeeId: "E1", frequency: "semimonthly", salaryPerPeriod: "5000.00", input: { ...base.employee, id: "E1", name: "Pat Example" } }],
});
const employer = { legalName: "Example Engineering LLC", address: ["100 Harbor Way Ste 1", "Oceanside, CA 92054"] };
const sick0 = { frontloadHours: "40", usedThisPeriod: "0", usedYtdBefore: "0" };

test("pay stub: every Labor Code 226(a) item and the 246(i) sick leave balance are on the sample stub", () => {
  const jan1 = approvePayRun(run("2099-01-01"), [], { allowDraftRules: true });
  const jan15 = approvePayRun(run("2099-01-15", [jan1]), [jan1], { allowDraftRules: true });
  const s = buildStub(jan15, "E1", [jan1.paychecks[0]!.result], employer, { employeeNumber: "E-0001", exemptFromOvertime: true, annualSalary: "120000.00" }, sick0);
  assert.deepEqual(check226(s), ["exempt status: no 2099 California minimum wage on file to check the exempt salary floor"]);   // fixture year
  s.payDate = "2027-01-15";
  assert.deepEqual(check226(s), []);
  const pdf = stubPdf(s).toString("latin1");
  const r = jan15.paychecks[0]!.result;
  const money = (v: string) => Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 });
  const need: [string, string][] = [
    ["(1) gross wages earned", `(Gross wages)`], ["(1) gross amount", `(${money(r.gross)})`],
    ["(2) hours: exempt note per 226(j)", "226\\(j\\)"],
    ["(4) deductions: federal income tax", "(Federal income tax)"], ["(4) social security", "(Social Security)"], ["(4) Medicare", "(Medicare)"],
    ["(4) CA PIT", "(California income tax \\(PIT\\))"], ["(4) CA SDI", "(California SDI)"],
    ["(5) net wages", "(Net pay)"], ["(5) net amount", `(${money(r.netPay)})`],
    ["(6) period dates", "(Pay period: 01/02/2099 - 01/16/2099)"],
    ["(7) employee name", "(Pat Example)"], ["(7) employee ID (not SSN)", "(E-0001)"],
    ["(8) employer legal name", "(Example Engineering LLC)"], ["(8) employer address", "(100 Harbor Way Ste 1)"],
    ["246(i) sick leave available", "(Paid sick leave available)"], ["246(i) hours", "(40.00 hours)"],
    ["year-to-date gross", `(${money("10000.00")})`],
  ];
  for (const [what, text] of need) assert.ok(pdf.includes(text), `missing on stub: ${what} (${text})`);
  assert.ok(!/DRAFT/.test(pdf), "approved stub must not say DRAFT");
});

test("pay stub: a non-exempt employee must show hours and rate (226(a)(2),(9))", () => {
  const r = run("2099-01-15");
  assert.throws(() => buildStub(r, "E1", [], employer, { exemptFromOvertime: false }, sick0), /hoursPerPeriod/);
  const s = buildStub(r, "E1", [], employer, { employeeNumber: "E-0001", exemptFromOvertime: false, hoursPerPeriod: "86.67" }, sick0);
  assert.deepEqual(check226(s), []);
  assert.equal(s.earnings[0]!.rate, "57.69");                 // 5000 / 86.67
  const pdf = stubPdf(s).toString("latin1");
  assert.ok(pdf.includes("(Hours)") && pdf.includes("(86.67)") && pdf.includes("(57.69)"));
  assert.ok(pdf.includes("DRAFT"), "an unapproved run's stub is marked DRAFT");
});

test("pay stub: an SSN as the employee ID is flagged; sick hours used reduce the balance", () => {
  const r = run("2099-01-15", [], { E1: "8" });
  assert.equal(r.paychecks[0]!.sickHoursUsed, "8.00");
  const s = buildStub(r, "E1", [], employer, { employeeNumber: "123-45-6789", exemptFromOvertime: true }, { frontloadHours: "40", usedThisPeriod: "8", usedYtdBefore: "16" });
  assert.match(check226(s).join(), /looks like an SSN/);
  assert.equal(s.sickLeaveAvailable, "16.00");
});

test("pdf: valid structure (header, xref offsets point at the objects, trailer)", () => {
  const b = renderPdf([{ texts: [{ x: 50, y: 700, text: "Hello (world) \\ test" }], lines: [{ x1: 50, y1: 690, x2: 300, y2: 690 }] }], "t").toString("latin1");
  assert.ok(b.startsWith("%PDF-1.4\n") && b.trimEnd().endsWith("%%EOF"));
  assert.ok(b.includes("(Hello \\(world\\) \\\\ test)"));
  const xref = Number(/startxref\n(\d+)/.exec(b)![1]);
  assert.ok(b.slice(xref).startsWith("xref"));
  const offsets = [...b.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(b.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`));
});

test("pay stub: an 'exempt' salary under 2 x CA minimum wage x 2080 is flagged (2027: $72,384)", async () => {
  const { exemptSalaryFloor } = await import("../src/paystub.js");
  assert.equal(exemptSalaryFloor(2026), "70304.00");
  assert.equal(exemptSalaryFloor(2027), "72384.00");
  const s = buildStub(run("2099-01-15"), "E1", [], employer, { employeeNumber: "E-0001", exemptFromOvertime: true, annualSalary: "72000.00" }, sick0);
  s.payDate = "2027-01-15";
  assert.match(check226(s).join(), /below the 2027 floor 72384.00/);
  s.payDate = "2026-12-15";
  assert.deepEqual(check226(s), []);
});
