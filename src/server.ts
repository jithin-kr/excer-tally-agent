// The agent's HTTP server — the surface the Excer app calls through the Cloudflare Tunnel.
//
// It implements the same two endpoints as the dev fixture in the main repo
// (src/app/api/dev-fake-tally/), so pointing TALLY_CONNECTOR_BASE_URL at this agent instead of
// at the fixture is a pure config change. Nothing in the Next.js app needs to know the
// difference.
//
// Uses node:http directly rather than Express — two routes do not justify a framework, and
// fewer dependencies means fewer things to patch on a machine we cannot easily reach.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { postsAsOptional, type AgentConfig } from "./excer/config.js";
import type { TallyClient } from "./tally/client.js";
import { buildVoucherXml, voucherDate } from "./excer/vouchers.js";
import { fetchLedgers, fetchOutstandings, fetchStockItems } from "./excer/masters.js";
import { findLedgerByName, findVoucherByRemoteId, type VoucherIdentity } from "./excer/lookup.js";
import { parseImportResult } from "./tally/xml.js";
import {
  pushRequestSchema,
  type MastersResponse,
  type OutstandingsResponse,
  type PushRequest,
  type PushResponse,
} from "./excer/contract.js";
import type { PollState } from "./poll-loop.js";
import { AGENT_VERSION } from "./heartbeat.js";
import { errorMessage, log } from "./log.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    // A voucher payload is a few KB. Anything past 5MB is a mistake or an attack.
    if (bytes > 5_000_000) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/**
 * Compare the presented API key in constant time. Hashing both sides first makes the buffers the
 * same length, so neither the content nor the length of the real key leaks through timing.
 */
export function isAuthorized(presented: string | string[] | undefined, apiKey: string): boolean {
  if (typeof presented !== "string") return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(presented), digest(apiKey));
}

/**
 * Decide whether Tally's import response means "you already sent me this voucher".
 *
 * This is the fallback — the primary duplicate check is the REMOTEID lookup BEFORE sending (see
 * handlePush). It catches the narrow race where two retries of the same job arrive together.
 *
 * Deliberately NOT matched: "already exists". For a new customer ledger that message means a
 * DIFFERENT customer already has this name — treating it as success would link the app's customer
 * to someone else's ledger. The ledger path handles that case explicitly with a 409.
 */
export function looksLikeDuplicate(result: ReturnType<typeof parseImportResult>): boolean {
  const nothingWritten = result.created === 0 && result.altered === 0 && result.combined === 0;
  const wasIgnored = result.ignored > 0;
  const saysDuplicate = /duplicate/i.test(result.lineError ?? "");
  return (nothingWritten && wasIgnored) || saysDuplicate;
}

function isVoucher(req: PushRequest): boolean {
  return req.type !== "push_new_ledger" && req.type !== "push_cancel_sales_order";
}

/** An error the caller must fix, carrying the HTTP status to answer with. */
class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function createAgentServer(config: AgentConfig, client: TallyClient, poll: PollState) {
  const state = { lastPushAt: null as string | null, lastPullAt: null as string | null };
  const company = client.config.defaultCompany;

  /** Look up what we wrote, so the app gets Tally's real GUID and voucher number. */
  async function readBack(req: PushRequest): Promise<VoucherIdentity | null> {
    if (req.type === "push_new_ledger") {
      const ledger = await findLedgerByName(client, req.customerName, company);
      return ledger ? { guid: ledger.guid, voucherNumber: null, cancelled: false } : null;
    }
    const date = voucherDate(req);
    if (!date) return null;
    return findVoucherByRemoteId(client, req.remoteId, date, company);
  }

  async function handlePush(req: PushRequest): Promise<{ status: number; body: PushResponse }> {
    // A cancel targets the Sales Order by its REMOTEID. Check it first: a clear "not in Tally" beats
    // Tally's own answer for a missing REMOTEID ("The date 0-0-0 is Out of Range!"), and an order
    // that is already cancelled makes a retried cancel a duplicate, not a second write.
    if (req.type === "push_cancel_sales_order") {
      const order = await findVoucherByRemoteId(client, req.referencedSalesOrderRemoteId, null, company);
      if (!order) {
        throw new HttpError(
          422,
          `No Sales Order with REMOTEID "${req.referencedSalesOrderRemoteId}" exists in Tally — ` +
            `it was never posted, or was deleted there. Nothing to cancel.`
        );
      }
      if (order.cancelled) {
        return {
          status: 200,
          body: { success: true, duplicate: true, remoteId: req.remoteId, guid: order.guid },
        };
      }
    }

    // ── 1. Already in Tally? Answer without writing. ──────────────────────
    // Checked BEFORE sending because re-importing a known REMOTEID may alter the existing
    // voucher instead of being ignored — e.g. flipping one the accountant already converted to
    // Regular back to Optional. A retry must never touch what is already there.
    if (req.type === "push_new_ledger") {
      const existing = await findLedgerByName(client, req.customerName, company);
      if (existing) {
        if (existing.remoteAltGuid === req.remoteId) {
          return { status: 200, body: { success: true, duplicate: true, remoteId: req.remoteId, guid: existing.guid } };
        }
        throw new HttpError(
          409,
          `A different ledger named "${req.customerName}" already exists in Tally. Rename the ` +
            `customer in the admin panel, or link it to the existing Tally ledger, then retry.`
        );
      }
    } else if (isVoucher(req)) {
      const existing = await readBack(req);
      if (existing) {
        return {
          status: 200,
          body: {
            success: true,
            duplicate: true,
            remoteId: req.remoteId,
            guid: existing.guid,
            voucherNumber: existing.voucherNumber ?? undefined,
          },
        };
      }
    }

    // ── 2. Write. ─────────────────────────────────────────────────────────
    const xml = buildVoucherXml(req, config.tallyNames, company, postsAsOptional(req.type, config));
    const result = parseImportResult(await client.send(xml));

    if (looksLikeDuplicate(result)) {
      const existing = await readBack(req).catch(() => null);
      return {
        status: 200,
        body: {
          success: true,
          duplicate: true,
          remoteId: req.remoteId,
          guid: existing?.guid,
          voucherNumber: existing?.voucherNumber ?? undefined,
        },
      };
    }

    // Success means Tally says it WROTE something. Checking only for errors is not enough: live
    // TallyPrime rejected a Sales Order with every count at 0 apart from EXCEPTIONS, and an
    // "all zeros, no error" answer must never be reported to the app as posted.
    const wrote = result.created + result.altered + result.combined + result.cancelled > 0;
    if (result.errors > 0 || result.exceptions > 0 || result.lineError || !wrote) {
      return {
        status: 422,
        body: {
          success: false,
          error: result.lineError ?? (wrote ? "Tally rejected the voucher" : "Tally wrote nothing and gave no reason"),
          tallyResult: { ...result, raw: undefined },
        },
      };
    }

    // ── 3. Read back the real identifiers. ────────────────────────────────
    // NOT result.lastVchId: that is Tally's internal id, not the voucher number, and cancelling
    // by it could cancel a different order.
    let identity: VoucherIdentity | null = null;
    if (req.type !== "push_cancel_sales_order") {
      try {
        identity = await readBack(req);
      } catch (err) {
        log.warn("push", `${req.type} ${req.remoteId}: written, but read-back failed: ${errorMessage(err)}`);
      }
      if (!identity) {
        log.warn(
          "push",
          `${req.type} ${req.remoteId}: written, but not found by read-back — no voucher number ` +
            `returned, so cancelling it later will need doing by hand in Tally.`
        );
      }
    }

    state.lastPushAt = new Date().toISOString();
    return {
      status: 200,
      body: {
        success: true,
        guid: identity?.guid || undefined,
        voucherNumber: identity?.voucherNumber ?? undefined,
        tallyResult: result,
      },
    };
  }

  // Pushes run one at a time, each to completion (check -> write -> read back). Without this, two
  // requests for the same remoteId — the app retrying while its first attempt is still waiting on
  // Tally — could both pass the "already in Tally?" check before either writes, and import twice.
  // TallyClient's own queue serializes single requests, not this three-step sequence.
  let pushQueue: Promise<unknown> = Promise.resolve();
  function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = pushQueue.then(fn);
    pushQueue = run.catch(() => undefined);
    return run;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
    } catch {
      return json(res, 400, { error: "Malformed request URL" });
    }
    const authorized = isAuthorized(req.headers["x-api-key"], config.apiKey);

    // Liveness probe. Unauthenticated so a tunnel health check can use it — which also means it is
    // public on the internet, so without the key it says only whether we are up. The details
    // (company name, Tally URL, raw error text) are for callers holding the key.
    // Reads the poll loop's last result instead of querying Tally: a health checker hitting this
    // every few seconds must not become extra load on Tally.
    if (req.method === "GET" && url.pathname === "/health") {
      const summary = { ok: true, agentId: config.agentId, tallyReachable: poll.tallyReachable };
      if (!authorized) return json(res, 200, summary);
      return json(res, 200, {
        ...summary,
        agentVersion: AGENT_VERSION,
        tallyUrl: client.config.url,
        company: company ?? null,
        lastPollAt: poll.lastRunAt,
        lastError: poll.lastError,
        lastMasterAlterId: poll.lastMasterAlterId,
        lastVoucherAlterId: poll.lastVoucherAlterId,
        ...state,
      });
    }

    if (!authorized) {
      return json(res, 401, { error: "Invalid API key" });
    }

    // ── Read: masters ────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/export/masters") {
      try {
        const since = Number.parseInt(url.searchParams.get("sinceAlterId") ?? "0", 10) || 0;
        const stockItems = await fetchStockItems(client, since, company);
        const ledgers = await fetchLedgers(client, since, company, config.tallyNames.customerParentGroup);
        const maxAlterId = Math.max(
          since,
          ...stockItems.map((r) => r.alterId),
          ...ledgers.map((r) => r.alterId)
        );
        state.lastPullAt = new Date().toISOString();
        const body: MastersResponse = { stockItems, ledgers, maxAlterId };
        return json(res, 200, body);
      } catch (err) {
        return json(res, 502, { error: errorMessage(err) });
      }
    }

    // ── Read: party outstandings, live (the website's Outstandings report) ─
    if (req.method === "GET" && url.pathname === "/api/export/outstandings") {
      try {
        const parties = await fetchOutstandings(client, company, config.tallyNames.customerParentGroup);
        const body: OutstandingsResponse = { parties, asOf: new Date().toISOString() };
        return json(res, 200, body);
      } catch (err) {
        return json(res, 502, { error: errorMessage(err) });
      }
    }

    // ── Write: one voucher ───────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/import/voucher") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, 400, { success: false, error: err instanceof Error ? err.message : "Invalid JSON" });
      }

      // Validate the shape before any XML exists. A 400 here is a bug in the app's payload
      // builder, not something a retry will fix.
      const parsed = pushRequestSchema.safeParse(body);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
        log.warn("push", `rejected invalid payload: ${issues.join("; ")}`);
        return json(res, 400, { success: false, error: "Invalid payload", issues });
      }
      const pushReq = parsed.data;

      try {
        const { status, body: out } = await oneAtATime(() => handlePush(pushReq));
        // One line per write attempt: the audit trail for "did the agent post this?".
        log.info(
          "push",
          `${pushReq.type} ${pushReq.remoteId} -> ${status} ` +
            (out.duplicate ? "duplicate " : out.success ? "created " : "rejected ") +
            (out.success
              ? `guid=${out.guid ?? "?"} vch=${out.voucherNumber ?? "?"}`
              : String(out.error ?? ""))
        );
        return json(res, status, out);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 502;
        log.warn("push", `${pushReq.type} ${pushReq.remoteId} -> ${status} ${errorMessage(err)}`);
        return json(res, status, { success: false, error: errorMessage(err) });
      }
    }

    return json(res, 404, { error: "Not found" });
  }

  // The request handler is async, so anything it throws becomes a rejected promise — and an
  // unhandled rejection terminates Node. One malformed request must never take the agent down,
  // so every request ends here: logged, answered with a 500 if nothing was sent yet.
  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      log.error("http", `${req.method} ${req.url}: unhandled ${errorMessage(err)}`);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
      else res.destroy();
    });
  });

  return server;
}
