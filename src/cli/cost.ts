// `golem cost`: what the minds are spending, from the transcripts. Every agent turn record carries
// tokens (total input across the turn's API round trips), cached reads, model, planning flag, tool
// calls and wall time; tool records carry the tool name. This aggregates them per agent per window.
import { existsSync, readFileSync } from "node:fs";

export interface TurnRec { t: number; tokens: number; cached: number; toolCalls: number; ms: number; model: string; planning: boolean }
export interface CostSummary {
  agent: string; hours: number; turns: number; planningTurns: number;
  tokens: number; cached: number; toolCalls: number; ms: number; compactions: number;
  byModel: Record<string, { turns: number; tokens: number; cached: number }>;
  tools: Record<string, number>;
}

export function readTranscript(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* torn line */ } }
  return out;
}

export function summarise(agent: string, records: Record<string, unknown>[], hours: number, now = Date.now()): CostSummary {
  const since = now - hours * 3_600_000;
  const s: CostSummary = { agent, hours, turns: 0, planningTurns: 0, tokens: 0, cached: 0, toolCalls: 0, ms: 0, compactions: 0, byModel: {}, tools: {} };
  for (const r of records) {
    const t = Number(r.t ?? 0);
    if (t < since) continue;
    if (r.role === "agent" && typeof r.tokens === "number") {
      s.turns++;
      if (r.planning) s.planningTurns++;
      s.tokens += Number(r.tokens); s.cached += Number(r.cached ?? 0); s.toolCalls += Number(r.toolCalls ?? 0); s.ms += Number(r.ms ?? 0);
      const m = String(r.model || "?");
      const bm = (s.byModel[m] ??= { turns: 0, tokens: 0, cached: 0 });
      bm.turns++; bm.tokens += Number(r.tokens); bm.cached += Number(r.cached ?? 0);
    } else if (r.role === "tool") {
      const name = String(r.text ?? "").match(/^(\w+)\(/)?.[1];
      if (name) s.tools[name] = (s.tools[name] ?? 0) + 1;
    } else if (r.role === "event" && r.compaction) s.compactions++;
  }
  return s;
}

const k = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

export function renderCost(summaries: CostSummary[]): string {
  const out: string[] = [];
  const hours = summaries[0]?.hours ?? 0;
  out.push(`## cost, last ${hours}h`, "");
  out.push(`${"agent".padEnd(8)} ${"turns".padStart(5)} ${"plan".padStart(4)} ${"input".padStart(7)} ${"cached".padStart(7)} ${"uncached".padStart(8)} ${"/turn".padStart(6)} ${"calls/t".padStart(7)} ${"s/turn".padStart(6)} ${"compact".padStart(7)}`);
  let T = 0, C = 0, N = 0;
  for (const s of summaries) {
    T += s.tokens; C += s.cached; N += s.turns;
    const per = (x: number) => s.turns ? x / s.turns : 0;
    out.push(`${s.agent.padEnd(8)} ${String(s.turns).padStart(5)} ${String(s.planningTurns).padStart(4)} ${k(s.tokens).padStart(7)} ${k(s.cached).padStart(7)} ${k(s.tokens - s.cached).padStart(8)} ${k(per(s.tokens)).padStart(6)} ${per(s.toolCalls).toFixed(1).padStart(7)} ${(per(s.ms) / 1000).toFixed(0).padStart(6)} ${String(s.compactions).padStart(7)}`);
  }
  if (summaries.length > 1) out.push(`${"fleet".padEnd(8)} ${String(N).padStart(5)} ${"".padStart(4)} ${k(T).padStart(7)} ${k(C).padStart(7)} ${k(T - C).padStart(8)}`);
  out.push("", `input = every API round trip's input tokens (one per tool call); uncached is what full price applies to.`);
  for (const s of summaries) {
    const models = Object.entries(s.byModel).map(([m, v]) => `${m}: ${v.turns} turns, ${k(v.tokens)}`).join("; ");
    const tools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n} ${c}`).join(", ");
    out.push("", `${s.agent}: ${models || "no turn records with tokens yet"}`, `  tools: ${tools || "none"}`);
  }
  return out.join("\n");
}
