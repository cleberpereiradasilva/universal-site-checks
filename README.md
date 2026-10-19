# universal-monitor

Uptime monitor for your own websites, running as a single **Cloudflare Worker** (free plan).

- Checks every registered URL **once a minute**.
- Sends a **Telegram** alert when a site goes down and when it comes back (with the downtime duration).
- Sends a **daily summary at 22:00** (America/Sao_Paulo) saying everything is fine, or listing what is down.
- Pings **healthchecks.io** on every run. If the monitor itself stops, healthchecks.io alerts you through an independent channel.
- Minimal web panel at `/admin` to add and remove URLs.

No history, no charts. Only the current state of each site.

---

## Contents

1. [Architecture](#architecture)
2. [How it works](#how-it-works)
3. [Endpoints](#endpoints)
4. [Secrets and configuration](#secrets-and-configuration)
5. [Deploy from scratch](#deploy-from-scratch)
6. [Day-to-day operations](#day-to-day-operations)
7. [Local development](#local-development)
8. [Free plan limits](#free-plan-limits)
9. [Troubleshooting](#troubleshooting)
10. [Before publishing the repository](#before-publishing-the-repository)
11. [Project structure](#project-structure)

---

## Architecture

```
                 cron * * * * *            ┌────────────┐
                 cron 0 1 * * * (22:00 BRT)│  Telegram  │◄── alerts, daily summary
                        │                  └────────────┘
                        ▼                        ▲
┌──────────┐    ┌──────────────────┐             │
│  You     │───►│ Cloudflare Worker│─────────────┘
│ /admin   │    │  src/index.ts    │──► fetch each registered site
└──────────┘    └────────┬─────────┘
                         │                 ┌────────────────┐
                         ├────────────────►│ healthchecks.io│──► Telegram (their bot)
                         │  ping per run   └────────────────┘    if the Worker stops
                         ▼
                   ┌───────────┐
                   │ D1 (SQLite)│  table `sites`: url, name, current status
                   └───────────┘
```

Three independent services, no shared failure mode:

| Component | Role | If it fails |
|---|---|---|
| Cloudflare Worker + D1 | Runs the checks and stores the URLs | healthchecks.io stops receiving pings and alerts you |
| Telegram (your bot) | Delivers the alerts | The 22:00 summary does not arrive: sign the bot is broken |
| healthchecks.io | Watches the Worker | The Worker keeps alerting as usual |

---

## How it works

### Check run (cron `* * * * *`)

1. Reads every URL from D1.
2. Sends a `GET` to all of them in parallel. **10 s** timeout. Follows redirects. `cache: no-store`.
3. **Up** = HTTP status `< 400`. Anything else (4xx, 5xx, timeout, DNS, TLS) = **down**.
4. On failure, waits 2 s and tries **once more** before declaring the site down. Avoids false positives from a single network hiccup.
5. Writes to D1: `status`, `since` (when the status last changed), `last_check`, `last_code`, `last_error`.
6. **Alerts only on transitions**:
   - `up → down`: `🔴 Name is DOWN` + URL + reason (`HTTP 503 in 812ms`, `timeout after 10s`, ...).
   - `down → up`: `🟢 Name is back UP` + `Was down for 12 min`.
   - Site still down: silence. It does not repeat the alert every minute.
7. At the end, pings healthchecks.io (`POST` to the ping URL).
8. If D1 does not respond: sends `⚠️ Database (D1) did not respond` to Telegram and pings `<ping-url>/fail` on healthchecks.io. Both channels fire.

Cloudflare network error codes are translated in the message:

| Code | Shown as |
|---|---|
| 530 | DNS does not resolve / origin does not exist |
| 521 | origin refused the connection |
| 522 | connection timed out |
| 523 | origin unreachable |
| 525 / 526 | SSL certificate error |

### Daily summary (cron `0 1 * * *`)

`01:00 UTC` = `22:00` in `America/Sao_Paulo` (Brazil has had no daylight saving time since 2019).

- All good: `✅ 19/10, 22:00 — all good. 5 site(s) up, monitor alive.`
- Something down: `⚠️ 19/10, 22:00 — 1 of 5 site(s) down:` + list with downtime.
- No sites registered: `ℹ️ ... monitor alive, but no sites registered.`

This doubles as a liveness signal for the Telegram bot. If it ever fails to arrive, the bot or the Worker is dead.

### New site

When a URL is added (panel or API) the Worker checks it immediately. The panel shows the real status right away, and if the site is already down the alert goes out at once.

---

## Endpoints

Base: `https://universal-monitor.<your-account>.workers.dev`

**Every endpoint (except `/`) requires HTTP Basic Auth** with `ADMIN_USER` / `ADMIN_PASS`.
Missing or wrong credentials: `401` with header `WWW-Authenticate: Basic`.

Responses are JSON (`content-type: application/json; charset=utf-8`), except `/admin`, which is HTML.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Redirects (302) to `/admin` |
| `GET` | `/admin` | Web panel |
| `GET` | `/api/sites` | Lists all sites with their current state |
| `POST` | `/api/sites` | Registers a URL and checks it right away |
| `DELETE` | `/api/sites/:id` | Removes a site |
| `POST` | `/api/check` | Runs a full check round now (same as the cron) |
| `POST` | `/api/test-telegram` | Sends a test message to Telegram |
| `GET` | `/api/config` | Tells whether Telegram and healthchecks are configured |

In the examples below `$A` is `user:password` and `$B` is the base URL:

```bash
A='YOUR_USER:YOUR_PASSWORD'
B='https://universal-monitor.<your-account>.workers.dev'
```

### `GET /api/sites`

```bash
curl -u "$A" "$B/api/sites"
```

```json
{
  "sites": [
    {
      "id": 1,
      "url": "https://example.com/",
      "name": "Example",
      "status": "up",
      "since": 1792416135389,
      "last_check": 1792416795123,
      "last_code": 200,
      "last_error": null,
      "created_at": 1792416135108
    }
  ],
  "now": 1792416800000
}
```

Fields:

| Field | Type | Meaning |
|---|---|---|
| `status` | `"up" \| "down" \| "unknown"` | `unknown` only until the first check |
| `since` | epoch ms | When the current status started. `now - since` = how long it has been up / down |
| `last_check` | epoch ms | Last check |
| `last_code` | number or `null` | Last HTTP status. `null` when there was no response (timeout, DNS) |
| `last_error` | string or `null` | Failure reason, `null` while up |
| `now` | epoch ms | Server clock, for computing durations on the client |

### `POST /api/sites`

JSON body. `url` is required (`http://` or `https://`), `name` is optional (up to 80 characters).

```bash
curl -u "$A" -X POST "$B/api/sites" \
  -H 'content-type: application/json' \
  -d '{"url":"https://mysite.com","name":"My Site"}'
```

| Status | When |
|---|---|
| `201` | Created. Returns `{ "site": {...} }` already containing the first check result |
| `400` | Invalid JSON, invalid URL, or a protocol other than http/https |
| `409` | URL already registered |

The URL is normalized (`https://mysite.com` becomes `https://mysite.com/`).

### `DELETE /api/sites/:id`

```bash
curl -u "$A" -X DELETE "$B/api/sites/3"
```

| Status | Response |
|---|---|
| `200` | `{ "ok": true }` |
| `404` | `{ "error": "Site not found" }` |

Removing a site that is down does **not** produce a "back up" message.

### `POST /api/check`

Runs a full round now, with the same effects as the cron: saves state, alerts on transitions, pings healthchecks.

```bash
curl -u "$A" -X POST "$B/api/check"
```

```json
{ "ok": true, "checked": 5, "up": 4, "down": 1, "alerts": 1 }
```

`alerts` = how many messages were sent in this round. If D1 fails: `{ "ok": false, "checked": 0, ..., "error": "..." }`.

### `POST /api/test-telegram`

```bash
curl -u "$A" -X POST "$B/api/test-telegram"
```

```json
{ "ok": true, "configured": true }
```

`configured: false` = `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is missing. `ok: false` with `configured: true` = Telegram rejected the message (invalid token, bot removed from the group). See `wrangler tail`.

### `GET /api/config`

```bash
curl -u "$A" "$B/api/config"
```

```json
{ "telegram": true, "healthchecks": true }
```

Does not expose values, only whether they are set.

### Errors

Any unhandled exception returns `500` with `{ "error": "message" }`. Unknown route: `404` with `{ "error": "Not found" }`.

---

## Secrets and configuration

Everything sensitive lives in **Cloudflare Secrets**, never in the code or in `wrangler.toml`.

| Name | Required | Purpose |
|---|---|---|
| `ADMIN_USER` | yes | Panel and API user |
| `ADMIN_PASS` | yes | Panel and API password |
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from `@BotFather` |
| `TELEGRAM_CHAT_ID` | yes | Chat that receives the alerts. Group ids start with `-` |
| `HEALTHCHECKS_PING_URL` | no | `https://hc-ping.com/<uuid>`. Without it, pings are simply skipped |

Without `ADMIN_USER`/`ADMIN_PASS` the Worker answers `401` to everything.

### Local files (git-ignored)

| File | Contents |
|---|---|
| `.dev.vars` | The 5 secrets above. Used by `wrangler dev` and by `scripts/setup.sh` |
| `.cf.env` | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` so wrangler can authenticate without `wrangler login` |

Template in `.dev.vars.example`.

### How to get each credential

**Telegram**
1. Talk to `@BotFather` → `/newbot` → copy the token.
2. Add the bot to the group that will receive alerts (or message it directly).
3. Send any message in the group and look up the `chat_id`:
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep -A3 '"chat"'
   ```

**healthchecks.io**
1. Create an account → **Add Check** → name it `universal-monitor`.
2. Schedule: **Period 5 min, Grace 10 min** (tolerates normal cron delays, alerts within ~15 min).
3. Integrations → Telegram → Connect.
4. Copy the Ping URL (`https://hc-ping.com/<uuid>`).

**Cloudflare API token** (alternative to `wrangler login`, which can fail with a CSRF error in the browser)
1. `dash.cloudflare.com` → Manage Account → **Account API Tokens** → Create Token.
2. Template **Edit Cloudflare Workers** + add **Account → D1 → Edit**.
3. Account ID: Workers & Pages, right-hand side of the page.

---

## Deploy from scratch

Prerequisite: Node 22+.

```bash
git clone <repo> universal-monitor && cd universal-monitor
npm install

cp .dev.vars.example .dev.vars        # fill in the 5 secrets
cat > .cf.env <<'EOF2'
export CLOUDFLARE_ACCOUNT_ID=<account id>
export CLOUDFLARE_API_TOKEN=<token>
EOF2
chmod 600 .cf.env

source .cf.env
./scripts/setup.sh
```

`setup.sh` does, in order:

1. Creates the D1 database `universal-monitor` and writes its `database_id` into `wrangler.toml` (first run only).
2. Applies the migrations in `migrations/` to the remote database.
3. Uploads every non-empty line of `.dev.vars` as a secret (`wrangler secret put`).
4. `wrangler deploy`.

At the end it prints the URL `https://universal-monitor.<account>.workers.dev` and the two crons.

**Cron triggers can take up to ~15 minutes to start firing after the first deploy.** That is normal Cloudflare propagation, not an error. In the meantime, `POST /api/check` works.

---

## Day-to-day operations

Always `source .cf.env` before any `wrangler` command.

| Task | Command |
|---|---|
| Deploy code changes | `npm run deploy` |
| Live logs (crons, errors, Telegram) | `npm run tail` |
| Change a secret | `npx wrangler secret put TELEGRAM_CHAT_ID` (prompts for the value) |
| List secrets | `npx wrangler secret list` |
| Query the database directly | `npx wrangler d1 execute universal-monitor --remote --command "SELECT id,url,status FROM sites"` |
| New migration | create `migrations/0002_xxx.sql` and run `npm run db:migrate` |
| Force a check round | `curl -u user:password -X POST $B/api/check` |
| Pause the monitor | Cloudflare dash → Worker → Settings → Triggers → disable the crons (or `crons = []` in the toml + deploy) |

Changing the Telegram group: add the bot to the new group, find the `chat_id` with `getUpdates`, run `npx wrangler secret put TELEGRAM_CHAT_ID`. No redeploy needed.

Changing the panel password: `npx wrangler secret put ADMIN_PASS`. Update `.dev.vars` too, otherwise the next `setup.sh` overwrites it.

---

## Local development

```bash
npm run db:migrate:local      # creates the local D1 under .wrangler/
npm run dev                   # http://127.0.0.1:8787, reads .dev.vars
```

Miniflare runs the real Worker runtime, with a local D1 and internet access. The `fetch` calls to your sites are real, and so are Telegram and healthchecks if they are filled in `.dev.vars`. Leave `TELEGRAM_*` empty to only log the messages to the console.

Trigger the crons manually (`--test-scheduled` is already in the `dev` script):

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"    # check round
curl "http://127.0.0.1:8787/__scheduled?cron=0+1+*+*+*"    # daily summary
```

Typecheck: `npm run typecheck`. Build without publishing: `npx wrangler deploy --dry-run`.

---

## Free plan limits

| Limit | Value | Impact |
|---|---|---|
| Requests per day | 100,000 | The cron uses 1,440/day. Plenty of headroom |
| Subrequests per execution | 50 | Each site = 1 fetch (2 on failure) + 1 Telegram call per alert + 1 healthchecks + D1. **Comfortable up to ~20 sites.** Beyond that, split into batches |
| CPU per execution | 10 ms | Time spent waiting on the sites does not count. Fine |
| Cron triggers | 5 per Worker | We use 2 |
| D1 | 5M reads/day, 100k writes/day, 5 GB | The cron does 1 read + 1 batched write per minute. Plenty |
| Cron triggers | "best effort" | May be delayed or skipped during incidents. Hence healthchecks.io |

Official source: https://developers.cloudflare.com/workers/platform/limits/

---

## Troubleshooting

**Cron does not fire after deploy.** Wait up to 15 min. Confirm it is registered:
```bash
source .cf.env
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/universal-monitor/schedules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

**`wrangler login` fails with `request_forbidden` / `No CSRF value available in the session cookie`.** Cookie blocked by the browser. Use an API token (`.cf.env`) instead of OAuth.

**`Authentication error [code: 10000]` when creating D1.** The token lacks `D1 → Edit`. Edit the token in the dash; its value does not change.

**Panel keeps asking for the password.** `ADMIN_USER`/`ADMIN_PASS` do not match or were never uploaded. Check with `npx wrangler secret list`.

**Telegram messages do not arrive.** `POST /api/test-telegram`. If `configured: false`, a secret is missing. If `ok: false`, look at `npm run tail`: `chat not found` = wrong `chat_id` or bot not in the group; `401 Unauthorized` = invalid token.

**A site shows as down but opens in the browser.** Some sites block bots by User-Agent or return 403 to Cloudflare's network. The monitor sends `User-Agent: universal-monitor/1.0 (uptime check)`. Allow that UA or expose a public health-check route on the site.

**Site behind Cloudflare proxy.** Works normally. If the origin goes down the status comes back as 521/522/523 and the message explains it.

**Isolated false positive.** The 2 s retry already covers most cases. If it persists, raise `RETRY_DELAY_MS` or `CHECK_TIMEOUT_MS` in `src/index.ts`.

---

## Before publishing the repository

Nothing sensitive is versioned: `.dev.vars` and `.cf.env` are in `.gitignore`. Before a public `git push`, confirm:

```bash
git ls-files | grep -E '\.dev\.vars$|\.cf\.env$' && echo "DANGER: secret file is tracked"
git grep -nE '[0-9]{9,10}:[A-Za-z0-9_-]{35}|cfat_[A-Za-z0-9]+|hc-ping\.com/[0-9a-f]{8}' && echo "DANGER: secret in the code"
```

Both commands should print nothing. The D1 `database_id` in `wrangler.toml` is not a secret: without the account token it is useless.

If a secret ever leaks, revoke it at the source (BotFather `/revoke`, Cloudflare dash, healthchecks "Regenerate"). Deleting it from git is not enough.

---

## Project structure

```
universal-monitor/
├── src/
│   ├── index.ts          # Worker: scheduled (crons) + fetch (panel and API)
│   ├── admin.html        # panel, served as text by the Worker
│   └── html.d.ts         # typing for the .html import
├── migrations/
│   └── 0001_init.sql     # sites table
├── scripts/
│   └── setup.sh          # creates D1, migrates, uploads secrets, deploys
├── wrangler.toml         # name, crons, D1 binding, .html rule
├── package.json          # npm scripts
├── tsconfig.json
├── .dev.vars.example     # secrets template
├── .dev.vars             # (ignored) real secrets
└── .cf.env               # (ignored) Cloudflare token and account id
```

D1 schema:

```sql
CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',   -- up | down | unknown
  since INTEGER,                            -- epoch ms of the last status change
  last_check INTEGER,                       -- epoch ms
  last_code INTEGER,                        -- last HTTP status, NULL when no response
  last_error TEXT,                          -- failure reason, NULL while up
  created_at INTEGER NOT NULL
);
```

Tunable constants in `src/index.ts`:

| Constant | Default | Purpose |
|---|---|---|
| `CHECK_TIMEOUT_MS` | 10 000 | Per-fetch timeout |
| `RETRY_DELAY_MS` | 2 000 | Wait before the retry |
| `DAILY_CRON` | `0 1 * * *` | Must match the second cron in `wrangler.toml` |
| `TZ` | `America/Sao_Paulo` | Time zone used in messages |
| `USER_AGENT` | `universal-monitor/1.0 (uptime check)` | UA sent to the sites |
