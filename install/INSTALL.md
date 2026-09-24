# Installing on the client's Tally machine

A runbook. Roughly 45 minutes on the day, assuming the prerequisites below are already true.

Do all of this against a **test company in Tally first**. Never point a first install at the
live books.

---

## Before you travel: confirm these

If any answer is "no", stop and resolve it — each one blocks the install completely.

| # | Question | Why it blocks |
|---|---|---|
| 1 | May we install a Windows Service on the Tally machine? | The entire approach depends on it |
| 2 | Is that machine always on, or at least on during business hours? | Nothing syncs while it's off |
| 3 | Do we have Administrator rights on it? | Service installation requires elevation |
| 4 | Is outbound HTTPS allowed (no blocking proxy)? | The tunnel and heartbeat need it |
| 5 | Is there a test company in Tally we can use? | You do not debug XML against live books |
| 6 | Who administers this machine, and who do we call at 9pm? | You will need this eventually |

Also get, from their Tally person:

- The company name **exactly** as it appears in Tally
- The **voucher type names** they actually use ("Sales Order"? "Delivery Challan"? custom?)
- Their **ledger names** for sales, CGST, SGST, IGST, discount
- Whether **godowns** are enabled, and which one the web shop sells from
- Their **customer group** name (usually "Sundry Debtors", but not always; sub-groups under it are
  included automatically)
- Whether **GST rate and HSN are set on each stock item**, or only on stock groups. The agent
  reads them from the item; an item without its own rate syncs with an unknown rate, and orders
  containing it wait (by design, rather than going out tax-free)
- Whether each item has a **standard selling price** set. That, plus GST, becomes the website's
  base price; items without one keep their website price

These go into `.env`. The defaults in `.env.example` are Tally's out-of-the-box names and are
very likely wrong for this installation.

---

## Step 1 — Enable Tally's XML gateway

In TallyPrime, on the Tally machine:

```
F1 (Help) → Settings → Connectivity → Client/Server configuration
    TallyPrime acts as :  Both          (or "Server")
    Enable ODBC         :  Yes
    Port                :  9000
```

Then **restart Tally** and open the test company. (If `tally.ini` in Tally's install folder still
says `Client Server=None`, the setting did not take.)

In the company, press **F11 (Features)** and make sure **Enable Order Processing** is on, and
Delivery Notes / tracking numbers if offered. Without it the *Sales Order* and *Delivery Note*
voucher types are inactive and every such push is rejected.

> Testing on an **Educational (unlicensed)** Tally? It only accepts voucher dates on the **1st,
> 2nd and 31st** of a month. Date test orders accordingly.

Verify from a browser on that same machine: `http://localhost:9000` should return XML, not a
connection error.

> Port 9000 has **no authentication and no TLS**. It must never be exposed to the internet or
> port-forwarded. The agent connects to it over localhost only, and the agent itself binds to
> `127.0.0.1`. That is deliberate — anyone who reaches port 9000 can rewrite the entire books.

---

## Step 2 — Install Node.js

Download the current **LTS** from <https://nodejs.org> and install with defaults.
Node 22.9 or newer is required (the agent uses `--env-file-if-exists`); the installer checks this.

Confirm in a new PowerShell window:

```powershell
node --version
```

---

## Step 3 — Get the code onto the machine

Either clone it:

```powershell
cd C:\
git clone <your-repo-url> excer-tally-agent
cd excer-tally-agent
```

Or copy a zip of the repo (without `node_modules` and `dist`) to `C:\excer-tally-agent`.

Put it somewhere boring and permanent — `C:\excer-tally-agent` is good. Not on a user's Desktop,
not in a OneDrive-synced folder. The service runs as SYSTEM and needs the path to be stable.

---

## Step 4 — Configure

```powershell
copy .env.example .env
notepad .env
```

Fill in, at minimum:

- `TALLY_COMPANY` — the exact company name
- `AGENT_API_KEY` — a long random secret, at least 16 characters (the agent refuses to start with
  a shorter one or with `change-me`). Generate one:
  ```powershell
  -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
  ```
- `EXCER_APP_URL` — your production app URL
- `EXCER_APP_TOKEN` — a second long random secret; the website's `TALLY_AGENT_TOKEN` must match it
- Every `TALLY_VT_*`, `TALLY_LEDGER_*`, `TALLY_GROUP_*` value from their Tally person

The same `AGENT_API_KEY` goes into the Vercel environment as `TALLY_CONNECTOR_API_KEY`.

---

## Step 5 — Check Tally answers correctly

**Before** installing any service:

```powershell
npm ci
npm run build
npm run doctor
```

`doctor` makes no writes. It reports whether Tally is reachable, whether the AlterID counters
work, whether stock items and customer ledgers come back with the fields we need, and whether the
lookups the agent uses to detect duplicates are accepted. It exits 0 only when the agent can work.

Read its output carefully. In particular:

- **FAIL "AlterID counters both returned 0"** — incremental sync cannot work, and the poll loop
  refuses to run (rather than exporting everything every 15 seconds). The company is empty or the
  field names differ on this Tally build.
- **WARN "GUID empty"** — record linking will not work.
- **"no ledgers under Sundry Debtors"** — wrong group name; ask them what theirs is called.
- **NOTE "hsnCode empty" / "no standard selling price"** — set on the stock group or not set; see
  "Before you travel".

Fix these before going further. This is the whole reason `doctor` exists.

---

## Step 6 — Install the service

From an **elevated** PowerShell prompt, in the repo root:

```powershell
.\install\install-agent.ps1
```

This needs [NSSM](https://nssm.cc/download) — download it, unzip, and either put `nssm.exe` on
PATH or pass `-NssmPath C:\tools\nssm.exe`.

If the machine is locked down and cannot download tools, use the no-download fallback:

```powershell
.\install\install-agent.ps1 -Backend task
```

That registers a Scheduled Task that starts at boot and restarts on failure. It works, but you
lose NSSM's log rotation and clean start/stop control.

Verify:

```powershell
curl http://127.0.0.1:7010/health
```

You want `"tallyReachable": true`. Without a key `/health` shows only that; for the last error,
company, and sync position, send the key:

```powershell
curl -H "x-api-key: <AGENT_API_KEY>" http://127.0.0.1:7010/health
```

---

## Step 7 — Set up the tunnel

See [TUNNEL.md](./TUNNEL.md). This is what lets your Vercel app reach the agent without opening
anything on their firewall.

---

## Step 8 — Verify end to end

1. In Vercel, set `TALLY_CONNECTOR_BASE_URL` to the tunnel hostname and
   `TALLY_CONNECTOR_API_KEY` to the `AGENT_API_KEY` from Step 4. Redeploy.
2. Open `/admin/tally-sync` and press **Pull from Tally**. Check the Sync History row.
3. Confirm a test order. It is pushed automatically within seconds (**Push to Tally** forces it).
4. Open Tally and look for the voucher in the **Optional** vouchers of the **test company**, not
   the live one. The agent's log line for it should show a `guid=`.
5. Push the same thing again (e.g. the button): the log must say `duplicate`, and Tally must
   still hold one voucher.

> Known issue (2026-09-24): Tally rejects the agent's **Sales Order** with `Bad Order Number in
> Voucher!`. Delivery Notes, Credit Notes, cable cuts, customers and cancels work. See the README.

---

## Updating later

```powershell
cd C:\excer-tally-agent
git pull
.\install\install-agent.ps1        # idempotent: rebuilds and upgrades in place
```

The install script stops the service, rebuilds, and restarts it. `.env` is never touched.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `health` says Tally unreachable | Tally closed, company not open, or gateway setting reverted after a Tally update |
| Service starts then stops immediately | Almost always `.env` — a missing `AGENT_API_KEY` throws at startup. Check `logs\agent.err.log` |
| Pull returns zero rows | `sinceAlterId` watermark is ahead of reality, or the customer group name is wrong |
| Push returns 422 with Tally's message | Tally rejected the voucher — usually a ledger, voucher type or stock item name that doesn't exist in this company |
| 422 "Tally wrote nothing and gave no reason" | Tally rejected it silently — typically an unknown unit, an inactive voucher type (F11), or a layout issue. Check the voucher type is active |
| 422 "Bad Order Number in Voucher!" | Known Sales Order issue, see the README |
| Push returns 400 | The website sent a malformed payload (a bug there). The response lists each bad field; it is not retried |
| Push returns 409 | A different Tally ledger already has this customer's name. Rename one of them; it is not retried |
| Website job says "GST rate unknown" | Set the GST rate on that stock item in Tally; it syncs and the job retries by itself |
| Everything works, then stops at 6pm | They close Tally at end of day. Queued jobs will go out next morning; this is expected |

Logs (NSSM backend): `C:\excer-tally-agent\logs\agent.out.log` and `agent.err.log`, rotated at
10MB.

---

## What the client should be told, plainly

- **The Tally machine must be on, with Tally open**, for sync to happen. Orders placed while it's
  off are queued and go out when it comes back — nothing is lost, but nothing is instant either.
- **Stock in the website is up to about a minute behind Tally** (customer and item changes about
  15 seconds). Orders going *into* Tally are near instant.
- **Orders arrive in Tally as Optional vouchers.** They affect no balance or stock until an
  accountant converts them to Regular — that is the review step.
- **Someone needs to tell us if that machine is replaced or rebuilt.** The agent has to be
  reinstalled.
