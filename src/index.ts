// Entry point: start the HTTP server, the poll loop and the heartbeat.

import { loadAgentConfig } from "./excer/config.js";
import { TallyClient } from "./tally/client.js";
import { createAgentServer } from "./server.js";
import { createPollState, startPollLoop } from "./poll-loop.js";
import { AGENT_VERSION, startHeartbeat } from "./heartbeat.js";
import { loadWatermarks } from "./state-store.js";
import { errorMessage, log } from "./log.js";

async function main() {
  const config = loadAgentConfig();
  const client = new TallyClient();
  const state = createPollState(loadWatermarks(config.stateFile, client.config.defaultCompany ?? null));

  const server = createAgentServer(config, client, state);
  const stopPoll = startPollLoop(config, client, state);
  const stopHeartbeat = startHeartbeat(config, client, state);

  server.listen(config.port, "127.0.0.1", () => {
    log.info("agent", `excer-tally-agent v${AGENT_VERSION}`);
    log.info("agent", `  listening      http://127.0.0.1:${config.port}`);
    log.info("agent", `  tally          ${client.config.url}`);
    log.info("agent", `  company        ${client.config.defaultCompany ?? "(active company)"}`);
    log.info("agent", `  poll every     ${config.pollIntervalMs}ms`);
    log.info("agent", `  watermarks     masters=${state.lastMasterAlterId} vouchers=${state.lastVoucherAlterId} (${config.stateFile})`);
    log.info("agent", `  reporting to   ${config.appBaseUrl ?? "(no app URL configured)"}`);
  });

  // Bound to 127.0.0.1 on purpose: the only route in is the Cloudflare Tunnel, which connects
  // to localhost. Binding 0.0.0.0 would expose the agent to the whole office LAN, and the agent
  // can write to the accounting books.

  const shutdown = () => {
    log.info("agent", "shutting down…");
    stopPoll();
    stopHeartbeat();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("agent", `Failed to start: ${errorMessage(err)}`);
  process.exit(1);
});
