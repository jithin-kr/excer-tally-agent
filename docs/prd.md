# Product Requirements: Excer Tally Agent

| | |
|---|---|
| **Client** | Excer Global, wholesale electrical and solar supplier, Kerala |
| **Built by** | Velvetek Systems |
| **Status** | Built; verified end to end against a live TallyPrime test company except the Sales Order voucher (§6) |
| **Last reviewed** | 2026-09-24 |

This document states *what* the agent must do and why. How it is built is in
[architecture.md](architecture.md); its external interfaces are in [design.md](design.md); the
rules for changing it are in [rules.md](rules.md); hard-won facts are in [memory.md](memory.md).

---

## 1. Problem and goal

The Excer website (`excer-global`) takes orders online, but **TallyPrime on the office PC is the
book of record** for stock and accounts. Tally is a Windows desktop program: it has no cloud API,
no webhooks, and its only integration surface is XML over HTTP on port 9000, with no password and
no encryption. The website cannot reach it, and it cannot reach the website.

**Goal:** a small program on the office PC that keeps the two in step without anyone typing
anything twice:

- Business events on the website (order confirmed, dispatched, returned, cancelled, customer
  onboarded, cable cut) appear in Tally as the right vouchers and ledgers **within seconds**.
- Stock, customer and price changes made in Tally reach the website **within about a minute**.

**It is not** a Tally replacement, a reporting tool, or a way to edit Tally from the internet.

## 2. Users

| User | Who | What they need from the agent |
|---|---|---|
| **The website** | `excer-global` on Vercel | A small, stable HTTP API; honest success/failure; idempotent retries |
| **The accountant** | Excer office staff using Tally | Correct vouchers they can review before they affect the books; no duplicates; no slowdown |
| **The installer** | Velvetek, on site once | A one-command install and a `doctor` that proves Tally answers correctly |
| **The admin** | Excer owners, in the website admin | A live "connected / Tally closed / agent down" status |

## 3. Requirements

### 3.1 Writing to Tally (website → Tally)

| # | Requirement | Why |
|---|---|---|
| W1 | Post six document types: Sales Order, Delivery Note, Credit Note, New Customer Ledger, Stock Journal (cable cut), Cancel Sales Order | The website's business events (CLAUDE.md §20.4 in the website repo) |
| W2 | A retry must **never** create a second document or overwrite an existing one | One network blip must not put two orders, or undo an accountant's edit, in a real client's books |
| W3 | Vouchers post as **Optional** by default | The website pushes automatically; Optional is the human review step — nothing affects balances until an accountant converts it |
| W4 | Report success **only** when Tally actually wrote the document | The website marks orders "in Tally" from this answer |
| W5 | Tell apart "fix the data" (422), "bug in the request" (400), "name clash" (409), "Tally unreachable" (502) | The website retries some and not others |
| W6 | GST split: CGST+SGST inside Kerala, IGST otherwise; refuse rather than guess when the state is unknown | A wrong guess misfiles tax in the client's books |
| W7 | Cancel an order even though Optional vouchers have no reliable number | Voucher numbers are not unique while Optional (verified live) |

### 3.2 Reading from Tally (Tally → website)

| # | Requirement | Why |
|---|---|---|
| R1 | Send changed stock items and customer ledgers to the website | Stock and customer details are owned by Tally |
| R2 | Pick up stock changes caused by **vouchers**, not just master edits | A purchase changes stock without editing the item |
| R3 | Never make Tally visibly slow for the person using it | A two-stage check: a near-free counter, then only the rows that moved |
| R4 | Survive restarts, restores and bad counters without silent stalls or full exports every tick | The office PC reboots; companies get restored from backup |
| R5 | Send the item's GST rate, HSN, Tally unit and **selling** price (never cost) | The website prices and taxes from them |
| R6 | Every Tally item reaches the website, where it appears as a hidden draft the admin completes and publishes | Client decision 2026-09-24: "show the Tally products on our website; I add images and details" |

### 3.3 Operations

| # | Requirement |
|---|---|
| O1 | Runs as a Windows service, starts with the PC, restarts on failure |
| O2 | Reachable only through the Cloudflare Tunnel; binds `127.0.0.1`; no inbound firewall rule |
| O3 | Heartbeat every 30s so the admin panel shows a red badge within about 90s of trouble |
| O4 | One malformed request, a hung website call or Tally being closed never crashes or stalls it |
| O5 | Timestamped log line for every write, readable on the office PC |

## 4. Explicitly out of scope

- Editing or deleting arbitrary Tally data; the agent only creates its own documents and
  cancels its own Sales Orders.
- Deciding which website product a Tally item belongs to (the website links them).
- Creating a Tally company or changing company features (done once in Tally's UI).
- Invoices (Tally raises them from the order).

## 5. Acceptance

Verified on a live TallyPrime Edit Log test company on 2026-09-24 (details in the README):

| Area | Result |
|---|---|
| Read path, incremental + voucher-driven stock sync, heartbeat | ✅ |
| Customer create / retry / name clash | ✅ |
| Credit Note (CGST+SGST and IGST), Delivery Note, Stock Journal, cancel by REMOTEID | ✅ |
| Retries caught before writing; Optional posting | ✅ |
| **Sales Order** | ❌ Tally rejects: `Bad Order Number in Voucher!` |

## 6. Open

1. **Sales Order voucher layout.** Needs one Sales Order entered by hand in Tally to copy.
2. ~~**Client questions**~~ answered 2026-09-26: the agent is installed as a service on the
   client's Tally PC, and **Tally owns stock** (see the README).
3. **The client's real Tally names**: voucher types, ledgers, customer group (`.env`).
4. **Cable cuts** are recorded stock-neutral; confirm the business does not want them to consume
   stock.
