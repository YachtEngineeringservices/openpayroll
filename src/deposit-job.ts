/**
 * Decide which deposit emails to send today. Pure: no I/O, so it can be tested and dry-run.
 *  1. Batch: on a quarter batch's send date, list its payments that aren't scheduled yet.
 *  2. Change: a scheduled payment whose amount no longer matches the paychecks (once per new amount).
 *  3. Reminder: an unscheduled payment 5 days before, and on, its last schedule date; and a payment
 *     that was outside its window at batch time, once the window opens.
 *  4. Can't compute: paychecks within 45 days that couldn't be projected (e.g. next year's rule files
 *     aren't loaded yet), weekly, so a missing year never goes quiet.
 */
import { addDays } from "./calendar.js";
import type { Batch, Deposit } from "./deposits.js";
import { batchMessage, changeMessage, reminderMessage, type Message } from "./notify.js";

export interface ScheduledMark { amount: string; confirmation?: string; at: string }
export interface DepositState {
  scheduled: Record<string, ScheduledMark>;
  sent: Record<string, string>;          // notification key -> ISO date sent
  /** Deposit id -> its TX-<id> journal in Bigcapital (posted when the payment is marked scheduled). */
  posted?: Record<string, { journalNumber: string; status: "posting" | "posted"; amount: string; bigcapitalId?: number; at: string }>;
}

export interface Planned { message: Message; keys: string[] }

export function planNotifications(deposits: Deposit[], batches: Batch[], st: DepositState, today: string, to: string,
  projectionErrors: string[] = [], uncomputedFrom?: string): Planned[] {
  const out: Planned[] = [];
  const week = Math.floor(Date.parse(`${today}T12:00:00Z`) / (7 * 864e5));
  if (uncomputedFrom && uncomputedFrom <= addDays(today, 45) && !st.sent[`uncomputed:${week}`]) out.push({
    message: {
      to, subject: `Payroll deposits can't be computed from ${uncomputedFrom}`,
      text: ["openpayroll can't work out the payroll tax deposits for these paychecks, so no schedule email will go out for them:", "",
        ...projectionErrors.map(e => `  ${e}`), "",
        "Usually this means next year's federal (Pub 15-T) or California (DE 44) rule files aren't loaded yet. Load them and redeploy.",
        "This warning repeats weekly until it's fixed."].join("\n"),
    },
    keys: [`uncomputed:${week}`],
  });
  const open = (d: Deposit) => d.dueDate >= today && !st.scheduled[d.id];

  for (const b of batches) {
    const key = `batch:${b.id}`;
    if (b.sendOn > today || st.sent[key]) continue;
    const pending = { ...b, deposits: b.deposits.filter(open), later: b.later.filter(open) };
    if (!pending.deposits.length && !pending.later.length) continue;
    out.push({ message: batchMessage(to, pending, projectionErrors), keys: [key] });
  }

  const changes = deposits.filter(d => st.scheduled[d.id] && st.scheduled[d.id]!.amount !== d.amount && d.dueDate >= today && !st.sent[`change:${d.id}:${d.amount}`]);
  if (changes.length) out.push({
    message: changeMessage(to, changes.map(d => ({ d, scheduled: st.scheduled[d.id]!.amount }))),
    keys: changes.map(d => `change:${d.id}:${d.amount}`),
  });

  const due: { d: Deposit; key: string }[] = [];
  for (const d of deposits.filter(open)) {
    if (today >= d.scheduleBy && !st.sent[`r2:${d.id}`]) due.push({ d, key: `r2:${d.id}` });
    else if (today >= addDays(d.scheduleBy, -5) && !st.sent[`r1:${d.id}`]) due.push({ d, key: `r1:${d.id}` });
    else if (today >= d.scheduleFrom && batches.some(b => b.later.some(x => x.id === d.id) && st.sent[`batch:${b.id}`]) && !st.sent[`open:${d.id}`])
      due.push({ d, key: `open:${d.id}` });
  }
  if (due.length) out.push({ message: reminderMessage(to, due.map(x => x.d)), keys: due.map(x => x.key) });
  return out;
}
