import ADMIN_HTML from "./admin.html";

export interface Env {
  DB: D1Database;
  ADMIN_USER: string;
  ADMIN_PASS: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  HEALTHCHECKS_PING_URL?: string;
}

type Status = "up" | "down" | "unknown";

interface Site {
  id: number;
  url: string;
  name: string | null;
  status: Status;
  since: number | null;
  last_check: number | null;
  last_code: number | null;
  last_error: string | null;
  created_at: number;
}

interface CheckResult {
  up: boolean;
  code: number | null;
  error: string | null;
  detail: string;
  ms: number;
}

interface RunSummary {
  ok: boolean;
  checked: number;
  up: number;
  down: number;
  alerts: number;
  error?: string;
}

const CHECK_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
const DAILY_CRON = "0 1 * * *";
const TZ = "America/Sao_Paulo";
const USER_AGENT = "universal-monitor/1.0 (uptime check)";

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === DAILY_CRON) {
      ctx.waitUntil(dailyReport(env));
    } else {
      ctx.waitUntil(runChecks(env));
    }
  },
  async fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

async function runChecks(env: Env): Promise<RunSummary> {
  let sites: Site[];
  try {
    sites = await listSites(env.DB);
  } catch (err) {
    const msg = errMsg(err);
    console.error("D1 read failed", msg);
    await notify(
      env,
      `⚠️ <b>Database (D1) did not respond</b>\n<code>${esc(msg)}</code>\nThe monitor could not read the site list.`,
    );
    await pingHealthchecks(env, "fail");
    return { ok: false, checked: 0, up: 0, down: 0, alerts: 1, error: msg };
  }

  const summary = await processSites(env, sites);
  await pingHealthchecks(env, summary.ok ? "ok" : "fail");
  return summary;
}

// Checks the given sites, persists the new state and sends alerts on transitions.
async function processSites(env: Env, sites: Site[]): Promise<RunSummary> {
  const results = await Promise.all(sites.map((s) => checkSite(s.url)));
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  const messages: string[] = [];
  let up = 0;
  let down = 0;

  sites.forEach((site, i) => {
    const r = results[i];
    const newStatus: Status = r.up ? "up" : "down";
    const changed = site.status !== newStatus;
    const since = changed ? now : (site.since ?? now);
    if (r.up) up++;
    else down++;

    statements.push(
      env.DB.prepare(
        "UPDATE sites SET status = ?, since = ?, last_check = ?, last_code = ?, last_error = ? WHERE id = ?",
      ).bind(newStatus, since, now, r.code, r.error, site.id),
    );

    if (changed && newStatus === "down") {
      messages.push(`🔴 <b>${esc(label(site))}</b> is DOWN\n${esc(site.url)}\n${esc(r.detail)}`);
    } else if (changed && newStatus === "up" && site.status === "down") {
      const downFor = site.since ? fmtDuration(now - site.since) : "an unknown time";
      messages.push(`🟢 <b>${esc(label(site))}</b> is back UP\n${esc(site.url)}\nWas down for ${esc(downFor)}.`);
    }
  });

  let ok = true;
  try {
    if (statements.length) await env.DB.batch(statements);
  } catch (err) {
    ok = false;
    const msg = errMsg(err);
    console.error("D1 write failed", msg);
    messages.push(`⚠️ <b>Failed to save state to D1</b>\n<code>${esc(msg)}</code>`);
  }

  // Sequential on purpose: Telegram rate-limits bursts.
  for (const m of messages) await notify(env, m);

  return { ok, checked: sites.length, up, down, alerts: messages.length };
}

async function checkSite(url: string): Promise<CheckResult> {
  const first = await fetchOnce(url);
  if (first.up) return first;
  await sleep(RETRY_DELAY_MS);
  return fetchOnce(url);
}

async function fetchOnce(url: string): Promise<CheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" },
      cache: "no-store",
    });
    const ms = Date.now() - started;
    // Release the connection without downloading the whole body.
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    const up = res.status < 400;
    const label = describeStatus(res.status);
    return {
      up,
      code: res.status,
      error: up ? null : label,
      detail: `${label} in ${ms}ms`,
      ms,
    };
  } catch (err) {
    const ms = Date.now() - started;
    const msg = controller.signal.aborted ? `timeout after ${CHECK_TIMEOUT_MS / 1000}s` : friendlyNetError(err);
    return { up: false, code: null, error: msg, detail: msg, ms };
  } finally {
    clearTimeout(timer);
  }
}

async function dailyReport(env: Env): Promise<void> {
  let sites: Site[];
  try {
    sites = await listSites(env.DB);
  } catch (err) {
    await notify(
      env,
      `⚠️ <b>Daily report</b>: database (D1) did not respond.\n<code>${esc(errMsg(err))}</code>`,
    );
    return;
  }

  const now = Date.now();
  const time = fmtTime(now);
  const down = sites.filter((s) => s.status === "down");
  let msg: string;
  if (sites.length === 0) {
    msg = `ℹ️ <b>${time}</b> — monitor alive, but no sites registered.`;
  } else if (down.length === 0) {
    msg = `✅ <b>${time}</b> — all good. ${sites.length} site(s) up, monitor alive.`;
  } else {
    const lines = down.map(
      (s) => `🔴 ${esc(label(s))} (down for ${esc(s.since ? fmtDuration(now - s.since) : "?")})`,
    );
    msg = `⚠️ <b>${time}</b> — ${down.length} of ${sites.length} site(s) down:\n${lines.join("\n")}`;
  }
  await notify(env, msg);
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

async function notify(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.error("Telegram not configured; message dropped:", text);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.error("Telegram error", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error("Telegram request failed", errMsg(err));
    return false;
  }
}

async function pingHealthchecks(env: Env, kind: "ok" | "fail"): Promise<void> {
  const base = env.HEALTHCHECKS_PING_URL?.replace(/\/+$/, "");
  if (!base) return;
  const url = kind === "fail" ? `${base}/fail` : base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(url, { method: "POST", signal: controller.signal, headers: { "User-Agent": USER_AGENT } });
  } catch (err) {
    console.error("healthchecks ping failed", errMsg(err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// HTTP: admin panel + API (all behind Basic auth)
// ---------------------------------------------------------------------------

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") return Response.redirect(new URL("/admin", url).toString(), 302);

  if (!authorized(request, env)) {
    return new Response("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="universal-monitor", charset="UTF-8"' },
    });
  }

  try {
    if (path === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/api/sites" && request.method === "GET") {
      return json({ sites: await listSites(env.DB), now: Date.now() });
    }

    if (path === "/api/sites" && request.method === "POST") {
      return addSite(request, env);
    }

    const del = path.match(/^\/api\/sites\/(\d+)$/);
    if (del && request.method === "DELETE") {
      const id = Number(del[1]);
      const r = await env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id).run();
      if (!r.meta.changes) return json({ error: "Site not found" }, 404);
      return json({ ok: true });
    }

    if (path === "/api/check" && request.method === "POST") {
      return json(await runChecks(env));
    }

    if (path === "/api/test-telegram" && request.method === "POST") {
      const sent = await notify(env, `🧪 universal-monitor test at ${fmtTime(Date.now())}. If you can read this, Telegram works.`);
      return json({ ok: sent, configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) });
    }

    if (path === "/api/config" && request.method === "GET") {
      return json({
        telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        healthchecks: Boolean(env.HEALTHCHECKS_PING_URL),
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("request failed", errMsg(err));
    return json({ error: errMsg(err) }, 500);
  }
}

async function addSite(request: Request, env: Env): Promise<Response> {
  let body: { url?: unknown; name?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return json({ error: "Invalid URL. Use http:// or https://" }, 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return json({ error: "Only http:// or https:// are allowed" }, 400);
  }

  const now = Date.now();
  try {
    await env.DB.prepare("INSERT INTO sites (url, name, status, created_at) VALUES (?, ?, 'unknown', ?)")
      .bind(parsed.toString(), name, now)
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(errMsg(err))) return json({ error: "URL already registered" }, 409);
    throw err;
  }

  // Check the new site right away so the panel shows a real status (and alerts if it is already down).
  const site = await env.DB.prepare("SELECT * FROM sites WHERE url = ?").bind(parsed.toString()).first<Site>();
  if (site) await processSites(env, [site]);
  const fresh = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(site?.id).first<Site>();
  return json({ site: fresh }, 201);
}

function authorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_USER || !env.ADMIN_PASS) return false;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  // Evaluate both so timing does not reveal which one failed.
  const userOk = safeEqual(user, env.ADMIN_USER);
  const passOk = safeEqual(pass, env.ADMIN_PASS);
  return userOk && passOk;
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listSites(db: D1Database): Promise<Site[]> {
  const { results } = await db.prepare("SELECT * FROM sites ORDER BY created_at ASC").all<Site>();
  return results;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function label(site: Site): string {
  return site.name || site.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Cloudflare's network answers some connection failures with its own 52x/530 codes.
function describeStatus(code: number): string {
  switch (code) {
    case 530:
      return "HTTP 530 (DNS does not resolve / origin does not exist)";
    case 521:
      return "HTTP 521 (origin refused the connection)";
    case 522:
      return "HTTP 522 (connection timed out)";
    case 523:
      return "HTTP 523 (origin unreachable)";
    case 525:
    case 526:
      return `HTTP ${code} (SSL certificate error)`;
    default:
      return `HTTP ${code}`;
  }
}

// Workers report DNS/TLS/connect failures with opaque internal messages; translate the common ones.
function friendlyNetError(err: unknown): string {
  const raw = errMsg(err);
  if (/lookup address|ENOTFOUND|getaddrinfo|internal error/i.test(raw)) return "no response (DNS failure or connection refused)";
  if (/certificate|TLS|SSL/i.test(raw)) return `TLS/certificate error: ${raw.slice(0, 100)}`;
  return `connection error: ${raw.slice(0, 120)}`;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "less than 1 min";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}min` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
}

function fmtTime(ts: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}
