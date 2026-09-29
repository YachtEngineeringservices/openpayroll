import { test } from "node:test";
import assert from "node:assert/strict";
import { bigcapitalSettings, assertPostable, toBigcapital } from "../src/adapters/bigcapital.js";
import { depositJournal, type Deposit } from "../src/deposits.js";
import type { AccountMap } from "../src/journal.js";

// A typical Bigcapital account map (ids are examples).
const accounts: AccountMap = {
  wagesExpense: 1083, employerTaxExpense: 1082, netPay: 1047,
  liabilities: { fit: 1051, ss_ee: 1051, ss_er: 1051, medicare_ee: 1051, medicare_er: 1051, addl_medicare_ee: 1051,
                 futa: 1052, ca_pit: 1049, ca_sdi: 1049, ca_ui: 1050, ca_ett: 1050 },
};
const dep = (x: Partial<Deposit>): Deposit => ({ id: "IRS-941-2027-01", agency: "IRS", kind: "941", period: "2027-01", amount: "812.40",
  dueDate: "2027-02-16", scheduleBy: "2027-02-15", scheduleFrom: "2026-10-19", payDates: [], projected: false, ...x });
const lines = (j: { lines: { account: string | number; debit: string; credit: string }[] }) => j.lines.map(l => [l.account, l.debit, l.credit]);

test("settings: URL and key from the environment win; missing either = not configured", () => {
  assert.equal(bigcapitalSettings({ publish: true }, {}), null);
  const s = bigcapitalSettings({ baseUrl: "http://x", apiKey: "cfg", publish: true, postFrom: "2027-01-01" },
    { BIGCAPITAL_URL: "http://bigcapital-server:3000", BIGCAPITAL_API_KEY: "env" })!;
  assert.deepEqual([s.baseUrl, s.apiKey, s.publish, s.postFrom], ["http://bigcapital-server:3000", "env", true, "2027-01-01"]);
  assert.equal(bigcapitalSettings(undefined, { BIGCAPITAL_URL: "u", BIGCAPITAL_API_KEY: "k" })!.apiKey, "k");
});

test("nothing before postFrom is posted, and nothing at all without postFrom", () => {
  assert.throws(() => assertPostable("2027-01-15", {}), /postFrom .* is not set/);
  assert.throws(() => assertPostable("2026-12-15", { postFrom: "2027-01-01" }), /booked in your previous payroll system/);
  assert.doesNotThrow(() => assertPostable("2027-01-01", { postFrom: "2027-01-01" }));
});

test("941 deposit: Dr Federal Taxes 1051 / Cr bank on the due date, numbered TX-<id>", () => {
  const j = depositJournal(dep({}), "812.40", accounts, 1034);
  assert.equal(j.reference, "TX-IRS-941-2027-01");
  assert.equal(j.date, "2027-02-16");
  assert.deepEqual(lines(j), [[1051, "812.40", "0.00"], [1034, "0.00", "812.40"]]);
  // Bigcapital payload carries the number, so a second post is refused by Bigcapital as a duplicate number too.
  assert.equal(toBigcapital(j, { publish: true }, j.reference).journalNumber, "TX-IRS-941-2027-01");
});

test("EDD deposits clear their own accounts; the scheduled amount is used, not the computed one", () => {
  assert.deepEqual(lines(depositJournal(dep({ id: "EDD-PIT+SDI-2027-01", agency: "EDD", kind: "PIT+SDI" }), "301.45", accounts, 1034)),
    [[1049, "301.45", "0.00"], [1034, "0.00", "301.45"]]);
  assert.deepEqual(lines(depositJournal(dep({ id: "EDD-UI+ETT-2027-Q1", agency: "EDD", kind: "UI+ETT", period: "2027-Q1" }), "434.00", accounts, 1034)),
    [[1050, "434.00", "0.00"], [1034, "0.00", "434.00"]]);
});

test("FUTA with Form 940: the credit reduction was never accrued, so it is expensed", () => {
  // CA 2025 credit reduction 1.2% of $7,000 = $84.00 on top of the accrued $42.00.
  const j = depositJournal(dep({ id: "IRS-FUTA-2027", kind: "FUTA", period: "2027", amount: "126.00", creditReduction: "84.00" }), "126.00", accounts, 1034);
  assert.deepEqual(lines(j), [[1052, "42.00", "0.00"], [1082, "84.00", "0.00"], [1034, "0.00", "126.00"]]);
});

test("a deposit whose codes map to several accounts is refused rather than guessed", () => {
  const split = { ...accounts, liabilities: { ...accounts.liabilities, ca_sdi: 1099 } };
  assert.throws(() => depositJournal(dep({ id: "EDD-PIT+SDI-2027-01", agency: "EDD", kind: "PIT+SDI" }), "301.45", split, 1034), /several liability accounts \(1049, 1099\)/);
  assert.throws(() => depositJournal(dep({}), "0.00", accounts, 1034), /bad amount/);
});
