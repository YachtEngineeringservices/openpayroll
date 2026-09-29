import { Dec, D } from "./money.js";
import { applyBracket } from "./rules.js";
import type { FederalRules, Frequency, SourceRef, W4_2020, W4Legacy } from "./types.js";

export interface Computed { amount: Dec; taxable: Dec; refs: SourceRef[]; trace?: Record<string, string> }

/**
 * Federal income tax withholding: IRS Pub 15-T, Worksheet 1A
 * ("Percentage Method Tables for Automated Payroll Systems").
 * Line numbers in comments match the worksheet.
 */
export function federalIncomeTax(rules: FederalRules, w4: W4_2020 | W4Legacy, wages: Dec, freq: Frequency): Computed {
  const periods = rules.payPeriodsPerYear.value[freq];
  if (!periods) throw new Error(`no pay-period count for ${freq}`);
  const w = rules.fit.w4_2020;
  const refs: SourceRef[] = [rules.payPeriodsPerYear.ref];
  const t: Record<string, string> = {};

  const l1c = wages.mul(BigInt(periods));                                     // 1a x 1b
  t["1a"] = wages.toString(); t["1b"] = String(periods); t["1c"] = l1c.toString();

  let adjusted: Dec;
  let table;
  let credits = Dec.ZERO;
  let extra: Dec;

  if (w4.version === "2020+") {
    const l1e = l1c.add(D(w4.step4aOtherIncome));                             // 1d, 1e
    const l1g = w4.step2Checkbox ? Dec.ZERO
      : D(w4.filingStatus === "mfj" ? w.line1gDeduction.value.mfj : w.line1gDeduction.value.other);
    const l1h = D(w4.step4bDeductions).add(l1g);                              // 1f + 1g
    adjusted = l1e.sub(l1h).floor0();                                         // 1i
    const sched = w4.step2Checkbox ? w.checkbox : w.standard;
    table = sched.value[w4.filingStatus];
    refs.push(w.line1gDeduction.ref, sched.ref);
    credits = D(w4.step3Credits);                                             // 3a
    extra = D(w4.step4cExtra);                                                // 4a
    Object.assign(t, { "1e": l1e.toString(), "1g": l1g.toString(), "1h": l1h.toString(), "1i": adjusted.toString() });
  } else {
    const l1k = D(rules.fit.w4_legacy.allowanceValue.value).mul(BigInt(w4.allowances));
    adjusted = l1c.sub(l1k).floor0();                                         // 1l
    table = w.standard.value[w4.maritalStatus === "married" ? "mfj" : "single"];
    refs.push(rules.fit.w4_legacy.allowanceValue.ref, w.standard.ref);
    extra = D(w4.additional);
    Object.assign(t, { "1k": l1k.toString(), "1l": adjusted.toString() });
  }

  const l2g = applyBracket(table, adjusted);                                  // 2b..2g
  const l2h = l2g.div(BigInt(periods));
  const l3b = credits.div(BigInt(periods));
  const l3c = l2h.sub(l3b).floor0();
  const l4b = l3c.add(extra);
  Object.assign(t, { "2g": l2g.toString(), "2h": l2h.toString(), "3b": l3b.toString(), "3c": l3c.toString(), "4b": l4b.toString() });

  return { amount: l4b.round(2), taxable: wages, refs, trace: t };
}

/** Portion of `wages` that falls under an annual wage base, given wages already taxed YTD. */
export function underWageBase(wages: Dec, ytd: Dec, base: Dec): Dec {
  return Dec.min(wages, base.sub(ytd).floor0());
}

export interface FicaResult {
  ssEmployee: Computed; ssEmployer: Computed;
  medEmployee: Computed; medEmployer: Computed; addlMedicare: Computed;
}

/** Social Security + Medicare (+ Additional Medicare withholding over the threshold). */
export function fica(rules: FederalRules, wages: Dec, ytdSs: Dec, ytdMed: Dec): FicaResult {
  const ss = rules.fica.socialSecurity; const med = rules.fica.medicare;
  const ssTaxable = underWageBase(wages, ytdSs, D(ss.value.wageBase));
  const threshold = D(med.value.additionalThreshold);
  // Additional Medicare applies to wages paid in excess of the threshold in the calendar year.
  const addlTaxable = ytdMed.add(wages).sub(threshold).floor0().sub(ytdMed.sub(threshold).floor0());
  return {
    ssEmployee: { amount: ssTaxable.mul(D(ss.value.employeeRate)).round(2), taxable: ssTaxable, refs: [ss.ref] },
    ssEmployer: { amount: ssTaxable.mul(D(ss.value.employerRate)).round(2), taxable: ssTaxable, refs: [ss.ref] },
    medEmployee: { amount: wages.mul(D(med.value.employeeRate)).round(2), taxable: wages, refs: [med.ref] },
    medEmployer: { amount: wages.mul(D(med.value.employerRate)).round(2), taxable: wages, refs: [med.ref] },
    addlMedicare: { amount: addlTaxable.mul(D(med.value.additionalEmployeeRate)).round(2), taxable: addlTaxable, refs: [med.ref] },
  };
}

/** FUTA at the net rate (gross rate less the maximum state credit). Credit reductions are a year-end 940 item. */
export function futa(rules: FederalRules, wages: Dec, ytd: Dec): Computed {
  const f = rules.futa.value;
  const taxable = underWageBase(wages, ytd, D(f.wageBase));
  const net = D(f.grossRate).sub(D(f.maxCredit));
  return { amount: taxable.mul(net).round(2), taxable, refs: [rules.futa.ref] };
}
