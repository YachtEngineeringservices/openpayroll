#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RuleSet, listRuleFiles, readRuleFile, validateRules } from "./rules.js";
import { runPayRun } from "./engine.js";
import { buildJournal, type AccountMap } from "./journal.js";
import { toBigcapital, postManualJournal } from "./adapters/bigcapital.js";
import { summarizeQuarter } from "./summary.js";
import type { PayRunInput, PayRunResult } from "./types.js";

const USAGE = `openpayroll <command>

  validate <rulesDir>                         check every rule file (structure, citations, bracket continuity)
  run --rules <dir> --input <pay.json>        compute one pay run, print the result as JSON
      [--allow-draft] [--trace]
      [--journal <accounts.json>]             also print the balanced journal entry
      [--bigcapital <bigcapital.json>]        print the Bigcapital manual-journal payload (dry run)
      [--post]                                ...and POST it (created unpublished unless config says publish)
  summary --results <dir> --year Y --quarter Q   quarter totals + Form 941 / DE 9 figures from saved results
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

async function main() {
  const cmd = process.argv[2];
  if (cmd === "validate") {
    const dir = process.argv[3] ?? "rules";
    let bad = 0;
    for (const f of listRuleFiles(dir)) {
      const r = readRuleFile(f);
      const issues = validateRules(r);
      const errs = issues.filter(i => i.level === "error").length;
      const inc = issues.filter(i => i.level === "incomplete").length;
      const state = errs ? "ERRORS" : inc ? "INCOMPLETE" : r.status.toUpperCase();
      console.log(`${state.padEnd(10)} ${f}  (${errs} errors, ${inc} incomplete)`);
      for (const i of issues.slice(0, 25)) console.log(`   ${i.level.padEnd(10)} ${i.path}: ${i.message}`);
      if (issues.length > 25) console.log(`   ... ${issues.length - 25} more`);
      if (errs) bad++;
    }
    process.exitCode = bad ? 1 : 0;
    return;
  }
  if (cmd === "run") {
    const rules = RuleSet.load(arg("rules") ?? "rules");
    const input = readJson<PayRunInput>(arg("input") ?? "");
    const result = runPayRun(input, rules, { allowDraft: flag("allow-draft"), trace: flag("trace") });
    const out: Record<string, unknown> = { result };
    const acctPath = arg("journal");
    if (acctPath) {
      const journal = buildJournal(result, readJson<AccountMap>(acctPath));
      out.journal = journal;
      const bcPath = arg("bigcapital");
      if (bcPath) {
        const cfg = readJson<{ baseUrl: string; apiKey: string; publish?: boolean }>(bcPath);
        const payload = toBigcapital(journal, cfg);
        out.bigcapitalPayload = payload;
        if (flag("post")) {
          if (result.rulesUsed.some(r => r.status !== "verified")) throw new Error("refusing to post a journal computed with DRAFT rules");
          out.bigcapitalResponse = await postManualJournal(payload, cfg);
        }
      }
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (cmd === "summary") {
    const dir = arg("results") ?? "";
    const results = readdirSync(dir).filter(f => f.endsWith(".json"))
      .map(f => readJson<{ result?: PayRunResult } & PayRunResult>(join(dir, f)))
      .map(x => x.result ?? x);
    console.log(JSON.stringify(summarizeQuarter(results, Number(arg("year")), Number(arg("quarter")) as 1 | 2 | 3 | 4), null, 2));
    return;
  }
  console.log(USAGE);
  process.exitCode = cmd ? 2 : 0;
}

main().catch(e => { console.error(`error: ${e instanceof Error ? e.message : e}`); process.exitCode = 1; });
