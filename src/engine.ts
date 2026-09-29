import { Dec, D } from "./money.js";
import { assertUsable, type RuleSet } from "./rules.js";
import { federalIncomeTax, fica, futa } from "./federal.js";
import { californiaPit, californiaSdi, californiaUi, californiaEtt } from "./california.js";
import type { CaliforniaRules, FederalRules, PayRunInput, PayRunResult, TaxKey, TaxLine } from "./types.js";

export const ENGINE_VERSION = "0.1.0";

export interface RunOptions {
  /** Permit DRAFT (unverified) rule files. For shadow comparisons only. */
  allowDraft?: boolean;
  /** Include the worksheet trace for each computed tax. */
  trace?: boolean;
}

export function runPayRun(input: PayRunInput, rules: RuleSet, opts: RunOptions = {}): PayRunResult & { trace?: Record<string, Record<string, string>> } {
  const warnings: string[] = [];
  const { period, employee, employer } = input;
  const date = period.payDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`payDate must be YYYY-MM-DD, got ${date}`);

  const fed = rules.forDate<FederalRules>("US", date);
  warnings.push(...assertUsable(fed, !!opts.allowDraft));
  let ca: CaliforniaRules | undefined;
  if (employee.workState === "CA") {
    ca = rules.forDate<CaliforniaRules>("US-CA", date);
    warnings.push(...assertUsable(ca, !!opts.allowDraft));
    if (!employee.de4) throw new Error("California employee requires a DE 4 (employee.de4)");
  }

  // ---- gross and taxable wage bases
  if (input.earnings.length === 0) throw new Error("no earnings");
  let gross = Dec.ZERO;
  for (const e of input.earnings) {
    const a = D(e.amount);
    if (a.isNeg()) throw new Error(`negative earnings line ${e.code}`);
    gross = gross.add(a);
    if (e.supplemental) warnings.push(`earnings "${e.code}" is supplemental: withheld with regular wages (aggregate method). Flat-rate supplemental withholding is not implemented.`);
  }
  const preTax = input.preTax ?? [];
  const taxable = (k: TaxKey) => preTax.filter(p => p.reduces.includes(k)).reduce((w, p) => w.sub(D(p.amount)), gross).floor0();
  const preTaxTotal = preTax.reduce((s, p) => s.add(D(p.amount)), Dec.ZERO);
  if (preTaxTotal.gt(gross)) throw new Error("pre-tax deductions exceed gross pay");

  const ex = employee.exempt ?? {};
  const ytd = { ss: D(input.ytd.ssWages), med: D(input.ytd.medicareWages), futa: D(input.ytd.futaWages), caUi: D(input.ytd.caUiWages), caSdi: D(input.ytd.caSdiWages) };
  const lines: TaxLine[] = [];
  const trace: Record<string, Record<string, string>> = {};
  const line = (code: string, label: string, payer: TaxLine["payer"], c: { amount: Dec; taxable: Dec; refs: TaxLine["ruleRefs"]; trace?: Record<string, string> }) => {
    lines.push({ code, label, payer, taxableWages: c.taxable.toMoney(), amount: c.amount.toMoney(), ruleRefs: c.refs });
    if (opts.trace && c.trace) trace[code] = c.trace;
  };

  // ---- federal
  const fitWages = taxable("fit");
  if (!ex.fit) line("fit", "Federal income tax", "employee", federalIncomeTax(fed, employee.w4, fitWages, period.frequency));
  const ficaWages = taxable("fica");
  if (!ex.fica) {
    const f = fica(fed, ficaWages, ytd.ss, ytd.med);
    line("ss_ee", "Social Security (employee)", "employee", f.ssEmployee);
    line("medicare_ee", "Medicare (employee)", "employee", f.medEmployee);
    if (!f.addlMedicare.amount.isZero()) line("addl_medicare_ee", "Additional Medicare (employee)", "employee", f.addlMedicare);
    line("ss_er", "Social Security (employer)", "employer", f.ssEmployer);
    line("medicare_er", "Medicare (employer)", "employer", f.medEmployer);
  }
  const futaWages = taxable("futa");
  if (!ex.futa) line("futa", "FUTA (net of max state credit)", "employer", futa(fed, futaWages, ytd.futa));
  const cr = fed.futa.value.creditReductionByState?.[employee.workState];
  if (cr) warnings.push(`FUTA credit reduction for ${employee.workState} (${cr}) is owed with Form 940 / the Q4 deposit, not per pay run.`);

  // ---- California
  const caSdiWages = taxable("caSdi");
  const caUiWages = taxable("caUi");
  if (ca && employee.de4) {
    if (!ex.caPit) line("ca_pit", "California PIT", "employee", californiaPit(ca, employee.de4, taxable("caPit"), period.frequency, { method: employer.caPitMethod, periodsPerYear: fed.payPeriodsPerYear.value[period.frequency] }));
    if (!ex.caSdi) line("ca_sdi", "California SDI", "employee", californiaSdi(ca, caSdiWages, ytd.caSdi));
    if (!ex.caUi) {
      if (!employer.caUiRate) warnings.push(`No employer UI rate set: using the new-employer rate ${ca.ui.value.newEmployerRate}. Set employer.caUiRate from your EDD rate notice.`);
      line("ca_ui", "California UI", "employer", californiaUi(ca, caUiWages, ytd.caUi, employer.caUiRate));
      line("ca_ett", "California ETT", "employer", californiaEtt(ca, caUiWages, ytd.caUi));
    }
  }

  // ---- totals
  const sum = (payer: TaxLine["payer"]) => lines.filter(l => l.payer === payer).reduce((s, l) => s.add(D(l.amount)), Dec.ZERO);
  const eeTax = sum("employee");
  const erTax = sum("employer");
  const net = gross.sub(preTaxTotal).sub(eeTax);
  if (net.isNeg()) throw new Error(`net pay would be negative (${net.toMoney()}); check deductions and withholding`);

  const result: PayRunResult & { trace?: Record<string, Record<string, string>> } = {
    engine: { name: "openpayroll", version: ENGINE_VERSION },
    rulesUsed: [fed, ...(ca ? [ca] : [])].map(r => ({ jurisdiction: r.jurisdiction, taxYear: r.taxYear, status: r.status })),
    employeeId: employee.id,
    period,
    gross: gross.toMoney(),
    preTax: preTax.map(p => ({ code: p.code, amount: D(p.amount).toMoney() })),
    taxes: lines,
    employeeTaxTotal: eeTax.toMoney(),
    employerTaxTotal: erTax.toMoney(),
    netPay: net.toMoney(),
    ytdAfter: {
      ssWages: ytd.ss.add(ex.fica ? Dec.ZERO : ficaWages).toMoney(),
      medicareWages: ytd.med.add(ex.fica ? Dec.ZERO : ficaWages).toMoney(),
      futaWages: ytd.futa.add(ex.futa ? Dec.ZERO : futaWages).toMoney(),
      caUiWages: ytd.caUi.add(ex.caUi || !ca ? Dec.ZERO : caUiWages).toMoney(),
      caSdiWages: ytd.caSdi.add(ex.caSdi || !ca ? Dec.ZERO : caSdiWages).toMoney(),
    },
    warnings,
  };
  if (opts.trace) result.trace = trace;
  return result;
}
