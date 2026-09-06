// Chat routing: who we listen to, what counts as being addressed, and the owner fast path that
// handles a handful of commands without waking the mind.
import type { AgentConfig } from "../config/schema.ts";

export interface ChatLine { text: string; sender?: string; kind: string }

export type ChatDecision =
  | { action: "drop"; reason: string }
  | { action: "inbox"; priority: number; addressed: boolean; owner: boolean; text: string }
  | { action: "fast"; command: FastCommand; owner: boolean };

export type FastCommand =
  | { name: "met" }
  | { name: "status" }
  | { name: "reflex"; reflex: string; on: boolean }
  | { name: "goal"; text: string }
  | { name: "goal_clear" }
  | { name: "come" };

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Strips the address prefix ("Clay", "@Clay", "hey Clay,") if present. Returns null when not addressed. */
export function stripAddress(text: string, name: string, patterns: string[]): string | null {
  const t = text.trim();
  for (const p of patterns) {
    const lit = p.replace("{name}", name);
    const re = new RegExp(`^${escapeRe(lit)}\\b[\\s,:!.-]*`, "i");
    const m = re.exec(t);
    if (m) return t.slice(m[0].length).trim();
  }
  return null;
}

export function parseFastCommand(body: string): FastCommand | null {
  const s = body.trim().toLowerCase();
  if (/^(met|stop|halt)\b/.test(s)) return { name: "met" };
  if (/^status\b/.test(s)) return { name: "status" };
  if (/^come\b/.test(s)) return { name: "come" };
  const m = /^(?:mode|reflex)\s+([a-z_]+)\s+(on|off)\b/.exec(s);
  if (m) return { name: "reflex", reflex: m[1]!, on: m[2] === "on" };
  if (/^goal\s+(clear|none|off)\b/.test(s)) return { name: "goal_clear" };
  const g = /^goal\s+(.+)$/.exec(body.trim());
  if (g) return { name: "goal", text: g[1]!.trim() };
  return null;
}

export function routeChat(agent: AgentConfig, line: ChatLine): ChatDecision {
  const sender = line.sender;
  const self = agent.body.username;
  if (line.kind !== "chat" && line.kind !== "whisper") {
    // System lines: deaths, joins and the like arrive through other events; keep the rest quiet
    // unless they mention us.
    const mentions = new RegExp(`\\b${escapeRe(self)}\\b`, "i").test(line.text);
    return mentions ? { action: "inbox", priority: 30, addressed: false, owner: false, text: line.text } : { action: "drop", reason: "system" };
  }
  if (!sender) return { action: "drop", reason: "no sender" };
  if (sender === self) return { action: "drop", reason: "own echo" };
  if (agent.players.ignored.includes(sender)) return { action: "drop", reason: "ignored player" };
  const owner = agent.players.owners.includes(sender);
  const trusted = owner || agent.players.trusted.includes(sender);
  const stripped = stripAddress(line.text, agent.name, agent.chat.address);
  const addressed = stripped !== null || line.kind === "whisper";
  const body = stripped ?? line.text;

  if (owner && addressed) {
    const fast = parseFastCommand(body);
    if (fast) return { action: "fast", command: fast, owner: true };
  }
  switch (agent.chat.listen) {
    case "owners":
      if (!owner) return { action: "drop", reason: "listen=owners" };
      break;
    case "addressed":
      if (!addressed) return { action: "drop", reason: "not addressed" };
      break;
    case "all":
      break;
  }
  // Owners interrupt whatever the mind is doing (>= drive.interrupt_priority); the ACP session keeps
  // its history across a cancelled turn, so being responsive costs nothing but the in-flight tool call.
  const priority = owner ? 80 : trusted ? 55 : addressed ? 50 : 40;
  return { action: "inbox", priority, addressed, owner, text: line.text };
}
