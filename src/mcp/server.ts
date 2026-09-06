// One HTTP listener per Golem process. Per agent it serves:
//   /agents/<name>/mcp      Streamable-HTTP MCP endpoint (the mind's tools)
//   /agents/<name>/inbox    POST {text, from?, kind?, priority?}   push into the inbox (bridge)
//   /agents/<name>/say      POST {text}                             speak in game (bridge)
//   /agents/<name>/status   GET                                     one-line state (bridge)
//   /agents/<name>/events   GET  text/event-stream                  live transcript + events (bridge)
// All routes require `Authorization: Bearer <agent mcp token>`. Bound to 127.0.0.1 by default.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { Drive } from "../drive/drive.ts";
import { GolemError } from "../primitives/errors.ts";
import { makeLog, type Logger } from "../util/log.ts";
import { ALL_TOOLS, type ToolCtx } from "./tools.ts";
import type { ShemEngine } from "../shem/engine.ts";

export interface HostedAgent {
  rt: AgentRuntime;
  drive: Drive;
  shem?: ShemEngine;
  token: string;
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
  private server: Server | undefined;
  private readonly log: Logger;

  constructor(bind: string, log?: Logger) {
    const i = bind.lastIndexOf(":");
    this.host = i > 0 ? bind.slice(0, i) : "127.0.0.1";
    this.port = Number(bind.slice(i + 1)) || 8770;
    this.log = log ?? makeLog("http");
  }

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
    await new Promise<void>((r) => this.server ? this.server.close(() => r()) : r());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    const m = /^\/agents\/([^/]+)\/(mcp|inbox|say|status|events)$/.exec(url.pathname);
    if (!m) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    const name = decodeURIComponent(m[1]!);
    const route = m[2]!;
    const hosted = this.agents.get(name);
    if (!hosted) { res.writeHead(404, { "content-type": "text/plain" }); res.end(`no agent ${name}`); return; }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${hosted.token}`) { res.writeHead(401, { "content-type": "text/plain" }); res.end("unauthorized"); return; }
    switch (route) {
      case "mcp": return this.handleMcp(req, res, name, hosted);
      case "inbox": return this.handleInbox(req, res, hosted);
      case "say": return this.handleSay(req, res, hosted);
      case "status": { res.writeHead(200, { "content-type": "text/plain" }); res.end(hosted.drive.stateHeader() + "\n"); return; }
      case "events": return this.handleEvents(req, res, hosted);
    }
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

  private handleEvents(req: IncomingMessage, res: ServerResponse, hosted: HostedAgent): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify({ t: Date.now(), state: hosted.drive.stateHeader() })}\n\n`);
    const off = hosted.subscribe((ev) => { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => { off(); clearInterval(ping); });
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
