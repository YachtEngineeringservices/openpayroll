/**
 * Deposit notifications: plain-text emails and an iCalendar feed.
 * Email goes out over SMTP with STARTTLS (e.g. Postmark on port 2525) using only node:net/node:tls.
 * Without SMTP settings, messages are written to an outbox directory instead of being sent.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Batch, Deposit } from "./deposits.js";

export interface SmtpSettings { host: string; port: number; user: string; pass: string; from: string }
export interface Message { to: string; subject: string; text: string }

export function smtpFromEnv(env = process.env): SmtpSettings | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) return null;
  return { host: SMTP_HOST, port: Number(SMTP_PORT ?? 587), user: SMTP_USER, pass: SMTP_PASS, from: MAIL_FROM };
}

/** Minimal SMTP: EHLO, STARTTLS, EHLO, AUTH LOGIN, MAIL, RCPT, DATA. Throws on any unexpected reply. */
export async function sendSmtp(s: SmtpSettings, m: Message, timeoutMs = 20000): Promise<void> {
  let sock: Socket | TLSSocket = netConnect({ host: s.host, port: s.port });
  let buf = "";
  const waiters: ((line: string) => void)[] = [];
  const early: string[] = [];                     // replies that arrived before anyone waited for them
  let failed: Error | null = null;
  const fail = (e: Error) => { failed = e; for (const w of waiters.splice(0)) w(`ERR ${e.message}
`); };
  const onData = (d: Buffer) => {
    buf += d.toString("utf8");
    // A reply is complete when a line has "NNN " (space after the code).
    let m2: RegExpExecArray | null;
    while ((m2 = /^(\d{3}) .*\r?\n/m.exec(buf))) {
      const end = m2.index + m2[0].length; const reply = buf.slice(0, end); buf = buf.slice(end);
      const w = waiters.shift(); if (w) w(reply); else early.push(reply);
    }
  };
  const attach = (x: Socket | TLSSocket) => { x.on("data", onData); x.on("error", fail); };
  attach(sock);
  const timer = setTimeout(() => fail(new Error("SMTP timeout")), timeoutMs);
  const reply = () => new Promise<string>(res => {
    if (failed) return res(`ERR ${failed.message}
`);
    const e = early.shift(); if (e !== undefined) res(e); else waiters.push(res);
  });
  const expect = async (code: string, send?: string) => {
    if (send !== undefined) sock.write(send + "\r\n");
    const r = await reply();
    if (!r.startsWith(code)) throw new Error(`SMTP: expected ${code}, got ${r.trim().split("\n").pop()}`);
    return r;
  };
  try {
    await expect("220");
    await expect("250", "EHLO openpayroll");
    await expect("220", "STARTTLS");
    sock.removeListener("data", onData);
    sock = tlsConnect({ socket: sock as Socket, servername: s.host });
    await new Promise<void>((res, rej) => { (sock as TLSSocket).once("secureConnect", () => res()); sock.once("error", rej); });
    sock.on("data", onData); sock.on("error", fail);
    await expect("250", "EHLO openpayroll");
    await expect("334", "AUTH LOGIN");
    await expect("334", Buffer.from(s.user).toString("base64"));
    await expect("235", Buffer.from(s.pass).toString("base64"));
    await expect("250", `MAIL FROM:<${s.from.replace(/^.*<|>.*$/g, "")}>`);
    await expect("250", `RCPT TO:<${m.to}>`);
    await expect("354", "DATA");
    const body = m.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await expect("250", [`From: ${s.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", body, "."].join("\r\n"));
    sock.write("QUIT\r\n");
  } finally { clearTimeout(timer); sock.end(); sock.destroy(); }
}

/** Send, or write to the outbox when SMTP isn't configured. Returns where it went. */
export async function deliver(m: Message, smtp: SmtpSettings | null, outbox: string): Promise<string> {
  if (smtp) { await sendSmtp(smtp, m); return `sent to ${m.to}`; }
  mkdirSync(outbox, { recursive: true });
  const f = join(outbox, `${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  writeFileSync(f, `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`);
  return `written to ${f}`;
}

// ---------------------------------------------------------------- message text

const HOW: Record<Deposit["agency"], string> = {
  IRS: "EFTPS (eftps.gov): Make a Payment → Form 941 (or 940 for FUTA) → Federal Tax Deposit → tax period below. Settlement date = the due date; it must be scheduled by 8 p.m. Eastern the day before.",
  EDD: "EDD e-Services for Business: Make a Payment → Payroll Tax Deposit (DE 88) → the period below, deposit schedule as shown. ACH debit settlement date = the due date (can be scheduled up to 90 days ahead; cancel by 3 p.m. PT the day before).",
};
const agencyLabel = (d: Deposit) => d.agency === "IRS" ? `IRS ${d.kind === "FUTA" ? "940 (FUTA)" : "941"}` : `EDD ${d.kind}`;
const line = (d: Deposit) => `  ${d.dueDate}  ${agencyLabel(d).padEnd(14)} ${d.period.padEnd(8)} $${d.amount.padStart(9)}${d.projected ? "  (projected)" : ""}${d.note ? `  - ${d.note}` : ""}`;

export function batchMessage(to: string, b: Batch, projectionErrors: string[]): Message {
  const irs = b.deposits.filter(d => d.agency === "IRS"), edd = b.deposits.filter(d => d.agency === "EDD");
  const text = [
    `Payroll tax deposits to schedule for wages in ${b.id}.`,
    "",
    "Schedule each one with the settlement date = the due date shown.",
    "",
    ...(irs.length ? ["IRS", HOW.IRS, ...irs.map(line), ""] : []),
    ...(edd.length ? ["EDD", HOW.EDD, ...edd.map(line), ""] : []),
    ...(b.later.length ? ["Not schedulable yet (outside the agency's window); you'll get a separate reminder:", ...b.later.map(d => `${line(d)}  - opens ${d.scheduleFrom}`), ""] : []),
    ...(projectionErrors.length ? ["Could not project some paychecks, so those amounts are missing:", ...projectionErrors.map(e => `  ${e}`), ""] : []),
    "Amounts marked (projected) come from the salary in the settings. After every payday openpayroll re-checks them and emails you if a scheduled amount needs to change.",
    "When a payment is scheduled, mark it on the openpayroll page (Deposits) with the confirmation number.",
  ].join("\n");
  return { to, subject: `Schedule payroll tax deposits: ${b.id} (${b.deposits.length} payments)`, text };
}

export function changeMessage(to: string, changes: { d: Deposit; scheduled: string }[]): Message {
  const text = [
    "A scheduled payroll tax deposit no longer matches the paychecks. Edit the scheduled payment:",
    "",
    ...changes.map(({ d, scheduled }) => `${line(d)}\n      scheduled $${scheduled} -> should be $${d.amount}`),
    "",
    "Then update the amount on the openpayroll page (Deposits).",
  ].join("\n");
  return { to, subject: `Payroll tax deposit amount changed (${changes.length})`, text };
}

export function reminderMessage(to: string, ds: Deposit[]): Message {
  const text = [
    "These payroll tax deposits are not marked as scheduled yet:",
    "",
    ...ds.map(d => `${line(d)}  - schedule by ${d.scheduleBy}`),
    "",
    ...[...new Set(ds.map(d => d.agency))].map(a => `${a}: ${HOW[a]}`),
  ].join("\n");
  return { to, subject: `Reminder: ${ds.length} payroll tax deposit${ds.length > 1 ? "s" : ""} not scheduled (first due ${ds[0]!.dueDate})`, text };
}

// ---------------------------------------------------------------- iCalendar

const icsEsc = (s: string) => s.replace(/[\\;,]/g, m => `\\${m}`).replace(/\n/g, "\\n");
export function toIcs(deposits: Deposit[], stamp = new Date()): string {
  const dt = stamp.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ev = deposits.flatMap(d => {
    const day = d.dueDate.replace(/-/g, "");
    const next = new Date(`${d.dueDate}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    return ["BEGIN:VEVENT", `UID:${d.id}@openpayroll`, `DTSTAMP:${dt}`, `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`,
      `SUMMARY:${icsEsc(`${agencyLabel(d)} ${d.period} $${d.amount} due`)}`,
      `DESCRIPTION:${icsEsc(`Schedule by ${d.scheduleBy}.${d.projected ? " Projected amount." : ""}${d.note ? ` ${d.note}.` : ""}`)}`,
      "BEGIN:VALARM", "TRIGGER:-P5D", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(`${agencyLabel(d)} deposit due ${d.dueDate}`)}`, "END:VALARM",
      "END:VEVENT"];
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//openpayroll//deposits//EN", "CALSCALE:GREGORIAN", ...ev, "END:VCALENDAR", ""].join("\r\n");
}
