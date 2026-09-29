# openpayroll

Open-source US payroll calculation engine, with a small web app that runs it side by side with your
current payroll provider before you trust it with real paychecks.

- **Engine**: federal income tax (IRS Pub 15-T percentage method, 2020+ and legacy W-4), Social Security,
  Medicare and Additional Medicare, FUTA; California PIT (EDD DE 44 Method B), SDI, UI, ETT.
- **Rules as data**: every rate, wage base and bracket lives in `rules/<jurisdiction>/<year>.json` with a
  citation to the agency publication it came from. Code never hard-codes a tax number.
- **Exact arithmetic**: rational numbers on `BigInt`; rounding happens only where the agency says to round.
- **Simulator mode**: import pay stubs from QuickBooks Online Payroll, recompute every paycheck, and compare
  line by line and per quarter (the level Form 941 and DE 9 are filed at).
- **Accounting**: turns a paycheck into a balanced journal entry and posts it to
  [Bigcapital](https://github.com/bigcapitalhq/bigcapital) as a draft manual journal.
- Zero runtime dependencies. Apache-2.0.

> **Status: pre-release.** The 2026 federal and California rule files are transcribed from the official PDFs
> (IRS Pub 15-T 2026, EDD DE 44 Rev. 52) by script, pass the validator and the DE 44 worked examples, and
> reconcile to the cent with a real 2026 QuickBooks payroll. They stay `draft` until a person has checked every
> value against the PDFs (see CONTRIBUTING). It does not move money, file returns, or make deposits.

## Why simulator mode

Switching payroll providers is where mistakes happen. openpayroll is meant to run in the shadow of your
existing provider for a few months:

1. Your provider keeps paying, depositing and filing.
2. After each payday, import that provider's pay stubs.
3. openpayroll recomputes each one from the employee's W-4 / DE 4 and shows every difference, per line and
   per quarter. Provider correction checks (e.g. QuickBooks re-rating state UI after a rate notice) are
   included in the quarter totals, so quarters can reconcile to the cent even when single checks don't.
4. Once a full quarter matches, you know the engine and your employee settings are right.

## Run the app (Docker)

```bash
docker compose up -d --build      # builds, runs the test suite, serves on 127.0.0.1:8100
```

The app has **no login**. The compose file publishes it on loopback only. Reach it from your own devices
through a private network, for example Tailscale:

```bash
sudo tailscale serve --bg --https=8443 http://127.0.0.1:8100   # check flags with: tailscale serve --help
```

Every state-changing request needs the header `X-OpenPayroll: 1`. Browsers can't add that header cross-site
without a CORS preflight the app never approves, which blocks CSRF from other websites.

Then open the page and:

1. **Settings**: paste a config (see `examples/config.example.json`): your EDD UI rate, the California method
   (`caPitMethod`: `"period"` tables or `"annualized"`; QuickBooks uses annualized), and for each employee
   the provider's employee id, pay frequency, W-4 and DE 4. Optionally the Bigcapital account map and API key.
2. **Import**: choose the QuickBooks export file (JSON).
3. Read the **Quarter reconciliation** and **Paychecks** sections.

Data lives in the `openpayroll_data` volume (`config.json` plus one JSON file per imported paycheck).
Back it up like any other business record.

### Getting pay stubs out of QuickBooks

The importer takes Intuit's payslip JSON: the payslip list merged with each payslip's details
(`employee_taxes`, `employer_taxes`, `deductions`). A plain array, or `{ "payslips": [...] }`.
QuickBooks' own report exports (CSV/Excel) are not supported yet.

Tax names are mapped in `QBO_TAX_MAP` (`src/compare.ts`). Unmapped names are listed on the paycheck,
never silently dropped.

Known QuickBooks behavior: `current_taxable_income` for FUTA, UI and ETT is the full gross even after the
$7,000 wage base is reached. openpayroll therefore compares **amounts**, not QuickBooks' taxable wages.

## Pay runs (live payroll)

From the deposits start date (`deposits.from`), openpayroll runs payroll itself instead of shadowing QuickBooks. A **pay run** is one pay date for every active salaried employee (`salaryPerPeriod`), on the pay schedule (default: QuickBooks' semimonthly 1st/15th).

- **Dry run**: computes paychecks, the journal and year-to-date totals without saving. Running it again gives identical results (same `fingerprint`).
- **Create draft**: saves the run. Creating it again is a no-op if nothing changed; **Recompute** rebuilds it after a settings change. Drafts can be deleted.
- **Approve**: locks the run. Approved runs never change, feed the deposit schedule and the YTD report, and are what the returns are built from. Approval refuses runs computed with **draft** rule files (`payroll.allowDraftRules: true` overrides this for testing only).
- **Void** (with a reason): takes an approved run out of YTD. Voiding goes latest-first; the voided file is archived when the date is re-run.
- **Order**: a run can't be created while a later run exists in the same year, and can't be approved while an earlier one is still a draft. This keeps year-to-date wages right.
- **YTD** carries from run to run through the engine's `ytdAfter`, starting from any QuickBooks pay stubs imported for the same year. A pay date QuickBooks already paid is refused.

**Journals** follow QuickBooks' two "Payroll Check" entries, with the accounts from `config.accounts`:
1. `PR-<pay date>`: Dr wages and employer taxes; Cr each tax liability and **net pay** (`accounts.netPay`, e.g. Direct Deposit Payable).
2. `PR-<pay date>-NET` (only if `accounts.netPayPaidFrom` is set): Dr net pay account, Cr the bank.

**Post to Bigcapital** sends an approved run's journals as manual journals numbered `PR-...`. A "posting" marker is saved before each request, so a failed or interrupted post is never silently repeated; the run says to check Bigcapital first.

API: `GET /api/payruns`, `GET /api/payruns/next`, `POST /api/payruns` `{"payDate":"2027-01-15","dryRun":true}` (or `"recompute":true`), `GET|DELETE /api/payruns/{date}`, `POST /api/payruns/{date}/approve|void|post`, `GET /api/ytd?year=2027`.

## Pay stubs (California itemized wage statements)

Every paycheck in a pay run has a PDF stub (link on the Pay runs card; `GET /api/payruns/{date}/stubs/{employeeId}.pdf`). It carries every item of Labor Code 226(a) and the paid sick leave balance of 246(i):

| 226(a) | On the stub |
|---|---|
| (1) gross wages | Earnings and "Gross wages", this period and year to date |
| (2) total hours | shown for non-exempt employees (`hoursPerPeriod`); omitted with a note for salaried exempt employees (226(j)) |
| (4) all deductions | each tax withheld, this period and year to date |
| (5) net wages | "Net pay" |
| (6) pay period dates | "Pay period" |
| (7) name and ID | employee name and `employeeNumber` (never an SSN; an SSN-looking ID is refused) |
| (8) employer | `payroll.employerLegalName` and `payroll.employerAddress` |
| (9) hourly rates and hours | non-exempt: hours and rate (salary / hours) |
| 246(i) sick leave | "Paid sick leave available": `payroll.sickLeaveFrontloadHours` (the full 40 hours given each calendar year, 246(d)) minus hours used (`sickHours` when creating a pay run) |

- **Approval requires compliant stubs.** A run can't be approved if any stub misses an item, and approving saves each stub under `/data/stubs/<year>/` (226(a): keep a copy for at least three years). Approved stubs are always served from that saved copy. Drafts say DRAFT.
- **Year-to-date columns** count openpayroll's approved pay runs only (not QuickBooks paychecks imported for the same year). With a January 1 start that's the whole year; a mid-year start would understate them. YTD isn't a 226(a) item.
- **Exempt salary check.** `exemptFromOvertime: true` is refused if the annual salary is below 2 x the California minimum wage x 2080 for the pay year (2026: $70,304; 2027: $72,384, from the $17.40 minimum wage). Below that floor the employee isn't exempt: hours must be shown and overtime applies. Add each new year's minimum wage to `CA_MIN_WAGE` in `src/paystub.ts`.

Settings:

```json
"payroll": { "employerLegalName": "Example Engineering LLC", "employerAddress": ["100 Harbor Way Ste 1", "Oceanside, CA 92054"], "sickLeaveFrontloadHours": "40" },
"employees": [ { "providerEmployeeId": "...", "employeeNumber": "E-0001", "exemptFromOvertime": true, "salaryPerPeriod": "3016.00" } ]
```

## Deposit schedule and reminders

openpayroll works out every payroll-tax deposit for a **monthly federal depositor in California** and emails you what to schedule. Nothing is paid automatically: neither EFTPS nor EDD e-Services has an API for a single employer. Both let you **schedule payments ahead** (EFTPS up to 120 days for businesses, EDD ACH debits up to 90 days), so the routine is one short session per quarter.

- **Federal (Pub 15):** 941 taxes (withholding, both halves of social security and Medicare, Additional Medicare) for wages *paid* in a month are due the 15th of the next month. Saturdays, Sundays and DC legal holidays move the date to the next business day; the holiday generator is tested against Pub 15 (2026)'s printed list. EFTPS needs the payment by 8 p.m. Eastern the day before. FUTA is deposited at a quarter end once over $500; otherwise it's paid with the 940.
- **California (DE 44):** PIT + SDI monthly (`caSchedule: "monthly"`, the default; paying early is always allowed) or the minimum $350-rule schedule (`"minimum"`). UI + ETT are quarterly with the DE 9. California's legal holidays include moving dates whose treatment by the EDD isn't documented, so its calendar **errs early**: a date can only come out a day early, never late.
- **Future paychecks** are projected with the engine from `salaryPerPeriod`. If a year's rule files aren't loaded yet (e.g. 2027 before Pub 15-T 2027), those amounts are missing and the email says so.

Emails (a daily check at `runAtHour`, default 7 a.m. Pacific):
1. **Batch:** once per quarter of wages, on the first day every payment in it can be scheduled: the payments with amounts, due dates and where to enter them.
2. **Change:** after a payday, if a payment you marked as scheduled no longer matches the paychecks.
3. **Reminder:** 5 days before, and on, the last day to schedule a payment that isn't marked scheduled.

Mark each payment as scheduled on the page (Deposits card) with its confirmation number. The card also links a calendar feed (`/api/deposits.ics`), and "Preview today's emails" shows what the daily check would send.

Settings (in `config.json`):

```json
"deposits": { "from": "2027-01-01", "notifyTo": "you@example.com", "caSchedule": "monthly" },
"employees": [ { "providerEmployeeId": "...", "salaryPerPeriod": "2500.00", "frequency": "semimonthly", "input": { } } ]
```

Salary changes: `"salaryChanges": [{ "from": "2027-01-01", "perPeriod": "2600.00" }]` on an employee; the latest entry whose `from` is on or before the pay date wins, otherwise `salaryPerPeriod`.

Optional: `futaCreditReductionRate` (DOL publishes it in November), `paySchedule` (default: pay on the 1st for the 17th..1st and on the 15th for the 2nd..16th), `runAtHour`, and `"active": false` on employees who have left.

Email goes over SMTP with STARTTLS (for example Postmark on port 2525). Put these in `/etc/openpayroll/openpayroll.env` (read by `docker-compose.yml`); without them, messages are written to `/data/outbox/` instead:

```bash
SMTP_HOST=smtp.postmarkapp.com
SMTP_PORT=2525
SMTP_USER=<SMTP token access key>
SMTP_PASS=<SMTP token secret>
MAIL_FROM=Payroll <accounting@example.com>
```

API: `GET /api/deposits`, `GET /api/deposits.ics`, `POST /api/deposits/run?dry=1` (preview; without `dry=1` it sends and records), `POST` or `DELETE /api/deposits/{id}/scheduled` with `{"amount":"1502.16","confirmation":"..."}`.

## Library and CLI

```bash
npm install && npm test
node dist/src/cli.js validate rules
# examples use the synthetic 2099 test tables:
node dist/src/cli.js run --rules test/fixtures/rules --input examples/pay-run.fixture.json --trace
node dist/src/cli.js run --rules test/fixtures/rules --input examples/pay-run.fixture.json --journal examples/accounts.example.json
```

```ts
import { RuleSet, runPayRun, buildJournal, toBigcapital } from "openpayroll";
const rules = RuleSet.load("rules");
const result = runPayRun(input, rules);          // throws on draft/incomplete rules unless { allowDraft: true }
const journal = buildJournal(result, accounts);  // Dr wages + employer tax expense / Cr liabilities + net pay
```

`test/fixtures/rules/*-2099.json` hold synthetic round-number tables for tests. They are not real tax data.

## Bigcapital

Posting creates a **draft** manual journal (`POST /api/manual-journals`, `Authorization: Bearer bc_...`)
so you can review it in Bigcapital before publishing. In simulator mode the app posts the **provider's
actual amounts**, so your books match what was really paid. A paycheck can be posted once; the app refuses
a second post.

Settings (`bigcapital` in config.json): `publish` (default false = draft), `postFrom` (**required**: nothing dated
before it is posted, e.g. your cutover from the previous payroll provider), `postOnApprove` (post a run's journals the
moment it is approved). The URL and key can come from the environment instead of config.json:
`BIGCAPITAL_URL` and `BIGCAPITAL_API_KEY`, read from `/etc/openpayroll/bigcapital.env`. If Bigcapital runs on the
same host, add `-f docker-compose.bigcapital.yml` to join its docker network (`BIGCAPITAL_URL=http://bigcapital-server:3000`).

Tax deposits: marking a deposit scheduled (`POST /api/deposits/:id/scheduled`) also posts `TX-<deposit id>` on its due
date, Dr the liability the paychecks accrued / Cr the bank (`accounts.netPayPaidFrom`), so a bank feed finds the
EFTPS / EDD debit already booked. A FUTA credit reduction (never accrued per paycheck) is expensed. A deposit whose tax
codes map to more than one liability account is refused.

## Scope and limits

- US federal + California only. Other states are welcome (see CONTRIBUTING).
- Salary/hourly gross only; pre-tax deductions are modelled in the engine but not yet imported from providers.
- Supplemental wages (bonuses) use the regular method and raise a warning.
- Not tax or legal advice. You are responsible for your filings.

## License

Apache-2.0. See `LICENSE`.
