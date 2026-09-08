// A Golem-owned ACP adapter for OpenAI Codex, bridging ACP (spoken to Golem over this process's
// stdio) to `codex app-server` (a JSON-RPC child we spawn). Unlike Zed's @zed-industries/codex-acp,
// this drives the *installed* codex, so whatever models that codex supports (e.g. gpt-6-astra) work.
//
// Golem is the ACP client; we are the ACP agent. On the other side we are the app-server's client.
// Mapping:
//   ACP initialize            -> codex initialize + `initialized`
//   ACP session/new           -> codex thread/start (+ model/list for the model select)
//   ACP session/load          -> codex thread/resume
//   ACP session/prompt        -> codex turn/start; stream item/agentMessage/delta -> agent_message_chunk,
//                                 finish on turn/completed; tokenUsage -> usage
//   ACP session/cancel        -> codex turn/interrupt
//   set_mode / set_config     -> stored, applied to the next turn/start (sandbox+approval, model, effort)
// Any approval request codex sends is auto-approved: Golem runs full-access and answers `met` itself.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// What codex advertises per model; the union across models, filtered by what each one supports.
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const MODES: acp.SessionMode[] = [
  { id: "read-only", name: "read-only" },
  { id: "auto", name: "auto" },
  { id: "full-access", name: "full-access" },
];
const log = (...a: unknown[]) => process.stderr.write("[codex-acp] " + a.join(" ") + "\n");
const DEBUG = !!process.env.GOLEM_CODEX_DEBUG;

/** Minimal ND-JSON JSON-RPC peer over the codex app-server child's stdio. */
class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private buf = "";
  onNotify: (method: string, params: unknown) => void = () => {};
  onServerRequest: (method: string, params: unknown) => Promise<unknown> = async () => ({});
  private readonly stdin: NodeJS.WritableStream;

  constructor(stdin: NodeJS.WritableStream, stdout: NodeJS.ReadableStream) {
    this.stdin = stdin;
    stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.handle(line);
      }
    });
  }

  private send(obj: unknown): void { this.stdin.write(JSON.stringify(obj) + "\n"); }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }
  notify(method: string, params?: unknown): void { this.send({ jsonrpc: "2.0", method, params: params ?? {} }); }

  private handle(line: string): void {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(line); } catch { log("unparseable line from codex:", line.slice(0, 200)); return; }
    if (msg.method && msg.id !== undefined) {
      // server -> client request (approvals, elicitation): answer and reply
      void this.onServerRequest(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: "2.0", id: msg.id, result }),
        (e) => this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e) } }),
      );
      return;
    }
    if (msg.method) { this.onNotify(msg.method, msg.params); return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "codex error"));
      else p.resolve(msg.result);
    }
  }
}

interface TurnWaiter { resolve: (r: { stopReason: acp.StopReason }) => void }

async function main(): Promise<void> {
  const codexBin = process.env.GOLEM_CODEX_BIN || "codex";
  const child = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  child.on("exit", (code, sig) => { log(`codex app-server exited (${code ?? sig})`); process.exit(code ?? 0); });
  const rpc = new RpcClient(child.stdin!, child.stdout!);

  // Per session (thread) state.
  const threads = new Map<string, {
    model: string; effort: string; mode: string;
    text: string; usage: acp.Usage | null; waiter: TurnWaiter | null; turnId: string | null; streamed: boolean;
  }>();
  let models: string[] = [];
  let currentModel = "";
  const cfg = { model: process.env.GOLEM_CODEX_MODEL || "", effort: process.env.GOLEM_CODEX_EFFORT || "low", mode: "full-access", provider: process.env.GOLEM_CODEX_PROVIDER || "" };

  // codex handshake
  await rpc.request("initialize", { clientInfo: { name: "golem-codex-acp", version: "0.1.0" }, capabilities: {} });
  rpc.notify("initialized", {});
  try {
    // codex answers model/list with {data: [...]}. It was read as {items}/{models} here, so the list
    // came back empty, Golem warned `no model matching "gpt-5.6-sol" (have: )` and fell back to the
    // default model - the config was being silently ignored.
    const ml = await rpc.request<{ data?: { id: string }[]; items?: { id: string }[]; models?: { id: string }[] }>("model/list", {});
    models = (ml.data ?? ml.items ?? ml.models ?? []).map((m) => m.id).filter(Boolean);
    if (models.length) currentModel = cfg.model && models.includes(cfg.model) ? cfg.model : models[0]!;
  } catch (e) { log("model/list failed:", (e as Error).message); }
  if (cfg.model) currentModel = cfg.model;

  let conn!: acp.AgentSideConnection;

  const sandboxFor = (mode: string): { type: string } => mode === "read-only" ? { type: "readOnly", networkAccess: false } as never : mode === "auto" ? { type: "dangerFullAccess" } : { type: "dangerFullAccess" };

  // codex notifications -> ACP session updates
  rpc.onNotify = (method, params) => {
    const p = (params ?? {}) as Record<string, any>;
    const threadId = p.threadId as string | undefined;
    const st = threadId ? threads.get(threadId) : undefined;
    if (st && typeof p.turnId === "string") st.turnId = p.turnId;
    if (DEBUG) log("<-", method, JSON.stringify(p).slice(0, 200));
    switch (method) {
      case "item/agentMessage/delta": {
        if (st && typeof p.delta === "string") { st.text += p.delta; st.streamed = true; void conn.sessionUpdate({ sessionId: threadId!, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.delta } } }); }
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = (p.item ?? {}) as Record<string, any>;
        if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string" && st && !st.streamed) {
          void conn.sessionUpdate({ sessionId: threadId!, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } } });
        } else if (item.type === "mcpToolCall" && item.status === "failed") {
          log("mcpToolCall FAILED:", item.tool, JSON.stringify({ error: item.error, result: item.result }).slice(0, 400));
        }
        if ((item.type === "mcpToolCall" || item.type === "commandExecution") && st) {
          const title = item.type === "mcpToolCall" ? `${item.server ?? ""}:${item.tool ?? ""}` : String(item.command ?? "exec");
          void conn.sessionUpdate({ sessionId: threadId!, update: { sessionUpdate: method === "item/started" ? "tool_call" : "tool_call_update", toolCallId: String(item.id ?? title), title, status: method === "item/started" ? "in_progress" : "completed", kind: "other" } as acp.SessionUpdate });
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        if (st && p.tokenUsage) {
          // tokenUsage.last is the just-finished turn's breakdown; Golem's "input tokens" metric maps
          // to codex inputTokens with cachedInputTokens as the cached portion.
          const b = ((p.tokenUsage as { last?: Record<string, number>; total?: Record<string, number> }).last ?? (p.tokenUsage as { total?: Record<string, number> }).total ?? {}) as Record<string, number>;
          st.usage = { totalTokens: Number(b.inputTokens ?? 0), cachedReadTokens: Number(b.cachedInputTokens ?? 0) } as acp.Usage;
        }
        break;
      }
      case "turn/completed": {
        if (st && st.waiter) { const w = st.waiter; st.waiter = null; st.turnId = null; w.resolve({ stopReason: "end_turn" }); }
        break;
      }
      case "error": {
        // Say what went wrong. ACP has no error stop reason, so this arrives at Golem as "refusal" -
        // which reads as the model declining the task when it is usually a transport or quota fault.
        // Push the text into the transcript first so the log says something more useful than the
        // word "refusal" with an empty message beside it.
        const detail = String((p as { message?: string; error?: { message?: string } }).message
          ?? (p as { error?: { message?: string } }).error?.message
          ?? JSON.stringify(p)).slice(0, 500);
        log("codex error notification:", detail);
        if (threadId) {
          void conn.sessionUpdate({ sessionId: threadId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[codex error] ${detail}` } } });
        }
        if (st && st.waiter) { const w = st.waiter; st.waiter = null; w.resolve({ stopReason: "refusal" }); }
        break;
      }
      default: break;   // item/started, item/completed, plan deltas, thread/* status: ignored for now
    }
  };
  // Server -> client requests. Golem runs full-access and answers `met` itself, so approve everything
  // and decline elicitations (Golem's tools take no interactive input). Each needs its exact shape or
  // codex fails to deserialize the reply and the tool interaction breaks.
  rpc.onServerRequest = async (method, params) => {
    const reply = await (async () => {
    switch (method) {
      case "mcpServer/elicitation/request": return { action: "accept", content: {}, _meta: null };
      case "item/tool/requestUserInput": {
        const qs = ((params as { questions?: unknown[] } | undefined)?.questions ?? []) as unknown[];
        const answers: Record<string, { answers: string[] }> = {};
        for (const q of qs as { id?: string }[]) if (q.id) answers[q.id] = { answers: [] };
        return { answers };
      }
      case "execCommandApproval":
      case "applyPatchApproval": return { decision: "approved" };
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval": return { decision: "acceptForSession" };
      case "item/permissions/requestApproval": return { permissions: { all: true }, scope: "session", strictAutoReview: false };
      case "account/chatgptAuthTokens/refresh": return {};
      default: if (DEBUG) log("unhandled server request:", method); return {};
    }
    })();
    if (DEBUG) log("=> server request", method, "answered", JSON.stringify(reply).slice(0, 160));
    return reply;
  };

  const modelSelect = (): acp.SessionConfigOption => ({
    type: "select", id: "model", name: "model", currentValue: currentModel,
    options: (models.length ? models : [currentModel]).filter(Boolean).map((m) => ({ value: m, name: m })),
  } as acp.SessionConfigOption);
  const effortSelect = (): acp.SessionConfigOption => ({
    type: "select", id: "effort", name: "reasoning effort", currentValue: cfg.effort,
    options: REASONING_EFFORTS.map((e) => ({ value: e, name: e })),
  } as acp.SessionConfigOption);
  const modeState = (mode: string): acp.SessionModeState => ({ currentModeId: mode, availableModes: MODES });

  const agent: acp.Agent = {
    async initialize() {
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, mcpCapabilities: { http: true } },
      } as acp.InitializeResponse;
    },
    async authenticate() { return {}; },
    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
      const mcp = configFromMcp(params.mcpServers ?? []);
      const res = await rpc.request<{ thread?: { id?: string }; threadId?: string }>("thread/start", {
        model: currentModel || undefined, modelProvider: cfg.provider || undefined,
        cwd: params.cwd, sandbox: cfg.mode === "read-only" ? "read-only" : "danger-full-access",
        config: mcp,
      });
      const id = res.thread?.id ?? res.threadId;
      if (!id) throw new Error("thread/start returned no thread id");
      threads.set(id, { model: currentModel, effort: cfg.effort, mode: cfg.mode, text: "", usage: null, waiter: null, turnId: null, streamed: false });
      log(`session ${id} model=${currentModel}${cfg.provider ? " provider=" + cfg.provider : ""} effort=${cfg.effort} mode=${cfg.mode} mcp=${Object.keys((mcp as any).mcp_servers ?? {}).join(",") || "none"}`);
      return { sessionId: id, configOptions: [modelSelect(), effortSelect()], modes: modeState(cfg.mode) } as acp.NewSessionResponse;
    },
    async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
      const mcp = configFromMcp(params.mcpServers ?? []);
      try { await rpc.request("thread/resume", { threadId: params.sessionId, model: currentModel || undefined, modelProvider: cfg.provider || undefined, cwd: params.cwd, sandbox: cfg.mode === "read-only" ? "read-only" : "danger-full-access", config: mcp }); }
      catch (e) { log("thread/resume failed:", (e as Error).message); throw e; }
      if (!threads.has(params.sessionId)) threads.set(params.sessionId, { model: currentModel, effort: cfg.effort, mode: cfg.mode, text: "", usage: null, waiter: null, turnId: null, streamed: false });
      return { modes: modeState(cfg.mode), configOptions: [modelSelect(), effortSelect()] } as acp.LoadSessionResponse;
    },
    async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
      cfg.mode = params.modeId; const st = threads.get(params.sessionId); if (st) st.mode = params.modeId;
      return {};
    },
    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
      const { configId, value } = params as unknown as { configId: string; value: string };
      if (configId === "model") { currentModel = value; const st = threads.get(params.sessionId); if (st) st.model = value; }
      else if (configId === "effort") { cfg.effort = value; const st = threads.get(params.sessionId); if (st) st.effort = value; }
      return { configOptions: [modelSelect(), effortSelect()] };
    },
    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const st = threads.get(params.sessionId);
      if (!st) throw new Error(`no such session ${params.sessionId}`);
      st.text = ""; st.usage = null; st.streamed = false;
      const input = blocksToInput(params.prompt);
      const done = new Promise<{ stopReason: acp.StopReason }>((resolve) => { st.waiter = { resolve }; });
      let started: { turnId?: string } = {};
      try {
        started = await rpc.request<{ turnId?: string }>("turn/start", {
          threadId: params.sessionId, input,
          model: st.model || undefined, effort: st.effort || undefined,
          sandboxPolicy: sandboxFor(st.mode), approvalPolicy: "on-request",
        });
      } catch (e) { st.waiter = null; log("turn/start failed:", (e as Error).message); throw e; }
      st.turnId = started.turnId ?? null;
      const r = await done;
      return { stopReason: r.stopReason, usage: st.usage ?? undefined } as acp.PromptResponse;
    },
    async cancel(params: acp.CancelNotification): Promise<void> {
      const st = threads.get(params.sessionId);
      if (st?.turnId) { try { await rpc.request("turn/interrupt", { threadId: params.sessionId, turnId: st.turnId }); } catch (e) { log("turn/interrupt failed:", (e as Error).message); } }
      if (st && st.waiter) { const w = st.waiter; st.waiter = null; w.resolve({ stopReason: "cancelled" }); }
    },
  };

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  conn = new acp.AgentSideConnection(() => agent, stream);
  log(`ready (codex=${codexBin}, models=${models.length}, model=${currentModel})`);
}

/** ACP content blocks -> codex UserInput[]. Text only for now. */
function blocksToInput(prompt: acp.ContentBlock[] | string): { type: string; text: string }[] {
  const blocks = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;
  const text = blocks.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return [{ type: "text", text }];
}

/** Golem's MCP servers -> a codex config overlay (streamable HTTP MCP servers). */
function configFromMcp(servers: acp.McpServer[]): Record<string, unknown> {
  const mcp_servers: Record<string, unknown> = {};
  for (const s of servers as (acp.McpServer & { type?: string; url?: string; name?: string; headers?: { name: string; value: string }[] })[]) {
    if (s.type === "http" && s.url) {
      const http_headers: Record<string, string> = {};
      for (const h of s.headers ?? []) http_headers[h.name] = h.value;
      mcp_servers[s.name] = { url: s.url, http_headers, startup_timeout_sec: 20 };
    }
  }
  return Object.keys(mcp_servers).length ? { mcp_servers } : {};
}

main().catch((e) => { log("fatal:", (e as Error).stack ?? String(e)); process.exit(1); });
