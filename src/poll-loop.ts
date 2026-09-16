// The "Tally cannot call us, so we keep asking" loop.
//
// Tally has no webhooks and no push of any kind, so near-real-time reads mean polling. The cost
// of polling is kept low by the two-stage check in src/excer/masters.ts: ask for a counter, and
// only fetch rows when the counter moves.
//
// Deltas are POSTed to the Excer app at /api/tally/pull. The app owns all matching and mapping
// (features/tally/mapping.ts) — the agent never decides which Product a Tally item belongs to.

import type { AgentConfig } from "./excer/config.js";
import type { TallyClient } from "./tally/client.js";
import { fetchLedgers, fetchStockItems, getLastAlterIds } from "./excer/masters.js";

export interface PollState {
  lastMasterAlterId: number;
  lastRunAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export function createPollState(): PollState {
  return { lastMasterAlterId: 0, lastRunAt: null, lastError: null, consecutiveFailures: 0 };
}

async function postToApp(config: AgentConfig, path: string, body: unknown): Promise<void> {
  if (!config.appBaseUrl) return;
  const res = await fetch(`${config.appBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.appToken ? { Authorization: `Bearer ${config.appToken}` } : {}),
    },
    body: JSON.stringify(body),
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

  // Stage 1: the cheap counter.
  const { masters } = await getLastAlterIds(client, company);
  if (masters > 0 && masters <= state.lastMasterAlterId) {
    state.lastRunAt = new Date().toISOString();
    return false; // nothing changed — this is the common case, and it costs almost nothing
  }

  // Stage 2: only the rows that moved.
  const since = state.lastMasterAlterId;
  const [stockItems, ledgers] = await Promise.all([
    fetchStockItems(client, since, company),
    fetchLedgers(client, since, company, config.tallyNames.customerParentGroup),
  ]);

  if (stockItems.length === 0 && ledgers.length === 0) {
    state.lastMasterAlterId = Math.max(state.lastMasterAlterId, masters);
    state.lastRunAt = new Date().toISOString();
    return false;
  }

  await postToApp(config, "/api/tally/pull", {
    agentId: config.agentId,
    sinceAlterId: since,
    stockItems,
    ledgers,
  });

  // Only advance the watermark after the app has accepted the batch. If the POST throws, we
  // re-send the same rows next tick rather than skipping them — at-least-once, which is safe
  // because the app's pull is an idempotent upsert keyed on tallyGuid.
  state.lastMasterAlterId = Math.max(
    masters,
    ...stockItems.map((r) => r.alterId),
    ...ledgers.map((r) => r.alterId)
  );
  state.lastRunAt = new Date().toISOString();
  return true;
}

export function startPollLoop(config: AgentConfig, client: TallyClient, state: PollState) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const sent = await pollOnce(config, client, state);
      state.lastError = null;
      state.consecutiveFailures = 0;
      if (sent) console.log(`[poll] sent delta, watermark now ${state.lastMasterAlterId}`);
    } catch (err) {
      state.consecutiveFailures += 1;
      state.lastError = err instanceof Error ? err.message : String(err);
      // Tally closed at 6pm, a backup running, a reboot — all normal. Log the first few, then
      // go quiet so we do not fill the disk overnight with the same line.
      if (state.consecutiveFailures <= 3) {
        console.warn(`[poll] failed (${state.consecutiveFailures}): ${state.lastError}`);
      } else if (state.consecutiveFailures % 100 === 0) {
        console.warn(`[poll] still failing after ${state.consecutiveFailures} attempts`);
      }
    } finally {
      if (!stopped) setTimeout(tick, config.pollIntervalMs);
    }
  };

  setTimeout(tick, config.pollIntervalMs);
  return () => {
    stopped = true;
  };
}
