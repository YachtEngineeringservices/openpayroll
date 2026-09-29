import { test } from "node:test";
import assert from "node:assert/strict";
import { runPayRun } from "../src/engine.js";
import { buildJournal, type AccountMap } from "../src/journal.js";
import { toBigcapital } from "../src/adapters/bigcapital.js";
import { summarizeQuarter } from "../src/summary.js";
import { baseInput, fixtureRules } from "./helpers.js";

const accounts: AccountMap = {
  wagesExpense: 6000, employerTaxExpense: 6010, netPay: 1000,
  liabilities: { fit: 2100, ss_ee: 2110, ss_er: 2110, medicare_ee: 2110, medicare_er: 2110, addl_medicare_ee: 2110,
    futa: 2120, ca_pit: 2200, ca_sdi: 2200, ca_ui: 2210, ca_ett: 2210 },
  preTax: { "401k": 2300 },
};

test("journal balances and groups liabilities by account", () => {
  const r = runPayRun(baseInput({ preTax: [{ code: "401k", amount: "500", reduces: ["fit", "caPit"] }] }), fixtureRules());
  const j = buildJournal(r, accounts);
  const dr = j.lines.filter(l => l.debit !== "0.00").map(l => [l.account, l.debit]);
  assert.deepEqual(dr, [[6000, "5000.00"], [6010, "587.50"]]);
  const fica = j.lines.find(l => l.account === 2110);
  assert.equal(fica?.credit, "765.00");       // 310 + 72.50 + 310 + 72.50
  assert.equal(j.lines.find(l => l.account === 1000)?.credit, "3221.50");
  assert.equal(j.lines.find(l => l.account === 2300)?.credit, "500.00");
});

test("unmapped tax code is an error, not a silent drop", () => {
  const r = runPayRun(baseInput(), fixtureRules());
  const { futa, ...rest } = accounts.liabilities; void futa;
  assert.throws(() => buildJournal(r, { ...accounts, liabilities: rest }), /no liability account mapped for tax code "futa"/);
});

test("Bigcapital payload matches CreateManualJournalDto shape", () => {
  const j = buildJournal(runPayRun(baseInput(), fixtureRules()), accounts);
  const p = toBigcapital(j);
  assert.equal(p.publish, false);
  assert.equal(p.currencyCode, "USD");
  assert.equal(p.date, "2099-01-15");
  assert.deepEqual(p.entries[0], { index: 1, accountId: 6000, debit: 5000, note: "Gross wages" });
  const d = p.entries.reduce((s, e) => s + Math.round((e.debit ?? 0) * 100), 0);
  const c = p.entries.reduce((s, e) => s + Math.round((e.credit ?? 0) * 100), 0);
  assert.equal(d, c);
});

test("quarter summary: 941 and DE 9 figures", () => {
  const rules = fixtureRules();
  const runs = [
    runPayRun(baseInput(), rules),
    runPayRun(baseInput({ period: { frequency: "semimonthly", start: "2099-01-16", end: "2099-01-31", payDate: "2099-01-31" },
      ytd: { ssWages: "5000", medicareWages: "5000", futaWages: "5000", caUiWages: "5000", caSdiWages: "5000" } }), rules),
    runPayRun(baseInput({ period: { frequency: "semimonthly", start: "2099-04-01", end: "2099-04-15", payDate: "2099-04-15" } }), rules),
  ];
  const s = summarizeQuarter(runs, 2099, 1);
  assert.equal(s.payRuns, 2);
  assert.equal(s.form941["2  wages, tips, other compensation"], "10000.00");
  assert.equal(s.form941["3  federal income tax withheld"], "1750.00");
  assert.equal(s.form941["5a col 2 (x 0.124)"], "1240.00");
  assert.equal(s.form941["7  fractions of cents adjustment"], "0.00");
  assert.equal(s.de9["UI taxable wages"], "7000.00");      // 5000 + 2000 (cap)
  assert.equal(s.de9["PIT withheld"], "162.00");
});
