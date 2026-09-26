// Agent configuration.
//
// DESIGN NOTE: every value in `tallyNames` below is installation-specific — it depends on how
// THIS client's Tally is configured, not on anything in our code. They are deliberately gathered
// into one object so that the open questions in CLAUDE.md §20.6 (Q9, Q15, Q16) have exactly one
// place to land once the client's Tally person answers them. Nothing else in the agent should
// hard-code a Tally voucher type or ledger name.

import { resolve } from "node:path";
import type { TallyJobType } from "./contract.js";

export interface TallyNames {
  /** Voucher type names EXACTLY as configured in their Tally. §20.6 Q15. */
  salesOrderVoucherType: string;
  deliveryNoteVoucherType: string;
  creditNoteVoucherType: string;
  stockJournalVoucherType: string;
  /** Ledger the sales value posts to. */
  salesLedger: string;
  /** Ledgers the tax components post to. */
  cgstLedger: string;
  sgstLedger: string;
  igstLedger: string;
  /** Discount ledger, used when an order carries an admin discount. */
  discountLedger: string;
  /** Parent group for new customer ledgers. */
  customerParentGroup: string;
  /** Godown the web shop's stock is drawn from. §20.6 Q9. Empty = godowns not in use. */
  godown?: string;
  /** Home state — used to decide CGST+SGST vs IGST. */
  homeState: string;
  /**
   * Ledgers per GST rate, keyed by the item's total rate ("5", "12", "18"). Many books keep one
   * sales ledger and one set of tax ledgers per rate instead of a single one — the client's does
   * ("Sales@18%", "CGST@9%", "SGST@9%", "IGST @18%"; verified 2026-09-26). A line whose rate is
   * listed posts to these; any other line, or a blank entry, uses the single ledgers above.
   */
  ledgersByRate?: Record<string, RateLedgers>;
}

/** The ledgers one GST rate posts to. A missing one falls back to the single ledger of its kind. */
export interface RateLedgers {
  sales?: string;
  cgst?: string;
  sgst?: string;
  igst?: string;
}

/** The key `ledgersByRate` uses for a rate: 18 and "18.00" are the same rate. */
export function rateKey(rate: number): string {
  return String(Number(rate));
}

/**
 * Parses TALLY_LEDGERS_BY_RATE: `rate=sales|cgst|sgst|igst`, one rate per `;`. A blank position
 * keeps the single ledger of that kind. Example (the client's books):
 *   18=Sales@18%|CGST@9%|SGST@9%|IGST @18%; 12=Sales@12%|CGST @6%|SGST @6%|IGST 12%
 * Ledger names are used exactly as written after trimming the ends, spaces inside and all.
 */
export function parseLedgersByRate(raw: string | undefined): Record<string, RateLedgers> | undefined {
  if (!raw?.trim()) return undefined;
  const map: Record<string, RateLedgers> = {};
  for (const entry of raw.split(";").map((e) => e.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const rate = Number(eq > 0 ? entry.slice(0, eq).trim() : NaN);
    const parts = eq > 0 ? entry.slice(eq + 1).split("|").map((p) => p.trim()) : [];
    if (!Number.isFinite(rate) || rate < 0 || parts.length !== 4) {
      throw new Error(
        `Invalid TALLY_LEDGERS_BY_RATE entry "${entry}". Expected rate=sales|cgst|sgst|igst, ` +
          `e.g. 18=Sales@18%|CGST@9%|SGST@9%|IGST @18% (leave a position blank to keep the default).`
      );
    }
    const [sales, cgst, sgst, igst] = parts.map((p) => p || undefined);
    map[rateKey(rate)] = { sales, cgst, sgst, igst };
  }
  return map;
}

export interface AgentConfig {
  /** Port this agent's HTTP server listens on (Cloudflare Tunnel points here). */
  port: number;
  /** Shared secret the Excer app sends as `x-api-key`. */
  apiKey: string;
  /** Base URL of the Excer app, for pushing master deltas and heartbeats. */
  appBaseUrl?: string;
  /** Bearer token for calling back into the Excer app. */
  appToken?: string;
  /** How often to ask Tally "has anything changed?" (ms). */
  pollIntervalMs: number;
  /** How often to report liveness to the app (ms). */
  heartbeatIntervalMs: number;
  /**
   * Minimum gap between full stock-balance refreshes triggered by voucher activity (ms). A refresh
   * re-reads every item's closing balance, so on a busy day this caps how often we ask for it.
   */
  stockRefreshMinIntervalMs: number;
  /**
   * How long a call back into the Excer app may take before we give up on it this tick (ms). The
   * first sync of a real company sends every master at once and can outlast the 15s default.
   */
  appTimeoutMs: number;
  /** Where the poll watermarks are persisted across restarts. */
  stateFile: string;
  /** Stable id for this agent instance. */
  agentId: string;
  /**
   * Posts every voucher into Tally's "Optional Vouchers" register instead of the regular books
   * (CLAUDE.md §21/§22, decided 2026-09-23 alongside making the app's push fully automatic).
   * Optional vouchers do not affect any balance or report until an accountant converts them to
   * Regular inside Tally — that conversion is the human review step, since there is no longer an
   * admin button-press to serve as one. Default true; only flip to false once the agent has been
   * proven reliable against a real Tally test company (§22.6).
   */
  postVouchersAsOptional: boolean;
  /**
   * Delivery Notes are the exception: Tally owns stock (decided 2026-09-26), and a website sale
   * lowers Tally's stock only through its Delivery Note. An Optional voucher moves no stock until
   * an accountant converts it, so Delivery Notes post Regular by default. The accountant can
   * still alter or delete one in Tally.
   */
  postDeliveryNotesAsOptional: boolean;
  /**
   * How often the full list of stock item GUIDs is sent even when no master changed (ms), so the
   * website hides products whose item was deleted in Tally. Also sent on every master change and
   * on the first poll after a start.
   */
  itemListIntervalMs: number;
  tallyNames: TallyNames;
}

/** Whether a push of this type goes into Tally's Optional register. */
export function postsAsOptional(type: TallyJobType, config: AgentConfig): boolean {
  return type === "push_delivery_note" ? config.postDeliveryNotesAsOptional : config.postVouchersAsOptional;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${raw}. Expected a positive integer.`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`Invalid ${name}: ${raw}. Expected true/false.`);
}

/** The key guards an endpoint that writes to the accounting books, reachable from the internet. */
const MIN_API_KEY_LENGTH = 16;

function apiKey(): string {
  const key = required("AGENT_API_KEY");
  if (key === "change-me" || key.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `AGENT_API_KEY is too weak: use a random secret of at least ${MIN_API_KEY_LENGTH} characters ` +
        `(e.g. the output of: node -e "console.log(crypto.randomBytes(32).toString('hex'))").`
    );
  }
  return key;
}

export function loadAgentConfig(): AgentConfig {
  return {
    port: int("AGENT_PORT", 7010),
    apiKey: apiKey(),
    // No trailing slash: paths are appended as "/api/...", and "//api" can redirect or 404.
    appBaseUrl: process.env.EXCER_APP_URL?.trim().replace(/\/+$/, "") || undefined,
    appToken: process.env.EXCER_APP_TOKEN?.trim() || undefined,
    pollIntervalMs: int("POLL_INTERVAL_MS", 15_000),
    heartbeatIntervalMs: int("HEARTBEAT_INTERVAL_MS", 30_000),
    stockRefreshMinIntervalMs: int("STOCK_REFRESH_MIN_INTERVAL_MS", 60_000),
    appTimeoutMs: int("APP_TIMEOUT_MS", 15_000),
    // Relative to the working directory, which the installer sets to the repo root.
    stateFile: resolve(process.env.AGENT_STATE_FILE?.trim() || "state/poll-state.json"),
    agentId: process.env.AGENT_ID?.trim() || "excer-tally-agent-1",
    postVouchersAsOptional: bool("TALLY_POST_VOUCHERS_AS_OPTIONAL", true),
    postDeliveryNotesAsOptional: bool("TALLY_POST_DELIVERY_NOTES_AS_OPTIONAL", false),
    itemListIntervalMs: int("ITEM_LIST_INTERVAL_MS", 30 * 60_000),
    tallyNames: loadTallyNames(),
  };
}

/** The installation-specific Tally names, from the environment (see .env.example). */
export function loadTallyNames(): TallyNames {
  return {
    salesOrderVoucherType: process.env.TALLY_VT_SALES_ORDER?.trim() || "Sales Order",
    deliveryNoteVoucherType: process.env.TALLY_VT_DELIVERY_NOTE?.trim() || "Delivery Note",
    creditNoteVoucherType: process.env.TALLY_VT_CREDIT_NOTE?.trim() || "Credit Note",
    stockJournalVoucherType: process.env.TALLY_VT_STOCK_JOURNAL?.trim() || "Stock Journal",
    salesLedger: process.env.TALLY_LEDGER_SALES?.trim() || "Sales Accounts",
    cgstLedger: process.env.TALLY_LEDGER_CGST?.trim() || "CGST",
    sgstLedger: process.env.TALLY_LEDGER_SGST?.trim() || "SGST",
    igstLedger: process.env.TALLY_LEDGER_IGST?.trim() || "IGST",
    discountLedger: process.env.TALLY_LEDGER_DISCOUNT?.trim() || "Discount Allowed",
    customerParentGroup: process.env.TALLY_GROUP_CUSTOMERS?.trim() || "Sundry Debtors",
    godown: process.env.TALLY_GODOWN?.trim() || undefined,
    homeState: process.env.TALLY_HOME_STATE?.trim() || "Kerala",
    ledgersByRate: parseLedgersByRate(process.env.TALLY_LEDGERS_BY_RATE),
  };
}
