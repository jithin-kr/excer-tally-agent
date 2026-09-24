# Cloudflare Tunnel setup

The problem: your app runs on Vercel, the agent runs on a PC inside the client's office. Vercel
cannot dial into their LAN, and asking their IT to port-forward is both a hard sell and a genuine
security risk — the agent can write to the accounting books.

The solution: `cloudflared` runs on the office PC and makes an **outbound** connection to
Cloudflare, which stays open. Cloudflare gives you a stable HTTPS hostname that routes down that
existing connection to the agent.

From the office network's point of view this is just an outgoing HTTPS session, the same shape as
opening a website. **No inbound firewall rule. No port forward. No static IP.**

```
  Office PC                            Cloudflare                     Vercel
  ┌──────────────────┐                ┌───────────┐                 ┌──────────┐
  │ agent :7010      │                │           │                 │          │
  │   ▲              │   outbound     │           │    HTTPS        │          │
  │   └─ cloudflared ├───────────────►│  edge     │◄────────────────┤ your app │
  │      (service)   │   stays open   │           │  tally.you.com  │          │
  └──────────────────┘                └───────────┘                 └──────────┘
```

---

## Prerequisites

- A domain on Cloudflare (free plan is fine). You need a subdomain like `tally.yourdomain.com`.
- Administrator access on the office PC.

---

## Steps

### 1. Install cloudflared

On the office PC:

```powershell
winget install --id Cloudflare.cloudflared
```

Or download the `.msi` from
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>.

### 2. Create the tunnel

Easiest path is the Cloudflare dashboard:

1. **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel**
2. Choose **Cloudflared**, name it `excer-tally`
3. Copy the install command it shows — it contains a token
4. Run that command on the office PC (it installs cloudflared as a Windows service)

Then add a **Public Hostname** on that tunnel:

| Field | Value |
|---|---|
| Subdomain | `tally` |
| Domain | `yourdomain.com` |
| Type | `HTTP` |
| URL | `localhost:7010` |

`HTTP` is correct here — the hop from cloudflared to the agent is over loopback on the same
machine. Cloudflare terminates TLS at its edge, so the public hostname is HTTPS.

### 3. Verify

From anywhere:

```bash
curl https://tally.yourdomain.com/health
```

You should get `{"ok":true,"agentId":"…","tallyReachable":true}`. Without the API key that is all
`/health` shows, on purpose — it is public. Add `-H "x-api-key: <AGENT_API_KEY>"` for details.

### 4. Point the app at it

In Vercel:

```
TALLY_CONNECTOR_BASE_URL = https://tally.yourdomain.com
TALLY_CONNECTOR_API_KEY  = <the AGENT_API_KEY from the agent's .env>
TALLY_AGENT_TOKEN        = <the EXCER_APP_TOKEN from the agent's .env>
```

Redeploy. The first two let the website call the agent; the third lets the agent's deltas and
heartbeats into the website (without it they get `401` and the admin panel shows the agent as
never connected). No code change is needed.

---

## Lock it down

`/health` is deliberately unauthenticated so tunnel health checks work. Everything else requires
`x-api-key`. Two things worth adding:

**1. A Cloudflare WAF rule** restricting the hostname to Vercel's egress, or at minimum rate
limiting it. The agent is small and the API key is strong, but there is no reason to let the
whole internet knock on it.

**2. Cloudflare Access** in front of the paths, if you want a second factor beyond the API key.
Note that Access will also block your own app unless you configure a service token — set that up
deliberately or not at all.

---

## Alternatives

| Option | Notes |
|---|---|
| **Tailscale Funnel** | Similar model, also outbound-only. Good if they already use Tailscale. |
| **ngrok** | Works, but the free tier's URL changes on restart — unusable for this. Paid tier is fine. |
| **VPN into their network** | Heavier, needs their IT, and usually slower to get approved. |
| **Port forwarding** | Do not. It exposes a machine that can rewrite the books, and port 9000 next to it has no authentication at all. |

---

## When it breaks

| Symptom | Check |
|---|---|
| `curl` to the hostname times out | Is the `cloudflared` service running? `Get-Service cloudflared` |
| 502 from Cloudflare | Tunnel is up, agent is down. `curl http://127.0.0.1:7010/health` on the PC |
| 401 from the agent | `TALLY_CONNECTOR_API_KEY` in Vercel doesn't match `AGENT_API_KEY` in `.env` |
| Admin panel: agent "never connected", agent log shows HTTP 401 | `TALLY_AGENT_TOKEN` in Vercel doesn't match `EXCER_APP_TOKEN` in `.env` |
| Works, then stops after a reboot | cloudflared didn't install as a service — re-run the dashboard install command |
