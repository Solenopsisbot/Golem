// Translating proxy: accept the OpenAI *Responses* API (what the Codex harness speaks to a custom
// provider) and forward it to an OpenAI *Chat Completions* endpoint (Logfare, OpenRouter, vLLM...).
// This lets the full Codex harness -- file edits, shell, MCP tools -- drive a chat-completions-only
// model such as glm-5.3 on Logfare, unchanged.
//
//   UPSTREAM_BASE   chat completions root, e.g. https://logfare.ai/v1     (required)
//   PROXY_PORT      listen port (default 8788)
//   PROXY_MODEL     model id to advertise on GET /models (optional)
//   PROXY_DEBUG=1   verbose
// The incoming Authorization header is forwarded upstream, so the API key stays in Codex's env.
import { createServer } from "node:http";
const UPSTREAM = (process.env.UPSTREAM_BASE || "").replace(/\/$/, "");
const PORT = Number(process.env.PROXY_PORT || 8788);
const DEBUG = !!process.env.PROXY_DEBUG;
if (!UPSTREAM) { console.error("UPSTREAM_BASE required"); process.exit(1); }
const log = (...a) => process.stderr.write("[resp-proxy] " + a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n");
const rid = (p) => p + Math.random().toString(36).slice(2, 12);

// ---- Responses request -> Chat Completions request ----
function flattenTools(tools = []) {
  const out = [];
  for (const t of tools) {
    if (t.type === "function") out.push({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } } });
    else if (t.type === "namespace" && Array.isArray(t.tools)) for (const inner of t.tools) { if (inner.type === "function") out.push({ type: "function", function: { name: inner.name, description: inner.description ?? "", parameters: inner.parameters ?? { type: "object", properties: {} } } }); }
    // web_search and any other tool type: dropped (chat completions has no equivalent)
  }
  return out;
}
function toChatMessages(instructions, input = []) {
  const msgs = [];
  if (instructions) msgs.push({ role: "system", content: instructions });
  for (const item of input) {
    if (item.type === "message") {
      const text = (item.content ?? []).map((c) => c.text ?? "").join("");
      if (item.role === "assistant") msgs.push({ role: "assistant", content: text });
      else msgs.push({ role: item.role || "user", content: text });
    } else if (item.type === "function_call") {
      msgs.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }] });
    } else if (item.type === "function_call_output") {
      msgs.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    }
  }
  // Merge consecutive assistant tool_calls into the preceding assistant message so a call and its
  // output stay adjacent as chat expects.
  return msgs;
}
function toolChoice(tc) {
  if (!tc || tc === "auto" || tc === "none" || tc === "required") return tc;
  if (tc.type === "function" && tc.name) return { type: "function", function: { name: tc.name } };
  return "auto";
}

// ---- Chat SSE -> Responses SSE ----
function sse(res, type, obj) { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`); }

async function handleResponses(reqBody, auth, res) {
  const chatBody = {
    model: reqBody.model,
    messages: toChatMessages(reqBody.instructions, reqBody.input),
    tools: flattenTools(reqBody.tools),
    tool_choice: toolChoice(reqBody.tool_choice),
    parallel_tool_calls: reqBody.parallel_tool_calls ?? undefined,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (!chatBody.tools.length) delete chatBody.tools;
  const upHeaders = { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) };
  const upPayload = JSON.stringify(chatBody);
  let upstream;
  for (let attempt = 0; ; attempt++) {
    upstream = await fetch(`${UPSTREAM}/chat/completions`, { method: "POST", headers: upHeaders, body: upPayload });
    if (upstream.ok) break;
    if ((upstream.status === 429 || upstream.status >= 500) && attempt < 5) {
      const ra = Number(upstream.headers.get("retry-after"));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(1000 * 2 ** attempt, 20000);
      log(`upstream ${upstream.status}; retry in ${Math.round(waitMs/1000)}s (${attempt + 1}/5)`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    break;
  }
  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    return res.end(body || JSON.stringify({ error: { message: `upstream ${upstream.status}` } }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = rid("resp_");
  sse(res, "response.created", { response: { id: responseId, object: "response", status: "in_progress", output: [] } });

  let outIndex = 0;
  let msg = null;                 // { id, index, text }
  const calls = new Map();        // toolcall index -> { id(call_id), itemIndex, name, args }
  let usage = null;
  const dec = new TextDecoder();
  let buf = "";
  const reader = upstream.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length) {
        if (!msg) { msg = { id: rid("msg_"), index: outIndex++, text: "" }; sse(res, "response.output_item.added", { output_index: msg.index, item: { id: msg.id, type: "message", role: "assistant", status: "in_progress", content: [] } }); sse(res, "response.content_part.added", { item_id: msg.id, output_index: msg.index, content_index: 0, part: { type: "output_text", text: "" } }); }
        msg.text += delta.content;
        sse(res, "response.output_text.delta", { item_id: msg.id, output_index: msg.index, content_index: 0, delta: delta.content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const k = tc.index ?? 0;
        let c = calls.get(k);
        if (!c) { c = { id: tc.id || rid("call_"), itemIndex: outIndex++, name: tc.function?.name || "", args: "" }; calls.set(k, c); sse(res, "response.output_item.added", { output_index: c.itemIndex, item: { id: rid("fc_"), type: "function_call", status: "in_progress", call_id: c.id, name: c.name, arguments: "" } }); }
        if (tc.function?.name && !c.name) c.name = tc.function.name;
        if (tc.function?.arguments) { c.args += tc.function.arguments; sse(res, "response.function_call_arguments.delta", { output_index: c.itemIndex, item_id: c.id, delta: tc.function.arguments }); }
      }
    }
  }
  const output = [];
  if (msg) { sse(res, "response.output_text.done", { item_id: msg.id, output_index: msg.index, content_index: 0, text: msg.text }); sse(res, "response.output_item.done", { output_index: msg.index, item: { id: msg.id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.text }] } }); output.push({ id: msg.id, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: msg.text }] }); }
  for (const c of calls.values()) { const item = { id: rid("fc_"), type: "function_call", status: "completed", call_id: c.id, name: c.name, arguments: c.args }; sse(res, "response.output_item.done", { output_index: c.itemIndex, item }); output.push(item); }
  const u = usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0, input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 } } : undefined;
  sse(res, "response.completed", { response: { id: responseId, object: "response", status: "completed", output, usage: u } });
  res.end();
  if (DEBUG) log(`done: ${msg ? msg.text.length + " text chars" : "no text"}, ${calls.size} tool call(s), usage=${usage ? usage.total_tokens : "n/a"}`);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const path = (req.url || "").split("?")[0];
    if (req.method === "GET" && /\/models$/.test(path)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ object: "list", data: [{ id: process.env.PROXY_MODEL || "model", object: "model" }] })); }
    if (req.method !== "POST" || !/\/responses$/.test(path)) { res.writeHead(404); return res.end("not found"); }
    let reqBody; try { reqBody = JSON.parse(body); } catch { res.writeHead(400); return res.end("bad json"); }
    if (DEBUG) log("IN", reqBody.model, "stream=", !!reqBody.stream, "tools=", (reqBody.tools || []).length, "input=", (reqBody.input || []).length);
    try { await handleResponses(reqBody, req.headers.authorization, res); }
    catch (e) { log("error:", e.stack || String(e)); if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: String(e) } })); } else res.end(); }
  });
});
server.listen(PORT, "127.0.0.1", () => log(`listening ${PORT} -> ${UPSTREAM}`));
