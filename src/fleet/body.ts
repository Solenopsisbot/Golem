// Spawning a MezzoSopranoClef body from the standalone launcher jar, one game dir per agent.
// The launcher downloads Minecraft + Fabric into CLEF_GAMEDIR on first run (minutes), then boots
// the headless client, which reads config/mezzoclef.json from that dir.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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

/** Direct children of a pid (pgrep -P), empty when none or when pgrep is missing. */
function childrenOf(pid: number): number[] {
  try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}
/** The pid and every descendant, deepest last. The launcher's JVM child is the one holding the port. */
function processTree(pid: number): number[] {
  const out = [pid];
  for (const c of childrenOf(pid)) out.push(...processTree(c));
  return out;
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

/** Pids listening on a local TCP port (lsof), empty when none. */
export function portHolders(port: number): number[] {
  try { return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number); }
  catch { return []; }
}
function commandOf(pid: number): string {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; }
}
function looksLikeClef(pid: number): boolean { return /mezzoclef|launcher\.jar|fabric|minecraft/i.test(commandOf(pid)); }

/**
 * Kill a body's whole process tree: SIGTERM first, SIGKILL after `graceMs`, and wait until the
 * control port is free so the next launch (or a sibling process) can't attach to a corpse.
 * SIGTERM to the launcher alone used to orphan the JVM under it, which kept the port and the
 * username and got the fresh body kicked with "logged in from another location".
 */
export async function killTree(rootPid: number, port: number | undefined, graceMs = 6000): Promise<void> {
  const pids = processTree(rootPid);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  const t0 = Date.now();
  while (Date.now() - t0 < graceMs && pids.some(alive)) await new Promise((r) => setTimeout(r, 200));
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  if (port !== undefined) {
    const t1 = Date.now();
    while (Date.now() - t1 < 5000 && portHolders(port).length) await new Promise((r) => setTimeout(r, 200));
  }
}

export function killBody(agent: AgentConfig): boolean {
  const pid = isBodyRunning(agent);
  if (!pid) return false;
  void killTree(pid, agent.body.port);
  return true;
}

/**
 * A body's control port must be ours to take. A stale Clef holding it (an orphan from an earlier
 * run) is killed; anything else is an error naming the holder, because attaching to the wrong
 * process wastes ninety seconds of "joining the world" per attempt.
 */
export async function ensurePortFree(agent: AgentConfig): Promise<void> {
  const holders = portHolders(agent.body.port);
  if (!holders.length) return;
  const stale = holders.filter(looksLikeClef);
  if (stale.length !== holders.length) throw new Error(`${agent.name}: port ${agent.body.port} is held by pid(s) ${holders.join(", ")} (${holders.map(commandOf).join(" | ").slice(0, 120)}), not a Clef body; pick another base_port or stop it`);
  log.warn(`${agent.name}: port ${agent.body.port} held by stale Clef pid(s) ${stale.join(", ")}; killing before launch`);
  for (const pid of stale) await killTree(pid, agent.body.port);
  if (portHolders(agent.body.port).length) throw new Error(`${agent.name}: port ${agent.body.port} still held after killing stale bodies`);
}

export interface Supervisor {
  stop(): Promise<void>;
  /** Synchronous SIGKILL of the whole tree, for a shutdown that has run out of time. */
  killNow(): void;
  readonly child: ChildProcess | undefined;
}

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
  const launch = async () => {
    if (stopped) return;
    try { await ensurePortFree(agent); } catch (e) { log.error(`${agent.name}: ${(e as Error).message}`); return; }
    if (stopped) return;
    child = spawnBody(agent);
    child.once("exit", (code, sig) => {
      if (stopped) return;
      const now = Date.now();
      while (restarts.length && now - restarts[0]! > 3_600_000) restarts.shift();
      if (restarts.length >= maxPerHour) { log.error(`${agent.name}: body died ${restarts.length} times this hour; not restarting`); return; }
      restarts.push(now);
      log.warn(`${agent.name}: body exited (${code ?? sig}); relaunching in ${delay / 1000}s`);
      setTimeout(() => { void launch(); }, delay);
    });
  };
  void launch();
  return {
    async stop() {
      stopped = true;
      if (!child?.pid) return;
      log.info(`${agent.name}: stopping body tree ${processTree(child.pid).join(",")}`);
      await killTree(child.pid, agent.body.port);
      log.info(`${agent.name}: body stopped, port ${agent.body.port} ${portHolders(agent.body.port).length ? "STILL HELD" : "free"}`);
    },
    killNow() { stopped = true; if (child?.pid) for (const pid of processTree(child.pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } },
    get child() { return child; },
  };
}
