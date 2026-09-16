// The agent's HTTP server — the surface the Excer app calls through the Cloudflare Tunnel.
//
// It implements the same two endpoints as the dev fixture in the main repo
// (src/app/api/dev-fake-tally/), so pointing TALLY_CONNECTOR_BASE_URL at this agent instead of
// at the fixture is a pure config change. Nothing in the Next.js app needs to know the
// difference.
//
// Uses node:http directly rather than Express — two routes do not justify a framework, and
// fewer dependencies means fewer things to patch on a machine we cannot easily reach.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentConfig } from "./excer/config.js";
import type { TallyClient } from "./tally/client.js";
import { buildVoucherXml } from "./excer/vouchers.js";
import { fetchLedgers, fetchStockItems, getLastAlterIds } from "./excer/masters.js";
import { parseImportResult } from "./tally/xml.js";
import type { PushResponse, TallyJobType } from "./excer/contract.js";

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
 * Decide whether Tally's import response means "you already sent me this voucher".
 *
 * Tally has no dedicated duplicate status. When it sees a REMOTEID it already holds, it ignores
 * the row rather than creating it. So: nothing created or altered, but something ignored, is our
 * duplicate signal — and the app treats duplicate as SUCCESS, never an error, because the
 * voucher it wanted does exist in Tally. That is the whole point of stamping REMOTEID.
 */
function looksLikeDuplicate(result: ReturnType<typeof parseImportResult>): boolean {
  const nothingWritten = result.created === 0 && result.altered === 0 && result.combined === 0;
  const wasIgnored = result.ignored > 0;
  const saysDuplicate = /duplicate|already exists/i.test(result.lineError ?? "");
  return (nothingWritten && wasIgnored) || saysDuplicate;
}

export function createAgentServer(config: AgentConfig, client: TallyClient) {
  const state = { lastPushAt: null as string | null, lastPullAt: null as string | null };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    // Liveness probe — deliberately unauthenticated so a tunnel health check can use it.
    if (req.method === "GET" && url.pathname === "/health") {
      let tallyReachable = false;
      let tallyError: string | undefined;
      try {
        await getLastAlterIds(client, client.config.defaultCompany);
        tallyReachable = true;
      } catch (err) {
        tallyError = err instanceof Error ? err.message : String(err);
      }
      return json(res, 200, {
        agentId: config.agentId,
        tallyReachable,
        tallyError,
        tallyUrl: client.config.url,
        company: client.config.defaultCompany ?? null,
        ...state,
      });
    }

    if (req.headers["x-api-key"] !== config.apiKey) {
      return json(res, 401, { error: "Invalid API key" });
    }

    // ── Read: masters ────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/export/masters") {
      try {
        const since = Number.parseInt(url.searchParams.get("sinceAlterId") ?? "0", 10) || 0;
        const company = client.config.defaultCompany;
        const [stockItems, ledgers] = await Promise.all([
          fetchStockItems(client, since, company),
          fetchLedgers(client, since, company, config.tallyNames.customerParentGroup),
        ]);
        const maxAlterId = Math.max(
          since,
          ...stockItems.map((r) => r.alterId),
          ...ledgers.map((r) => r.alterId)
        );
        state.lastPullAt = new Date().toISOString();
        return json(res, 200, { stockItems, ledgers, maxAlterId });
      } catch (err) {
        return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Write: one voucher ───────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/import/voucher") {
      let body: any;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, 400, { error: err instanceof Error ? err.message : "Invalid JSON" });
      }

      const type = body?.type as TallyJobType | undefined;
      const remoteId = body?.remoteId as string | undefined;
      if (!type) return json(res, 400, { error: "type is required" });
      if (!remoteId) return json(res, 400, { error: "remoteId is required" });

      try {
        const xml = buildVoucherXml(type, body, config.tallyNames, client.config.defaultCompany);
        const responseXml = await client.send(xml);
        const result = parseImportResult(responseXml);

        if (looksLikeDuplicate(result)) {
          const dup: PushResponse = { success: true, duplicate: true, remoteId };
          return json(res, 200, dup);
        }

        if (result.errors > 0 || result.lineError) {
          return json(res, 422, {
            success: false,
            error: result.lineError ?? "Tally rejected the voucher",
            tallyResult: result,
          });
        }

        state.lastPushAt = new Date().toISOString();
        const ok: PushResponse = {
          success: true,
          // Tally returns the internal id of the last written voucher/master.
          guid: result.lastVchId ? String(result.lastVchId) : String(result.lastMId || ""),
          voucherNumber: result.lastVchId ? String(result.lastVchId) : undefined,
          tallyResult: result,
        };
        return json(res, 200, ok);
      } catch (err) {
        return json(res, 502, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return json(res, 404, { error: "Not found" });
  });

  return server;
}
