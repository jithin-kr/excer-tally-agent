// Liveness reporting.
//
// Without this, "the Tally sync stopped working" is discovered days later by a confused
// accountant. With it, the admin panel can show a red badge the moment the office PC reboots,
// Tally is closed, or the tunnel drops.
//
// The heartbeat carries the last poll error too, so the common failures (Tally closed for the
// night, company not open, backup running) are visible in the app without anyone opening a log
// file on a machine we cannot reach.

import type { AgentConfig } from "./excer/config.js";
import type { TallyClient } from "./tally/client.js";
import { getLastAlterIds } from "./excer/masters.js";
import type { PollState } from "./poll-loop.js";

export const AGENT_VERSION = "0.1.0";

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

export async function buildHeartbeat(
  config: AgentConfig,
  client: TallyClient,
  state: PollState
): Promise<HeartbeatPayload> {
  let tallyReachable = false;
  let lastAlterId: number | null = null;
  let error: string | null = state.lastError;

  try {
    const ids = await getLastAlterIds(client, client.config.defaultCompany);
    tallyReachable = true;
    lastAlterId = ids.masters;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    agentId: config.agentId,
    agentVersion: AGENT_VERSION,
    tallyReachable,
    tallyCompany: client.config.defaultCompany ?? null,
    lastAlterId,
    lastPollAt: state.lastRunAt,
    lastError: error,
    sentAt: new Date().toISOString(),
  };
}

export function startHeartbeat(config: AgentConfig, client: TallyClient, state: PollState) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const payload = await buildHeartbeat(config, client, state);
      if (config.appBaseUrl) {
        await fetch(`${config.appBaseUrl}/api/tally/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(config.appToken ? { Authorization: `Bearer ${config.appToken}` } : {}),
          },
          body: JSON.stringify(payload),
        });
      }
    } catch {
      // A failed heartbeat is itself the signal — the app will notice the gap in lastSeenAt.
      // Never let it crash the agent or interrupt the poll loop.
    } finally {
      if (!stopped) setTimeout(tick, config.heartbeatIntervalMs);
    }
  };

  setTimeout(tick, 1_000);
  return () => {
    stopped = true;
  };
}
