/** Shared types. Money/rates in input and rule files are decimal STRINGS ("1234.56", "0.062"). */

export type Frequency =
  | "daily" | "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "semiannual" | "annual";

// ---------------------------------------------------------------- rule files

/** Where a number came from. Every table/constant in a rule file carries one. */
export interface SourceRef {
  source: string;        // id into RuleFile.sources
  locator: string;       // page / table / line, e.g. "p. 12, Worksheet 1A line 1g"
}

export interface SourceDoc {
  id: string;
  title: string;
  url: string;
  edition?: string;      // e.g. "2026", "Rev. 12-2025"
  retrieved?: string;    // ISO date the transcriber downloaded it
}

/** One bracket row, same columns as IRS/EDD tables: at least A, less than B, base C, rate D, of excess over E. */
export interface BracketRow {
  atLeast: string;
  lessThan: string | null;   // null = no upper bound
  base: string;
  rate: string;              // decimal fraction, "0.12"
  excessOver: string;
}

export interface Cited<T> { value: T; ref: SourceRef
  /** Only for agency tables whose printed rows are not exactly continuous (rounded bracket limits).
   *  The amount is the largest allowed gap; the reason must say what in the source causes it. */
  continuityTolerance?: { amount: string; reason: string };
}

export type RuleStatus = "draft" | "verified";

export interface RuleFileMeta {
  $schema?: string;
  jurisdiction: string;          // "US" | "US-CA" | ...
  taxYear: number;
  effectiveFrom: string;         // ISO date
  effectiveTo: string;           // ISO date
  status: RuleStatus;
  verification?: { by: string; on: string; method: string } | null;
  sources: SourceDoc[];
  notes?: string[];
}

export type FedStatus = "mfj" | "single" | "hoh";   // single includes married filing separately

export interface FederalRules extends RuleFileMeta {
  jurisdiction: "US";
  payPeriodsPerYear: Cited<Record<Frequency, number>>;
  fit: {
    w4_2020: {
      line1gDeduction: Cited<{ mfj: string; other: string }>;
      standard: Cited<Record<FedStatus, BracketRow[]>>;
      checkbox: Cited<Record<FedStatus, BracketRow[]>>;
    };
    w4_legacy: {
      allowanceValue: Cited<string>;
      // Pub 15-T uses the STANDARD schedules for 2019-and-earlier Forms W-4
      // (married -> MFJ schedule, single -> Single schedule).
    };
  };
  fica: {
    socialSecurity: Cited<{ employeeRate: string; employerRate: string; wageBase: string }>;
    medicare: Cited<{ employeeRate: string; employerRate: string; additionalEmployeeRate: string; additionalThreshold: string }>;
  };
  futa: Cited<{ grossRate: string; maxCredit: string; wageBase: string; creditReductionByState: Record<string, string | null> }>;
}

export type CaStatus = "single" | "married" | "hoh";
/** DE 4 / DE 44 Method B. Tables are keyed by pay frequency. */
export interface CaliforniaRules extends RuleFileMeta {
  jurisdiction: "US-CA";
  pit: {
    method: "B";
    /** Low income exemption: no withholding if gross wages <= amount. Keys: single | married_0_1 | married_2plus | hoh */
    lowIncomeExemption: Cited<Partial<Record<Frequency, Record<string, string>>>>;
    /** Estimated deduction amount per count of additional allowances ("1".."10"). */
    estimatedDeduction: Cited<Partial<Record<Frequency, Record<string, string>>>>;
    /** Standard deduction. Keys as lowIncomeExemption. */
    standardDeduction: Cited<Partial<Record<Frequency, Record<string, string>>>>;
    /** Exemption allowance (tax credit) per number of allowances ("0".."10"). */
    exemptionAllowance: Cited<Partial<Record<Frequency, Record<string, string>>>>;
    /** Tax rate brackets per filing status. */
    rates: Cited<Partial<Record<Frequency, Record<CaStatus, BracketRow[]>>>>;
  };
  sdi: Cited<{ employeeRate: string; wageBase: string | null }>;
  ui: Cited<{ wageBase: string; newEmployerRate: string }>;
  ett: Cited<{ rate: string; wageBase: string }>;
}

export type AnyRules = FederalRules | CaliforniaRules;

// ---------------------------------------------------------------- pay run input

export interface W4_2020 {
  version: "2020+";
  filingStatus: FedStatus;
  step2Checkbox: boolean;
  step3Credits: string;        // annual
  step4aOtherIncome: string;   // annual
  step4bDeductions: string;    // annual
  step4cExtra: string;         // per pay period
}
export interface W4Legacy {
  version: "legacy";
  maritalStatus: "single" | "married";
  allowances: number;
  additional: string;          // per pay period
}

export interface DE4 {
  filingStatus: CaStatus;      // "married" = married, one income; dual-income married uses "single"
  regularAllowances: number;
  estimatedDeductionAllowances: number;
  additional: string;          // per pay period
}

export interface Exemptions { fit?: boolean; fica?: boolean; futa?: boolean; caPit?: boolean; caSdi?: boolean; caUi?: boolean }

export interface Employee {
  id: string;
  name: string;
  w4: W4_2020 | W4Legacy;
  de4?: DE4;
  workState: "CA";
  exempt?: Exemptions;
}

export interface Employer {
  name: string;
  caUiRate?: string;           // your EDD-assigned UI rate; defaults to the new-employer rate in the rules
  /** DE 44 Method B permits either per-period tables ("period", default) or computing the annual tax from the
   *  annual tables and dividing by pay periods ("annualized", DE 44 Examples E/F). QuickBooks uses "annualized". */
  caPitMethod?: "period" | "annualized";
}

export type TaxKey = "fit" | "fica" | "futa" | "caPit" | "caSdi" | "caUi";

export interface PreTaxDeduction {
  code: string;                // "401k", "sec125-health", ...
  amount: string;
  /** Which taxable-wage bases this deduction reduces. 401(k): ["fit","caPit"]; sec 125: all. */
  reduces: TaxKey[];
}

export interface PayRunInput {
  employer: Employer;
  employee: Employee;
  period: { frequency: Frequency; start: string; end: string; payDate: string };
  earnings: { code: string; amount: string; supplemental?: boolean }[];
  preTax?: PreTaxDeduction[];
  /** Year-to-date taxable wages BEFORE this run (same calendar year as payDate). */
  ytd: { ssWages: string; medicareWages: string; futaWages: string; caUiWages: string; caSdiWages: string };
}

// ---------------------------------------------------------------- results

export interface TaxLine {
  code: string;                // "fit", "ss_ee", "medicare_ee", "addl_medicare_ee", "ss_er", "medicare_er", "futa", "ca_pit", "ca_sdi", "ca_ui", "ca_ett"
  label: string;
  payer: "employee" | "employer";
  taxableWages: string;
  amount: string;
  ruleRefs: SourceRef[];
}

export interface PayRunResult {
  engine: { name: "openpayroll"; version: string };
  rulesUsed: { jurisdiction: string; taxYear: number; status: RuleStatus }[];
  employeeId: string;
  period: PayRunInput["period"];
  gross: string;
  preTax: { code: string; amount: string }[];
  taxes: TaxLine[];
  employeeTaxTotal: string;
  employerTaxTotal: string;
  netPay: string;
  ytdAfter: PayRunInput["ytd"];
  warnings: string[];
}
