/**
 * TaxBandits adapter: Form 941 from a QuarterSummary.
 * Auth and schema per developer.taxbandits.com (docs/oauth2.0authentication, docs/form941/create), read 2026-09-28.
 *
 * SANDBOX ONLY in this build: the live URLs are deliberately not configured. Going live is a separate,
 * reviewed change, not a flag.
 */
import { createHmac } from "node:crypto";
import { D, Dec } from "../money.js";
import type { Form940Summary, QuarterSummary, W2Summary } from "../summary.js";

export const TB_SANDBOX = {
  oauth: "https://testoauth.expressauth.net/v2/tbsauth",
  api: "https://testapi.taxbandits.com/v1.7.3",
} as const;

export interface TaxBanditsKeys { clientId: string; clientSecret: string; userToken: string }

export interface TaxBanditsBusiness {
  BusinessNm: string;
  EINorSSN: string;           // 9 digits, no dash
  IsEIN: true;
  Email: string;
  ContactNm: string;
  Phone: string;              // 10 digits
  BusinessType: "ESTE" | "PART" | "CORP" | "EORG" | "SPRO" | "SLGOV";
  USAddress: { Address1: string; Address2?: string; City: string; State: string; ZipCd: string };
  SigningAuthority: { Name: string; Phone: string; BusinessMemberType: string };
}

export interface Form941Options {
  /** Line 13: deposits actually made for the quarter. There is no default: the caller states what was paid. */
  depositsMade: string;
  signatureType: "FORM_8453_EMP" | "ONLINE_SIGN_PIN";
  onlineSignaturePin?: string;
  sequenceId?: string;
  /** Required when line 14 (balance due) > 0: how that balance is paid. EFW (debit through the return) is not supported here. */
  balanceDuePaidBy?: "EFTPS" | "CHECK_OR_MO";
}

const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** JWS: HS256, iss = sub = Client ID, aud = User Token, iat = now; signed with the Client Secret. */
export function jws(k: TaxBanditsKeys, now = Math.floor(Date.now() / 1000)): string {
  const head = b64u({ alg: "HS256", typ: "JWT" });
  const body = b64u({ iss: k.clientId, sub: k.clientId, aud: k.userToken, iat: now });
  return `${head}.${body}.${createHmac("sha256", k.clientSecret).update(`${head}.${body}`).digest("base64url")}`;
}

export async function accessToken(k: TaxBanditsKeys): Promise<string> {
  const res = await fetch(TB_SANDBOX.oauth, { headers: { Authentication: jws(k) } });
  const j = await res.json().catch(() => ({})) as { AccessToken?: string; StatusCode?: number; StatusMessage?: string };
  if (!res.ok || !j.AccessToken) throw new Error(`TaxBandits auth ${res.status}: ${j.StatusMessage ?? "no access token"}`);
  return j.AccessToken;
}

const num = (s: string | Dec) => Number(typeof s === "string" ? s : s.toMoney());
const line = (s: QuarterSummary, prefix: string) => {
  const k = Object.keys(s.form941).find(x => x.startsWith(prefix));
  if (!k) throw new Error(`summary has no Form 941 line "${prefix}"`);
  return D(s.form941[k]!);
};

/** Build one Form941Records entry. Throws if the return does not add up. */
export function form941Record(s: QuarterSummary, biz: TaxBanditsBusiness, o: Form941Options) {
  const l2 = line(s, "2 "), l3 = line(s, "3 ");
  const l5a1 = line(s, "5a taxable"), l5a2 = line(s, "5a col 2");
  const l5c1 = line(s, "5c taxable"), l5c2 = line(s, "5c col 2");
  const l5d1 = line(s, "5d wages"), l5d2 = line(s, "5d col 2");
  const l7 = line(s, "7 ");
  const l5e = l5a2.add(l5c2).add(l5d2);
  const l6 = l3.add(l5e);
  const l10 = l6.add(l7);                     // lines 8 and 9 are zero for this employer
  const l12 = l10;                            // no line 11 credits
  const l13 = D(o.depositsMade);
  const bal = l12.sub(l13);
  const m = s.monthlyLiability.map(D);
  const l16 = m[0]!.add(m[1]!).add(m[2]!);

  if (l12.toMoney() !== line(s, "12 ").toMoney()) throw new Error(`line 12 ${l12.toMoney()} != summary ${s.form941[Object.keys(s.form941).find(k => k.startsWith("12 "))!]}`);
  if (l16.toMoney() !== l12.toMoney()) throw new Error(`line 16 months total ${l16.toMoney()} != line 12 ${l12.toMoney()}`);
  if (s.employeesOn12th < 1 && !l2.isZero()) throw new Error("line 1 is 0 but wages were paid: check pay periods");
  if (bal.gt(Dec.ZERO) && !o.balanceDuePaidBy) throw new Error(`line 14 balance due ${bal.toMoney()}: say how it is paid (balanceDuePaidBy)`);
  if (o.signatureType === "ONLINE_SIGN_PIN" && !/^\d{10}$/.test(o.onlineSignaturePin ?? "")) throw new Error("Online Signature PIN must be 10 digits");

  return {
    SequenceId: o.sequenceId ?? `${s.year}Q${s.quarter}`,
    ReturnHeader: {
      ReturnType: "FORM941",
      TaxYr: String(s.year),
      Qtr: `Q${s.quarter}`,
      Business: biz,
      SignatureDetails: o.signatureType === "ONLINE_SIGN_PIN"
        ? { SignatureType: "ONLINE_SIGN_PIN", OnlineSignaturePIN: { PIN: o.onlineSignaturePin } }
        : { SignatureType: "FORM_8453_EMP" },
    },
    ReturnData: {
      Form941: {
        EmployeeCnt: s.employeesOn12th,
        WagesAmt: num(l2),
        FedIncomeTaxWHAmt: num(l3),
        SocialSecurityTaxCashWagesAmt_Col1: num(l5a1), SocialSecurityTaxAmt_Col2: num(l5a2),
        TaxableSocSecTipsAmt_Col1: 0, TaxOnSocialSecurityTipsAmt_Col2: 0,
        TaxableMedicareWagesTipsAmt_Col1: num(l5c1), TaxOnMedicareWagesTipsAmt_Col2: num(l5c2),
        TxblWageTipsSubjAddnlMedcrAmt_Col1: num(l5d1), TaxOnWageTipsSubjAddnlMedcrAmt_Col2: num(l5d2),
        TotSSMdcrTaxAmt: num(l5e),
        TotalTaxBeforeAdjustmentAmt: num(l6),
        CurrentQtrFractionsCentsAmt: num(l7),
        TotalTaxAfterAdjustmentAmt: num(l10),
        PayrollTaxCreditAmt: 0,
        IsPayrollTaxCredit: false,
        TotTaxAfterAdjustmentAndNonRfdCr: num(l12),
        TotTaxDepositAmt: num(l13),
        BalanceDueAmt: bal.gt(Dec.ZERO) ? num(bal) : 0,
        OverpaidAmt: bal.gt(Dec.ZERO) ? 0 : num(Dec.ZERO.sub(bal)),
      },
      ...(bal.gt(Dec.ZERO) ? { IRSPaymentType: o.balanceDuePaidBy } : {}),
      DepositScheduleType: {
        DepositorType: "MONTHLY",
        TotalQuarterTaxLiabilityAmt: num(l16),
        MonthlyDepositor: { TaxLiabilityMonth1: num(m[0]!), TaxLiabilityMonth2: num(m[1]!), TaxLiabilityMonth3: num(m[2]!) },
      },
    },
  };
}

async function call(token: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(TB_SANDBOX.api + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let v: unknown; try { v = JSON.parse(text); } catch { v = text; }
  if (!res.ok) throw Object.assign(new Error(`TaxBandits ${method} ${path} ${res.status}`), { response: v });
  return v;
}

export const createForm941 = (token: string, records: unknown[]) => call(token, "POST", "/Form941/Create", { Form941Records: records });
export const getForm941 = (token: string, submissionId: string) => call(token, "GET", `/Form941/Get?SubmissionId=${encodeURIComponent(submissionId)}`);
/** Transmit created records (docs: only after all validation errors are cleared). */
export const transmitForm941 = (token: string, submissionId: string, recordIds: string[]) =>
  call(token, "POST", "/Form941/Transmit", { SubmissionId: submissionId, RecordIds: recordIds });
/** Delete in-progress records (live: only before Transmitted/Accepted). */
export const deleteForm941 = (token: string, submissionId: string, recordIds: string[]) =>
  call(token, "DELETE", `/Form941/Delete?SubmissionId=${encodeURIComponent(submissionId)}&RecordIds=${recordIds.map(encodeURIComponent).join(",")}`);

// ---------------------------------------------------------------- California DE 9 / DE 9C
export interface De9Options {
  accNum: string;                         // EDD employer account number, 8 digits
  uiRatePct: string;                      // e.g. "4.00" (EDD rate notice for the year)
  /** Item I: contributions and withholdings already paid for the quarter when filing. No default. */
  depositsMade: string;
  /** employeeId (as in the summary) -> identity. SSNs stay out of git: pass them in at run time. */
  employees: Record<string, { ssn: string; firstNm: string; lastNm: string; middleNm?: string }>;
  sequenceId?: string;
}

const de9Line = (s: QuarterSummary, k: string) => {
  const v = s.de9[k]; if (v === undefined) throw new Error(`summary has no DE 9 figure "${k}"`); return D(v);
};

/** Build one StateWhUIRecords entry (DE 9 + DE 9C). Throws if the return does not add up. */
export function de9Record(s: QuarterSummary, biz: TaxBanditsBusiness, o: De9Options) {
  const ui = de9Line(s, "UI contributions"), ett = de9Line(s, "ETT contributions");
  const sdi = de9Line(s, "SDI withheld"), pit = de9Line(s, "PIT withheld");
  const h = ui.add(ett).add(sdi).add(pit);
  const i = D(o.depositsMade);
  const emps = s.de9cEmployees.map((e, n) => {
    const who = o.employees[e.employeeId];
    if (!who) throw new Error(`no identity given for employee "${e.employeeId}"`);
    if (!/^\d{9}$/.test(who.ssn)) throw new Error(`SSN for "${e.employeeId}" must be 9 digits`);
    return { EmpSequenceId: String(n + 1), EmployeeId: null, SSN: who.ssn, FirstNm: who.firstNm, MiddleNm: who.middleNm ?? null, LastNm: who.lastNm,
      Suffix: null, WageCode: "S", TotalWagesAmt: num(e.subjectWages), PITWagesAmt: num(e.pitWages), PITWhAmt: num(e.pitWithheld) };
  });
  const sum = (f: "subjectWages" | "pitWithheld") => s.de9cEmployees.reduce((a, e) => a.add(D(e[f])), Dec.ZERO);
  if (sum("pitWithheld").toMoney() !== pit.toMoney()) throw new Error(`DE 9C PIT ${sum("pitWithheld").toMoney()} != DE 9 item G ${pit.toMoney()}`);
  const subject = sum("subjectWages");
  if (!/^\d{8}$/.test(o.accNum)) throw new Error("EDD account number must be 8 digits");

  return {
    SequenceId: o.sequenceId ?? `${s.year}Q${s.quarter}`,
    ReturnHeader: { TaxYr: String(s.year), Qtr: `Q${s.quarter}`, Business: { ...biz, IsForeign: false } },
    ReturnData: {
      FormDE9: {
        AccNum: o.accNum, IsNoWageReported: subject.isZero(), IsNoEmpOrBusinessClosed: false, BusinessClosedDt: null,
        TaxableWages: num(subject),                                   // item C, total subject wages
        UIRate: Number(o.uiRatePct),
        UITaxableWagesAmt: num(de9Line(s, "UI taxable wages")), TotUIContribAmt: num(ui),
        TotETTContribAmt: num(ett),
        SDITaxableWagesAmt: num(de9Line(s, "SDI taxable wages")), TotSDIContribAmt: num(sdi),
        PITWhAmt: num(pit),
        TotalTaxLiability: num(h), TotalDeposits: num(i), TotalTaxDue: num(h.sub(i)),   // items H, I, J
        NumOfEmployees: { Month1TotEmployees: s.employeesOn12thByMonth[0], Month2TotEmployees: s.employeesOn12thByMonth[1], Month3TotEmployees: s.employeesOn12thByMonth[2] },
        EmployeeDetails: emps,
      },
    },
  };
}

export const createDe9 = (token: string, records: unknown[]) => call(token, "POST", "/StateFilings/CAWHUI/Create", { StateWhUIRecords: records });
export const transmitStateFilings = (token: string, businessId: string, submissionId: string, recordIds: string[]) =>
  call(token, "POST", "/StateFilings/Transmit", { BusinessId: businessId, SubmissionId: submissionId, RecordIds: recordIds });
export const deleteStateFilings = (token: string, submissionId: string, recordIds: string[]) =>
  call(token, "DELETE", `/StateFilings/Delete?SubmissionId=${encodeURIComponent(submissionId)}&RecordIds=${recordIds.map(encodeURIComponent).join(",")}`);

// ---------------------------------------------------------------- Form 940
export interface Form940Options {
  stateCd: string;                        // single-state employer
  creditReductionRate: string;            // same rate the summary used, e.g. "0.012"
  /** Line 13: FUTA deposited for the year. No default. */
  depositsMade: string;
  signatureType: "FORM_8453_EMP" | "ONLINE_SIGN_PIN";
  onlineSignaturePin?: string;
  balanceDuePaidBy?: "EFTPS" | "CHECK_OR_MO";
  sequenceId?: string;
}

export function form940Record(s: Form940Summary, biz: TaxBanditsBusiness, o: Form940Options) {
  const l12 = D(s.line12Total), l13 = D(o.depositsMade), bal = l12.sub(l13);
  const q = s.quarters.map(D);
  const l17 = q.reduce((a, b) => a.add(b), Dec.ZERO);
  if (l17.toMoney() !== l12.toMoney()) throw new Error(`line 17 ${l17.toMoney()} != line 12 ${l12.toMoney()}`);
  if (bal.gt(Dec.ZERO) && !o.balanceDuePaidBy) throw new Error(`line 14 balance due ${bal.toMoney()}: say how it is paid (balanceDuePaidBy)`);
  if (o.signatureType === "ONLINE_SIGN_PIN" && !/^\d{10}$/.test(o.onlineSignaturePin ?? "")) throw new Error("Online Signature PIN must be 10 digits");
  const cr = D(s.line11CreditReduction);
  const part5 = l12.gt("500");
  return {
    SequenceId: o.sequenceId ?? `${s.year}-940`,
    ReturnHeader: {
      ReturnType: "FORM940", TaxYr: String(s.year), Business: { ...biz, IsForeign: false },
      SignatureDetails: o.signatureType === "ONLINE_SIGN_PIN"
        ? { SignatureType: "ONLINE_SIGN_PIN", OnlineSignaturePIN: { PIN: o.onlineSignaturePin } }
        : { SignatureType: "FORM_8453_EMP" },
    },
    ReturnData: {
      Form940: {
        OneStateCd: o.stateCd, IsMultiState: false, IsCreditReduction: cr.gt(Dec.ZERO),
        IsSuccessorEmployer: false, IsPymtsMadeToEmployees: true, IsBusinessClosed: false,
        WagesAmt: num(s.line3TotalPayments),                       // 3
        ExemptWagesAmt: num(s.line4Exempt),                        // 4
        IsFringeBenfs: false, IsGrpTermLifeIns: false, IsRetrmntOrPension: false, IsDepCare: false, IsOtherExempt: false,
        WagesOverLmtAmt: num(s.line5OverBase),                     // 5
        TotExemptWagesAmt: num(s.line6),                           // 6
        TotTaxableWagesAmt: num(s.line7Taxable),                   // 7
        FUTATaxBeforeAdjAmt: num(s.line8Tax),                      // 8
        MaxCreditAmt: 0, FUTAAdjAmt: 0,                            // 9, 10
        TotCrdtRedAmt: num(cr),                                    // 11
        FUTATaxAfterAdjAmt: num(l12),                              // 12
        TotDepositAmt: num(l13),                                   // 13
        BalanceDueAmt: bal.gt(Dec.ZERO) ? num(bal) : 0,            // 14
        OverPaidAmt: bal.gt(Dec.ZERO) ? 0 : num(Dec.ZERO.sub(bal)),// 15
        // Part 5 (16a-d, 17) is completed only when line 12 is more than $500; otherwise it stays blank.
        ...(part5 ? {
          FirstQtrTaxLiabilityAmt: num(q[0]!), secondQtrTaxLiabilityAmt: num(q[1]!),   // the API spells "second" in lower case
          ThirdQtrTaxLiabilityAmt: num(q[2]!), FourthQtrTaxLiabilityAmt: num(q[3]!),
          TotTaxLiabilityAmt: num(l17),
        } : {}),
      },
      ...(bal.gt(Dec.ZERO) ? { IRSPaymentType: o.balanceDuePaidBy } : {}),
      ScheduleA: cr.gt(Dec.ZERO)
        ? [{ StateCd: o.stateCd, TotTaxableFUTAwagesAmt: num(s.line7Taxable), CreditReductionRt: Number(o.creditReductionRate), CreditReductionAmt: num(cr) }]
        : null,
    },
  };
}

export const createForm940 = (token: string, records: unknown[]) => call(token, "POST", "/Form940/Create", { Form940Records: records });
export const transmitForm940 = (token: string, submissionId: string, recordIds: string[]) =>
  call(token, "POST", "/Form940/Transmit", { SubmissionId: submissionId, RecordIds: recordIds });
export const deleteForm940 = (token: string, submissionId: string, recordIds: string[]) =>
  call(token, "DELETE", `/Form940/Delete?SubmissionId=${encodeURIComponent(submissionId)}&RecordIds=${recordIds.map(encodeURIComponent).join(",")}`);

// ---------------------------------------------------------------- Form W-2 / W-3
export interface W2Employee {
  ssn: string; firstNm: string; lastNm: string; middleNm?: string;
  address: { Address1: string; Address2?: string; City: string; State: string; ZipCd: string };
}
export interface W2Options {
  taxYear: number;
  stateIdNum: string;                       // EDD employer account number (box 15)
  /** employeeId (as in the summary) -> identity and address. SSNs stay out of git: pass them in at run time. */
  employees: Record<string, W2Employee>;
  /** Paper copies / online access for employees through TaxBandits. Default false: we hand out copies ourselves. */
  isPostal?: boolean;
  isOnlineAccess?: boolean;
}

/** One FormW2/Create request (all employees; W-3 is generated from it). Federal + California filing. */
export function w2Request(w2s: W2Summary[], biz: TaxBanditsBusiness, o: W2Options) {
  const postal = o.isPostal ?? false, online = o.isOnlineAccess ?? false;
  return {
    SubmissionManifest: { TaxYear: String(o.taxYear), IsFederalFiling: true, IsStateFiling: true, IsPostal: postal, IsOnlineAccess: online, IsScheduleFiling: false },
    ReturnHeader: {
      Business: { BusinessNm: biz.BusinessNm, IsEIN: true, EINorSSN: biz.EINorSSN, Email: biz.Email, Phone: biz.Phone,
        KindOfEmployer: "NONEAPPLY", KindOfPayer: "REGULAR941", IsForeign: false, USAddress: biz.USAddress },
    },
    ReturnData: w2s.map((w, n) => {
      const who = o.employees[w.employeeId];
      if (!who) throw new Error(`no identity given for employee "${w.employeeId}"`);
      if (!/^\d{9}$/.test(who.ssn)) throw new Error(`SSN for "${w.employeeId}" must be 9 digits`);
      return {
        SequenceId: String(n + 1), IsPostal: postal, IsOnlineAccess: online,
        Employee: { SSN: who.ssn, FirstNm: who.firstNm, MiddleNm: who.middleNm ?? null, LastNm: who.lastNm, IsForeign: false, USAddress: who.address },
        W2FormData: {
          B1Wages: num(w.b1Wages), B2FedTaxWH: num(w.b2FedTaxWh),
          B3SocSecWages: num(w.b3SocSecWages), B4SocSecTaxWH: num(w.b4SocSecTaxWh),
          B5MediWages: num(w.b5MedicareWages), B6MediTaxWH: num(w.b6MedicareTaxWh),
          B13IsStatEmp: false, B13IsRetPlan: false, B13Is3rdPartySickPay: false,
          B14Other: D(w.b14CaSdi).gt(Dec.ZERO) ? `CA SDI ${w.b14CaSdi}` : null,
          States: [{ B15StateCd: "CA", B15StateIdNum: o.stateIdNum, B16StateWages: num(w.b16StateWages), B17StateTax: num(w.b17StateTax), LocalityData: null }],
        },
      };
    }),
  };
}

export const createW2 = (token: string, body: unknown) => call(token, "POST", "/FormW2/Create", body);
export const transmitW2 = (token: string, submissionId: string, recordIds: string[]) =>
  call(token, "POST", "/FormW2/Transmit", { SubmissionId: submissionId, RecordIds: recordIds });
