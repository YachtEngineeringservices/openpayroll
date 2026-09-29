/**
 * Golden cases: agency worked examples (IRS Pub 15-T, EDD DE 44) copied verbatim into
 * test/golden/*.json and run against the REAL rule files in /rules.
 * A rule file may only be marked "verified" once every golden case for its year passes.
 * Files starting with "_" are templates and are skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runPayRun } from "../src/engine.js";
import { D } from "../src/money.js";
import { ROOT, realRules } from "./helpers.js";
import type { PayRunInput } from "../src/types.js";

interface Golden { id: string; source: { doc: string; locator: string }; input: PayRunInput; expect: Record<string, string>; tolerance?: string }

const dir = join(ROOT, "test", "golden");
const cases = readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith("_"))
  .map(f => JSON.parse(readFileSync(join(dir, f), "utf8")) as Golden);

if (cases.length === 0) test("golden: no agency examples transcribed yet", { skip: "add cases to test/golden" }, () => {});

for (const g of cases) {
  test(`golden ${g.id} (${g.source.doc}, ${g.source.locator})`, () => {
    const r = runPayRun(g.input, realRules(), { allowDraft: true });
    const tol = D(g.tolerance ?? "0");
    for (const [code, want] of Object.entries(g.expect)) {
      const got = code === "netPay" ? r.netPay : r.taxes.find(t => t.code === code)?.amount ?? "0.00";
      const diff = D(got).sub(want);
      assert.ok((diff.isNeg() ? diff.neg() : diff).lte(tol), `${code}: got ${got}, agency example says ${want}`);
    }
  });
}
