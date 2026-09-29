# Contributing

The hard part of payroll is not code, it is getting every number right every year. These rules exist so
that a wrong number can't reach a paycheck quietly.

## Rule files

`rules/<jurisdiction>/<year>.json`. Each value is `{ "value": ..., "ref": { "doc": ..., "locator": ... } }`,
where `doc` names a publication listed in the file's `sources` (title, revision, URL) and `locator` says
where in it (table, page, worksheet line).

A file is `draft` until verified. The engine refuses draft files unless the caller passes `allowDraft`,
and the web app labels such results "comparison only". A `null` value means "not transcribed yet" and
makes the file incomplete; the engine refuses incomplete files even with `allowDraft`.

## Yearly update (each December/January)

1. Get the **official PDFs** (IRS Pub 15-T, EDD DE 44, SSA wage base announcement, etc.).
2. Extract the text mechanically: `pdftotext -layout pub15t.pdf -` and copy numbers from that output.
   Do **not** type tables from memory, from a web page summary, or from an AI answer. An AI summary of
   Pub 15-T produced wrong Single and Head of Household tables during development; the bracket
   continuity check caught it.
3. Create `rules/<jurisdiction>/<year>.json` with `status: "draft"` and run
   `npm run validate-rules`. The validator checks bracket continuity
   (`base[i] = base[i-1] + rate[i-1] × width[i-1]`), gaps, open ends, rates outside 0–1, and missing values.
4. Add **golden tests** in `test/golden/` from the worked examples in the publication itself
   (copy `_TEMPLATE.json`). Each case cites the page it came from.
5. If you run a provider in simulator mode, import a full quarter and confirm it reconciles.
6. A **human** compares every value against the PDF, then sets `status: "verified"` and fills
   `verification` (who, date, what was checked). AI tools may draft a rule file; they may not verify one.

## Code

- TypeScript, strict. `npm test` must pass. No runtime dependencies.
- Money is `Dec` (`src/money.ts`). Never use JS floating point for amounts.
- New tax: add the computation, its rule fields with citations, a validator entry, unit tests with
  hand-worked numbers, and a golden test from the agency.
- New provider importer: map its names to openpayroll codes, report anything unmapped, and add tests
  with a small synthetic sample (never real pay data).

## Never commit

Real pay stubs, employee names/IDs, `config.json`, API keys.
