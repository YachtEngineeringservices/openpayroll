import { Dec, D } from "./money.js";
import type { PayRunResult } from "./types.js";

export interface QuarterSummary {
  year: number;
  quarter: 1 | 2 | 3 | 4;
  payRuns: number;
  employees: string[];
  totals: Record<string, string>;
  /** Figures laid out the way the returns ask for them. Check line numbers against the current form. */
  form941: Record<string, string>;
  de9: Record<string, string>;
  /** Form 941 line 1: employees whose pay period includes the 12th of the quarter's third month. */
  employeesOn12th: number;
  /** DE 9C item A: employees paid for the pay period that includes the 12th, per month of the quarter. */
  employeesOn12thByMonth: [number, number, number];
  /** DE 9C lines: per employee, subject wages (SDI-subject wages, which have no cap), PIT wages, PIT withheld. */
  de9cEmployees: { employeeId: string; subjectWages: string; pitWages: string; pitWithheld: string }[];
  /** Form 941 line 16 (monthly depositor): federal liability by month of pay date, months 1..3 of the quarter. */
  monthlyLiability: [string, string, string];
}

const q = (date: string) => (Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1) as 1 | 2 | 3 | 4;

/** Aggregate saved pay-run results (by pay date) into one calendar quarter. */
export function summarizeQuarter(results: PayRunResult[], year: number, quarter: 1 | 2 | 3 | 4): QuarterSummary {
  const rs = results.filter(r => Number(r.period.payDate.slice(0, 4)) === year && q(r.period.payDate) === quarter);
  const amt = (code: string) => rs.flatMap(r => r.taxes).filter(t => t.code === code).reduce((s, t) => s.add(D(t.amount)), Dec.ZERO);
  const wages = (code: string) => rs.flatMap(r => r.taxes).filter(t => t.code === code).reduce((s, t) => s.add(D(t.taxableWages)), Dec.ZERO);

  const fitWages = wages("fit"), fit = amt("fit");
  const ssWages = wages("ss_ee"), medWages = wages("medicare_ee"), addlWages = wages("addl_medicare_ee");
  const ssTax = amt("ss_ee").add(amt("ss_er"));
  const medTax = amt("medicare_ee").add(amt("medicare_er"));
  const addlTax = amt("addl_medicare_ee");

  // 941 computes column 2 as wages x combined rate; the difference from what was actually
  // withheld/owed per paycheck is the "fractions of cents" adjustment.
  const col5a = ssWages.mul("0.124").round(2);
  const col5c = medWages.mul("0.029").round(2);
  const col5d = addlWages.mul("0.009").round(2);
  const fractions = ssTax.add(medTax).add(addlTax).sub(col5a.add(col5c).add(col5d));

  const totals: Record<string, string> = {};
  for (const code of ["fit", "ss_ee", "ss_er", "medicare_ee", "medicare_er", "addl_medicare_ee", "futa", "ca_pit", "ca_sdi", "ca_ui", "ca_ett"])
    totals[code] = amt(code).toMoney();

  // Line 16: FIT + SS (both halves) + Medicare (both halves) + Additional Medicare, by month the wages were paid.
  const fed = new Set(["fit", "ss_ee", "ss_er", "medicare_ee", "medicare_er", "addl_medicare_ee"]);
  const month = (i: number) => rs.filter(r => Number(r.period.payDate.slice(5, 7)) === (quarter - 1) * 3 + i + 1)
    .flatMap(r => r.taxes).filter(t => fed.has(t.code)).reduce((s, t) => s.add(D(t.amount)), Dec.ZERO).toMoney();
  const onThe12th = (m: number) => {
    const d = `${year}-${String((quarter - 1) * 3 + m).padStart(2, "0")}-12`;
    return new Set(rs.filter(r => r.period.start <= d && d <= r.period.end && D(r.gross ?? "0").gt(Dec.ZERO)).map(r => r.employeeId)).size;
  };
  const perEmp = (id: string, code: string, f: "amount" | "taxableWages") =>
    rs.filter(r => r.employeeId === id).flatMap(r => r.taxes).filter(t => t.code === code).reduce((s, t) => s.add(D(t[f])), Dec.ZERO).toMoney();

  return {
    year, quarter,
    payRuns: rs.length,
    employees: [...new Set(rs.map(r => r.employeeId))],
    totals,
    form941: {
      "2  wages, tips, other compensation": fitWages.toMoney(),
      "3  federal income tax withheld": fit.toMoney(),
      "5a taxable social security wages": ssWages.toMoney(),
      "5a col 2 (x 0.124)": col5a.toMoney(),
      "5c taxable Medicare wages": medWages.toMoney(),
      "5c col 2 (x 0.029)": col5c.toMoney(),
      "5d wages subject to Additional Medicare": addlWages.toMoney(),
      "5d col 2 (x 0.009)": col5d.toMoney(),
      "7  fractions of cents adjustment": fractions.toMoney(),
      "12 total taxes after adjustments (expected deposits)": fit.add(ssTax).add(medTax).add(addlTax).toMoney(),
    },
    de9: {
      "UI taxable wages": wages("ca_ui").toMoney(),
      "SDI taxable wages": wages("ca_sdi").toMoney(),
      "PIT wages": wages("ca_pit").toMoney(),
      "UI contributions": amt("ca_ui").toMoney(),
      "ETT contributions": amt("ca_ett").toMoney(),
      "SDI withheld": amt("ca_sdi").toMoney(),
      "PIT withheld": amt("ca_pit").toMoney(),
    },
    employeesOn12th: onThe12th(3),
    employeesOn12thByMonth: [onThe12th(1), onThe12th(2), onThe12th(3)],
    de9cEmployees: [...new Set(rs.map(r => r.employeeId))].sort().map(id => ({
      employeeId: id, subjectWages: perEmp(id, "ca_sdi", "taxableWages"), pitWages: perEmp(id, "ca_pit", "taxableWages"), pitWithheld: perEmp(id, "ca_pit", "amount"),
    })),
    monthlyLiability: [month(0), month(1), month(2)],
  };
}

export interface FutaRules {
  wageBase: string;            // "7000"
  netRate: string;             // 0.6% after the full 5.4% credit: "0.006"
  stateCd: string;             // single-state employer, e.g. "CA"
  creditReductionRate: string; // DOL list for the year, e.g. "0.012"; "0" if none
}

export interface Form940Summary {
  year: number;
  line3TotalPayments: string;
  line4Exempt: string;
  line5OverBase: string;
  line6: string;
  line7Taxable: string;
  line8Tax: string;
  line11CreditReduction: string;
  line12Total: string;
  /** Line 16 a..d: FUTA liability by quarter wages were paid; the credit reduction goes in Q4 (Form 940 instructions). */
  quarters: [string, string, string, string];
}

/** Form 940 figures from a year of pay-run results. FUTA wages are recomputed from gross (provider stubs can't be trusted past the base). */
export function summarizeFuta(results: PayRunResult[], year: number, r: FutaRules): Form940Summary {
  const rs = results.filter(x => Number(x.period.payDate.slice(0, 4)) === year && D(x.gross ?? "0").gt(Dec.ZERO))
    .sort((a, b) => a.period.payDate.localeCompare(b.period.payDate));
  if (rs.some(x => (x.preTax ?? []).length)) throw new Error("pre-tax deductions present: FUTA-exempt payments (line 4) are not handled yet");
  const base = D(r.wageBase), rate = D(r.netRate);
  const ytd = new Map<string, Dec>();
  const qTaxable = [Dec.ZERO, Dec.ZERO, Dec.ZERO, Dec.ZERO];
  let total = Dec.ZERO;
  for (const x of rs) {
    const g = D(x.gross), before = ytd.get(x.employeeId) ?? Dec.ZERO;
    const room = base.sub(before);
    const taxable = room.gt(Dec.ZERO) ? (g.gt(room) ? room : g) : Dec.ZERO;
    ytd.set(x.employeeId, before.add(g));
    qTaxable[Math.floor((Number(x.period.payDate.slice(5, 7)) - 1) / 3)] = qTaxable[Math.floor((Number(x.period.payDate.slice(5, 7)) - 1) / 3)]!.add(taxable);
    total = total.add(g);
  }
  const taxableAll = qTaxable.reduce((a, b) => a.add(b), Dec.ZERO);
  const over = total.sub(taxableAll);
  const cr = taxableAll.mul(r.creditReductionRate).round(2);
  // Per-quarter liability rounded per quarter; line 8 is computed on the year's total, so check they agree.
  const q = qTaxable.map(t => t.mul(rate).round(2));
  q[3] = q[3]!.add(cr);
  const line8 = taxableAll.mul(rate).round(2);
  const line12 = line8.add(cr);
  const qSum = q.reduce((a, b) => a.add(b), Dec.ZERO);
  if (qSum.toMoney() !== line12.toMoney()) throw new Error(`line 16 quarters ${qSum.toMoney()} != line 12 ${line12.toMoney()} (rounding): review before filing`);
  return {
    year, line3TotalPayments: total.toMoney(), line4Exempt: "0.00", line5OverBase: over.toMoney(), line6: over.toMoney(),
    line7Taxable: taxableAll.toMoney(), line8Tax: line8.toMoney(), line11CreditReduction: cr.toMoney(), line12Total: line12.toMoney(),
    quarters: [q[0]!.toMoney(), q[1]!.toMoney(), q[2]!.toMoney(), q[3]!.toMoney()],
  };
}

export interface W2Summary {
  employeeId: string;
  b1Wages: string; b2FedTaxWh: string;
  b3SocSecWages: string; b4SocSecTaxWh: string;
  b5MedicareWages: string; b6MedicareTaxWh: string;
  b14CaSdi: string;
  b16StateWages: string; b17StateTax: string;
}

/** Form W-2 boxes per employee for a calendar year, from pay-run results (box 6 includes Additional Medicare). */
export function summarizeW2(results: PayRunResult[], year: number): W2Summary[] {
  const rs = results.filter(x => Number(x.period.payDate.slice(0, 4)) === year);
  const ids = [...new Set(rs.map(r => r.employeeId))].sort();
  return ids.map(id => {
    const t = rs.filter(r => r.employeeId === id).flatMap(r => r.taxes);
    const amt = (...codes: string[]) => t.filter(x => codes.includes(x.code)).reduce((s, x) => s.add(D(x.amount)), Dec.ZERO).toMoney();
    const wages = (code: string) => t.filter(x => x.code === code).reduce((s, x) => s.add(D(x.taxableWages)), Dec.ZERO).toMoney();
    return {
      employeeId: id,
      b1Wages: wages("fit"), b2FedTaxWh: amt("fit"),
      b3SocSecWages: wages("ss_ee"), b4SocSecTaxWh: amt("ss_ee"),
      b5MedicareWages: wages("medicare_ee"), b6MedicareTaxWh: amt("medicare_ee", "addl_medicare_ee"),
      b14CaSdi: amt("ca_sdi"),
      b16StateWages: wages("ca_pit"), b17StateTax: amt("ca_pit"),
    };
  });
}
