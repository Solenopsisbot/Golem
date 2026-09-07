// One HTTP listener per Golem process. Per agent it serves:
//   /agents/<name>/mcp      Streamable-HTTP MCP endpoint (the mind's tools)
//   /agents/<name>/inbox    POST {text, from?, kind?, priority?}   push into the inbox (bridge)
//   /agents/<name>/say      POST {text}                             speak in game (bridge)
//   /agents/<name>/status   GET                                     one-line state (bridge)
//   /agents/<name>/events   GET  text/event-stream                  live transcript + events (bridge)
//   /agents/<name>/dash     GET  the dashboard page (token in ?token=, remembered by the page)
//   /agents/<name>/runs, /reflexes (GET/POST), /inbox (GET), /transcript, /shot, /met   dashboard data
//   /dash                   GET  the fleet page: every agent, the bus, the shared files
//   /fleet/status|bus|shared|events   fleet data (any agent's token works)
// All routes require `Authorization: Bearer <agent mcp token>` (or ?token= on GET, for the browser).
// Bound to 127.0.0.1 by default.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Drive } from "../drive/drive.ts";
import { GolemError } from "../primitives/errors.ts";
import { makeLog, type Logger } from "../util/log.ts";
import { ALL_TOOLS, type ToolCtx } from "./tools.ts";
import type { ShemEngine } from "../shem/engine.ts";
import type { AgentBus, BusMessage } from "../comms/bus.ts";

export interface HostedAgent {
  rt: AgentRuntime;
  drive: Drive;
  shem?: ShemEngine;
  token: string;
  transcriptPath?: string;
  /** Subscribe to bridge events (transcript lines, inbox pushes). Returns unsubscribe. */
  subscribe(listener: (ev: BridgeEvent) => void): () => void;
}

export interface BridgeEvent { t: number; type: string; [k: string]: unknown }

interface Session { transport: StreamableHTTPServerTransport; server: McpServer }

export class GolemHttpHost {
  readonly host: string;
  readonly port: number;
  private readonly agents = new Map<string, HostedAgent>();
  private readonly sessions = new Map<string, Session>();
  private readonly streams = new Set<ServerResponse>();
  private server: Server | undefined;
  private readonly log: Logger;

  constructor(bind: string, log?: Logger) {
    const i = bind.lastIndexOf(":");
    this.host = i > 0 ? bind.slice(0, i) : "127.0.0.1";
    this.port = Number(bind.slice(i + 1)) || 8770;
    this.log = log ?? makeLog("http");
  }

  /** Fleet-wide things the fleet page shows: the agent bus and the shared world dir. Set by `golem up`. */
  private fleet: { bus?: AgentBus; sharedWorldDir?: string } = {};
  setFleet(f: { bus?: AgentBus; sharedWorldDir?: string }): void { this.fleet = f; }

  register(name: string, hosted: HostedAgent): void { this.agents.set(name, hosted); }
  unregister(name: string): void { this.agents.delete(name); }
  mcpUrl(name: string): string { return `http://${this.host}:${this.port}/agents/${encodeURIComponent(name)}/mcp`; }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => { void this.handle(req, res).catch((e) => { this.log.error(`request failed: ${(e as Error).message}`); if (!res.headersSent) { res.writeHead(500); res.end("error"); } }); });
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => { this.log.info(`listening on http://${this.host}:${this.port}`); resolve(); });
    });
  }
  async stop(): Promise<void> {
    for (const s of this.sessions.values()) { try { await s.transport.close(); } catch { /* fine */ } }
    this.sessions.clear();
    // Long-lived SSE responses (the dashboard) would keep close() from ever calling back.
    for (const res of this.streams) { try { res.end(); } catch { /* fine */ } }
    this.streams.clear();
    this.server?.closeAllConnections();
    await new Promise<void>((r) => { if (!this.server) return r(); const t = setTimeout(r, 2000); this.server.close(() => { clearTimeout(t); r(); }); });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    if (url.pathname === "/" || url.pathname === "/agents") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset=utf-8><title>Golem</title><body style="font:14px system-ui;background:#141518;color:#e6e6e6;padding:2em"><h1 style="color:#c9a227">Golem</h1><p><a style="color:#7fb3ff" href="/dash">fleet dashboard</a> (add <code>?token=</code> from any agent's <code>data/&lt;name&gt;/tokens.json</code>)</p><ul>${[...this.agents.keys()].map((n) => `<li><a style="color:#7fb3ff" href="/agents/${encodeURIComponent(n)}/dash">${n}</a></li>`).join("")}</ul></body>`);
      return;
    }
    if (url.pathname === "/dash") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fleetHtml()); return; }
    const fm = /^\/fleet\/(status|bus|shared|events)$/.exec(url.pathname);
    if (fm) {
      if (!this.fleetAuthed(req, url)) { res.writeHead(401, { "content-type": "text/plain" }); res.end("unauthorized"); return; }
      return this.handleFleet(fm[1]!, req, res);
    }
    const m = /^\/agents\/([^/]+)\/(mcp|inbox|say|status|events|dash|runs|reflexes|transcript|shot|met)$/.exec(url.pathname);
    if (!m) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    const name = decodeURIComponent(m[1]!);
    const route = m[2]!;
    const hosted = this.agents.get(name);
    if (!hosted) { res.writeHead(404, { "content-type": "text/plain" }); res.end(`no agent ${name}`); return; }
    const auth = req.headers.authorization ?? "";
    const queryToken = url.searchParams.get("token");
    const authed = auth === `Bearer ${hosted.token}` || (req.method === "GET" && queryToken === hosted.token);
    if (route === "dash") {
      // The page itself is public (it holds no secrets); everything it fetches needs the token.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(dashboardHtml());
      return;
    }
    if (!authed) { res.writeHead(401, { "content-type": "text/plain" }); res.end("unauthorized"); return; }
    switch (route) {
      case "mcp": return this.handleMcp(req, res, name, hosted);
      case "inbox": return req.method === "GET" ? this.json(res, hosted.drive.inbox.snapshot().map((i) => ({ id: i.id, t: i.t, kind: i.kind, priority: i.priority, from: i.from, text: i.text }))) : this.handleInbox(req, res, hosted);
      case "say": return this.handleSay(req, res, hosted);
      case "status": { res.writeHead(200, { "content-type": "text/plain" }); res.end(hosted.drive.stateHeader() + "\n"); return; }
      case "events": return this.handleEvents(req, res, hosted);
      case "runs": return this.json(res, (hosted.shem?.runs.list() ?? []).slice(0, 20).map((r) => ({ id: r.id, label: r.label, script: r.script, priority: r.priority, background: r.background, status: r.status, current: r.current, startedAt: r.startedAt, endedAt: r.endedAt })));
      case "reflexes": {
        if (req.method === "POST") {
          const b = (await this.readJson(req)) as { name?: string; on?: boolean } | undefined;
          if (!b?.name) { res.writeHead(400); res.end("name required"); return; }
          try { hosted.rt.reflexes.enable(b.name, b.on !== false); } catch (e) { res.writeHead(404); res.end((e as Error).message); return; }
        }
        return this.json(res, hosted.rt.reflexes.list());
      }
      case "transcript": {
        const limit = Number(url.searchParams.get("limit") ?? 150);
        if (!hosted.transcriptPath || !existsSync(hosted.transcriptPath)) return this.json(res, []);
        const lines = readFileSync(hosted.transcriptPath, "utf8").trim().split("\n").slice(-limit);
        return this.json(res, lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      }
      case "shot": {
        const dir = hosted.rt.agent.shotsDir;
        if (url.searchParams.get("fresh")) {
          try { const r = await hosted.rt.p.screenshot({ width: 960, height: 540 }); res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(r.png); return; }
          catch (e) { res.writeHead(500, { "content-type": "text/plain" }); res.end((e as Error).message); return; }
        }
        const latest = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).map((f) => ({ f, t: statSync(resolve(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0] : undefined;
        if (!latest) { res.writeHead(404, { "content-type": "text/plain" }); res.end("no screenshot yet"); return; }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(readFileSync(resolve(dir, latest.f)));
        return;
      }
      case "met": { await hosted.rt.met(); await hosted.drive.mindCancel(); return this.json(res, { ok: true }); }
    }
  }

  private json(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse, name: string, hosted: HostedAgent): Promise<void> {
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    const body = req.method === "POST" ? await this.readJson(req) : undefined;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      if (req.method !== "POST" || !isInitialize(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "no session; send initialize first" }, id: null }));
        return;
      }
      const server = buildMcpServer(name, hosted);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { this.sessions.set(id, { transport, server }); this.log.info(`${name}: mcp session ${id}`); },
      });
      transport.onclose = () => { if (transport.sessionId) this.sessions.delete(transport.sessionId); };
      await server.connect(transport);
      session = { transport, server };
    }
    await session.transport.handleRequest(req, res, body);
  }

  private async handleInbox(req: IncomingMessage, res: ServerResponse, hosted: HostedAgent): Promise<void> {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const b = (await this.readJson(req)) as { text?: string; from?: string; kind?: string; priority?: number } | undefined;
    if (!b?.text) { res.writeHead(400, { "content-type": "text/plain" }); res.end("text required"); return; }
    const item = hosted.drive.pushExternal({ text: b.text, from: b.from, kind: b.kind, priority: b.priority });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: item.id }));
  }

  private async handleSay(req: IncomingMessage, res: ServerResponse, hosted: HostedAgent): Promise<void> {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    const b = (await this.readJson(req)) as { text?: string } | undefined;
    if (!b?.text) { res.writeHead(400, { "content-type": "text/plain" }); res.end("text required"); return; }
    try {
      const r = await hosted.rt.p.say(b.text);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, sent: r.sent }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  }

  /** Any registered agent's token opens the fleet views: whoever runs one golem runs the fleet. */
  private fleetAuthed(req: IncomingMessage, url: URL): boolean {
    const auth = req.headers.authorization ?? "";
    const q = req.method === "GET" ? url.searchParams.get("token") : null;
    for (const h of this.agents.values()) if (auth === `Bearer ${h.token}` || (q && q === h.token)) return true;
    return false;
  }

  private agentRows(): { name: string; state: string; dash: string }[] {
    return [...this.agents.entries()].map(([name, h]) => ({ name, state: h.drive.stateHeader().split("\n")[0]!.replace(/^\[state\]\s*/, ""), dash: `/agents/${encodeURIComponent(name)}/dash?token=${encodeURIComponent(h.token)}` }));
  }

  private handleFleet(route: string, req: IncomingMessage, res: ServerResponse): void {
    switch (route) {
      case "status": return this.json(res, { agents: this.agentRows(), bus: !!this.fleet.bus, shared: !!this.fleet.sharedWorldDir });
      case "bus": return this.json(res, (this.fleet.bus?.log ?? []).slice(-150));
      case "shared": {
        const dir = this.fleet.sharedWorldDir;
        const read = (f: string) => { try { return dir ? readFileSync(resolve(dir, f), "utf8") : ""; } catch { return ""; } };
        return this.json(res, { tasks: read("tasks.md"), places: read("places.md"), chests: read("chests.md") });
      }
      case "events": {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        this.streams.add(res);
        const send = (type: string, data: unknown) => { try { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } };
        send("hello", { t: Date.now(), agents: this.agentRows() });
        const offs = [...this.agents.entries()].map(([name, h]) => h.subscribe((ev) => send(ev.type, { ...ev, agent: name })));
        let busSeen = this.fleet.bus?.log.length ?? 0;
        const tick = setInterval(() => {
          send("state", { t: Date.now(), agents: this.agentRows() });
          const log = this.fleet.bus?.log ?? [];
          for (const m of log.slice(busSeen)) send("bus", m as BusMessage);
          busSeen = log.length;
        }, 3000);
        req.on("close", () => { for (const off of offs) off(); clearInterval(tick); this.streams.delete(res); });
        return;
      }
    }
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, hosted: HostedAgent): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now(), state: hosted.drive.stateHeader() })}\n\n`);
    this.streams.add(res);
    const off = hosted.subscribe((ev) => { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { off(); clearInterval(ping); this.streams.delete(res); });
  }
}

function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => m && typeof m === "object" && (m as { method?: string }).method === "initialize");
}

function buildMcpServer(name: string, hosted: HostedAgent): McpServer {
  const server = new McpServer({ name: `golem-${name}`, version: "0.0.1" });
  const tc: ToolCtx = { rt: hosted.rt, drive: hosted.drive, shem: hosted.shem, get p() { return hosted.rt.p; } };
  for (const t of ALL_TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args: Record<string, unknown>) => {
      const t0 = Date.now();
      hosted.rt.trace.mark("tool", { name: t.name, args });
      try {
        const r = await t.run(args as never, tc);
        hosted.drive.noteToolCall(t.name, args, r.text, Date.now() - t0);
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: r.text }];
        if (r.image) content.push({ type: "image", data: r.image.data.toString("base64"), mimeType: r.image.mimeType });
        return { content };
      } catch (e) {
        const msg = e instanceof GolemError ? `${e.kind}: ${e.message}` : `error: ${(e as Error).message ?? String(e)}`;
        hosted.drive.noteToolCall(t.name, args, msg, Date.now() - t0, true);
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    });
  }
  server.registerResource("status", `golem://${name}/status`, { description: "Current state line" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: hosted.drive.stateHeader() }] }));
  server.registerResource("inbox", `golem://${name}/inbox`, { description: "Unread inbox" }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: hosted.drive.peekInbox() }] }));
  return server;
}

let fleetCache: string | undefined;
function fleetHtml(): string {
  if (!fleetCache || process.env.GOLEM_DEV) fleetCache = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../dashboard/fleet.html"), "utf8");
  return fleetCache;
}

let dashboardCache: string | undefined;
function dashboardHtml(): string {
  if (!dashboardCache || process.env.GOLEM_DEV) {
    dashboardCache = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../dashboard/index.html"), "utf8");
  }
  return dashboardCache;
}
