// Self-hosted backend for the finance dashboard.
// - Talks to Era Context over MCP (OAuth 2.1, one-time browser login), keeps tokens in SQLite.
// - Syncs transactions into SQLite on a timer so page loads don't spend Era MCP calls.
// - Serves the same web/index.html the claude.ai artifact uses, plus a shim that maps
//   window.claude.use("mcp" | "db" | "sample") onto this server's /api routes.
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
// Only this machine by default; Tailscale Serve / Docker port mapping forward to it.
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
const ERA_MCP_URL = process.env.ERA_MCP_URL || "https://context.era.app/mcp";
const SYNC_HOURS = Number(process.env.SYNC_HOURS || 6);
const HISTORY_START = process.env.HISTORY_START || "2026-04-01";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const ERA_SCOPES = process.env.ERA_SCOPES || "";  // optional: space-separated scopes to request from Era
const MANUAL_REFRESH_MINUTES = 30;

/* ---------- storage ---------- */
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "dashboard.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS docs (coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (coll, id));
  CREATE TABLE IF NOT EXISTS tx (id TEXT PRIMARY KEY, account_group_key TEXT, date TEXT, raw TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS tx_date ON tx(date);
`);
const kvGet = (k) => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? JSON.parse(r.v) : undefined; };
const kvSet = (k, v) => v === undefined
  ? db.prepare("DELETE FROM kv WHERE k=?").run(k)
  : db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v));

// Seed perks/offers on first run (same documents the claude.ai artifact holds).
if (!db.prepare("SELECT 1 FROM docs LIMIT 1").get()) {
  const dir = join(ROOT, "seed");
  for (const f of readdirSync(dir)) {
    const m = f.match(/^(perks|offers|meta)__(.+)\.json$/);
    if (!m) continue;
    db.prepare("INSERT INTO docs(coll,id,data,updated_at) VALUES(?,?,?,?)").run(m[1], m[2], readFileSync(join(dir, f), "utf8"), new Date().toISOString());
  }
}

/* ---------- Era Context over MCP ---------- */
class EraAuth {
  pendingUrl = null;
  get redirectUrl() { return `${PUBLIC_URL}/auth/callback`; }
  get clientMetadata() {
    return { client_name: "Finance Dashboard (self-hosted)", redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      ...(ERA_SCOPES ? { scope: ERA_SCOPES } : {}) };
  }
  state() { const s = randomBytes(16).toString("hex"); kvSet("oauth_state", s); return s; }
  clientInformation() {
    // A client registered for another PUBLIC_URL can't complete login here; register again.
    const c = kvGet("oauth_client");
    return c && Array.isArray(c.redirect_uris) && !c.redirect_uris.includes(this.redirectUrl) ? undefined : c;
  }
  saveClientInformation(c) { kvSet("oauth_client", c); }
  tokens() { return kvGet("oauth_tokens"); }
  saveTokens(t) { kvSet("oauth_tokens", t); }
  redirectToAuthorization(url) { this.pendingUrl = url.toString(); }
  saveCodeVerifier(v) { kvSet("oauth_verifier", v); }
  codeVerifier() { return kvGet("oauth_verifier"); }
  discoveryState() { return kvGet("oauth_discovery"); }
  saveDiscoveryState(s) { kvSet("oauth_discovery", s); }
  invalidateCredentials(scope) {
    if (scope === "all" || scope === "tokens") kvSet("oauth_tokens", undefined);
    if (scope === "all" || scope === "client") kvSet("oauth_client", undefined);
    if (scope === "all" || scope === "verifier") kvSet("oauth_verifier", undefined);
    if (scope === "all" || scope === "discovery") kvSet("oauth_discovery", undefined);
  }
}
const auth = new EraAuth();
let client = null, transport = null, toolNames = {};

async function connect() {
  if (client) return client;
  transport = new StreamableHTTPClientTransport(new URL(ERA_MCP_URL), { authProvider: auth });
  const c = new Client({ name: "finance-dashboard", version: "1.0.0" });
  try {
    await c.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) { const err = new Error("needs_login"); err.code = "needs_login"; throw err; }
    throw e;
  }
  // Resolve tool names by suffix so a renamed prefix on Era's side doesn't break us.
  const { tools } = await c.listTools();
  for (const want of ["list_transactions", "list_financial_accounts"]) {
    const t = tools.find(t => t.name === want || t.name.endsWith("__" + want) || t.name.endsWith("." + want));
    if (t) toolNames[want] = t.name;
  }
  client = c;
  return c;
}
function reset() { try { client && client.close(); } catch {} client = null; transport = null; }

async function callEra(tool, args) {
  const c = await connect();
  const name = toolNames[tool];
  if (!name) throw new Error(`Era Context 没有 ${tool} 工具`);
  let r;
  try { r = await c.callTool({ name, arguments: args }); }
  catch (e) { if (e instanceof UnauthorizedError) { reset(); const err = new Error("needs_login"); err.code = "needs_login"; throw err; } throw e; }
  if (r.isError) throw new Error((r.content || []).map(x => x.text).join(" ") || "Era tool error");
  if (r.structuredContent) return r.structuredContent;
  const text = (r.content || []).find(x => x.type === "text");
  return text ? JSON.parse(text.text) : {};
}

/* ---------- sync ---------- */
const iso = d => d.toISOString().slice(0, 10);
let syncing = null;
async function sync({ full = false } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    const accounts = (await callEra("list_financial_accounts", {})).accounts || [];
    kvSet("accounts", accounts);
    const cards = new Set(accounts.filter(a => a.type === "CreditCard").map(a => a.account_group_key));
    const last = kvGet("last_sync");
    const from = full || !last ? HISTORY_START : iso(new Date(Date.now() - 14 * 864e5));
    const ins = db.prepare("INSERT INTO tx(id,account_group_key,date,raw) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_group_key=excluded.account_group_key, date=excluded.date, raw=excluded.raw");
    let page = 1, pages = 1, n = 0;
    do {
      const p = await callEra("list_transactions", { from_date: from, page_size: 100, page, include_pending: true });
      for (const t of p.transactions || []) {
        if (!cards.has(t.account_group_key)) continue;
        ins.run(t.transaction_id, t.account_group_key, t.transaction_date, JSON.stringify(t)); n++;
      }
      pages = (p.pagination && p.pagination.total_pages) || 1;
      page++;
    } while (page <= pages && page <= 60);
    // Pending rows that have since settled come back with a new id; drop stale pending rows.
    db.prepare("DELETE FROM tx WHERE date < ? AND json_extract(raw,'$.is_pending') = 1").run(iso(new Date(Date.now() - 8 * 864e5)));
    kvSet("last_sync", new Date().toISOString());
    console.log(`[sync] ${n} card transactions since ${from}`);
  })().finally(() => { syncing = null; });
  return syncing;
}
async function scheduledSync() {
  try { await sync(); } catch (e) { console.error("[sync]", e.code || e.message); }
}
setInterval(scheduledSync, SYNC_HOURS * 3600e3);
setTimeout(scheduledSync, 3000);

/* ---------- http ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
const fail = (res, e) => res.status(e.code === "needs_login" ? 401 : 502).json({ code: e.code === "needs_login" ? "needs_reauth" : "upstream_error", message: e.message });

app.get("/auth/start", async (req, res) => {
  reset(); auth.pendingUrl = null;
  try { await connect(); return res.redirect("/"); }
  catch (e) {
    if (auth.pendingUrl) return res.redirect(auth.pendingUrl);
    res.status(502).send("连接 Era Context 失败：" + e.message);
  }
});
app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send("Era 登录被拒绝：" + error);
  if (!code || (kvGet("oauth_state") && state !== kvGet("oauth_state"))) return res.status(400).send("登录回调参数不对，请重新从 /auth/start 开始。");
  try {
    if (!transport) transport = new StreamableHTTPClientTransport(new URL(ERA_MCP_URL), { authProvider: auth });
    await transport.finishAuth(String(code));
    reset();
    await connect();
    sync({ full: !kvGet("last_sync") }).catch(e => console.error("[sync]", e.message));
    res.redirect("/");
  } catch (e) { res.status(502).send("换取 Era 登录凭证失败：" + e.message); }
});
app.get("/api/status", (req, res) => res.json({ loggedIn: !!kvGet("oauth_tokens"), lastSync: kvGet("last_sync") || null, advice: !!ANTHROPIC_API_KEY }));
app.post("/api/refresh", async (req, res) => {
  const last = kvGet("last_sync");
  if (last && Date.now() - Date.parse(last) < MANUAL_REFRESH_MINUTES * 60e3) return res.json({ skipped: true, lastSync: last });
  try { await sync(); res.json({ lastSync: kvGet("last_sync") }); } catch (e) { fail(res, e); }
});

// Same payload shapes as Era's own tools, served from the local copy.
app.post("/api/era/:tool", async (req, res) => {
  const tool = req.params.tool.replace(/^.*__/, "");
  try {
    if (!kvGet("last_sync")) { if (!kvGet("oauth_tokens")) return fail(res, Object.assign(new Error("还没登录 Era"), { code: "needs_login" })); await sync({ full: true }); }
    if (tool === "list_financial_accounts") return res.json({ accounts: kvGet("accounts") || [], as_of: kvGet("last_sync") });
    if (tool === "list_transactions") {
      const a = req.body || {};
      const rows = db.prepare(`SELECT raw FROM tx WHERE date >= ? AND date <= ? ${a.account_group_key ? "AND account_group_key = ?" : ""} ORDER BY date DESC`)
        .all(...[a.from_date || HISTORY_START, a.to_date || "9999-12-31", ...(a.account_group_key ? [a.account_group_key] : [])]);
      const txs = rows.map(r => JSON.parse(r.raw));
      return res.json({ transactions: txs, pagination: { current_page: 1, page_size: txs.length, total_items: txs.length, total_pages: 1, has_more: false } });
    }
    res.status(400).json({ code: "bad_request", message: "unknown tool" });
  } catch (e) { fail(res, e); }
});

// Minimal document store mirroring the artifact's db collections.
const okSeg = s => /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s) && s !== "." && s !== "..";
app.get("/api/db/:coll", (req, res) => {
  if (!okSeg(req.params.coll)) return res.status(400).end();
  res.json(db.prepare("SELECT id, data FROM docs WHERE coll=?").all(req.params.coll).map(r => ({ id: r.id, data: JSON.parse(r.data) })));
});
app.get("/api/db/:coll/:id", (req, res) => {
  const r = db.prepare("SELECT data FROM docs WHERE coll=? AND id=?").get(req.params.coll, req.params.id);
  res.json(r ? { id: req.params.id, data: JSON.parse(r.data) } : { id: req.params.id, data: null });
});
app.put("/api/db/:coll/:id", (req, res) => {
  if (!okSeg(req.params.coll) || !okSeg(req.params.id)) return res.status(400).end();
  db.prepare("INSERT INTO docs(coll,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(coll,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at")
    .run(req.params.coll, req.params.id, JSON.stringify(req.body || {}), new Date().toISOString());
  res.json({ ok: true });
});
app.delete("/api/db/:coll/:id", (req, res) => { db.prepare("DELETE FROM docs WHERE coll=? AND id=?").run(req.params.coll, req.params.id); res.json({ ok: true }); });

// Advice: one non-streaming Claude call.
app.post("/api/advice", async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(501).json({ code: "not_granted", message: "没有设置 ANTHROPIC_API_KEY" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 1500, messages: [{ role: "user", content: String(req.body.prompt || "") }] })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ code: r.status === 429 ? "rate_limited" : "upstream_error", message: j.error?.message || r.statusText });
    res.json({ text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join("") });
  } catch (e) { res.status(502).json({ code: "upstream_error", message: e.message }); }
});

// The page: shared web/index.html wrapped in a document, with the shim loaded first.
const page = () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style><script src="/selfhost-shim.js"></script></head><body>${readFileSync(join(ROOT, "web/index.html"), "utf8")}</body></html>`;
app.get("/", (req, res) => res.type("html").send(page()));
app.get("/selfhost-shim.js", (req, res) => res.sendFile(join(ROOT, "web/selfhost-shim.js")));

app.listen(PORT, HOST, () => console.log(`finance dashboard on ${PUBLIC_URL} (listening ${HOST}:${PORT})`));
