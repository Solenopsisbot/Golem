// `golem replay <agent> [--from HH:MM] [--to HH:MM] [--grep re]`: the JSONL trace as a timeline.
// Commands, their results, events and Golem markers (tools, reflexes, preempts, met), one line each,
// with the noise (tick, status polls, inventory reads) folded away unless --all.
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

export interface ReplayOptions { from?: string; to?: string; grep?: string; all?: boolean }

const NOISE_CMDS = new Set(["status", "inventory", "entities", "nav.status", "blockAt", "schema", "subscribe", "ping", "findItem", "players", "container"]);
const NOISE_EVENTS = new Set(["tick", "health", "inventory", "entitySpawn", "entityRemove", "nav.progress", "blockUpdate", "baritone.log"]);

function hhmm(t: number): string { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`; }
function parseClock(s: string | undefined, base: number): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const d = new Date(base); d.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
  return d.getTime();
}
const short = (v: unknown, n = 110): string => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export async function replay(tracePath: string, opts: ReplayOptions, out: (line: string) => void): Promise<void> {
  if (!existsSync(tracePath)) { out(`no trace at ${tracePath}`); return; }
  const rl = createInterface({ input: createReadStream(tracePath) });
  const pendingCmd = new Map<string, { cmd: string; t: number; args: unknown }>();
  let from: number | null = null, to: number | null = null, first = true;
  const re = opts.grep ? new RegExp(opts.grep, "i") : null;
  let shown = 0, skipped = 0;
  for await (const line of rl) {
    let r: { t: number; kind: string; [k: string]: unknown };
    try { r = JSON.parse(line); } catch { continue; }
    if (first) { from = parseClock(opts.from, r.t); to = parseClock(opts.to, r.t); first = false; }
    if (from && r.t < from) continue;
    if (to && r.t > to) break;
    let text: string | null = null;
    switch (r.kind) {
      case "cmd": {
        const cmd = String(r.cmd);
        pendingCmd.set(String(r.id), { cmd, t: r.t, args: r.args });
        if (!opts.all && NOISE_CMDS.has(cmd)) continue;
        text = `> ${cmd} ${short(r.args ?? {}, 80)}`;
        break;
      }
      case "res": case "err": {
        const p = pendingCmd.get(String(r.id)); pendingCmd.delete(String(r.id));
        const cmd = p?.cmd ?? String(r.cmd);
        if (!opts.all && NOISE_CMDS.has(cmd)) continue;
        const ms = p ? r.t - p.t : 0;
        text = r.kind === "res" ? `  ${cmd} -> ${short(r.result, 100)} (${ms}ms)` : `  ${cmd} !! ${r.code}: ${short(r.error, 100)}`;
        break;
      }
      case "ev": {
        const ev = String(r.ev);
        if (!opts.all && NOISE_EVENTS.has(ev)) { skipped++; continue; }
        text = `* ${ev} ${short(r.data ?? {}, 100)}`;
        break;
      }
      case "mark": {
        const what = String(r.what);
        const { t: _t, kind: _k, what: _w, ...rest } = r;
        text = `# ${what} ${short(rest, 120)}`;
        break;
      }
      default: continue;
    }
    if (re && !re.test(text)) continue;
    out(`${hhmm(r.t)} ${text}`);
    shown++;
  }
  out(`(${shown} lines${skipped ? `, ${skipped} noisy events hidden; --all to show` : ""})`);
}
