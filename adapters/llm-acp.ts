// A generic ACP adapter: run any OpenAI/Anthropic-compatible HTTP endpoint as a Golem mind.
//
// Unlike the Claude Code and Codex adapters (which wrap a whole agent CLI), this one owns the agent
// loop: it reads the workspace AGENTS.md as its system prompt, connects to Golem's MCP server as a
// client to get and call the tools, and drives a tool-calling loop against a configured endpoint.
// One adapter, three wires, so any endpoint can be reached on whichever protocol it speaks:
//   GOLEM_LLM_WIRE = chat       -> POST {base}/chat/completions   (OpenAI Chat Completions; Logfare, OpenRouter, vLLM, ollama)
//                    responses  -> POST {base}/responses          (OpenAI Responses API)
//                    anthropic  -> POST {base}/messages           (Anthropic Messages API)
//   GOLEM_LLM_BASE_URL  the endpoint root (no trailing /chat...); required
//   GOLEM_LLM_MODEL     model id; required
//   GOLEM_LLM_KEY_ENV   name of the env var holding the API key (loaded from .env too), e.g. LOGFARE_API_KEY
//   GOLEM_LLM_API_KEY   the key directly (alternative to KEY_ENV)
//   GOLEM_LLM_HEADERS   extra headers as JSON, e.g. {"X-Org":"foo"}
//   GOLEM_LLM_MAX_STEPS tool-loop cap per turn (default 16)
//   GOLEM_LLM_MAX_TOKENS output cap for anthropic/responses (default 4096)
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const log = (...a: unknown[]) => process.stderr.write("[llm-acp] " + a.join(" ") + "\n");
const DEBUG = !!process.env.GOLEM_LLM_DEBUG;

/** Load KEY=VALUE lines from the nearest .env walking up from cwd; never overrides an existing var. */
function loadDotEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, ".env");
    if (existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m || line.trim().startsWith("#")) continue;
        let v = m[2]!.trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
      }
      return;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
}

type Wire = "chat" | "responses" | "anthropic";
interface Tool { name: string; description: string; parameters: Record<string, unknown> }
interface ToolCall { id: string; name: string; args: Record<string, unknown> }
// Neutral conversation item; each wire serialises these its own way.
export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

interface Cfg { wire: Wire; baseUrl: string; model: string; apiKey: string; headers: Record<string, string>; maxSteps: number; maxTokens: number }

function config(): Cfg {
  const wire = (process.env.GOLEM_LLM_WIRE || "chat") as Wire;
  const baseUrl = (process.env.GOLEM_LLM_BASE_URL || "").replace(/\/$/, "");
  const model = process.env.GOLEM_LLM_MODEL || "";
  const keyEnv = process.env.GOLEM_LLM_KEY_ENV;
  const apiKey = process.env.GOLEM_LLM_API_KEY || (keyEnv ? process.env[keyEnv] || "" : "");
  let headers: Record<string, string> = {};
  try { if (process.env.GOLEM_LLM_HEADERS) headers = JSON.parse(process.env.GOLEM_LLM_HEADERS); } catch { log("bad GOLEM_LLM_HEADERS JSON"); }
  if (!baseUrl || !model) throw new Error("GOLEM_LLM_BASE_URL and GOLEM_LLM_MODEL are required");
  if (keyEnv && !apiKey) log(`warning: ${keyEnv} is empty (checked env and .env)`);
  return { wire, baseUrl, model, apiKey, headers, maxSteps: Number(process.env.GOLEM_LLM_MAX_STEPS || 16), maxTokens: Number(process.env.GOLEM_LLM_MAX_TOKENS || 4096) };
}

interface LlmReply { text: string; toolCalls: ToolCall[]; usage: { input: number; cached: number } | null }

/** POST a request and parse the assistant reply for the given wire. Non-streaming. */
async function callLlm(cfg: Cfg, system: string, msgs: Msg[], tools: Tool[], signal: AbortSignal): Promise<LlmReply> {
  const headers: Record<string, string> = { "content-type": "application/json", ...cfg.headers };
  let url: string, body: unknown;
  if (cfg.wire === "anthropic") {
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
    url = `${cfg.baseUrl}/messages`;
    body = {
      model: cfg.model, max_tokens: cfg.maxTokens, system,
      messages: msgs.map(anthropicMsg),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    };
  } else if (cfg.wire === "responses") {
    if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;
    url = `${cfg.baseUrl}/responses`;
    body = {
      model: cfg.model, instructions: system, max_output_tokens: cfg.maxTokens,
      input: msgs.flatMap(responsesItems),
      tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
    };
  } else {
    if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;
    url = `${cfg.baseUrl}/chat/completions`;
    body = {
      model: cfg.model,
      messages: [{ role: "system", content: system }, ...msgs.map(chatMsg)],
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    };
  }
  if (DEBUG) log("->", url, JSON.stringify(body).length, "bytes,", msgs.length, "msgs");
  const payload = JSON.stringify(body);
  let res!: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { method: "POST", headers, body: payload, signal });
    if (res.ok) break;
    // Back off on rate limits and transient server errors; honour Retry-After when given.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const ra = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 30_000);
      log(`${res.status} from endpoint; retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/5)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`${cfg.wire} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = await res.json() as Record<string, any>;
  return cfg.wire === "anthropic" ? parseAnthropic(json) : cfg.wire === "responses" ? parseResponses(json) : parseChat(json);
}

// ---- chat completions ----
export function chatMsg(m: Msg): unknown {
  if (m.role === "user") return { role: "user", content: m.content };
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  return { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.length ? m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) : undefined };
}
export function parseChat(j: Record<string, any>): LlmReply {
  const msg = j.choices?.[0]?.message ?? {};
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t: any) => ({ id: t.id ?? t.function?.name, name: t.function?.name, args: safeJson(t.function?.arguments) }));
  const u = j.usage ?? {};
  return { text: msg.content ?? "", toolCalls, usage: u.prompt_tokens != null ? { input: Number(u.prompt_tokens), cached: Number(u.prompt_tokens_details?.cached_tokens ?? 0) } : null };
}

// ---- anthropic messages ----
export function anthropicMsg(m: Msg): unknown {
  if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.content }] };
  if (m.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
  const content: unknown[] = [];
  if (m.content) content.push({ type: "text", text: m.content });
  for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
  return { role: "assistant", content };
}
export function parseAnthropic(j: Record<string, any>): LlmReply {
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const b of j.content ?? []) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
  }
  const u = j.usage ?? {};
  return { text, toolCalls, usage: u.input_tokens != null ? { input: Number(u.input_tokens), cached: Number(u.cache_read_input_tokens ?? 0) } : null };
}

// ---- openai responses ----
export function responsesItems(m: Msg): unknown[] {
  if (m.role === "user") return [{ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] }];
  if (m.role === "tool") return [{ type: "function_call_output", call_id: m.toolCallId, output: m.content }];
  const out: unknown[] = [];
  if (m.content) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
  for (const c of m.toolCalls) out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
  return out;
}
export function parseResponses(j: Record<string, any>): LlmReply {
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const item of j.output ?? []) {
    if (item.type === "message") for (const c of item.content ?? []) { if (c.type === "output_text") text += c.text; }
    else if (item.type === "function_call") toolCalls.push({ id: item.call_id ?? item.id, name: item.name, args: safeJson(item.arguments) });
  }
  if (!text && typeof j.output_text === "string") text = j.output_text;
  const u = j.usage ?? {};
  return { text, toolCalls, usage: u.input_tokens != null ? { input: Number(u.input_tokens), cached: Number(u.input_tokens_details?.cached_tokens ?? 0) } : null };
}

export function safeJson(s: unknown): Record<string, unknown> { if (typeof s !== "string") return (s as Record<string, unknown>) ?? {}; try { return JSON.parse(s); } catch { return {}; } }

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = config();

  interface Session { mcp: Client; tools: Tool[]; history: Msg[]; abort: AbortController | null; system: string; cwd: string }
  const sessions = new Map<string, Session>();
  let conn!: acp.AgentSideConnection;
  let seq = 0;

  async function connectMcp(servers: acp.McpServer[]): Promise<{ mcp: Client; tools: Tool[] }> {
    const http = (servers as (acp.McpServer & { type?: string; url?: string; headers?: { name: string; value: string }[] })[]).find((s) => s.type === "http" && s.url);
    if (!http) return { mcp: null as unknown as Client, tools: [] };
    const requestInit: RequestInit = { headers: Object.fromEntries((http.headers ?? []).map((h) => [h.name, h.value])) };
    const mcp = new Client({ name: "golem-llm-acp", version: "0.1.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(http.url!), { requestInit }));
    const list = await mcp.listTools();
    const tools: Tool[] = list.tools.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.inputSchema as Record<string, unknown> }));
    log(`mcp connected: ${tools.length} tools`);
    return { mcp, tools };
  }

  const systemPrompt = (cwd: string): string => {
    const f = resolve(cwd, "AGENTS.md");
    try { return existsSync(f) ? readFileSync(f, "utf8") : "You are a Minecraft agent. Use the tools to act."; }
    catch { return "You are a Minecraft agent. Use the tools to act."; }
  };
  const modelSelect = (): acp.SessionConfigOption => ({ type: "select", id: "model", name: "model", currentValue: cfg.model, options: [{ value: cfg.model, name: cfg.model }] } as acp.SessionConfigOption);
  const modes: acp.SessionModeState = { currentModeId: "default", availableModes: [{ id: "default", name: "default" }] };

  const agent: acp.Agent = {
    async initialize() {
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, mcpCapabilities: { http: true } } } as acp.InitializeResponse;
    },
    async authenticate() { return {}; },
    async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
      const { mcp, tools } = await connectMcp(params.mcpServers ?? []);
      const id = `llm-${Date.now()}-${seq++}`;
      sessions.set(id, { mcp, tools, history: [], abort: null, system: "", cwd: params.cwd });
      log(`session ${id} wire=${cfg.wire} model=${cfg.model} base=${cfg.baseUrl} tools=${tools.length}`);
      return { sessionId: id, configOptions: [modelSelect()], modes } as acp.NewSessionResponse;
    },
    async setSessionMode() { return {}; },
    async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
      const { configId, value } = params as unknown as { configId: string; value: string };
      if (configId === "model") cfg.model = value;
      return { configOptions: [modelSelect()] };
    },
    async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
      const s = sessions.get(params.sessionId);
      if (!s) throw new Error(`no session ${params.sessionId}`);
      const userText = (typeof params.prompt === "string" ? params.prompt : params.prompt.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n"));
      s.history.push({ role: "user", content: userText });
      s.system = systemPrompt(s.cwd);
      s.abort = new AbortController();
      let usage: acp.Usage | null = null;
      try {
        for (let step = 0; step < cfg.maxSteps; step++) {
          const reply = await callLlm(cfg, s.system, s.history, s.tools, s.abort.signal);
          if (reply.usage) usage = { totalTokens: reply.usage.input, cachedReadTokens: reply.usage.cached } as acp.Usage;
          if (reply.text) await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.text } } });
          // Only keep an assistant turn that actually said or did something: an empty assistant message
          // (no content, no tool calls) is rejected by the OpenAI wire on the next request.
          if (reply.text || reply.toolCalls.length) s.history.push({ role: "assistant", content: reply.text, toolCalls: reply.toolCalls });
          if (!reply.toolCalls.length) return { stopReason: "end_turn", usage: usage ?? undefined } as acp.PromptResponse;
          for (const call of reply.toolCalls) {
            await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: call.id, title: call.name, status: "in_progress", kind: "other" } as acp.SessionUpdate });
            let out = "";
            try {
              const r = await s.mcp.callTool({ name: call.name, arguments: call.args }) as { content?: { type: string; text?: string }[]; isError?: boolean };
              out = (r.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type}]`)).join("\n") || "(no output)";
              await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: call.id, status: r.isError ? "failed" : "completed", kind: "other" } as acp.SessionUpdate });
            } catch (e) {
              out = `error: ${(e as Error).message}`;
              await conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: call.id, status: "failed", kind: "other" } as acp.SessionUpdate });
            }
            s.history.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
          }
        }
        log(`hit max_steps (${cfg.maxSteps})`);
        return { stopReason: "max_turn_requests", usage: usage ?? undefined } as acp.PromptResponse;
      } catch (e) {
        if (s.abort?.signal.aborted) return { stopReason: "cancelled" } as acp.PromptResponse;
        log("turn error:", (e as Error).message);
        return { stopReason: "refusal", usage: usage ?? undefined } as acp.PromptResponse;
      } finally { s.abort = null; }
    },
    async cancel(params: acp.CancelNotification): Promise<void> {
      const s = sessions.get(params.sessionId);
      s?.abort?.abort();
    },
  };

  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  conn = new acp.AgentSideConnection(() => agent, stream);
  log(`ready wire=${cfg.wire} model=${cfg.model} base=${cfg.baseUrl}`);
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { log("fatal:", (e as Error).stack ?? String(e)); process.exit(1); });
}
