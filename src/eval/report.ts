// `golem eval-report [--label x]`: results in data/eval/ as a table, grouped by label and task, so
// two configurations can be compared at a glance.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskResult } from "./task.ts";

export function evalReport(dir: string, onlyLabel?: string): string {
  if (!existsSync(dir)) return `no results in ${dir}`;
  const rows: (TaskResult & { label: string | null })[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    try { rows.push(JSON.parse(readFileSync(resolve(dir, f), "utf8"))); } catch { /* skip */ }
  }
  const filtered = onlyLabel ? rows.filter((r) => r.label === onlyLabel) : rows;
  if (!filtered.length) return "no results";
  const byLabel = new Map<string, (typeof filtered)[number][]>();
  for (const r of filtered) { const k = r.label ?? "(no label)"; if (!byLabel.has(k)) byLabel.set(k, []); byLabel.get(k)!.push(r); }
  const out: string[] = [];
  for (const [label, rs] of byLabel) {
    const ok = rs.filter((r) => r.status === "success").length;
    out.push(`## ${label}: ${ok}/${rs.length} succeeded, ${rs.reduce((a, r) => a + r.seconds, 0).toFixed(0)}s total, ${rs.reduce((a, r) => a + r.toolCalls, 0)} tool calls`);
    out.push(`${"task".padEnd(18)} ${"status".padEnd(8)} ${"secs".padStart(5)} ${"turns".padStart(5)} ${"calls".padStart(5)} ${"deaths".padStart(6)}  plan/act           when`);
    for (const r of rs) {
      out.push(`${r.name.padEnd(18)} ${r.status.padEnd(8)} ${r.seconds.toFixed(0).padStart(5)} ${String(r.turns).padStart(5)} ${String(r.toolCalls).padStart(5)} ${String(r.deaths).padStart(6)}  ${`${r.model.plan}/${r.model.act}`.padEnd(18)} ${new Date(r.startedAt).toISOString().slice(0, 16).replace("T", " ")}  ${r.detail.slice(0, 60)}`);
    }
    out.push("");
  }
  return out.join("\n");
}
