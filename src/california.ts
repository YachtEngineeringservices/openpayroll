import { Dec, D } from "./money.js";
import { applyBracket } from "./rules.js";
import { underWageBase, type Computed } from "./federal.js";
import type { CaliforniaRules, DE4, Frequency } from "./types.js";


function table<T>(byFreq: Partial<Record<Frequency, T>>, freq: Frequency, name: string): T {
  const t = byFreq[freq];
  if (!t) throw new Error(`CA ${name}: no ${freq} table transcribed`);
  return t;
}

/** Look up a per-allowance-count table; counts beyond the table use the "perAllowance" entry x count. */
function byCount(t: Record<string, string>, n: number, name: string): Dec {
  if (n === 0 && t["0"] === undefined) return Dec.ZERO;
  const exact = t[String(n)];
  if (exact !== undefined) return D(exact);
  const per = t["perAllowance"];
  if (per !== undefined) return D(per).mul(BigInt(n));
  throw new Error(`CA ${name}: no entry for ${n} allowances and no perAllowance value`);
}

function statusKey(de4: DE4): string {
  if (de4.filingStatus === "married") return de4.regularAllowances >= 2 ? "married_2plus" : "married_0_1";
  return de4.filingStatus;   // "single" | "hoh"
}

/**
 * California PIT withholding, EDD DE 44 "Method B - Exact Calculation Method".
 *   1. wages <= low income exemption  -> no withholding
 *   2. less estimated deduction (additional allowances for estimated deductions)
 *   3. less standard deduction
 *   4. tax from the rate table for the pay period
 *   5. less exemption allowance credit (regular allowances); floor at 0; plus additional amount
 */
export function californiaPit(rules: CaliforniaRules, de4: DE4, wages: Dec, freq: Frequency,
  opts: { method?: "period" | "annualized"; periodsPerYear?: number } = {}): Computed {
  const p = rules.pit;
  const key = statusKey(de4);
  const refs = [p.lowIncomeExemption.ref, p.estimatedDeduction.ref, p.standardDeduction.ref, p.rates.ref, p.exemptionAllowance.ref];
  const t: Record<string, string> = { status: key, wages: wages.toString() };

  const low = table(p.lowIncomeExemption.value, freq, "low income exemption")[key];
  if (low === undefined) throw new Error(`CA low income exemption: no "${key}" column`);
  t["lowIncomeExemption"] = low;
  if (wages.lte(D(low))) {
    return { amount: D(de4.additional).round(2), taxable: wages, refs, trace: { ...t, result: "below low income exemption" } };
  }

  // Steps 2-5. "annualized": annual wages through the annual tables, then divided by pay periods (DE 44 Example E).
  const annualized = opts.method === "annualized" && freq !== "annual";
  const n = opts.periodsPerYear;
  if (annualized && !n) throw new Error("CA annualized method needs periodsPerYear");
  const f: Frequency = annualized ? "annual" : freq;
  const base = annualized ? wages.mul(BigInt(n!)) : wages;
  const estDed = de4.estimatedDeductionAllowances > 0
    ? byCount(table(p.estimatedDeduction.value, f, "estimated deduction"), de4.estimatedDeductionAllowances, "estimated deduction")
    : Dec.ZERO;
  const std = table(p.standardDeduction.value, f, "standard deduction")[key];
  if (std === undefined) throw new Error(`CA standard deduction: no "${key}" column`);
  const taxableIncome = base.sub(estDed).sub(D(std)).floor0();
  const rateStatus = de4.filingStatus;       // rate tables: single | married | hoh
  const tax = applyBracket(table(p.rates.value, f, "tax rate")[rateStatus], taxableIncome);
  const credit = byCount(table(p.exemptionAllowance.value, f, "exemption allowance"), de4.regularAllowances, "exemption allowance");
  const net = tax.sub(credit).floor0();
  const withheld = (annualized ? net.div(BigInt(n!)) : net).add(D(de4.additional));
  t["method"] = annualized ? `annualized x${n}` : "period";
  Object.assign(t, { estimatedDeduction: estDed.toString(), standardDeduction: std, taxableIncome: taxableIncome.toString(),
    computedTax: tax.toString(), exemptionCredit: credit.toString() });
  return { amount: withheld.round(2), taxable: wages, refs, trace: t };
}

export function californiaSdi(rules: CaliforniaRules, wages: Dec, ytd: Dec): Computed {
  const s = rules.sdi.value;
  const taxable = s.wageBase === null ? wages : underWageBase(wages, ytd, D(s.wageBase));
  return { amount: taxable.mul(D(s.employeeRate)).round(2), taxable, refs: [rules.sdi.ref] };
}

export function californiaUi(rules: CaliforniaRules, wages: Dec, ytd: Dec, employerRate?: string): Computed {
  const u = rules.ui.value;
  const taxable = underWageBase(wages, ytd, D(u.wageBase));
  return { amount: taxable.mul(D(employerRate ?? u.newEmployerRate)).round(2), taxable, refs: [rules.ui.ref] };
}

export function californiaEtt(rules: CaliforniaRules, wages: Dec, ytd: Dec): Computed {
  const e = rules.ett.value;
  const taxable = underWageBase(wages, ytd, D(e.wageBase));
  return { amount: taxable.mul(D(e.rate)).round(2), taxable, refs: [rules.ett.ref] };
}
