import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBrackets, validateRules, assertUsable, readRuleFile, listRuleFiles } from "../src/rules.js";
import { join } from "node:path";
import { ROOT } from "./helpers.js";

const row = (atLeast: string, lessThan: string | null, base: string, rate: string) => ({ atLeast, lessThan, base, rate, excessOver: atLeast });

test("continuity check catches a mistyped base (the real failure seen when summarizing Pub 15-T)", () => {
  // Head of Household rows as returned by an automated summary of the 2026 PDF: rows 5+ are inconsistent.
  const bad = [row("0", "12850", "0", "0"), row("12850", "32550", "0", "0.10"), row("32550", "86550", "1970", "0.12"),
    row("86550", "169100", "8450", "0.22"), row("169100", "316550", "27470", "0.24"), row("316550", null, "66694", "0.32")];
  const issues = checkBrackets(bad, "hoh", "0.005");
  assert.ok(issues.some(i => i.path === "hoh[4].base"), JSON.stringify(issues));
});

test("continuity check accepts a consistent table", () => {
  const ok = [row("0", "5000", "0", "0"), row("5000", "15000", "0", "0.10"), row("15000", null, "1000", "0.20")];
  assert.deepEqual(checkBrackets(ok, "t"), []);
});

test("gaps, open ends and percent-vs-fraction mistakes are errors", () => {
  const gap = [row("0", "5000", "0", "0"), row("6000", null, "0", "0.10")];
  assert.ok(checkBrackets(gap, "t").some(i => /gap\/overlap/.test(i.message)));
  const closed = [row("0", "5000", "0", "0"), row("5000", "9000", "0", "0.10")];
  assert.ok(checkBrackets(closed, "t").some(i => /open-ended/.test(i.message)));
  const pct = [row("0", "5000", "0", "0"), row("5000", null, "0", "12")];
  assert.ok(checkBrackets(pct, "t").some(i => /outside 0..1/.test(i.message)));
});

test("fixture rules are complete and valid", () => {
  for (const f of listRuleFiles(join(ROOT, "test", "fixtures", "rules"))) {
    const issues = validateRules(readRuleFile(f));
    assert.deepEqual(issues, [], f);
  }
});

test("shipped rules validate cleanly; DRAFT files are refused unless allowDraft", () => {
  for (const f of listRuleFiles(join(ROOT, "rules"))) {
    const r = readRuleFile(f);
    const issues = validateRules(r);
    assert.deepEqual(issues, [], `${f}: ${JSON.stringify(issues)}`);
    if (r.status === "draft") {
      assert.throws(() => assertUsable(r, false), /DRAFT|draft/);
      assert.doesNotThrow(() => assertUsable(r, true));
    }
  }
});

test("incomplete rule files are refused even with allowDraft", () => {
  const r = readRuleFile(join(ROOT, "rules", "us-federal", "2026.json")) as any;
  const broken = { ...r, fica: { ...r.fica, socialSecurity: { ...r.fica.socialSecurity, value: { ...r.fica.socialSecurity.value, wageBase: null } } } };
  assert.throws(() => assertUsable(broken, true), /not usable/);
});

test("verified status requires a verification record", () => {
  const r = readRuleFile(join(ROOT, "test", "fixtures", "rules", "us-federal-2099.json"));
  const bad = { ...r, verification: null };
  assert.ok(validateRules(bad).some(i => i.path === "verification"));
});
