/**
 * Bigcapital adapter: turns a Journal into Bigcapital's CreateManualJournalDto
 * (POST /api/manual-journals, Authorization: Bearer bc_...).
 * Schema per docs.bigcapital.app/api-reference/manual-journals/create-a-new-manual-journal.
 */
import { assertBalanced, type Journal } from "../journal.js";

export interface BigcapitalConfig {
  baseUrl: string;            // e.g. "https://books.example.ts.net"
  apiKey: string;             // "bc_..."
  organizationId?: string;    // only needed with JWT auth, not API keys
  publish?: boolean;          // default false: create as draft for review
  currencyCode?: string;      // default "USD"
  /** Nothing dated before this is ever posted (the cutover: earlier periods come from QuickBooks). Required to post. */
  postFrom?: string;
  /** Post a pay run's journals as soon as it is approved (otherwise: POST /api/payruns/:date/post). */
  postOnApprove?: boolean;
}

/**
 * Effective settings: config.json's bigcapital section, with the URL and API key taken from the environment when set
 * (BIGCAPITAL_URL, BIGCAPITAL_API_KEY), so the key needn't live in the data volume. null = not configured.
 */
export function bigcapitalSettings(cfg: Partial<BigcapitalConfig> | undefined, env: Record<string, string | undefined> = process.env): BigcapitalConfig | null {
  const baseUrl = env.BIGCAPITAL_URL || cfg?.baseUrl, apiKey = env.BIGCAPITAL_API_KEY || cfg?.apiKey;
  if (!baseUrl || !apiKey) return null;
  return { ...cfg, baseUrl, apiKey };
}

/** Refuse to post anything dated before postFrom; refuse everything if postFrom isn't set. */
export function assertPostable(date: string, s: Pick<BigcapitalConfig, "postFrom">): void {
  if (!s.postFrom || !/^\d{4}-\d{2}-\d{2}$/.test(s.postFrom)) throw new Error("bigcapital.postFrom (YYYY-MM-DD) is not set: nothing is posted until it is");
  if (date < s.postFrom) throw new Error(`${date} is before bigcapital.postFrom ${s.postFrom}: that period is booked in your previous payroll system, not posted from here`);
}

export interface BigcapitalManualJournal {
  date: string;
  /** Unique journal number shown in Bigcapital (e.g. "PR-2027-01-15"). Omit to let Bigcapital number it. */
  journalNumber?: string;
  reference: string;
  description: string;
  currencyCode: string;
  publish: boolean;
  entries: { index: number; accountId: number; debit?: number; credit?: number; note: string }[];
}

/** Cents-exact strings -> JSON numbers with two decimals (safe: < 2^53 cents). */
const num = (s: string) => Number(s);

export function toBigcapital(j: Journal, cfg: Pick<BigcapitalConfig, "publish" | "currencyCode"> = {}, journalNumber?: string): BigcapitalManualJournal {
  assertBalanced(j);
  return {
    date: j.date,
    ...(journalNumber ? { journalNumber } : {}),
    reference: j.reference,
    description: j.description,
    currencyCode: cfg.currencyCode ?? "USD",
    publish: cfg.publish ?? false,
    entries: j.lines.map((l, i) => {
      const accountId = typeof l.account === "number" ? l.account : Number(l.account);
      if (!Number.isInteger(accountId)) throw new Error(`Bigcapital account ids are integers, got "${l.account}"`);
      const e: BigcapitalManualJournal["entries"][number] = { index: i + 1, accountId, note: l.memo };
      if (l.debit !== "0.00") e.debit = num(l.debit);
      if (l.credit !== "0.00") e.credit = num(l.credit);
      return e;
    }),
  };
}

export async function postManualJournal(payload: BigcapitalManualJournal, cfg: BigcapitalConfig): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` };
  if (cfg.organizationId) headers["organization-id"] = cfg.organizationId;
  const res = await fetch(new URL("/api/manual-journals", cfg.baseUrl), { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Bigcapital ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return text; }
}
