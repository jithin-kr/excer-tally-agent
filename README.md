# excer-tally-agent

On-premises agent bridging the Excer Global Next.js app to TallyPrime's XML gateway.

Forked from [ShrutiSaagar/tally-prime-mcp](https://github.com/ShrutiSaagar/tally-prime-mcp) (MIT).
The upstream project exposed Tally to LLMs over MCP; this fork keeps its XML layer and replaces
the MCP surface with an HTTP API, an AlterID poll loop, and a heartbeat.

---

## Why this exists

Tally is a Windows desktop application. It has **no cloud API, no webhooks, and no outbound push
of any kind**. Its only general-purpose integration surface is XML over HTTP on port 9000, and
that port must never be exposed to the internet — it has no authentication and no TLS.

So the app cannot talk to Tally directly. This agent runs on the client's premises next to Tally
and is reachable from the app through a Cloudflare Tunnel, which is an **outbound** connection
from their network. No firewall changes, no port forwarding, no static IP.

```
 CLIENT PREMISES (LAN)                        VERCEL
 ┌──────────────────────────────┐            ┌────────────────────────────┐
 │  TallyPrime :9000            │            │  Next.js app               │
 │      ▲ XML/HTTP (localhost)  │            │                            │
 │  ┌───┴──────────────────┐    │ Cloudflare │  lib/tally/connector.ts ───┼─► push
 │  │  excer-tally-agent   │◄───┼──Tunnel────┼──                          │
 │  │  :7010 (127.0.0.1)   │    │            │  /api/tally/pull       ◄───┼── deltas
 │  │  • HTTP server       │────┼─ HTTPS out ┼─►/api/tally/heartbeat  ◄───┼── liveness
 │  │  • AlterID poll loop │    │            │                            │
 │  │  • heartbeat         │    │            │  TallyJob queue (Postgres) │
 │  └──────────────────────┘    │            └────────────────────────────┘
 └──────────────────────────────┘
```

**Read is ~15 seconds behind. Write is 1–3 seconds.** That asymmetry is Tally's design, not ours:
we can call Tally whenever we like, but Tally can never call us, so reads are polling.

---

## Layout

| Path | Origin | What it does |
|---|---|---|
| `src/tally/client.ts` | upstream | POSTs XML to Tally, parses failure envelopes |
| `src/tally/xml.ts` | upstream | Export/Import envelopes, date + escaping helpers |
| `src/tally/util.ts` | upstream | Tally value coercion (`"42 Nos"` → `42`) |
| `src/tally/voucher-render.ts` | upstream + `REMOTEID` | Generic voucher/ledger/inventory XML |
| `src/excer/contract.ts` | **new** | The wire contract with the Next.js app |
| `src/excer/config.ts` | **new** | Agent config + all installation-specific Tally names |
| `src/excer/vouchers.ts` | **new** | The six Excer payloads → Tally XML |
| `src/excer/masters.ts` | **new** | AlterID-based incremental read |
| `src/server.ts` | **new** | The two HTTP endpoints the app calls |
| `src/poll-loop.ts` | **new** | Two-stage "has anything changed?" polling |
| `src/heartbeat.ts` | **new** | Liveness reporting |
| `src/doctor.ts` | **new** | Day-one validation against a real Tally |

Deleted from upstream: `src/tools/reports.ts`, `src/index.ts` (MCP entry), `src/jsonschema.ts`,
`bootstrap.cjs`, and the MCP SDK dependency.

---

## Setup

```bash
npm install
cp .env.example .env      # then edit it
npm run build
npm run doctor            # verify against a real Tally BEFORE anything else
npm start
```

The server binds to `127.0.0.1` on purpose. The only route in is the tunnel. Binding `0.0.0.0`
would expose an agent that can write to the accounting books to the entire office LAN.

---

## The endpoints

Both mirror the dev fixture at `src/app/api/dev-fake-tally/` in the main repo, so pointing
`TALLY_CONNECTOR_BASE_URL` at this agent instead of at the fixture is a pure config change.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness; reports whether Tally is reachable |
| `GET` | `/api/export/masters?sinceAlterId=N` | `x-api-key` | Stock items + customer ledgers |
| `POST` | `/api/import/voucher` | `x-api-key` | Post one of the six voucher types |

### Idempotency

Every voucher carries `<REMOTEID>`, built by `buildTallyRemoteId()` in the main app. On a retry
the same REMOTEID is sent, Tally ignores the duplicate, and the agent returns
`{ duplicate: true }` — which the app treats as **success**, because the voucher it wanted does
exist in Tally. Without this, one flaky network moment produces two sales orders in a real
client's books.

---

## Your one decision

`splitGst()` in `src/excer/vouchers.ts` is **deliberately left unimplemented**. It throws.

Everything else in this agent is mechanical translation, but this one is a judgement call about
how the business actually operates, and getting it wrong misfiles tax in a client's books:

Indian GST splits **CGST + SGST** for a sale inside your own state and **IGST** for a sale to
another state. Excer is in Kerala. The function receives the tax total, what we know about the
buyer (`gstin` and/or `state`), and the configured `homeState`.

Three things to decide:

1. **Which signal do you trust?** A GSTIN's first two digits are a government-issued state code
   (`32` = Kerala) and can't be typo'd into a different *valid* state. But unregistered buyers
   have no GSTIN and free-text `state` is all you get.
2. **What if both are missing?** Defaulting to intra-state silently misfiles inter-state sales —
   discovered by an accountant months later. Throwing blocks the push until someone fixes the
   customer record — discovered in the admin panel today. Both are defensible; they fail in very
   different places.
3. **Rounding.** CGST and SGST are each half the total, and an odd number of paise won't split
   evenly. Tally rejects a voucher whose entries don't balance to the paisa, so the two halves
   must still sum to exactly `taxTotal`.

About 8 lines. The doc comment on the function repeats all of this in place.

---

## Required changes in the main app — DONE (2026-09-23)

Found while building the agent against the existing payload builders in
`src/features/tally/mapping.ts`. All five are now done on the excer-global side (see its
CLAUDE.md §22.5 for the file-level detail); only #5 needs a further deployment step once a tunnel
hostname exists.

1. ✅ **`buildCancelVoucherPayload` includes the voucher number.** Tally cancels a voucher by its
   **voucher number**, not by REMOTEID. `salesOrderVoucherNumber` is now sent, read from
   `Order.tallyVoucherNumber`.
2. ✅ **`buildDeliveryNotePayload` sends `buyerLedgerName` and `referencedVoucherNumber`.** A
   delivery note still posts against the customer and references its sales order.
3. ✅ **`buildCreditNotePayload` sends `buyerLedgerName` and `buyerGstin`.** The ledger name to
   post against, and the GSTIN so the tax reversal can pick CGST+SGST vs IGST.
4. ✅ **Two new routes exist**: `POST /api/tally/pull` (accepts master deltas) and
   `POST /api/tally/heartbeat` (accepts liveness). Both bearer-authenticated
   (`TALLY_AGENT_TOKEN` on the app side must match this agent's `EXCER_APP_TOKEN`), and both
   were added to the app's proxy's public-route allowlist so an unauthenticated call gets a real
   401 instead of a 307 to `/login`.
5. ⬜ **`connector.ts`**: still needs `TALLY_CONNECTOR_BASE_URL` pointed at the tunnel hostname
   once one exists — a deployment step, not code. Mock mode still works for local development.

None of this has been run against this agent talking to a real Tally, or against a real tunnel
deployment — see "Not yet verified against a real Tally" below, which is unchanged by this.

---

## Not yet verified against a real Tally

This fork has **never been run against a live Tally installation** — neither has upstream, as far
as we can tell. It typechecks, builds, serves, and rejects bad input correctly. That is all it
currently proves.

Verify each of these before trusting the agent with real books:

- [ ] `<REMOTEID>` is accepted on vouchers and does suppress duplicates. Upstream's captured
      fixtures use `<REMOTEALTGUID>` for **masters**; `<REMOTEID>` is the documented **voucher**
      field. We may need both.
- [ ] The Company object exposes `ALTMSTID` / `ALTVCHID`. **Incremental sync depends entirely on
      this.** `npm run doctor` warns if they come back as 0.
- [ ] `$AlterID > n` works as a collection `FILTER` on this Tally build.
- [ ] Stock Journal XML — cable cuts may need `SOURCELIST`/`DESTINATIONLIST` rather than the flat
      `ALLINVENTORYENTRIES.LIST` this renders.
- [ ] Field names on stock items: `OpeningRate` for base price, whether `HSNCode` lives on the
      item or the stock **group**.
- [ ] Every name in `.env.example`'s bottom section — voucher types, ledgers, the customer group.
      The defaults are Tally's out-of-the-box names and are very likely wrong here.
- [ ] `<ISOPTIONAL>Yes</ISOPTIONAL>` (added 2026-09-23, `TALLY_POST_VOUCHERS_AS_OPTIONAL`) actually
      posts to the Optional Vouchers register instead of being silently ignored — and whether
      Tally's Cancel action applies cleanly to an Optional voucher the accountant hasn't converted
      to Regular yet. This flag exists because the main app's push is now fully automatic rather
      than triggered by an admin clicking a button, so Optional is the new human-review gate — see
      the main repo's CLAUDE.md §22.9.

Post your first voucher into a **test company**, never the live one.

---

## Still blocked on the client

Neither is a code problem, and both outrank everything above:

1. **May we install a Windows Service on the Tally machine?** If not, this whole approach needs
   rethinking. Find out first.
2. **Who owns stock — Tally, the app, or both reconciled?** (CLAUDE.md §20.5, options A/B/C.)
   Today the app deducts stock on dispatch. Once we also post Delivery Notes, both systems deduct
   the same goods unless this is decided deliberately.

---

## Licence

MIT, inherited from upstream. See `LICENSE` and `NOTICE`.
