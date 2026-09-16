// Entry point: start the HTTP server, the poll loop and the heartbeat.

import { loadAgentConfig } from "./excer/config.js";
import { TallyClient } from "./tally/client.js";
import { createAgentServer } from "./server.js";
import { createPollState, startPollLoop } from "./poll-loop.js";
import { AGENT_VERSION, startHeartbeat } from "./heartbeat.js";

async function main() {
  const config = loadAgentConfig();
  const client = new TallyClient();
  const state = createPollState();

  const server = createAgentServer(config, client);
  const stopPoll = startPollLoop(config, client, state);
  const stopHeartbeat = startHeartbeat(config, client, state);

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`excer-tally-agent v${AGENT_VERSION}`);
    console.log(`  listening      http://127.0.0.1:${config.port}`);
    console.log(`  tally          ${client.config.url}`);
    console.log(`  company        ${client.config.defaultCompany ?? "(active company)"}`);
    console.log(`  poll every     ${config.pollIntervalMs}ms`);
    console.log(`  reporting to   ${config.appBaseUrl ?? "(no app URL configured)"}`);
  });

  // Bound to 127.0.0.1 on purpose: the only route in is the Cloudflare Tunnel, which connects
  // to localhost. Binding 0.0.0.0 would expose the agent to the whole office LAN, and the agent
  // can write to the accounting books.

  const shutdown = () => {
    console.log("shutting down…");
    stopPoll();
    stopHeartbeat();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
