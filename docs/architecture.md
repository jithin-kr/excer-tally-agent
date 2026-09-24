# Architecture: Excer Tally Agent

| | |
|---|---|
| **Style** | One small Node.js process: HTTP server + poll loop + heartbeat, sharing one Tally client |
| **Runtime** | Node 22.9+ (`--env-file-if-exists`), TypeScript, 3 runtime dependencies |
| **Last reviewed** | 2026-09-24 |

What the agent must do is in [prd.md](prd.md); its wire formats are in [design.md](design.md);
the rules that keep this structure intact are in [rules.md](rules.md).

---

## 1. System context

```
 CLIENT PREMISES (office LAN)                                   VERCEL
 ┌──────────────────────────────────────────┐                  ┌─────────────────────────────┐
 │  TallyPrime  :9000  (XML over HTTP)      │                  │  excer-global (Next.js)     │
 │      ▲  one request at a time            │                  │                             │
 │      │  localhost only                   │   Cloudflare     │  lib/tally/connector.ts ────┼─► push
 │  ┌───┴──────────────────────────────┐    │     Tunnel       │                             │
 │  │ excer-tally-agent  127.0.0.1:7010│◄───┼──────────────────┼──  (app → agent)            │
 │  │  • HTTP server   (server.ts)     │    │                  │                             │
 │  │  • poll loop     (poll-loop.ts)  │────┼── HTTPS out ────►│  /api/tally/pull            │
 │  │  • heartbeat     (heartbeat.ts)  │────┼── HTTPS out ────►│  /api/tally/heartbeat       │
 │  │  Windows service (NSSM)          │    │                  │                             │
 │  └──────────────────────────────────┘    │                  │  TallyJob queue (Postgres)  │
 └──────────────────────────────────────────┘                  └─────────────────────────────┘
```

Tally can be called but never calls out, so the two directions behave differently:
**writes take 1–3 s** (the website starts the conversation), **reads lag 5–60 s** (the agent has to
keep asking). That asymmetry is Tally's design, not ours.

## 2. Code layers

```
src/
├── index.ts          Entry: wires config, client, server, poll loop, heartbeat; process safety nets
├── server.ts         The two HTTP routes; push flow (check → write → read back); /health
├── poll-loop.ts      Two-counter polling; posts deltas to the website
├── heartbeat.ts      Liveness to the website, from poll state (never queries Tally)
├── state-store.ts    Persisted poll watermarks (atomic write)
├── doctor.ts         `npm run doctor`: read-only checks against a real Tally
├── log.ts            Timestamped logging
├── excer/            Excer-specific: knows our payloads and accounting
│   ├── contract.ts   Wire contract with the website (zod schemas = types)
│   ├── config.ts     Env config; every installation-specific Tally name
│   ├── vouchers.ts   Six payloads → voucher XML; GST split; discount reconciliation
│   ├── masters.ts    Counters, stock items, customer ledgers (reads)
│   └── lookup.ts     Find what we wrote: voucher by REMOTEID, ledger by name
└── tally/            Generic Tally XML (third-party MIT code, see NOTICE)
    ├── client.ts     Serialised HTTP client for :9000
    ├── xml.ts        Envelopes, escaping, dates, response parsing
    ├── util.ts       Value coercion (unwraps typed values)
    └── voucher-render.ts  Voucher/ledger/inventory XML
test/                 node:test suites against a fake Tally (shapes captured from a live one)
install/              Windows service installer, tunnel and install runbooks
```

**Dependency direction:** `index/server/poll → excer → tally`. `tally/` knows nothing about Excer;
`excer/` holds every accounting decision.

## 3. Write path (website → Tally)

```
POST /api/import/voucher
  1. auth (x-api-key, constant time)          → 401
  2. zod: pushRequestSchema                    → 400 (issues listed)
  3. one push at a time (oneAtATime)
  4. already in Tally?  lookup by REMOTEID     → 200 duplicate (nothing written)
     ledger: same name, other customer         → 409
     cancel: order missing / already cancelled → 422 / 200 duplicate
  5. build XML (vouchers.ts) → Tally import
  6. Tally wrote nothing / EXCEPTIONS / LINEERROR → 422 with Tally's reason
  7. read back GUID (+ voucher number)         → 200 { success, guid, voucherNumber? }
```

Step 4 runs **before** writing because a re-import with a known REMOTEID *alters* that voucher
(verified live) — it would overwrite an accountant's edits.

## 4. Read path (Tally → website)

```
every POLL_INTERVAL_MS (15s):
  Stage 1  company ALTMSTID / ALTVCHID            (tiny request)
           both 0            → error, stop (never full-export every tick)
           went backwards    → restored from backup: reset watermarks, full re-sync
  Stage 2  masters moved     → items + customer ledgers with AlterID > watermark
           vouchers moved    → every item's closing stock (≤ once per STOCK_REFRESH_MIN_INTERVAL_MS)
  POST /api/tally/pull  → only on 2xx advance watermarks, save to AGENT_STATE_FILE
```

Vouchers change stock **without** changing the item's AlterID, hence two counters.

## 5. Shared state and concurrency

| Resource | Guard |
|---|---|
| Tally (serves one request at a time) | `TallyClient` queues every request; timeout starts when it is sent |
| Push sequence (check → write → read back) | `oneAtATime` in `server.ts` |
| Poll watermarks | In memory + `state/poll-state.json` (atomic rename), keyed by company |
| `/health`, heartbeat | Read poll state; never query Tally |

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| Tally closed / company not open | Poll logs 3 times then every 100th; heartbeat `tallyReachable: false`; pushes 502 |
| Website slow or down | 15s timeout; watermarks not advanced; re-sent next tick |
| Malformed HTTP / URL / JSON | 400; agent keeps running |
| Unexpected rejected promise | Logged; agent keeps running |
| Synchronous uncaught exception | Logged; exit 1; NSSM restarts it |
| Port in use | Clear message; exit 1 |

## 7. Deployment

- Windows service via `install/install-agent.ps1` (NSSM, or a Scheduled Task fallback); logs in
  `logs/`, rotated at 10 MB.
- Cloudflare Tunnel to `127.0.0.1:7010` (`install/TUNNEL.md`); no inbound port.
- `npm run doctor` must pass before the service is installed.
- CI: typecheck, build, `npm test`, boot smoke test, `npm audit` at high.
