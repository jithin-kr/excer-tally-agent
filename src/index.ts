// Entry point: start the HTTP server, the poll loop and the heartbeat.

import { loadAgentConfig } from "./excer/config.js";
import { TallyClient } from "./tally/client.js";
import { createAgentServer } from "./server.js";
import { createPollState, startPollLoop } from "./poll-loop.js";
import { AGENT_VERSION, startHeartbeat } from "./heartbeat.js";
import { loadWatermarks } from "./state-store.js";
import { errorMessage, log } from "./log.js";
import { getGlobalDispatcher } from "undici";

async function main() {
  const config = loadAgentConfig();
  const client = new TallyClient();
  const state = createPollState(loadWatermarks(config.stateFile, client.config.defaultCompany ?? null));

  const server = createAgentServer(config, client, state);
  const stopPoll = startPollLoop(config, client, state);
  const stopHeartbeat = startHeartbeat(config, client, state);

  // Port already taken (a second copy running?) — say so plainly instead of a raw stack trace.
  server.on("error", (err: NodeJS.ErrnoException) => {
    log.error(
      "agent",
      err.code === "EADDRINUSE"
        ? `port ${config.port} is already in use — is another copy of the agent running?`
        : `server error: ${errorMessage(err)}`
    );
    process.exit(1);
  });
  // Garbage from the network (bad HTTP framing) closes that one connection, nothing more.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    else socket.destroy();
  });

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
    // Close the keep-alive connections to Tally before exiting: process.exit() with sockets still
    // open trips a libuv assertion on Windows (seen with `npm run doctor` on a live Tally).
    server.close(() => {
      getGlobalDispatcher()
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Last-resort safety nets. Every known path already catches its own errors; these exist so an
// unforeseen one is logged with a timestamp in the service log instead of vanishing.
//  - A stray rejected promise is logged and the agent keeps serving: it is not proof that the
//    process state is corrupt.
//  - A synchronous uncaught exception IS: log it and exit, and the service manager (NSSM /
//    the scheduled task) restarts a clean process within seconds.
process.on("unhandledRejection", (reason) => {
  log.error("agent", `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  log.error("agent", `uncaught exception, exiting for a clean restart: ${err.stack ?? err.message}`);
  process.exit(1);
});

main().catch((err) => {
  log.error("agent", `Failed to start: ${errorMessage(err)}`);
  process.exit(1);
});
