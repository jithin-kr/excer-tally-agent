// The "Tally cannot call us, so we keep asking" loop.
//
// Tally has no webhooks and no push of any kind, so near-real-time reads mean polling. The cost
// of polling is kept low by the two-stage check in src/excer/masters.ts: ask for a counter, and
// only fetch rows when the counter moves.
//
// There are TWO counters, and both matter:
//
//   ALTMSTID  moves when a master is edited — a new customer, a renamed item, a changed rate.
//   ALTVCHID  moves when a voucher is entered — a purchase, a sale, a stock journal.
//
// Stock levels change through vouchers. Entering a purchase raises an item's closing stock but
// does not edit the item master, so the item's own AlterID does not move. Watching only ALTMSTID
// would therefore miss exactly the stock movements the website needs. When ALTVCHID moves we
// re-read every item's closing balance; when ALTMSTID moves we read only the changed masters.
//
// Deltas are POSTed to the Excer app at /api/tally/pull. The app owns all matching and mapping
// (features/tally/mapping.ts) — the agent never decides which Product a Tally item belongs to.

import type { AgentConfig } from "./excer/config.js";
import type { TallyClient } from "./tally/client.js";
import { fetchLedgers, fetchStockItemGuids, fetchStockItems, getLastAlterIds } from "./excer/masters.js";
import { errorMessage, log } from "./log.js";
import { saveWatermarks, type Watermarks } from "./state-store.js";

export interface PollState extends Watermarks {
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** Whether Tally answered the last counter check. Read by /health and the heartbeat. */
  tallyReachable: boolean;
  /** When stock balances were last fully re-read because vouchers moved (ms since epoch). */
  lastStockRefreshAt: number;
  /** When the full list of stock item GUIDs was last sent (ms since epoch; 0 = not since start). */
  lastItemListAt: number;
}

export function createPollState(marks: Watermarks): PollState {
  return {
    ...marks,
    lastRunAt: null,
    lastError: null,
    consecutiveFailures: 0,
    tallyReachable: false,
    lastStockRefreshAt: 0,
    lastItemListAt: 0,
  };
}

export async function postToApp(config: AgentConfig, path: string, body: unknown): Promise<void> {
  if (!config.appBaseUrl) throw new Error("EXCER_APP_URL is not configured");
  const res = await fetch(`${config.appBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.appToken ? { Authorization: `Bearer ${config.appToken}` } : {}),
    },
    body: JSON.stringify(body),
    // Without a timeout, one hung request to Vercel would stall this loop forever: the next tick
    // is only scheduled once the current one finishes.
    signal: AbortSignal.timeout(config.appTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Excer app returned HTTP ${res.status} for ${path}`);
  }
}

/** One pass. Returns true if anything was sent. */
export async function pollOnce(
  config: AgentConfig,
  client: TallyClient,
  state: PollState
): Promise<boolean> {
  const company = client.config.defaultCompany;
  const persist = () =>
    saveWatermarks(config.stateFile, company ?? null, {
      lastMasterAlterId: state.lastMasterAlterId,
      lastVoucherAlterId: state.lastVoucherAlterId,
    });

  // Stage 1: the cheap counters.
  let ids;
  try {
    ids = await getLastAlterIds(client, company);
  } catch (err) {
    state.tallyReachable = false;
    throw err;
  }
  state.lastRunAt = new Date().toISOString();
  // Tally answers, but nothing can sync until the company is open. Every morning Tally starts at
  // the company login screen, where every query answers empty — this used to be reported as
  // "reachable" with a wrong hint about the counters' field names.
  if (!ids.companyOpen) {
    state.tallyReachable = false;
    throw new Error(
      `Tally is running, but the company "${company ?? "(active company)"}" is not open — it is ` +
        `closed, or waiting at its login screen. Sync resumes by itself once it is opened.`
    );
  }
  state.tallyReachable = true;

  // Both zero means the ALTMSTID/ALTVCHID field names are wrong on this Tally build (or the company
  // is empty). Carrying on would treat every tick as "changed" and run a FULL export every 15s —
  // precisely the load this loop exists to avoid. Fail loudly instead; the heartbeat shows it.
  if (ids.masters === 0 && ids.vouchers === 0) {
    throw new Error(
      "Tally's AlterID counters both read 0 — incremental sync is impossible until this is " +
        "fixed. Run `npm run doctor` and check the ALTMSTID/ALTVCHID field names."
    );
  }

  // Nowhere to send deltas. Stop here WITHOUT advancing the watermarks, so nothing is skipped
  // once EXCER_APP_URL is configured. (Stage 1 still ran, so /health stays truthful.)
  if (!config.appBaseUrl) return false;

  // A counter going BACKWARDS means the company was restored from a backup or repaired. Our
  // watermark then points past everything Tally holds, and "nothing newer than N" would stay true
  // forever — the sync would silently stop. Start over: the app's pull is an idempotent upsert
  // keyed on tallyGuid, so a full re-send is safe, just heavier once.
  if (ids.masters < state.lastMasterAlterId || ids.vouchers < state.lastVoucherAlterId) {
    log.warn(
      "poll",
      `AlterID went backwards (masters ${state.lastMasterAlterId} -> ${ids.masters}, ` +
        `vouchers ${state.lastVoucherAlterId} -> ${ids.vouchers}) — company restored? Full re-sync.`
    );
    state.lastMasterAlterId = 0;
    state.lastVoucherAlterId = 0;
    state.lastStockRefreshAt = 0;
  }

  const mastersMoved = ids.masters !== state.lastMasterAlterId;
  // Re-reading every item's balance is not free, so on a busy day (a voucher every few seconds)
  // cap it at one refresh per stockRefreshMinIntervalMs. A voucher change we skip now is not lost:
  // the voucher watermark only advances when we actually refresh.
  const vouchersMoved =
    ids.vouchers !== state.lastVoucherAlterId &&
    Date.now() - state.lastStockRefreshAt >= config.stockRefreshMinIntervalMs;

  // The full item list lets the website hide items deleted in Tally, which no "since" export can
  // mention. Sent on a master change, on the first poll after a start (a deletion while we were
  // down), and every itemListIntervalMs in case a deletion does not move the counter.
  const sendItemList =
    mastersMoved || Date.now() - state.lastItemListAt >= config.itemListIntervalMs;

  if (!mastersMoved && !vouchersMoved && !sendItemList) {
    return false; // nothing changed — this is the common case, and it costs almost nothing
  }

  // Stage 2: only what moved. Sequential on purpose — Tally serves one request at a time anyway.
  const since = state.lastMasterAlterId;
  const stockItems = vouchersMoved
    ? await fetchStockItems(client, 0, company) // balances changed on items whose AlterID did not
    : await fetchStockItems(client, since, company);
  const ledgers = mastersMoved
    ? await fetchLedgers(client, since, company, config.tallyNames.customerParentGroup)
    : [];

  // Never an empty list: the website would read it as "every item deleted" (it refuses, but a
  // company with no items has nothing to hide anyway).
  const itemGuids = sendItemList ? await fetchStockItemGuids(client, company) : [];
  const allStockItemGuids = itemGuids.length > 0 ? itemGuids : undefined;

  if (stockItems.length > 0 || ledgers.length > 0 || allStockItemGuids) {
    await postToApp(config, "/api/tally/pull", {
      agentId: config.agentId,
      sinceAlterId: since,
      stockItems,
      ledgers,
      ...(allStockItemGuids ? { allStockItemGuids } : {}),
    });
  }
  if (sendItemList) state.lastItemListAt = Date.now();

  // Only advance the watermarks after the app has accepted the batch. If the POST throws, we
  // re-send the same rows next tick rather than skipping them — at-least-once, which is safe
  // because the app's pull is an idempotent upsert keyed on tallyGuid.
  state.lastMasterAlterId = Math.max(
    ids.masters,
    ...stockItems.map((r) => r.alterId),
    ...ledgers.map((r) => r.alterId)
  );
  if (vouchersMoved) {
    state.lastVoucherAlterId = ids.vouchers;
    state.lastStockRefreshAt = Date.now();
  }
  persist();
  return stockItems.length > 0 || ledgers.length > 0 || allStockItemGuids !== undefined;
}

export function startPollLoop(config: AgentConfig, client: TallyClient, state: PollState) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const sent = await pollOnce(config, client, state);
      if (state.consecutiveFailures > 3) {
        log.info("poll", `recovered after ${state.consecutiveFailures} failed attempts`);
      }
      state.lastError = null;
      state.consecutiveFailures = 0;
      if (sent) {
        log.info(
          "poll",
          `sent delta, watermarks now masters=${state.lastMasterAlterId} vouchers=${state.lastVoucherAlterId}`
        );
      }
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastError = errorMessage(err);
      // Tally closed at 6pm, a backup running, a reboot — all normal. Log the first few, then
      // go quiet so we do not fill the disk overnight with the same line.
      if (state.consecutiveFailures <= 3) {
        log.warn("poll", `failed (${state.consecutiveFailures}): ${state.lastError}`);
      } else if (state.consecutiveFailures % 100 === 0) {
        log.warn("poll", `still failing after ${state.consecutiveFailures} attempts: ${state.lastError}`);
      }
    } finally {
      if (!stopped) setTimeout(tick, config.pollIntervalMs);
    }
  };

  // First pass right away: /health and the heartbeat read the result, and with persisted
  // watermarks a restart's first pass is as cheap as any other.
  setTimeout(tick, 0);
  return () => {
    stopped = true;
  };
}
