// Agent configuration.
//
// DESIGN NOTE: every value in `tallyNames` below is installation-specific — it depends on how
// THIS client's Tally is configured, not on anything in our code. They are deliberately gathered
// into one object so that the open questions in CLAUDE.md §20.6 (Q9, Q15, Q16) have exactly one
// place to land once the client's Tally person answers them. Nothing else in the agent should
// hard-code a Tally voucher type or ledger name.

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
  tallyNames: TallyNames;
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

export function loadAgentConfig(): AgentConfig {
  return {
    port: int("AGENT_PORT", 7010),
    apiKey: required("AGENT_API_KEY"),
    appBaseUrl: process.env.EXCER_APP_URL?.trim() || undefined,
    appToken: process.env.EXCER_APP_TOKEN?.trim() || undefined,
    pollIntervalMs: int("POLL_INTERVAL_MS", 15_000),
    heartbeatIntervalMs: int("HEARTBEAT_INTERVAL_MS", 30_000),
    agentId: process.env.AGENT_ID?.trim() || "excer-tally-agent-1",
    postVouchersAsOptional: bool("TALLY_POST_VOUCHERS_AS_OPTIONAL", true),
    tallyNames: {
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
    },
  };
}
