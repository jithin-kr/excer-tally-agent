// Liveness reporting.
//
// Without this, "the Tally sync stopped working" is discovered days later by a confused
// accountant. With it, the admin panel can show a red badge the moment the office PC reboots,
// Tally is closed, or the tunnel drops.
//
// The heartbeat carries the last poll error too, so the common failures (Tally closed for the
// night, company not open, backup running) are visible in the app without anyone opening a log
// file on a machine we cannot reach.
//
// It reports what the poll loop last saw rather than asking Tally itself: the poll already checks
// Tally every few seconds, and a second query every heartbeat is load on a program that serves
// one request at a time, for no new information.

import { readFileSync } from "node:fs";
import type { AgentConfig } from "./excer/config.js";
import type { TallyClient } from "./tally/client.js";
import { postToApp, type PollState } from "./poll-loop.js";

/** Read from package.json so the version reported to the app can never drift from the release. */
export const AGENT_VERSION: string = (() => {
  try {
    // dist/heartbeat.js -> ../package.json is the repo root in both src and dist layouts.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "unknown";
  }
})();

export interface HeartbeatPayload {
  agentId: string;
  agentVersion: string;
  tallyReachable: boolean;
  tallyCompany: string | null;
  lastAlterId: number | null;
  lastPollAt: string | null;
  lastError: string | null;
  sentAt: string;
}

export function buildHeartbeat(
  config: AgentConfig,
  client: TallyClient,
  state: PollState
): HeartbeatPayload {
  return {
    agentId: config.agentId,
    agentVersion: AGENT_VERSION,
    tallyReachable: state.tallyReachable,
    tallyCompany: client.config.defaultCompany ?? null,
    lastAlterId: state.lastRunAt ? state.lastMasterAlterId : null,
    lastPollAt: state.lastRunAt,
    lastError: state.lastError,
    sentAt: new Date().toISOString(),
  };
}

export function startHeartbeat(config: AgentConfig, client: TallyClient, state: PollState) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      if (config.appBaseUrl) {
        await postToApp(config, "/api/tally/heartbeat", buildHeartbeat(config, client, state));
      }
    } catch {
      // A failed heartbeat is itself the signal — the app will notice the gap in lastSeenAt.
      // Never let it crash the agent or interrupt the poll loop.
    } finally {
      if (!stopped) setTimeout(tick, config.heartbeatIntervalMs);
    }
  };

  // A few seconds in, so the first heartbeat reports the first poll's result, not "unknown".
  setTimeout(tick, 5_000);
  return () => {
    stopped = true;
  };
}
