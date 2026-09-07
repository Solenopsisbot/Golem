#!/usr/bin/env node
// The smallest possible Golem integration: watch the fleet's events, and relay what you type into
// one agent's inbox as a named sender. Everything a chat bot or a web front end needs is here.
//
//   node examples/bridge-client.mjs --agent Clay --from YourName --token <mcp token> [--base http://127.0.0.1:8770]
//
// Type a line and press enter to send it. As an owner (players.owners in golem.toml), "goal ..." and
// "met" take the fast path and never wake the mind.
import { createInterface } from "node:readline";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const base = (arg("--base", "http://127.0.0.1:8770")).replace(/\/$/, "");
const agent = arg("--agent", "Clay");
const from = arg("--from", "bridge");
const token = arg("--token", process.env.GOLEM_TOKEN || "");
if (!token) { console.error("need --token (data/<agent>/tokens.json -> mcp)"); process.exit(1); }
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---- events: a bare SSE reader, no dependency ----
async function watch() {
  const res = await fetch(`${base}/fleet/events?token=${encodeURIComponent(token)}`);
  if (!res.ok || !res.body) { console.error(`events: ${res.status}`); process.exit(1); }
  const dec = new TextDecoder(); let buf = ""; let type = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) { try { onEvent(type, JSON.parse(line.slice(5))); } catch {} }
    }
  }
}
function onEvent(type, d) {
  const who = d.agent ? `${d.agent}` : "";
  switch (type) {
    case "hello": console.log(`connected: ${(d.agents || []).map((a) => a.name).join(", ")}`); break;
    case "said": console.log(`${hhmm(d.t)} ${who} says: ${d.text}`); break;
    case "dm": console.log(`${hhmm(d.t)} ${who} -> ${d.to}: ${d.text}`); break;
    case "bus": console.log(`${hhmm(d.t)} ${d.from} -> ${d.to}: ${d.text}`); break;
    case "turn_end": console.log(`${hhmm(d.t)} ${who} turn ${d.stopReason} (${Math.round(d.ms / 1000)}s, ${d.toolCalls ?? 0} calls)`); break;
    case "reflex": console.log(`${hhmm(d.t)} ${who} reflex ${d.name}${d.note ? ": " + d.note : ""}`); break;
    default: break;   // inbox, prompt, agent_text, golem_tool, usage, state: noisy; enable if you want them
  }
}

// ---- input: relay lines into the inbox ----
async function send(text) {
  const r = await fetch(`${base}/agents/${encodeURIComponent(agent)}/inbox`, { method: "POST", headers: H, body: JSON.stringify({ text, from }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.error(`inbox: ${r.status}`); else console.log(`(sent to ${agent}${j.id === -1 ? ", fast path" : ""})`);
}
createInterface({ input: process.stdin }).on("line", (l) => { if (l.trim()) void send(l.trim()); });

console.log(`watching ${base} as ${from}; type to message ${agent}`);
watch().catch((e) => { console.error(e.message); process.exit(1); });
