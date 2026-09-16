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
- Their **customer group** name (usually "Sundry Debtors", but not always)

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

Then **restart Tally** and open the test company.

Verify from a browser on that same machine: `http://localhost:9000` should return XML, not a
connection error.

> Port 9000 has **no authentication and no TLS**. It must never be exposed to the internet or
> port-forwarded. The agent connects to it over localhost only, and the agent itself binds to
> `127.0.0.1`. That is deliberate — anyone who reaches port 9000 can rewrite the entire books.

---

## Step 2 — Install Node.js

Download the current **LTS** from <https://nodejs.org> and install with defaults.
Node 20 or newer is required (the agent uses `--env-file-if-exists`).

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
- `AGENT_API_KEY` — a long random secret. Generate one:
  ```powershell
  -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
  ```
- `EXCER_APP_URL` — your production app URL
- `EXCER_APP_TOKEN` — a second long random secret
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
work, and whether stock items and customer ledgers come back with the fields we need.

Read its warnings carefully. In particular:

- **"AlterID counters both returned 0"** — incremental sync will not work. The field names differ
  on this Tally build. Do not proceed as if this is fine; the poll loop would run forever finding
  "nothing changed" and silently sync nothing.
- **"GUID empty"** — record linking will not work.
- **"no ledgers under Sundry Debtors"** — wrong group name; ask them what theirs is called.

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

You want `"tallyReachable": true`.

---

## Step 7 — Set up the tunnel

See [TUNNEL.md](./TUNNEL.md). This is what lets your Vercel app reach the agent without opening
anything on their firewall.

---

## Step 8 — Verify end to end

1. In Vercel, set `TALLY_CONNECTOR_BASE_URL` to the tunnel hostname and
   `TALLY_CONNECTOR_API_KEY` to the `AGENT_API_KEY` from Step 4. Redeploy.
2. Open `/admin/tally-sync` and press **Pull from Tally**. Check the Sync History row.
3. Confirm a test order, then press **Push to Tally**.
4. Open Tally and look for the voucher. Check the **test company**, not the live one.

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
| Push returns 422 | Tally rejected the voucher. The response includes Tally's own `lineError` — usually a ledger or voucher type name that doesn't exist |
| Everything works, then stops at 6pm | They close Tally at end of day. Queued jobs will go out next morning; this is expected |

Logs (NSSM backend): `C:\excer-tally-agent\logs\agent.out.log` and `agent.err.log`, rotated at
10MB.

---

## What the client should be told, plainly

- **The Tally machine must be on, with Tally open**, for sync to happen. Orders placed while it's
  off are queued and go out when it comes back — nothing is lost, but nothing is instant either.
- **Stock in the website is up to ~15 seconds behind Tally.** Orders going *into* Tally are near
  instant.
- **Someone needs to tell us if that machine is replaced or rebuilt.** The agent has to be
  reinstalled.
