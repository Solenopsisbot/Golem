// Spawning a MezzoSopranoClef body from the standalone launcher jar, one game dir per agent.
// The launcher downloads Minecraft + Fabric into CLEF_GAMEDIR on first run (minutes), then boots
// the headless client, which reads config/mezzoclef.json from that dir.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig } from "../config/schema.ts";
import { ensureTokens } from "../config/load.ts";
import { makeLog } from "../util/log.ts";

const log = makeLog("fleet");

/** Write (or update) the body's mezzoclef.json so it matches the agent's config and token. */
export function ensureBodyConfig(agent: AgentConfig): string {
  const tokens = ensureTokens(agent);
  const dir = resolve(agent.clefDir, "config");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "mezzoclef.json");
  let cfg: Record<string, any> = {};
  if (existsSync(path)) { try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch { cfg = {}; } }
  cfg.auth = { ...(cfg.auth ?? {}), mode: agent.clef.auth, offlineUsername: agent.body.username };
  cfg.connection = {
    ...(cfg.connection ?? {}),
    autoConnect: true, serverHost: agent.body.server.host, serverPort: agent.body.server.port, autoRespawn: true,
  };
  cfg.control = {
    ...(cfg.control ?? {}),
    enabled: true, host: agent.body.host, port: agent.body.port, authToken: tokens.clef, auditLog: true,
  };
  cfg.screenshot = { ...(cfg.screenshot ?? {}), backend: agent.clef.screenshot_backend, defaultWidth: 960, defaultHeight: 540, maxRayDistance: 96 };
  cfg.headless = true;
  cfg.noGl = agent.clef.screenshot_backend !== "gl";
  cfg.headlessLoopSleepMs = cfg.headlessLoopSleepMs ?? 10;
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return path;
}

/** Copies the launcher jar into data/clef/ (so a rebuild in the sibling repo can't yank it mid-run). */
export function stageLauncher(agent: AgentConfig): string {
  const src = agent.clef.launcher;
  if (!existsSync(src)) throw new Error(`launcher jar not found: ${src} (build it with ./gradlew :launcher:jar in MezzoSopranoClef)`);
  const dstDir = resolve(agent.dataDir, "..", "clef");
  mkdirSync(dstDir, { recursive: true });
  const dst = resolve(dstDir, "launcher.jar");
  if (!existsSync(dst) || statSync(src).mtimeMs > statSync(dst).mtimeMs) copyFileSync(src, dst);
  return dst;
}

export function bodyLogPath(agent: AgentConfig): string { return resolve(agent.dataDir, "clef.log"); }
export function bodyPidPath(agent: AgentConfig): string { return resolve(agent.dataDir, "clef.pid"); }

export function isBodyRunning(agent: AgentConfig): number | null {
  const p = bodyPidPath(agent);
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, "utf8").trim());
  if (!Number.isFinite(pid)) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

/** Launch the body. Returns the child; stdout/stderr go to data/<agent>/clef.log. */
export function spawnBody(agent: AgentConfig): ChildProcess {
  ensureBodyConfig(agent);
  const jar = stageLauncher(agent);
  mkdirSync(agent.dataDir, { recursive: true });
  const out = openSync(bodyLogPath(agent), "a");
  // "TRUE" not "true": MezzoSopranoClef's own verify scripts `pkill -f "mezzoclef.headless=true"`
  // between runs, which also matched our bodies. Boolean.parseBoolean is case-insensitive; pkill is
  // not. The launcher forwards -Dmezzoclef.* flags to the client verbatim and skips adding its own
  // when one is present.
  const child = spawn(agent.clef.java, ["-Dmezzoclef.headless=TRUE", "-jar", jar], {
    cwd: agent.dataDir,
    env: { ...process.env, CLEF_GAMEDIR: agent.clefDir, CLEF_MAX_HEAP: agent.body.max_heap, CLEF_BG_THREADS: "4" },
    stdio: ["ignore", out, out],
    detached: false,
  });
  if (child.pid) writeFileSync(bodyPidPath(agent), String(child.pid));
  log.info(`${agent.name}: body pid ${child.pid} (log ${bodyLogPath(agent)})`);
  child.on("exit", (code, sig) => log.warn(`${agent.name}: body exited (${code ?? sig})`));
  return child;
}

export function killBody(agent: AgentConfig): boolean {
  const pid = isBodyRunning(agent);
  if (!pid) return false;
  try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
}

export interface Supervisor { stop(): void; readonly child: ChildProcess | undefined }

/**
 * Keep a body alive: relaunch it `restartDelayMs` after it exits for any reason we didn't ask for.
 * Something else on the machine sending SIGTERM (a sibling project's test cleanup, say) should cost
 * us a minute, not the session. The BodyClient reconnects on its own once the port is back.
 */
export function superviseBody(agent: AgentConfig, opts: { restartDelayMs?: number; maxRestartsPerHour?: number } = {}): Supervisor {
  const delay = opts.restartDelayMs ?? 5000;
  const maxPerHour = opts.maxRestartsPerHour ?? 20;
  const restarts: number[] = [];
  let stopped = false;
  let child: ChildProcess | undefined;
  const launch = () => {
    if (stopped) return;
    child = spawnBody(agent);
    child.once("exit", (code, sig) => {
      if (stopped) return;
      const now = Date.now();
      while (restarts.length && now - restarts[0]! > 3_600_000) restarts.shift();
      if (restarts.length >= maxPerHour) { log.error(`${agent.name}: body died ${restarts.length} times this hour; not restarting`); return; }
      restarts.push(now);
      log.warn(`${agent.name}: body exited (${code ?? sig}); relaunching in ${delay / 1000}s`);
      setTimeout(launch, delay);
    });
  };
  launch();
  return {
    stop() { stopped = true; if (child?.pid) { try { process.kill(child.pid, "SIGTERM"); } catch { /* gone */ } } },
    get child() { return child; },
  };
}
