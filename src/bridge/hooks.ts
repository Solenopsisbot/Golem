// Generic outward hooks so an agent can be wired into anything: POST events to webhooks, or pipe
// them into a shell command. Configured per agent under [bridge]. Failures are logged, never fatal.
import { spawn } from "node:child_process";
import type { BridgeConfig } from "../config/schema.ts";
import type { Logger } from "../util/log.ts";

export interface HookEvent { t: number; type: string; agent: string; [k: string]: unknown }

function matches(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith("*") && type.startsWith(p.slice(0, -1))));
}

export function makeHookSink(agentName: string, cfg: BridgeConfig, log: Logger): (ev: { type: string; [k: string]: unknown }) => void {
  return (ev) => {
    const full: HookEvent = { t: Date.now(), agent: agentName, ...ev, type: ev.type };
    for (const w of cfg.webhooks) {
      if (!matches(w.events, full.type)) continue;
      fetch(w.url, { method: "POST", headers: { "content-type": "application/json", ...w.headers }, body: JSON.stringify(full) })
        .then((r) => { if (!r.ok) log.warn(`webhook ${w.url} -> ${r.status}`); })
        .catch((e) => log.warn(`webhook ${w.url} failed: ${(e as Error).message}`));
    }
    for (const c of cfg.commands) {
      if (!matches([c.on], full.type)) continue;
      try {
        const child = spawn("sh", ["-c", c.run], { stdio: ["pipe", "ignore", "inherit"] });
        child.stdin!.end(JSON.stringify(full));
        child.on("error", (e) => log.warn(`hook command failed: ${e.message}`));
      } catch (e) { log.warn(`hook command failed: ${(e as Error).message}`); }
    }
  };
}
