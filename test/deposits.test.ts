import { test } from "node:test";
import assert from "node:assert/strict";
import { federalHolidays, onOrNextBusinessDay } from "../src/calendar.js";
import { computeDeposits, planBatches, type PayRun } from "../src/deposits.js";
import { planNotifications, type DepositState } from "../src/deposit-job.js";
import { payDatesBetween, QBO_SEMIMONTHLY } from "../src/project.js";
import { toIcs } from "../src/notify.js";

test("federal holiday generator reproduces Pub 15 (2026)'s printed list", () => {
  // Pub 15 (2026), "Legal holidays": the 12 dates as printed.
  assert.deepEqual(federalHolidays(2026).map(h => h.date), [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-16", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"]);
});

test("due-date shifting: QBO's actual 2026 deposit dates and the 2027 examples", () => {
  const f = (d: string) => onOrNextBusinessDay(d, "US");
  assert.equal(f("2026-02-15"), "2026-02-17");   // Sunday, then Washington's Birthday: QBO paid 2/17
  assert.equal(f("2026-03-15"), "2026-03-16");   // Sunday: QBO paid 3/16
  assert.equal(f("2026-08-15"), "2026-08-17");   // Saturday: QBO paid 8/17
  assert.equal(f("2027-02-15"), "2027-02-16");   // Washington's Birthday
  assert.equal(f("2027-05-15"), "2027-05-17");
  assert.equal(f("2027-08-15"), "2027-08-16");
  assert.equal(f("2028-01-15"), "2028-01-18");   // Saturday, Sunday, MLK Day
  assert.equal(f("2027-07-31"), "2027-08-02");
  assert.equal(f("2027-10-31"), "2027-11-01");
  assert.equal(onOrNextBusinessDay("2027-02-15", "US-CA"), "2027-02-16");
  assert.equal(onOrNextBusinessDay("2027-09-09", "US-CA"), "2027-09-09");   // Admission Day is not counted: errs early
});

// Synthetic salaried employee: 2 checks a month.
const run = (payDate: string, t: Record<string, [string, string]>, projected = false): PayRun => ({
  engine: { name: "openpayroll", version: "t" }, rulesUsed: [], employeeId: "e1", gross: "3000.00", preTax: [],
  period: { frequency: "semimonthly", start: payDate, end: payDate, payDate },
  taxes: Object.entries(t).map(([code, [amount, taxableWages]]) => ({ code, label: code, payer: "employee" as const, amount, taxableWages, ruleRefs: [] })),
  employeeTaxTotal: "0", employerTaxTotal: "0", netPay: "0", ytdAfter: { ssWages: "0", medicareWages: "0", futaWages: "0", caUiWages: "0", caSdiWages: "0" }, warnings: [], projected,
});
const check = (payDate: string, futa = "0.00", ui = "0.00", projected = false) => run(payDate, {
  fit: ["250.00", "3000.00"], ss_ee: ["186.00", "3000.00"], ss_er: ["186.00", "3000.00"], medicare_ee: ["43.50", "3000.00"], medicare_er: ["43.50", "3000.00"],
  ca_pit: ["120.00", "3000.00"], ca_sdi: ["39.00", "3000.00"], ca_ui: [ui, "3000.00"], ca_ett: [ui === "0.00" ? "0.00" : "3.00", "3000.00"], futa: [futa, "3000.00"],
}, projected);
const year = ["01-01", "01-15", "02-01", "02-15", "03-01", "03-15", "04-01", "04-15"].map((d, i) => check(`2027-${d}`, i < 3 ? "18.00" : i === 3 ? "6.00" : "0.00", i < 3 ? "120.00" : "0.00", i >= 6));

test("deposits: federal and CA monthly, UI+ETT quarterly, FUTA with the 940 when under $500", () => {
  const ds = computeDeposits(year, { from: "2027-01-01", to: "2027-12-31" });
  const by = (id: string) => ds.find(d => d.id === id);
  assert.equal(by("IRS-941-2027-01")?.amount, "1418.00");     // 2 x (250 + 186*2 + 43.50*2)
  assert.equal(by("IRS-941-2027-01")?.dueDate, "2027-02-16");
  assert.equal(by("EDD-PIT+SDI-2027-01")?.amount, "318.00");
  assert.equal(by("EDD-UI+ETT-2027-Q1")?.amount, "369.00");    // 3 x 120 + 3 x 3
  assert.equal(by("EDD-UI+ETT-2027-Q1")?.dueDate, "2027-04-30");
  assert.equal(by("IRS-FUTA-2027")?.amount, "60.00");
  assert.equal(by("IRS-FUTA-2027")?.dueDate, "2028-01-31");
  assert.equal(by("IRS-941-2027-04")?.projected, true);
  assert.equal(by("IRS-941-2027-01")?.scheduleBy, "2027-02-15");
  assert.equal(by("EDD-PIT+SDI-2027-01")?.scheduleFrom, "2026-11-18");  // 90 days before
});

test("deposits: FUTA over $500 at a quarter end is deposited that quarter", () => {
  const big = [check("2027-01-15", "400.00"), check("2027-02-15", "200.00")];
  const ds = computeDeposits(big, { from: "2027-01-01", to: "2027-12-31" });
  assert.equal(ds.find(d => d.id === "IRS-FUTA-2027-Q1")?.amount, "600.00");
  assert.equal(ds.find(d => d.id === "IRS-FUTA-2027-Q1")?.dueDate, "2027-04-30");
  assert.equal(ds.find(d => d.id === "IRS-FUTA-2027"), undefined);
});

test("deposits: CA minimum schedule follows the $350 PIT rule", () => {
  const low = ["01-15", "02-15", "03-15"].map(d => run(`2027-${d}`, { ca_pit: ["200.00", "3000.00"], ca_sdi: ["39.00", "3000.00"] }));
  const ds = computeDeposits(low, { from: "2027-01-01", to: "2027-12-31", caSchedule: "minimum" }).filter(d => d.agency === "EDD");
  // Jan 200 carried; Feb brings it to 400 -> Jan+Feb due Mar 15; Mar 200 goes with the quarterly (Apr 30).
  assert.deepEqual(ds.map(d => [d.period, d.amount, d.dueDate]), [["2027-02", "478.00", "2027-03-15"], ["2027-Q1", "239.00", "2027-04-30"]]);
});

test("batches: one per quarter, sent when every payment can be scheduled", () => {
  const ds = computeDeposits(year, { from: "2027-01-01", to: "2027-12-31" });
  const q1 = planBatches(ds).find(b => b.id === "2027-Q1")!;
  // Latest window to open: EDD UI+ETT due 2027-04-30 opens 90 days earlier.
  assert.equal(q1.sendOn, "2027-01-30");
  assert.equal(q1.later.length, 0);
  assert.ok(q1.sendOn <= "2027-02-12");                          // 3 days before the first schedule-by (Feb 15)
});

test("notifications: batch once, change alert on a new amount, reminders near the deadline", () => {
  const ds = computeDeposits(year, { from: "2027-01-01", to: "2027-12-31" });
  const bs = planBatches(ds);
  const st: DepositState = { scheduled: {}, sent: {} };
  const first = planNotifications(ds, bs, st, "2027-01-30", "m@example.com");
  assert.equal(first.length, 1);
  assert.match(first[0]!.message.subject, /Schedule payroll tax deposits: 2027-Q1/);
  for (const k of first[0]!.keys) st.sent[k] = "2027-01-30";
  assert.equal(planNotifications(ds, bs, st, "2027-01-31", "m@example.com").length, 0);

  st.scheduled["IRS-941-2027-01"] = { amount: "1400.00", at: "x" };
  const change = planNotifications(ds, bs, st, "2027-02-01", "m@example.com");
  assert.match(change[0]!.message.text, /scheduled \$1400.00 -> should be \$1418.00/);

  const rem = planNotifications(ds, bs, st, "2027-02-10", "m@example.com").find(p => /Reminder/.test(p.message.subject));
  assert.ok(rem && rem.keys.includes("r1:EDD-PIT+SDI-2027-01"));
});

test("pay schedule: QuickBooks semimonthly periods", () => {
  assert.deepEqual(payDatesBetween("2027-01-01", "2027-01-31", QBO_SEMIMONTHLY), [
    { payDate: "2027-01-01", start: "2026-12-17", end: "2027-01-01" },
    { payDate: "2027-01-15", start: "2027-01-02", end: "2027-01-16" }]);
});

test("calendar feed has one event per deposit", () => {
  const ics = toIcs(computeDeposits(year, { from: "2027-01-01", to: "2027-12-31" }));
  assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, computeDeposits(year, { from: "2027-01-01", to: "2027-12-31" }).length);
  assert.match(ics, /DTSTART;VALUE=DATE:20270216/);
});

test("notifications: warns weekly when paychecks within 45 days can't be computed", () => {
  const st: DepositState = { scheduled: {}, sent: {} };
  assert.equal(planNotifications([], [], st, "2026-10-01", "m@example.com", ["x"], "2027-01-01").length, 0);   // 92 days out
  const w = planNotifications([], [], st, "2026-11-20", "m@example.com", ["2027-01-01 .. no US tax rules"], "2027-01-01");
  assert.match(w[0]!.message.subject, /can't be computed from 2027-01-01/);
  for (const k of w[0]!.keys) st.sent[k] = "2026-11-20";
  assert.equal(planNotifications([], [], st, "2026-11-22", "m@example.com", ["x"], "2027-01-01").length, 0);   // same week
  assert.equal(planNotifications([], [], st, "2026-11-27", "m@example.com", ["x"], "2027-01-01").length, 1);   // next week
});
