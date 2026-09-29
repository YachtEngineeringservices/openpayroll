import { Dec, D } from "./money.js";
import type { PayRunResult } from "./types.js";

/** Account identifiers are opaque (numbers for Bigcapital, codes for other ledgers). */
export type AccountId = string | number;

export interface AccountMap {
  wagesExpense: AccountId;
  employerTaxExpense: AccountId;
  /** Credited with net pay: the bank account, or a "net pay clearing" account if you transfer separately. */
  netPay: AccountId;
  /** Tax line code -> liability account (e.g. all FICA codes to one "FICA payable"). */
  liabilities: Record<string, AccountId>;
  /** Pre-tax deduction code -> liability account (e.g. 401k payable). */
  preTax?: Record<string, AccountId>;
}

export interface JournalLine { account: AccountId; debit: string; credit: string; memo: string }
export interface Journal { date: string; reference: string; description: string; lines: JournalLine[] }

/**
 * Accrual entry for one pay run:
 *   Dr wages expense (gross)           Dr employer payroll tax expense
 *   Cr each withholding / employer-tax liability, Cr pre-tax deduction liabilities, Cr net pay
 * Tax deposits later clear the liabilities (Dr liability / Cr bank).
 */
export function buildJournal(r: PayRunResult, map: AccountMap, reference?: string): Journal {
  const lines: JournalLine[] = [];
  // Negative amounts (provider adjustment checks, e.g. a UI rate correction) flip to the other side,
  // so no line ever carries a negative debit or credit.
  const dr = (account: AccountId, amt: Dec, memo: string): void => {
    if (amt.isZero()) return;
    if (amt.isNeg()) return cr(account, amt.neg(), memo);
    lines.push({ account, debit: amt.toMoney(), credit: "0.00", memo });
  };
  const cr = (account: AccountId, amt: Dec, memo: string): void => {
    if (amt.isZero()) return;
    if (amt.isNeg()) return dr(account, amt.neg(), memo);
    lines.push({ account, debit: "0.00", credit: amt.toMoney(), memo });
  };

  dr(map.wagesExpense, D(r.gross), "Gross wages");
  dr(map.employerTaxExpense, D(r.employerTaxTotal), "Employer payroll taxes");

  // Merge liabilities that share an account so the entry stays readable.
  const byAccount = new Map<AccountId, { amt: Dec; memos: string[] }>();
  for (const t of r.taxes) {
    const acct = map.liabilities[t.code];
    if (acct === undefined) throw new Error(`no liability account mapped for tax code "${t.code}"`);
    const cur = byAccount.get(acct) ?? { amt: Dec.ZERO, memos: [] };
    cur.amt = cur.amt.add(D(t.amount)); cur.memos.push(t.label);
    byAccount.set(acct, cur);
  }
  for (const [acct, v] of byAccount) cr(acct, v.amt, v.memos.join(", "));
  for (const p of r.preTax) {
    const acct = map.preTax?.[p.code];
    if (acct === undefined) throw new Error(`no account mapped for pre-tax deduction "${p.code}"`);
    cr(acct, D(p.amount), `Pre-tax deduction: ${p.code}`);
  }
  cr(map.netPay, D(r.netPay), "Net pay");

  const j: Journal = {
    date: r.period.payDate,
    reference: reference ?? `PAY-${r.employeeId}-${r.period.payDate}`,
    description: `Payroll ${r.period.start} to ${r.period.end} (${r.employeeId})`,
    lines,
  };
  assertBalanced(j);
  return j;
}

export function assertBalanced(j: Journal): void {
  const d = j.lines.reduce((s, l) => s.add(D(l.debit)), Dec.ZERO);
  const c = j.lines.reduce((s, l) => s.add(D(l.credit)), Dec.ZERO);
  if (!d.eq(c)) throw new Error(`journal does not balance: debits ${d.toMoney()} != credits ${c.toMoney()}`);
}
