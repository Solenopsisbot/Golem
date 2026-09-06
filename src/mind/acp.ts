// The mind: an ACP agent subprocess (Claude Code via @agentclientprotocol/claude-agent-acp by
// default) driven as a long-lived session. Golem is the ACP client: it answers permission requests
// by policy, serves file reads/writes inside a workspace jail, and runs prompt turns one at a time.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentConfig } from "../config/schema.ts";
import type { Logger } from "../util/log.ts";

type SessionUpdate = acp.SessionUpdate;
type ContentBlock = acp.ContentBlock;
type StopReason = acp.StopReason;
type Usage = acp.Usage;

export interface MindFs {
  read(path: string, line?: number | null, limit?: number | null): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface MindOptions {
  agent: AgentConfig;
  log: Logger;
  cwd: string;
  mcp: { name: string; url: string; token: string };
  fs: MindFs;
  onUpdate: (update: SessionUpdate) => void;
  onExit?: (code: number | null) => void;
}

export interface TurnResult { stopReason: StopReason; text: string; usage?: Usage | null }

interface SavedSession { sessionId: string; command: string; args: string[]; savedAt: number }

const PERMISSION_PREFERENCE: acp.PermissionOptionKind[] = ["allow_always", "allow_once", "reject_once", "reject_always"];

export class Mind {
  readonly opts: MindOptions;
  private readonly log: Logger;
  private child: ChildProcess | undefined;
  private session: acp.ActiveSession | undefined;
  private ctx: acp.ClientContext | undefined;
  caps: acp.AgentCapabilities = {};
  /** True when start() resumed a previous session instead of opening a fresh one. */
  resumed = false;
  private turn: Promise<TurnResult> | null = null;
  private stopping = false;
  private releaseConnection: (() => void) | undefined;
  private connectionDone: Promise<unknown> | undefined;

  constructor(opts: MindOptions) {
    this.opts = opts;
    this.log = opts.log;
  }

  get busy(): boolean { return this.turn !== null; }
  get sessionId(): string | undefined { return this.session?.sessionId; }
  get supportsImages(): boolean { return !!this.caps.promptCapabilities?.image; }

  /** Spawn the agent, initialise, open the session, set the permission mode. */
  async start(): Promise<void> {
    const { agent, cwd } = this.opts;
    mkdirSync(agent.dataDir, { recursive: true });
    const errLog = openSync(resolve(agent.dataDir, "mind.log"), "a");
    const child = spawn(agent.mind.command, agent.mind.args, {
      cwd,
      env: { ...process.env, ...agent.mind.env },
      stdio: ["pipe", "pipe", errLog],
    });
    this.child = child;
    child.on("exit", (code, sig) => {
      this.log.warn(`mind process exited (${code ?? sig})`);
      this.session = undefined;
      this.releaseConnection?.();
      if (!this.stopping) this.opts.onExit?.(code);
    });
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    let ready!: () => void;
    let failed!: (e: unknown) => void;
    const readyP = new Promise<void>((res, rej) => { ready = res; failed = rej; });
    const hold = new Promise<void>((res) => { this.releaseConnection = res; });

    this.connectionDone = acp.client({ name: "golem" })
      .onRequest(acp.methods.client.session.requestPermission, (c) => this.onPermission(c.params))
      .onRequest(acp.methods.client.fs.readTextFile, async (c) => ({ content: await this.opts.fs.read(c.params.path, c.params.line, c.params.limit) }))
      .onRequest(acp.methods.client.fs.writeTextFile, async (c) => { await this.opts.fs.write(c.params.path, c.params.content); return {}; })
      .connectWith(stream, async (ctx) => {
        try {
          this.ctx = ctx;
          const init = await ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          });
          this.caps = init.agentCapabilities ?? {};
          const mcpServers: acp.McpServer[] = [];
          if (this.caps.mcpCapabilities?.http) {
            mcpServers.push({ type: "http", name: this.opts.mcp.name, url: this.opts.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${this.opts.mcp.token}` }] });
          } else {
            this.log.warn("agent lacks http MCP support; no Golem tools will be available (stdio shim not implemented yet)");
          }
          this.session = await this.resumeOrCreate(ctx, cwd, mcpServers);
          this.log.info(`session ${this.session.sessionId}${this.resumed ? " (resumed)" : ""} (images=${this.supportsImages}, loadSession=${!!this.caps.loadSession})`);
          await this.applyMode();
          ready();
        } catch (e) {
          failed(e);
        }
        await hold;   // keep the connection open until stop()
      })
      .catch((e) => { this.log.error(`connection ended: ${(e as Error).message}`); failed(e); });

    await readyP;
  }

  private get sessionFile(): string { return resolve(this.opts.agent.dataDir, "session.json"); }

  /**
   * Reopen the previous session when the agent supports session/load and the saved id came from
   * the same agent command; otherwise start a new one. The load's history replay arrives as
   * session/update notifications before any ActiveSession is attached, so it is dropped: the agent
   * has the history, we don't need a copy.
   */
  private async resumeOrCreate(ctx: acp.ClientContext, cwd: string, mcpServers: acp.McpServer[]): Promise<acp.ActiveSession> {
    const { agent } = this.opts;
    let saved: SavedSession | null = null;
    if (existsSync(this.sessionFile)) { try { saved = JSON.parse(readFileSync(this.sessionFile, "utf8")); } catch { saved = null; } }
    const sameAgent = saved && saved.command === agent.mind.command && JSON.stringify(saved.args) === JSON.stringify(agent.mind.args);
    if (saved && sameAgent && this.caps.loadSession) {
      try {
        const resp = await ctx.request(acp.methods.agent.session.load, { sessionId: saved.sessionId, cwd, mcpServers });
        const attach = (ctx as unknown as { attachSession(r: { sessionId: string; modes?: acp.SessionModeState | null }): acp.ActiveSession }).attachSession;
        const session = attach.call(ctx, { sessionId: saved.sessionId, modes: resp?.modes ?? null });
        this.resumed = true;
        return session;
      } catch (e) {
        this.log.warn(`could not resume session ${saved.sessionId} (${(e as Error).message}); starting fresh`);
      }
    }
    const session = await ctx.buildSession({ cwd, mcpServers }).start();
    this.resumed = false;
    const record: SavedSession = { sessionId: session.sessionId, command: agent.mind.command, args: agent.mind.args, savedAt: Date.now() };
    try { writeFileSync(this.sessionFile, JSON.stringify(record, null, 2) + "\n"); } catch (e) { this.log.warn(`could not save session id: ${(e as Error).message}`); }
    return session;
  }

  private async applyMode(): Promise<void> {
    const want = this.opts.agent.mind.permission_mode.toLowerCase();
    const modes = this.session?.modes;
    if (!modes || !this.ctx || !this.session) return;
    const match = modes.availableModes.find((m) => m.id.toLowerCase() === want || m.id.toLowerCase().includes(want) || m.name.toLowerCase().includes(want));
    if (!match) { this.log.warn(`no session mode matching "${want}" (have: ${modes.availableModes.map((m) => m.id).join(", ")})`); return; }
    if (modes.currentModeId === match.id) return;
    try {
      await this.ctx.request(acp.methods.agent.session.setMode, { sessionId: this.session.sessionId, modeId: match.id });
      this.log.info(`session mode: ${match.id}`);
    } catch (e) { this.log.warn(`could not set mode ${match.id}: ${(e as Error).message}`); }
  }

  private async onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const title = params.toolCall.title ?? params.toolCall.toolCallId;
    for (const kind of PERMISSION_PREFERENCE) {
      const opt = params.options.find((o) => o.kind === kind);
      if (opt) {
        this.log.debug(`permission "${title}": ${opt.kind}`);
        return { outcome: { outcome: "selected", optionId: opt.optionId } };
      }
    }
    return { outcome: { outcome: "cancelled" } };
  }

  /** Run one prompt turn. Serialised: a second call while one is running rejects. */
  prompt(blocks: ContentBlock[]): Promise<TurnResult> {
    if (!this.session) return Promise.reject(new Error("mind has no session"));
    if (this.turn) return Promise.reject(new Error("a turn is already running"));
    const session = this.session;
    const run = (async (): Promise<TurnResult> => {
      let text = "";
      const promptP = session.prompt(blocks);
      promptP.catch(() => {}); // surfaced via the stop message below
      for (;;) {
        const m = await session.nextUpdate();
        if (m.kind === "stop") {
          return { stopReason: m.stopReason, text, usage: m.response.usage ?? null };
        }
        const u = m.update;
        if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") text += u.content.text;
        try { this.opts.onUpdate(u); } catch (e) { this.log.error("onUpdate threw", e); }
      }
    })();
    this.turn = run.finally(() => { this.turn = null; });
    return this.turn;
  }

  /** Ask the agent to stop the current turn; resolves when the turn has ended. */
  async cancel(): Promise<void> {
    if (!this.turn || !this.session || !this.ctx) return;
    try { await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId }); }
    catch (e) { this.log.warn(`cancel failed: ${(e as Error).message}`); }
    await this.turn.catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.cancel().catch(() => {});
    this.releaseConnection?.();
    try { this.session?.dispose(); } catch { /* fine */ }
    if (this.child && this.child.exitCode === null) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1500));
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }
  }
}

/** Text and image helpers for prompt blocks. */
export const block = {
  text(text: string): ContentBlock { return { type: "text", text }; },
  image(data: Buffer, mimeType = "image/png"): ContentBlock { return { type: "image", data: data.toString("base64"), mimeType }; },
};
