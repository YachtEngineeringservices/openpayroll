#!/usr/bin/env node
/**
 * openpayroll web app (zero dependencies).
 * Shadow-mode dashboard: import provider pay stubs (QuickBooks), recompute each with the
 * engine, show line-by-line differences, and optionally post the provider's actual
 * paycheck to Bigcapital as a journal entry.
 *
 * No login: bind to 127.0.0.1 and publish only on your tailnet (tailscale serve).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RuleSet, listRuleFiles, readRuleFile, validateRules } from "./rules.js";
import { runPayRun, ENGINE_VERSION } from "./engine.js";
import { compare, fromQuickBooks, inputFromStatement, reconcileQuarters, type Comparison, type EmployeeProfile, type QboPayslip, type Statement } from "./compare.js";
import { buildJournal, type AccountMap } from "./journal.js";
import { toBigcapital, postManualJournal, bigcapitalSettings, assertPostable, type BigcapitalConfig } from "./adapters/bigcapital.js";
import { D } from "./money.js";
import type { PayRunInput, PayRunResult } from "./types.js";
import { computeDeposits, planBatches, depositJournal, type Deposit, type DepositOptions, type PayRun } from "./deposits.js";
import { planNotifications, type DepositState } from "./deposit-job.js";
import { deliver, smtpFromEnv, toIcs } from "./notify.js";
import { projectPayRuns, QBO_SEMIMONTHLY, type PaySchedule, type ProjectableProfile } from "./project.js";
import { addDays, lastDayOfMonth } from "./calendar.js";
import { approvePayRun, buildPayRun, voidPayRun, ytdReport, type PayRunRecord, type PayrollAccounts } from "./payrun.js";
import { payDatesBetween, salaryOn } from "./project.js";
import { buildStub, check226, stubPdf, type Stub } from "./paystub.js";
import { D as Dm } from "./money.js";

const DATA = process.env.DATA_DIR ?? "./data";
const RULES = process.env.RULES_DIR ?? "./rules";
const PORT = Number(process.env.PORT ?? 8100);
const HOST = process.env.HOST ?? "0.0.0.0";   // container-internal; compose publishes on 127.0.0.1 only

interface DepositSettings {
  from: string;                          // first pay date openpayroll is responsible for, e.g. "2027-01-01"
  caSchedule?: DepositOptions["caSchedule"];
  futaCreditReductionRate?: string;
  notifyTo?: string;                     // where reminder emails go
  paySchedule?: PaySchedule;             // default: QuickBooks semimonthly (1st and 15th)
  runAtHour?: number;                    // local hour (America/Los_Angeles) for the daily check, default 7
}

interface AppConfig {
  employer: PayRunInput["employer"];
  employees: (EmployeeProfile & Pick<ProjectableProfile, "salaryPerPeriod" | "salaryChanges" | "active"> & {
    employeeNumber?: string;               // printed on stubs instead of any SSN (226(a)(7))
    exemptFromOvertime?: boolean;          // 226(j): salaried + exempt -> hours not required on stubs
    hoursPerPeriod?: string;               // required when not exempt
  })[];
  deposits?: DepositSettings;
  tolerance?: string;
  accounts?: AccountMap & Pick<PayrollAccounts, "netPayPaidFrom">;
  payroll?: {
    allowDraftRules?: boolean;             // approve pay runs computed with DRAFT rule files (testing only)
    employerLegalName?: string;            // pay stubs, Labor Code 226(a)(8): the legal entity's exact name (e.g. "... LLC")
    employerAddress?: string[];            // pay stubs, Labor Code 226(a)(8): legal entity's address lines
    sickLeaveFrontloadHours?: string;      // Labor Code 246(d): full amount (40 hours) given at the start of each calendar year
  };
  bigcapital?: BigcapitalConfig;
}

mkdirSync(join(DATA, "statements"), { recursive: true });
mkdirSync(join(DATA, "payruns"), { recursive: true });

// ---------------------------------------------------------------- storage
const cfgPath = join(DATA, "config.json");
function config(): AppConfig {
  if (!existsSync(cfgPath)) return { employer: { name: "Employer" }, employees: [] };
  return JSON.parse(readFileSync(cfgPath, "utf8")) as AppConfig;
}
const REDACTED = "********";
function redacted(c: AppConfig): AppConfig {
  return c.bigcapital ? { ...c, bigcapital: { ...c.bigcapital, apiKey: c.bigcapital.apiKey ? REDACTED : "" } } : c;
}
function validateConfig(c: unknown): asserts c is AppConfig {
  const x = c as Partial<AppConfig>;
  if (!x || typeof x !== "object") throw new Error("config must be a JSON object");
  if (!x.employer || typeof x.employer.name !== "string") throw new Error("config.employer.name is required");
  if (!Array.isArray(x.employees)) throw new Error("config.employees must be an array");
  for (const e of x.employees) {
    if (!e.providerEmployeeId || !e.frequency || !e.input?.w4) throw new Error("each employee needs providerEmployeeId, frequency, input.w4");
  }
}
function writeJsonAtomic(path: string, v: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(v, null, 2));
  renameSync(path + ".tmp", path);
}
const safeId = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");
function saveStatement(st: Statement) { writeJsonAtomic(join(DATA, "statements", `${safeId(st.id)}.json`), st); }
function statements(): Statement[] {
  return readdirSync(join(DATA, "statements")).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(DATA, "statements", f), "utf8")) as Statement)
    .sort((a, b) => b.period.payDate.localeCompare(a.period.payDate) || a.employeeName.localeCompare(b.employeeName));
}

// ---------------------------------------------------------------- core
interface Row { st: Statement; cmp?: Comparison; result?: PayRunResult; error?: string }
function evaluate(): Row[] {
  const cfg = config();
  let rules: RuleSet | undefined; let rulesErr: string | undefined;
  try { rules = RuleSet.load(RULES); } catch (e) { rulesErr = String(e); }
  const all = statements();
  return all.map(st => {
    if (st.kind === "adjustment") return { st };
    const profile = cfg.employees.find(e => e.providerEmployeeId === st.employeeId);
    if (!profile) return { st, error: `no employee profile for ${st.employeeName} (${st.employeeId}) in config.json` };
    if (!rules) return { st, error: rulesErr };
    try {
      const input = inputFromStatement(st, profile, cfg.employer, all);
      const result = runPayRun(input, rules, { allowDraft: true });
      return { st, result, cmp: compare(result, st, cfg.tolerance ?? "0.00") };
    } catch (e) { return { st, error: e instanceof Error ? e.message : String(e) }; }
  });
}

/** Provider's actual paycheck as a result object, so it can be journaled. */
function statementAsResult(st: Statement): PayRunResult {
  const employerCodes = new Set(["ss_er", "medicare_er", "futa", "ca_ui", "ca_ett"]);
  const taxes = st.lines.map(l => ({ code: l.code, label: l.label, payer: (employerCodes.has(l.code) ? "employer" : "employee") as "employer" | "employee",
    taxableWages: l.taxableWages ?? "0.00", amount: l.amount, ruleRefs: [] }));
  const sum = (p: string) => taxes.filter(t => t.payer === p).reduce((s, t) => s.add(D(t.amount)), D("0")).toMoney();
  return {
    engine: { name: "openpayroll", version: ENGINE_VERSION }, rulesUsed: [], employeeId: safeId(st.employeeName.replace(/\s+/g, "-").toLowerCase()),
    period: { frequency: config().employees.find(e => e.providerEmployeeId === st.employeeId)?.frequency ?? "semimonthly", start: st.period.start, end: st.period.end, payDate: st.period.payDate },
    gross: st.gross, preTax: [], taxes, employeeTaxTotal: sum("employee"), employerTaxTotal: sum("employer"), netPay: st.net,
    ytdAfter: { ssWages: "0", medicareWages: "0", futaWages: "0", caUiWages: "0", caSdiWages: "0" }, warnings: [],
  };
}

// ---------------------------------------------------------------- deposits (B3)
const TZ = "America/Los_Angeles";
const localToday = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const localHour = (d = new Date()) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(d));
const depStatePath = join(DATA, "deposits-state.json");
function depState(): DepositState {
  return existsSync(depStatePath) ? JSON.parse(readFileSync(depStatePath, "utf8")) as DepositState : { scheduled: {}, sent: {} };
}

/** Deposits from settings.from through the end of the quarter ~4 months out (actual + projected pay runs). */
function depositView(today = localToday()) {
  const cfg = config(); const ds = cfg.deposits;
  if (!ds?.from) return { configured: false as const };
  const actual: PayRun[] = [...evaluate().filter(r => r.result).map(r => r.result!),
    ...payRuns().filter(r => r.status === "approved").flatMap(r => r.paychecks.map(p => p.result))];
  const h = new Date(`${today}T12:00:00Z`); h.setUTCDate(h.getUTCDate() + 120);
  const to = lastDayOfMonth(h.getUTCFullYear(), (Math.floor(h.getUTCMonth() / 3) + 1) * 3);
  let projected: PayRun[] = []; let projectionErrors: string[] = []; let uncomputedFrom: string | undefined;
  try {
    const pr = projectPayRuns(actual, cfg.employees, cfg.employer, RuleSet.load(RULES), ds.paySchedule ?? QBO_SEMIMONTHLY, ds.from, to);
    projected = pr.runs;
    uncomputedFrom = pr.errors.map(e => e.payDate).sort()[0];
    // One line per employee and error, with the range of pay dates it affects.
    const byMsg = new Map<string, string[]>();
    for (const e of pr.errors) {
      const who = cfg.employees.find(x => (x.input.id ?? x.providerEmployeeId) === e.employee)?.input.name ?? e.employee;
      const k = `${who}: ${e.error.replace(/no (\S+) rules cover \S+/, "no $1 tax rules loaded for that year yet")}`;
      byMsg.set(k, [...(byMsg.get(k) ?? []), e.payDate]);
    }
    projectionErrors = [...byMsg.entries()].map(([m, dates]) => `${dates[0]}${dates.length > 1 ? ` .. ${dates.at(-1)}` : ""} ${m}`);
  } catch (e) { projectionErrors = [e instanceof Error ? e.message : String(e)]; }
  const deposits = computeDeposits([...actual, ...projected], { from: ds.from, to, caSchedule: ds.caSchedule, futaCreditReductionRate: ds.futaCreditReductionRate });
  // Keep the page and emails to what matters now: anything due from 45 days ago onward.
  const recent = addDays(today, -45);
  const shown = deposits.filter(d => d.dueDate >= recent);
  return { configured: true as const, today, to, deposits: shown, batches: planBatches(shown), projectionErrors, uncomputedFrom, state: depState() };
}

let lastJobDay = "";
async function runDepositJob(dry: boolean, today = localToday()) {
  const v = depositView(today);
  if (!v.configured) return { ran: false, reason: "no deposits settings" };
  const to = config().deposits?.notifyTo;
  if (!to) return { ran: false, reason: "deposits.notifyTo is not set" };
  const plan = planNotifications(v.deposits, v.batches, v.state, today, to, v.projectionErrors, v.uncomputedFrom);
  const results: string[] = [];
  if (!dry) {
    const st = depState();
    for (const p of plan) {
      results.push(`${p.message.subject}: ${await deliver(p.message, smtpFromEnv(), join(DATA, "outbox"))}`);
      for (const k of p.keys) st.sent[k] = today;
      writeJsonAtomic(depStatePath, st);                // after each message, so a failure doesn't resend the ones that went out
    }
  }
  return { ran: true, today, dry, planned: plan.map(p => ({ subject: p.message.subject, keys: p.keys, text: p.message.text })), results };
}

function startDepositTimer() {
  const tick = () => {
    const today = localToday(), hour = config().deposits?.runAtHour ?? 7;
    if (localHour() >= hour && lastJobDay !== today) {
      lastJobDay = today;
      runDepositJob(false).then(r => console.log(`deposit job ${today}:`, JSON.stringify("results" in r ? r.results : r)))
        .catch(e => console.error(`deposit job ${today} failed:`, e instanceof Error ? e.message : e));
    }
  };
  setInterval(tick, 15 * 60 * 1000).unref(); setTimeout(tick, 60 * 1000).unref();
}

function depositCard(): string {
  let v: ReturnType<typeof depositView>;
  try { v = depositView(); } catch (e) { return `<div class="card"><b>Deposits</b><p class="bad">${esc(e instanceof Error ? e.message : e)}</p></div>`; }
  if (!v.configured) return `<div class="card"><b>Deposits</b> <span class="mut">Add a "deposits" section to Settings (from, notifyTo) to turn on the deposit schedule and reminders.</span></div>`;
  const vv = v;
  const row = (d: Deposit) => {
    const m = vv.state.scheduled[d.id];
    const status = m ? (m.amount === d.amount ? `<span class="ok">scheduled</span> <span class="mut">${esc(m.confirmation ?? "")}</span>` : `<span class="bad">scheduled $${esc(m.amount)}: change to $${esc(d.amount)}</span>`) : d.dueDate < vv.today ? `<span class="mut">past</span>` : `<span class="warn">not scheduled</span>`;
    return `<tr><td>${esc(d.dueDate)}</td><td>${esc(d.agency)} ${esc(d.kind)}</td><td>${esc(d.period)}</td><td>${esc(d.amount)}${d.projected ? ` <span class="mut">projected</span>` : ""}</td>
      <td>${esc(d.scheduleFrom)} .. ${esc(d.scheduleBy)}</td><td>${status}</td>
      <td><button onclick="markDep('${esc(d.id)}','${esc(d.amount)}')">${m ? "Update" : "Mark scheduled"}</button>${m ? ` <button onclick="unmarkDep('${esc(d.id)}')">Clear</button>` : ""}</td></tr>`;
  };
  return `<div class="card"><b>Deposits</b> <span class="mut">from ${esc(config().deposits!.from)} through ${esc(v.to)}; calendar feed: <a href="api/deposits.ics">deposits.ics</a></span>
  ${v.projectionErrors.length ? `<ul class="notes">${v.projectionErrors.map(e => `<li class="warn">${esc(e)}</li>`).join("")}</ul>` : ""}
  <p class="mut">Batch emails: ${v.batches.map(b => `${esc(b.id)} on ${esc(b.sendOn)}${v.state.sent[`batch:${b.id}`] ? " (sent)" : ""}`).join("; ") || "none"}</p>
  <div class="wrap"><table class="lines"><tr><th>due</th><th>agency</th><th>period</th><th>amount</th><th>can schedule</th><th>status</th><th></th></tr>
  ${v.deposits.map(row).join("") || `<tr><td colspan="7" class="mut">No deposits in range.</td></tr>`}</table></div>
  <p><button onclick="depJob()">Preview today's emails</button></p><pre id="depout"></pre></div>`;
}

// ---------------------------------------------------------------- pay runs (B1)
const runPath = (id: string) => join(DATA, "payruns", `${safeId(id)}.json`);
function payRuns(): PayRunRecord[] {
  return readdirSync(join(DATA, "payruns")).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(DATA, "payruns", f), "utf8")) as PayRunRecord)
    .sort((a, b) => a.payDate.localeCompare(b.payDate));
}
const saveRun = (r: PayRunRecord) => writeJsonAtomic(runPath(r.id), r);
function buildRun(payDate: string, prior: PayRunRecord[], sickHoursUsed?: Record<string, string>): PayRunRecord {
  const cfg = config();
  return buildPayRun({ payDate, schedule: cfg.deposits?.paySchedule ?? QBO_SEMIMONTHLY, profiles: cfg.employees, employer: cfg.employer,
    rules: RuleSet.load(RULES), prior, statements: statements(), accounts: cfg.accounts, sickHoursUsed });
}
/** Next scheduled pay date after the last live run (or from today). */
function nextPayDate(): string {
  const cfg = config(); const sched = cfg.deposits?.paySchedule ?? QBO_SEMIMONTHLY;
  const lastRun = payRuns().filter(r => r.status !== "voided").at(-1)?.payDate;
  const lastQbo = statements().filter(s => s.kind !== "adjustment").map(s => s.period.payDate).sort().at(-1);
  const after = [lastRun, lastQbo].filter(Boolean).sort().at(-1);
  const from = after ? addDays(after, 1) : localToday();
  return payDatesBetween(from, addDays(from, 40), sched)[0]?.payDate ?? from;
}
/** YTD as if this run were approved (for previews). */
function ytdWith(run: PayRunRecord) {
  const others = payRuns().filter(r => r.id !== run.id);
  return ytdReport([...others, { ...run, status: "approved" }], run.payDate.slice(0, 4));
}

/** Pay stub for one employee in a run (approved runs use earlier approved runs for YTD). */
function stubFor(run: PayRunRecord, employeeId: string): Stub {
  const cfg = config();
  const prof = cfg.employees.find(e => (e.input.id ?? e.providerEmployeeId) === employeeId);
  if (!prof) throw new Error(`no employee ${employeeId} in the settings`);
  if (!cfg.payroll?.employerLegalName) throw new Error("settings: payroll.employerLegalName (the legal entity's exact name) is required on pay stubs");
  if (!cfg.payroll.employerAddress?.length) throw new Error("settings: payroll.employerAddress (the employer's address lines) is required on pay stubs");
  const y = run.payDate.slice(0, 4);
  const earlier = payRuns().filter(r => r.status === "approved" && r.payDate.startsWith(y) && r.payDate < run.payDate);
  const ytdRuns = earlier.flatMap(r => r.paychecks.filter(p => p.employeeId === employeeId).map(p => p.result));
  const usedBefore = earlier.flatMap(r => r.paychecks.filter(p => p.employeeId === employeeId)).reduce((a, p) => a.add(Dm(p.sickHoursUsed ?? "0")), Dm("0")).toMoney();
  const pc = run.paychecks.find(p => p.employeeId === employeeId);
  return buildStub(run, employeeId, ytdRuns, { legalName: cfg.payroll.employerLegalName, address: cfg.payroll.employerAddress },
    { employeeNumber: prof.employeeNumber, exemptFromOvertime: prof.exemptFromOvertime ?? false, hoursPerPeriod: prof.hoursPerPeriod,
      annualSalary: salaryOn(prof, run.payDate) ? Dm(salaryOn(prof, run.payDate)!).mul(String(({ semimonthly: 24, biweekly: 26, weekly: 52, monthly: 12 } as Record<string, number>)[prof.frequency] ?? 0)).toMoney() : undefined },
    { frontloadHours: cfg.payroll.sickLeaveFrontloadHours ?? "40", usedThisPeriod: pc?.sickHoursUsed ?? "0", usedYtdBefore: usedBefore });
}
const stubPath = (run: PayRunRecord, employeeId: string) => join(DATA, "stubs", run.payDate.slice(0, 4), `${safeId(run.payDate)}-${safeId(employeeId)}.pdf`);
/** Build every stub of a run and refuse if any misses a 226(a)/246(i) item. */
function stubsOrThrow(run: PayRunRecord): { employeeId: string; stub: Stub }[] {
  return run.paychecks.map(p => {
    const stub = stubFor(run, p.employeeId);
    const miss = check226(stub);
    if (miss.length) throw new Error(`pay stub for ${p.name} is missing: ${miss.join("; ")}`);
    return { employeeId: p.employeeId, stub };
  });
}

/** Post one journal of an approved run to Bigcapital, exactly once. */
async function postRunJournal(run: PayRunRecord, which: "accrual" | "payment"): Promise<string> {
  const cfg = config();
  const j = run.journals?.[which];
  if (!j) return `${which}: no journal`;
  const st = run.bigcapital?.[which];
  if (st?.status === "posted") return `${which}: already posted (Bigcapital id ${st.bigcapitalId})`;
  if (st?.status === "posting") throw new Error(`${which} journal ${st.journalNumber} may already be in Bigcapital (a previous attempt didn't finish). Check Bigcapital for it, then clear bigcapital.${which} in data/payruns/${run.id}.json if it isn't there.`);
  const bc = bigcapitalSettings(cfg.bigcapital);
  if (!bc) throw new Error("Bigcapital is not configured (BIGCAPITAL_URL / BIGCAPITAL_API_KEY, or config bigcapital.baseUrl / apiKey)");
  assertPostable(j.date, bc);
  const journalNumber = j.reference;
  run.bigcapital = { ...run.bigcapital, [which]: { journalNumber, status: "posting", at: new Date().toISOString() } };
  saveRun(run);                                              // marker first: a crash can't cause a silent duplicate
  const resp = await postManualJournal(toBigcapital(j, bc, journalNumber), bc) as { id?: number };
  run.bigcapital = { ...run.bigcapital, [which]: { journalNumber, status: "posted", bigcapitalId: resp?.id, at: new Date().toISOString() } };
  saveRun(run);
  return `${which}: posted as ${journalNumber} (Bigcapital id ${resp?.id})`;
}

/**
 * Book a scheduled tax deposit in Bigcapital, exactly once: TX-<deposit id>, Dr liability / Cr bank on the due date.
 * The weekly bank-feed review then finds the EFTPS / EDD debit already booked. Returns undefined when Bigcapital isn't
 * configured or the deposit is before postFrom (those periods come from QuickBooks).
 */
async function postDepositJournal(id: string, st: DepositState): Promise<string | undefined> {
  const cfg = config();
  const bc = bigcapitalSettings(cfg.bigcapital);
  if (!bc || !cfg.accounts) return undefined;
  const v = depositView();
  const d = v.configured ? v.deposits.find(x => x.id === id) : undefined;
  if (!d) return `${id}: not in the current deposit list, so not posted; book it by hand`;
  if (!bc.postFrom || d.dueDate < bc.postFrom) return undefined;
  const mark = st.scheduled[id]!, prev = st.posted?.[id];
  if (prev?.status === "posted") return prev.amount === mark.amount ? `${prev.journalNumber}: already posted`
    : `${prev.journalNumber} was posted for ${prev.amount}; the payment is now ${mark.amount}. Correct the journal in Bigcapital.`;
  if (prev?.status === "posting") throw new Error(`${prev.journalNumber} may already be in Bigcapital (a previous attempt didn't finish): check, then clear posted["${id}"] in data/deposit-state.json`);
  const paidFrom = cfg.accounts.netPayPaidFrom;
  if (paidFrom === undefined) throw new Error("accounts.netPayPaidFrom (the bank that pays payroll) is not set");
  const j = depositJournal(d, mark.amount, cfg.accounts, paidFrom);
  assertPostable(j.date, bc);
  st.posted = { ...st.posted, [id]: { journalNumber: j.reference, status: "posting", amount: mark.amount, at: new Date().toISOString() } };
  writeJsonAtomic(depStatePath, st);                          // marker first: a crash can't cause a silent duplicate
  const resp = await postManualJournal(toBigcapital(j, bc, j.reference), bc) as { id?: number };
  st.posted[id] = { journalNumber: j.reference, status: "posted", amount: mark.amount, bigcapitalId: resp?.id, at: new Date().toISOString() };
  writeJsonAtomic(depStatePath, st);
  return `${j.reference}: posted (Bigcapital id ${resp?.id})`;
}

function payRunCard(): string {
  const runs = payRuns();
  const next = (() => { try { return nextPayDate(); } catch { return ""; } })();
  const row = (r: PayRunRecord) => {
    const posted = r.bigcapital?.accrual?.status === "posted" ? `<span class="ok">posted</span>` : r.bigcapital?.accrual?.status === "posting" ? `<span class="bad">posting?</span>` : "";
    const actions = r.status === "draft"
      ? `<button onclick="prAct('${esc(r.id)}','approve')">Approve</button> <button onclick="prCreate('${esc(r.id)}',false,true)">Recompute</button> <button onclick="prDel('${esc(r.id)}')">Delete</button>`
      : r.status === "approved" ? `<button onclick="prAct('${esc(r.id)}','post')">Post to Bigcapital</button> <button onclick="prVoid('${esc(r.id)}')">Void</button>` : esc(r.voidReason ?? "");
    return `<tr><td>${esc(r.payDate)}</td><td>${esc(r.period.start)} .. ${esc(r.period.end)}</td><td>${esc(r.status)} ${posted}</td>
      <td>${esc(r.totals.gross)}</td><td>${esc(r.totals.employeeTaxes)}</td><td>${esc(r.totals.employerTaxes)}</td><td>${esc(r.totals.net)}</td>
      <td>${actions} <a href="api/payruns/${esc(r.id)}">json</a> ${r.paychecks.map(pc => `<a href="api/payruns/${esc(r.id)}/stubs/${encodeURIComponent(pc.employeeId)}.pdf">stub: ${esc(pc.name)}</a>`).join(" ")}</td></tr>`;
  };
  return `<div class="card"><b>Pay runs</b> <span class="mut">openpayroll's own payroll (from the deposits start date). Draft, then approve to lock; approved runs feed the deposit schedule.</span>
  <p>Pay date <input id="prdate" value="${esc(next)}" size="11"> <span class="mut">sick hours used (optional, JSON by employee id)</span> <input id="prsick" placeholder='{"id":"8"}' size="18"> <button onclick="prCreate(document.getElementById('prdate').value,true)">Dry run</button>
  <button onclick="prCreate(document.getElementById('prdate').value,false)">Create draft</button> <span class="mut"><a href="api/ytd?year=${esc((next || localToday()).slice(0, 4))}">YTD</a></span></p>
  <div class="wrap"><table class="lines"><tr><th>pay date</th><th>period</th><th>status</th><th>gross</th><th>employee taxes</th><th>employer taxes</th><th>net</th><th></th></tr>
  ${runs.map(row).join("") || `<tr><td colspan="8" class="mut">No pay runs yet.</td></tr>`}</table></div><pre id="prout"></pre></div>`;
}

// ---------------------------------------------------------------- http helpers
async function body(req: IncomingMessage, limit = 5_000_000): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += (c as Buffer).length; if (size > limit) throw new Error("body too large"); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString("utf8");
}
const json = (res: ServerResponse, code: number, v: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v, null, 2)); };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// ---------------------------------------------------------------- html
function page(): string {
  const rows = evaluate();
  const ruleState = (() => {
    try {
      return listRuleFiles(RULES).map(f => {
        const r = readRuleFile(f); const iss = validateRules(r);
        const state = iss.some(i => i.level === "error") ? "errors" : iss.length ? `incomplete (${iss.length})` : r.status;
        return `<li><b>${esc(r.jurisdiction)} ${esc(r.taxYear)}</b>: ${esc(state)}</li>`;
      }).join("");
    } catch (e) { return `<li>${esc(e)}</li>`; }
  })();
  const matched = rows.filter(r => r.cmp?.matches).length;
  const recon = reconcileQuarters(rows).map(q => `<details class="card"><summary><b>${q.year} Q${q.quarter}</b>
    ${q.uncomputed ? `<span class="warn">${q.uncomputed} checks not computed</span>` : q.rows.some(x => x.diff !== "0.00") ? `<span class="bad">totals differ</span>` : `<span class="ok">totals match</span>`}
    <span class="mut">${q.providerAdjustments} QuickBooks adjustment checks included</span></summary>
    <table class="lines"><tr><th>tax</th><th>QuickBooks (incl. adjustments)</th><th>openpayroll</th><th>diff</th></tr>
    ${q.rows.map(x => q.uncomputed
      ? `<tr><td>${esc(x.code)}</td><td>${esc(x.provider)}</td><td class="mut">—</td><td class="mut">—</td></tr>`
      : `<tr class="${x.diff === "0.00" ? "" : "badrow"}"><td>${esc(x.code)}</td><td>${esc(x.provider)}</td><td>${esc(x.engine)}</td><td>${esc(x.diff)}</td></tr>`).join("")}</table>
    ${q.uncomputed ? `<p class="mut">openpayroll totals are shown only when every paycheck in the quarter was computed.</p>` : ""}</details>`).join("");
  const body = rows.map((r, i) => {
    if (r.st.kind === "adjustment") {
      return `<tr><td>${esc(r.st.period.payDate)}</td><td>${esc(r.st.employeeName)}</td><td colspan="2" class="mut">adjustment check</td><td class="mut">adjustment</td>
        <td>${r.st.lines.filter(l => l.amount !== "0.00").map(l => `${esc(l.label)} ${esc(l.amount)}`).join(", ")}
        <details><summary>journal</summary>
        <p><button onclick="journal('${esc(r.st.id)}', false)">Preview journal</button> <button onclick="journal('${esc(r.st.id)}', true)">Post QuickBooks actuals to Bigcapital</button></p>
        <pre data-id="${esc(r.st.id)}"></pre></details></td></tr>`;
    }
    const status = r.error ? `<span class="warn">not computed</span>` : r.cmp!.matches ? `<span class="ok">match</span>` : `<span class="bad">differs</span>`;
    const detail = r.error ? `<p class="warn">${esc(r.error)}</p>` : `
      <table class="lines"><tr><th>line</th><th>QuickBooks</th><th>openpayroll</th><th>diff</th></tr>
      ${r.cmp!.rows.map(x => `<tr class="${x.status === "match" ? "" : "badrow"}"><td>${esc(x.code)}</td><td>${esc(x.provider ?? "—")}</td><td>${esc(x.engine ?? "—")}</td><td>${esc(x.diff)}</td></tr>`).join("")}
      </table>${r.cmp!.notes.length ? `<ul class="notes">${r.cmp!.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
    return `<tr><td>${esc(r.st.period.payDate)}</td><td>${esc(r.st.employeeName)}</td><td>${esc(r.st.gross)}</td><td>${esc(r.st.net)}</td><td>${status}</td>
      <td><details><summary>lines</summary>${detail}
      <p><button onclick="journal('${esc(r.st.id)}', false)">Preview journal</button> <button onclick="journal('${esc(r.st.id)}', true)">Post QuickBooks actuals to Bigcapital</button></p>
      <pre id="j${i}" data-id="${esc(r.st.id)}"></pre></details></td></tr>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>openpayroll</title><style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#e3e3e3;--ok:#1a7f37;--bad:#c62828;--warn:#9a6700;--card:#f7f7f8}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#9a9a9a;--line:#2c2c2c;--ok:#4ac26b;--bad:#ff7b72;--warn:#d4a72c;--card:#1c1c1c}}
body{font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}.mut{color:var(--mut)}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.lines td,.lines th{font-variant-numeric:tabular-nums;padding:3px 8px}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.badrow td{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}textarea{width:100%;min-height:90px;background:var(--bg);color:var(--fg);border:1px solid var(--line)}
button{padding:4px 10px}pre{white-space:pre-wrap;font-size:12px}.wrap{overflow-x:auto}
</style></head><body>
<h1>openpayroll <span class="mut">shadow comparison</span></h1>
<p class="card"><b>Simulator mode.</b> QuickBooks remains the system of record: it pays, deposits and files. This app only recomputes each QuickBooks paycheck and shows the differences. Results computed with DRAFT rules are for comparison only.</p>
<p class="mut">Engine ${ENGINE_VERSION}. ${rows.filter(r => r.st.kind !== "adjustment").length} paychecks, ${matched} matching; ${rows.filter(r => r.st.kind === "adjustment").length} adjustment checks.</p>
<div class="card"><b>Rules</b><ul>${ruleState}</ul></div>
<div class="card"><b>Import QuickBooks pay stubs</b> <span class="mut">(JSON export: array of payslips with employee_taxes / employer_taxes)</span>
<p><input type="file" id="impfile" accept=".json,application/json" onchange="loadFile(this)"></p>
<textarea id="imp" placeholder='[{"id":"...","employee":{...},"pay_period":{...},"employee_taxes":[...],...}]'></textarea>
<button onclick="imp()">Import</button> <span id="impmsg" class="mut"></span></div>
<details class="card"><summary><b>Settings</b> <span class="mut">(employer, employee W-4 / DE 4 profiles, accounts, Bigcapital)</span></summary>
<p class="mut">Stored in the data volume as config.json. The Bigcapital API key is shown as ${REDACTED}; leave it that way to keep the saved key.</p>
<textarea id="cfg" style="min-height:260px;font-family:ui-monospace,monospace">${esc(JSON.stringify(redacted(config()), null, 2))}</textarea>
<button onclick="saveCfg()">Save settings</button> <span id="cfgmsg" class="mut"></span></details>
${payRunCard()}
${depositCard()}
<h2 style="font-size:16px">Quarter reconciliation</h2>${recon || `<p class="mut">No statements yet.</p>`}
<h2 style="font-size:16px">Paychecks</h2>
<div class="wrap"><table><tr><th>pay date</th><th>employee</th><th>gross</th><th>net</th><th>status</th><th></th></tr>${body || `<tr><td colspan="6" class="mut">No statements yet.</td></tr>`}</table></div>
<script>
async function imp(){const m=document.getElementById('impmsg');try{const r=await fetch('api/statements/import',{method:'POST',headers:{'content-type':'application/json','x-openpayroll':'1'},body:document.getElementById('imp').value});const j=await r.json();m.textContent=r.ok?('imported '+j.imported):j.error;if(r.ok)setTimeout(()=>location.reload(),600)}catch(e){m.textContent=e}}
function loadFile(el){const f=el.files[0];if(!f)return;f.text().then(t=>{document.getElementById('imp').value=t})}
async function saveCfg(){const m=document.getElementById('cfgmsg');try{const r=await fetch('api/config',{method:'POST',headers:{'content-type':'application/json','x-openpayroll':'1'},body:document.getElementById('cfg').value});const j=await r.json();m.textContent=r.ok?'saved':j.error;if(r.ok)setTimeout(()=>location.reload(),600)}catch(e){m.textContent=e}}
async function prCreate(d,dry,re){const r=await fetch('api/payruns',{method:'POST',headers:{'content-type':'application/json','x-openpayroll':'1'},body:JSON.stringify({payDate:d,dryRun:!!dry,recompute:!!re,sickHours:(()=>{const v=(document.getElementById('prsick')||{}).value;try{return v?JSON.parse(v):undefined}catch{alert('sick hours must be JSON like {"employee id":"8"}');throw new Error('bad json')}})()})});const j=await r.json();
if(!r.ok){document.getElementById('prout').textContent=j.error;return}
if(dry){const x=j.run;document.getElementById('prout').textContent='DRY RUN '+x.payDate+' ('+x.period.start+' .. '+x.period.end+')\\n'+x.paychecks.map(p=>p.name+': gross '+p.result.gross+', employee taxes '+p.result.employeeTaxTotal+', employer taxes '+p.result.employerTaxTotal+', net '+p.result.netPay+'\\n  '+p.result.taxes.map(t=>t.code+' '+t.amount).join(', ')).join('\\n')+(x.journals?'\\n\\nJournal '+x.journals.accrual.reference+':\\n'+x.journals.accrual.lines.map(l=>'  '+l.account+'  Dr '+l.debit+'  Cr '+l.credit+'  '+l.memo).join('\\n'):'\\n\\n(no accounts map: journal not built)')+'\\n\\nYTD after this run:\\n'+j.ytd.map(y=>'  '+y.name+': gross '+y.gross+', net '+y.net+' ('+y.payRuns+' runs)').join('\\n');return}
location.reload()}
async function prAct(id,a){if(a==='post'&&!confirm('Post pay run '+id+' journals to Bigcapital?'))return;const r=await fetch('api/payruns/'+encodeURIComponent(id)+'/'+a,{method:'POST',headers:{'x-openpayroll':'1'}});const j=await r.json();if(r.ok)location.reload();else document.getElementById('prout').textContent=j.error}
async function prVoid(id){const why=prompt('Reason for voiding pay run '+id+':','');if(!why)return;const r=await fetch('api/payruns/'+encodeURIComponent(id)+'/void',{method:'POST',headers:{'content-type':'application/json','x-openpayroll':'1'},body:JSON.stringify({reason:why})});const j=await r.json();if(r.ok)location.reload();else document.getElementById('prout').textContent=j.error}
async function prDel(id){if(!confirm('Delete draft pay run '+id+'?'))return;const r=await fetch('api/payruns/'+encodeURIComponent(id),{method:'DELETE',headers:{'x-openpayroll':'1'}});if(r.ok)location.reload();else document.getElementById('prout').textContent=(await r.json()).error}
async function markDep(id,amt){const c=prompt('Confirmation number for '+id+' ($'+amt+'):','');if(c===null)return;const a=prompt('Amount scheduled:',amt);if(a===null)return;
const r=await fetch('api/deposits/'+encodeURIComponent(id)+'/scheduled',{method:'POST',headers:{'content-type':'application/json','x-openpayroll':'1'},body:JSON.stringify({amount:a,confirmation:c})});if(r.ok)location.reload();else alert((await r.json()).error)}
async function unmarkDep(id){if(!confirm('Clear the scheduled mark for '+id+'?'))return;const r=await fetch('api/deposits/'+encodeURIComponent(id)+'/scheduled',{method:'DELETE',headers:{'x-openpayroll':'1'}});if(r.ok)location.reload()}
async function depJob(){const r=await fetch('api/deposits/run?dry=1',{method:'POST',headers:{'x-openpayroll':'1'}});const j=await r.json();document.getElementById('depout').textContent=j.planned?(j.planned.length?j.planned.map(p=>p.subject+'\\n\\n'+p.text).join('\\n\\n----\\n\\n'):'Nothing to send today.'):JSON.stringify(j)}
async function journal(id,post){const pre=[...document.querySelectorAll('pre')].find(p=>p.dataset.id===id);
if(post&&!confirm('Post this paycheck to Bigcapital as a draft manual journal?'))return;
const r=await fetch('api/statements/'+encodeURIComponent(id)+'/journal'+(post?'?post=1':''),{method:'POST',headers:{'x-openpayroll':'1'}});pre.textContent=JSON.stringify(await r.json(),null,2)}
</script></body></html>`;
}

// ---------------------------------------------------------------- routes
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  // Custom header on every POST forces a CORS preflight, so other websites can't trigger actions (CSRF).
  if (req.method === "POST" && req.headers["x-openpayroll"] !== "1") return json(res, 403, { error: "missing X-OpenPayroll header" });
  if (req.method === "GET" && p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page()); return; }
  if (req.method === "GET" && p === "/api/health") return json(res, 200, { ok: true, engine: ENGINE_VERSION });
  if (req.method === "GET" && p === "/api/rules") return json(res, 200, listRuleFiles(RULES).map(f => { const r = readRuleFile(f); return { file: f, jurisdiction: r.jurisdiction, taxYear: r.taxYear, status: r.status, issues: validateRules(r) }; }));
  if (req.method === "GET" && p === "/api/statements") return json(res, 200, statements());
  if (req.method === "GET" && p === "/api/summary") {
    const rows = evaluate();
    const regular = rows.filter(r => r.st.kind !== "adjustment");
    return json(res, 200, {
      engine: ENGINE_VERSION,
      rules: listRuleFiles(RULES).map(f => { const r = readRuleFile(f); const iss = validateRules(r); return { jurisdiction: r.jurisdiction, taxYear: r.taxYear, status: r.status, issues: iss.length }; }),
      paychecks: regular.length, adjustments: rows.length - regular.length,
      matching: regular.filter(r => r.cmp?.matches).length,
      notComputed: regular.filter(r => !r.cmp).map(r => ({ payDate: r.st.period.payDate, employee: r.st.employeeName, error: r.error })),
      differing: regular.filter(r => r.cmp && !r.cmp.matches).map(r => ({ payDate: r.st.period.payDate, employee: r.st.employeeName, summary: r.cmp!.summary })),
      quarters: reconcileQuarters(rows).map(q => ({ ...q, rows: q.uncomputed ? [] : q.rows.filter(x => x.diff !== "0.00"), totalsMatch: !q.uncomputed && q.rows.every(x => x.diff === "0.00") })),
    });
  }
  if (req.method === "GET" && p === "/api/comparisons") return json(res, 200, evaluate().map(r => ({ statement: r.st.id, payDate: r.st.period.payDate, employee: r.st.employeeName, error: r.error, comparison: r.cmp })));

  // ---- pay runs
  if (req.method === "GET" && p === "/api/payruns")
    return json(res, 200, payRuns().map(r => ({ id: r.id, payDate: r.payDate, status: r.status, totals: r.totals, fingerprint: r.fingerprint, bigcapital: r.bigcapital ?? null })));
  if (req.method === "GET" && p === "/api/payruns/next") return json(res, 200, { payDate: nextPayDate() });
  if (req.method === "GET" && p === "/api/ytd") return json(res, 200, ytdReport(payRuns(), url.searchParams.get("year") ?? localToday().slice(0, 4)));
  if (req.method === "POST" && p === "/api/payruns") {
    let b: { payDate?: string; dryRun?: boolean; recompute?: boolean; sickHours?: Record<string, string> };
    try { b = JSON.parse(await body(req, 10_000)); } catch { return json(res, 400, { error: "body is not valid JSON" }); }
    if (!b.payDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.payDate)) return json(res, 400, { error: "payDate (YYYY-MM-DD) is required" });
    const all = payRuns(); const existing = all.find(r => r.id === b.payDate);
    let run: PayRunRecord;
    try { run = buildRun(b.payDate, all.filter(r => r.id !== b.payDate), b.sickHours); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    if (b.dryRun) return json(res, 200, { dryRun: true, run, ytd: ytdWith(run), existing: existing ? { status: existing.status, sameAsSaved: existing.fingerprint === run.fingerprint } : null });
    if (existing?.status === "approved") return json(res, 409, { error: `pay run ${existing.id} is approved and locked; void it to redo it` });
    if (existing?.status === "draft" && !b.recompute) return json(res, 200, { created: false, unchanged: existing.fingerprint === run.fingerprint, run: existing });
    if (existing?.status === "voided") {
      mkdirSync(join(DATA, "payruns", "voided"), { recursive: true });
      renameSync(runPath(existing.id), join(DATA, "payruns", "voided", `${safeId(existing.id)}-${existing.voidedAt?.replace(/[:.]/g, "-")}.json`));
    }
    if (existing?.status === "draft" && existing.fingerprint === run.fingerprint) return json(res, 200, { created: false, unchanged: true, run: existing });
    saveRun(run);
    return json(res, 200, { created: true, run });
  }
  const sm = /^\/api\/payruns\/(\d{4}-\d{2}-\d{2})\/stubs\/([^/]+)\.pdf$/.exec(p);
  if (req.method === "GET" && sm) {
    const run = payRuns().find(r => r.id === sm[1]);
    if (!run) return json(res, 404, { error: "no such pay run" });
    const emp = decodeURIComponent(sm[2]!);
    const f = stubPath(run, emp);
    let pdf: Buffer;
    try { pdf = run.status === "approved" && existsSync(f) ? readFileSync(f) : stubPdf(stubFor(run, emp)); }
    catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `inline; filename="paystub-${run.payDate}-${safeId(emp)}.pdf"` });
    res.end(pdf); return;
  }
  const pm = /^\/api\/payruns\/(\d{4}-\d{2}-\d{2})(?:\/(approve|void|post))?$/.exec(p);
  if (pm) {
    const all = payRuns(); const run = all.find(r => r.id === pm[1]);
    if (!run) return json(res, 404, { error: "no such pay run" });
    if (req.method === "GET" && !pm[2]) return json(res, 200, run);
    if (req.method === "DELETE" && !pm[2]) {
      if (run.status !== "draft") return json(res, 409, { error: `only drafts can be deleted; ${run.id} is ${run.status}` });
      unlinkSync(runPath(run.id)); return json(res, 200, { deleted: run.id });
    }
    if (req.method === "POST" && pm[2] === "approve") {
      try {
        const a = approvePayRun(run, all, { allowDraftRules: config().payroll?.allowDraftRules });
        const stubs = stubsOrThrow(a);                     // before saving: an approved run always has compliant stubs
        saveRun(a);
        for (const { employeeId, stub } of stubs) {        // the retained copy (226(a): keep at least three years)
          const f = stubPath(a, employeeId); mkdirSync(join(f, ".."), { recursive: true });
          if (!existsSync(f)) writeFileSync(f, stubPdf(stub));
        }
        // Posting is best-effort here: the approval stands even if Bigcapital is unreachable (post again with /post).
        let posting: string[] | { error: string } | undefined;
        const bc = bigcapitalSettings(config().bigcapital);
        if (bc?.postOnApprove) {
          try { posting = [await postRunJournal(a, "accrual"), await postRunJournal(a, "payment")]; }
          catch (e) { posting = { error: e instanceof Error ? e.message : String(e) }; }
        }
        return json(res, 200, { approved: a.id, stubs: stubs.length, ...(posting ? { bigcapital: posting } : {}) });
      }
      catch (e) { return json(res, 409, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method === "POST" && pm[2] === "void") {
      let b: { reason?: string };
      try { b = JSON.parse(await body(req, 10_000)); } catch { return json(res, 400, { error: "body is not valid JSON" }); }
      try {
        const v = voidPayRun(run, all, b.reason ?? ""); saveRun(v);
        return json(res, 200, { voided: v.id, note: run.bigcapital?.accrual?.status === "posted" ? "This run was posted to Bigcapital: reverse or delete those journals there." : undefined });
      } catch (e) { return json(res, 409, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (req.method === "POST" && pm[2] === "post") {
      if (run.status !== "approved") return json(res, 409, { error: `only approved pay runs are posted; ${run.id} is ${run.status}` });
      try { return json(res, 200, { results: [await postRunJournal(run, "accrual"), await postRunJournal(run, "payment")] }); }
      catch (e) { return json(res, 502, { error: e instanceof Error ? e.message : String(e) }); }
    }
  }

  if (req.method === "GET" && p === "/api/deposits") return json(res, 200, depositView(url.searchParams.get("today") ?? undefined));
  if (req.method === "GET" && p === "/api/deposits.ics") {
    const v = depositView();
    res.writeHead(200, { "content-type": "text/calendar; charset=utf-8" }); res.end(toIcs(v.configured ? v.deposits : [])); return;
  }
  if (req.method === "POST" && p === "/api/deposits/run") {
    return json(res, 200, await runDepositJob(url.searchParams.get("dry") === "1", url.searchParams.get("today") ?? undefined));
  }
  const dm = /^\/api\/deposits\/([^/]+)\/scheduled$/.exec(p);
  if (dm && (req.method === "POST" || req.method === "DELETE")) {
    const id = decodeURIComponent(dm[1]!);
    const st = depState();
    if (req.method === "DELETE") {
      delete st.scheduled[id]; writeJsonAtomic(depStatePath, st);
      const tx = st.posted?.[id];
      return json(res, 200, { cleared: id, ...(tx ? { note: `journal ${tx.journalNumber} is in Bigcapital: if the payment was cancelled, delete it there and remove posted["${id}"] from data/deposit-state.json` } : {}) });
    }
    let b: { amount?: string; confirmation?: string };
    try { b = JSON.parse(await body(req, 10_000)); } catch { return json(res, 400, { error: "body is not valid JSON" }); }
    if (!b.amount || !/^\d+(\.\d{1,2})?$/.test(b.amount)) return json(res, 400, { error: "amount is required, e.g. 1502.16" });
    st.scheduled[id] = { amount: D(b.amount).toMoney(), confirmation: (b.confirmation ?? "").slice(0, 100), at: new Date().toISOString() };
    writeJsonAtomic(depStatePath, st);
    let bigcapital: string | { error: string } | undefined;
    try { bigcapital = await postDepositJournal(id, st); } catch (e) { bigcapital = { error: e instanceof Error ? e.message : String(e) }; }
    return json(res, 200, { scheduled: id, ...st.scheduled[id], ...(bigcapital ? { bigcapital } : {}) });
  }

  if (req.method === "GET" && p === "/api/config") return json(res, 200, redacted(config()));
  if (req.method === "POST" && p === "/api/config") {
    let next: unknown;
    try { next = JSON.parse(await body(req, 1_000_000)); } catch { return json(res, 400, { error: "settings are not valid JSON" }); }
    try { validateConfig(next); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    const cur = config();
    if (next.bigcapital?.apiKey === REDACTED) next.bigcapital.apiKey = cur.bigcapital?.apiKey ?? "";
    // Keep every previous version so any settings change can be undone.
    if (existsSync(cfgPath)) {
      mkdirSync(join(DATA, "config-history"), { recursive: true });
      writeJsonAtomic(join(DATA, "config-history", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`), cur);
    }
    writeJsonAtomic(cfgPath, next);
    return json(res, 200, { saved: true });
  }

  if (req.method === "POST" && p === "/api/statements/import") {
    let raw: unknown;
    try { raw = JSON.parse(await body(req)); } catch { return json(res, 400, { error: "import is not valid JSON" }); }
    const list = (Array.isArray(raw) ? raw : (raw as { payslips?: unknown[] }).payslips ?? [raw]) as (QboPayslip | Statement)[];
    let n = 0; const skipped: string[] = [];
    for (const item of list) {
      const st = "employee_taxes" in item ? fromQuickBooks(item as QboPayslip) : item as Statement;
      const ptype = (item as QboPayslip).payslip_type;
      if (ptype && ptype !== "REGULAR" && ptype !== "ADJUSTMENT") { skipped.push(`${st.id} (${(item as QboPayslip).payslip_type})`); continue; }
      if (!st.id || !st.period?.payDate) throw new Error("each item needs id and pay period");
      const prev = statements().find(x => x.id === st.id) as (Statement & { postedToBigcapital?: string }) | undefined;
      saveStatement(prev?.postedToBigcapital ? { ...st, postedToBigcapital: prev.postedToBigcapital } as Statement : st); n++;
    }
    return json(res, 200, { imported: n, skipped });
  }

  const jm = /^\/api\/statements\/([^/]+)\/journal$/.exec(p);
  if (req.method === "POST" && jm) {
    const cfg = config();
    const st = statements().find(s => s.id === decodeURIComponent(jm[1]!));
    if (!st) return json(res, 404, { error: "no such statement" });
    if (!cfg.accounts) return json(res, 400, { error: "config.json has no 'accounts' map" });
    const journal = buildJournal(statementAsResult(st), cfg.accounts, `QBO-${st.period.payDate}-${st.id.slice(-6)}`);
    if (url.searchParams.get("post") !== "1") return json(res, 200, { journal });
    const bc = bigcapitalSettings(cfg.bigcapital);
    if (!bc) return json(res, 400, { error: "Bigcapital is not configured" });
    try { assertPostable(journal.date, bc); } catch (e) { return json(res, 409, { error: e instanceof Error ? e.message : String(e) }); }
    const posted = (st as Statement & { postedToBigcapital?: string }).postedToBigcapital;
    if (posted) return json(res, 409, { error: `already posted on ${posted}; delete it in Bigcapital and clear postedToBigcapital to repost` });
    const payload = toBigcapital(journal, bc);
    const response = await postManualJournal(payload, bc);
    saveStatement({ ...st, postedToBigcapital: new Date().toISOString() } as Statement);
    return json(res, 200, { posted: response, payload });
  }
  json(res, 404, { error: "not found" });
}

createServer((req, res) => {
  handle(req, res).catch(e => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
}).listen(PORT, HOST, () => { console.log(`openpayroll ${ENGINE_VERSION} listening on ${HOST}:${PORT} (data ${DATA}, rules ${RULES})`); startDepositTimer(); });
