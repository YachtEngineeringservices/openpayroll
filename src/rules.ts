import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Dec, D } from "./money.js";
import type { AnyRules, BracketRow, CaliforniaRules, Cited, FederalRules, SourceRef } from "./types.js";

export interface Issue { level: "error" | "incomplete"; path: string; message: string }

/**
 * Structural checks on one bracket table. These catch the typical transcription
 * errors (a mistyped base amount, a shifted row) without needing the source PDF:
 * every row's base must equal the previous base plus the previous rate times the width.
 */
export function checkBrackets(rows: BracketRow[] | undefined, path: string, tolerance = "0.01"): Issue[] {
  const out: Issue[] = [];
  if (!rows || rows.length === 0) return [{ level: "incomplete", path, message: "table is empty" }];
  const tol = D(tolerance);
  rows.forEach((r, i) => {
    const p = `${path}[${i}]`;
    for (const k of ["atLeast", "base", "rate", "excessOver"] as const) {
      if (r[k] === null || r[k] === undefined || r[k] === "") { out.push({ level: "incomplete", path: `${p}.${k}`, message: "missing" }); return; }
    }
    const rate = D(r.rate);
    if (rate.isNeg() || rate.gt("1")) out.push({ level: "error", path: `${p}.rate`, message: `rate ${r.rate} outside 0..1 (use a fraction, e.g. 0.12)` });
    if (!D(r.excessOver).eq(D(r.atLeast))) out.push({ level: "error", path: p, message: `excessOver ${r.excessOver} != atLeast ${r.atLeast}` });
    if (i === 0) {
      if (!D(r.atLeast).isZero()) out.push({ level: "error", path: `${p}.atLeast`, message: "first row must start at 0" });
      if (!D(r.base).isZero()) out.push({ level: "error", path: `${p}.base`, message: "first row base must be 0" });
    } else {
      const prev = rows[i - 1]!;
      if (prev.lessThan === null || !D(prev.lessThan).eq(D(r.atLeast)))
        out.push({ level: "error", path: p, message: `gap/overlap: previous lessThan ${prev.lessThan} != atLeast ${r.atLeast}` });
      const expected = D(prev.base).add(D(prev.rate).mul(D(r.atLeast).sub(D(prev.atLeast))));
      const diff = expected.sub(D(r.base));
      if ((diff.isNeg() ? diff.neg() : diff).gt(tol))
        out.push({ level: "error", path: `${p}.base`, message: `base ${r.base} but previous row implies ${expected.toString()} (transcription error?)` });
    }
    if (r.lessThan !== null && D(r.lessThan).lte(D(r.atLeast))) out.push({ level: "error", path: p, message: "lessThan must exceed atLeast" });
  });
  const last = rows[rows.length - 1]!;
  if (last.lessThan !== null) out.push({ level: "error", path: `${path}[${rows.length - 1}].lessThan`, message: "last row must be open-ended (null)" });
  return out;
}

function checkRef(c: Cited<unknown> | undefined, path: string, ids: Set<string>): Issue[] {
  if (!c) return [{ level: "incomplete", path, message: "missing" }];
  const out: Issue[] = [];
  const ref: SourceRef | undefined = c.ref;
  if (!ref || !ref.source || !ref.locator) out.push({ level: "error", path: `${path}.ref`, message: "every value needs a source ref {source, locator}" });
  else if (!ids.has(ref.source)) out.push({ level: "error", path: `${path}.ref.source`, message: `unknown source id "${ref.source}"` });
  if (c.value === null || c.value === undefined) out.push({ level: "incomplete", path: `${path}.value`, message: "not transcribed yet" });
  return out;
}

/** Report null leaves as "not transcribed yet". Keys in allowNull may legitimately be null. */
function nullLeaves(v: unknown, path: string, allowNull: string[] = []): Issue[] {
  if (v === null) return [{ level: "incomplete", path, message: "not transcribed yet" }];
  if (Array.isArray(v)) return v.flatMap((x, i) => nullLeaves(x, `${path}[${i}]`, allowNull));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => allowNull.includes(k) ? [] : nullLeaves(x, `${path}.${k}`, allowNull));
  return [];
}

export function validateRules(r: AnyRules): Issue[] {
  const out: Issue[] = [];
  const ids = new Set((r.sources ?? []).map(s => s.id));
  if (!r.taxYear || !r.effectiveFrom || !r.effectiveTo) out.push({ level: "error", path: "meta", message: "taxYear/effectiveFrom/effectiveTo required" });
  if (r.status === "verified" && !(r.verification && r.verification.by && r.verification.on))
    out.push({ level: "error", path: "verification", message: "status 'verified' requires verification {by, on, method}" });

  if (r.jurisdiction === "US") {
    const f = r as FederalRules;
    out.push(...checkRef(f.payPeriodsPerYear, "payPeriodsPerYear", ids));
    out.push(...checkRef(f.fit?.w4_2020?.line1gDeduction, "fit.w4_2020.line1gDeduction", ids), ...nullLeaves(f.fit?.w4_2020?.line1gDeduction?.value, "fit.w4_2020.line1gDeduction.value"));
    out.push(...checkRef(f.fit?.w4_legacy?.allowanceValue, "fit.w4_legacy.allowanceValue", ids));
    for (const kind of ["standard", "checkbox"] as const) {
      const c = f.fit?.w4_2020?.[kind];
      out.push(...checkRef(c, `fit.w4_2020.${kind}`, ids));
      const tol = c?.continuityTolerance;
      if (tol && !(tol.amount && tol.reason)) out.push({ level: "error", path: `fit.w4_2020.${kind}.continuityTolerance`, message: "needs amount and reason" });
      for (const s of ["mfj", "single", "hoh"] as const) out.push(...checkBrackets(c?.value?.[s], `fit.w4_2020.${kind}.${s}`, tol?.amount ?? "0.005"));
    }
    out.push(...checkRef(f.fica?.socialSecurity, "fica.socialSecurity", ids), ...nullLeaves(f.fica?.socialSecurity?.value, "fica.socialSecurity.value"));
    out.push(...checkRef(f.fica?.medicare, "fica.medicare", ids), ...nullLeaves(f.fica?.medicare?.value, "fica.medicare.value"));
    out.push(...checkRef(f.futa, "futa", ids), ...nullLeaves(f.futa?.value, "futa.value", ["creditReductionByState"]));
  } else if (r.jurisdiction === "US-CA") {
    const c = r as CaliforniaRules;
    for (const k of ["lowIncomeExemption", "estimatedDeduction", "standardDeduction", "exemptionAllowance"] as const) {
      out.push(...checkRef(c.pit?.[k], `pit.${k}`, ids), ...nullLeaves(c.pit?.[k]?.value, `pit.${k}.value`));
      if (c.pit?.[k]?.value && Object.keys(c.pit[k].value).length === 0) out.push({ level: "incomplete", path: `pit.${k}`, message: "no pay-frequency tables transcribed" });
    }
    out.push(...checkRef(c.pit?.rates, "pit.rates", ids));
    const rates = c.pit?.rates?.value ?? {};
    if (Object.keys(rates).length === 0) out.push({ level: "incomplete", path: "pit.rates", message: "no pay-frequency tables transcribed" });
    for (const [freq, byStatus] of Object.entries(rates)) for (const s of ["single", "married", "hoh"] as const)
      out.push(...checkBrackets(byStatus?.[s], `pit.rates.${freq}.${s}`, c.pit.rates.continuityTolerance?.amount ?? "0.01"));
    out.push(...checkRef(c.sdi, "sdi", ids), ...nullLeaves(c.sdi?.value, "sdi.value", ["wageBase"]));
    out.push(...checkRef(c.ui, "ui", ids), ...nullLeaves(c.ui?.value, "ui.value"));
    out.push(...checkRef(c.ett, "ett", ids), ...nullLeaves(c.ett?.value, "ett.value"));
  } else {
    out.push({ level: "error", path: "jurisdiction", message: `unsupported jurisdiction ${(r as AnyRules).jurisdiction}` });
  }
  return out;
}

export function readRuleFile(path: string): AnyRules {
  return JSON.parse(readFileSync(path, "utf8")) as AnyRules;
}

/** All *.json rule files under a directory tree. */
export function listRuleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listRuleFiles(p));
    else if (name.endsWith(".json") && !name.endsWith(".schema.json")) out.push(p);
  }
  return out.sort();
}

export class RuleSet {
  constructor(readonly files: AnyRules[]) {}

  static load(dir: string): RuleSet {
    return new RuleSet(listRuleFiles(dir).map(readRuleFile));
  }

  /** The rule file for a jurisdiction covering `date` (ISO). */
  forDate<T extends AnyRules>(jurisdiction: T["jurisdiction"], date: string): T {
    const hit = this.files.filter(f => f.jurisdiction === jurisdiction && f.effectiveFrom <= date && date <= f.effectiveTo);
    if (hit.length === 0) throw new Error(`no ${jurisdiction} rules cover ${date}`);
    if (hit.length > 1) throw new Error(`ambiguous: ${hit.length} ${jurisdiction} rule files cover ${date}`);
    return hit[0] as T;
  }
}

/** Throws unless the file is complete and error-free; drafts are refused unless allowDraft. */
export function assertUsable(r: AnyRules, allowDraft: boolean): string[] {
  const issues = validateRules(r);
  const errors = issues.filter(i => i.level === "error");
  const incomplete = issues.filter(i => i.level === "incomplete");
  if (errors.length || incomplete.length) {
    const list = [...errors, ...incomplete].slice(0, 10).map(i => `  ${i.level}: ${i.path}: ${i.message}`).join("\n");
    throw new Error(`${r.jurisdiction} ${r.taxYear} rules are not usable (${errors.length} errors, ${incomplete.length} incomplete):\n${list}`);
  }
  if (r.status !== "verified") {
    if (!allowDraft) throw new Error(`${r.jurisdiction} ${r.taxYear} rules are DRAFT (not verified against the source documents). Use --allow-draft only for shadow runs.`);
    return [`${r.jurisdiction} ${r.taxYear} rules are DRAFT: results are for comparison only, not for paying or filing.`];
  }
  return [];
}

export function lookupBracket(rows: BracketRow[], amount: Dec): BracketRow {
  const row = rows.find(r => amount.gte(D(r.atLeast)) && (r.lessThan === null || amount.lt(D(r.lessThan))));
  if (!row) throw new Error(`no bracket row for ${amount.toString()}`);
  return row;
}

/** base + rate * (amount - excessOver), exact */
export function applyBracket(rows: BracketRow[], amount: Dec): Dec {
  const r = lookupBracket(rows, amount);
  return D(r.base).add(D(r.rate).mul(amount.sub(D(r.excessOver))));
}
