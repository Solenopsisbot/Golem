// Loads golem.toml, validates it, and resolves per-agent configs. Also owns the per-agent token
// file (data/<name>/tokens.json, mode 0600): Clef control token and Golem MCP bearer token.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { GolemConfigSchema, parseHostPort, type AgentConfig, type GolemConfig } from "./schema.ts";

export interface LoadedConfig {
  path: string;
  rootDir: string;   // directory containing golem.toml; relative paths resolve against it
  config: GolemConfig;
}

export function findConfig(explicit?: string): string {
  if (explicit) return resolve(explicit);
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "golem.toml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "golem.toml");
}

export function loadConfig(explicit?: string): LoadedConfig {
  const path = findConfig(explicit);
  if (!existsSync(path)) throw new Error(`no golem.toml found (looked for ${path})`);
  const raw = parseToml(readFileSync(path, "utf8"));
  const parsed = GolemConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid ${path}:\n${issues}`);
  }
  return { path, rootDir: dirname(path), config: parsed.data };
}

/** Drops undefined values so an agent override doesn't clobber a default with `undefined`. */
function defined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function agentNames(loaded: LoadedConfig): string[] {
  return loaded.config.agents.map((a) => a.name);
}

export function resolveAgent(loaded: LoadedConfig, name: string): AgentConfig {
  const { config, rootDir } = loaded;
  const index = config.agents.findIndex((a) => a.name === name);
  if (index < 0) throw new Error(`no agent named ${JSON.stringify(name)} in ${loaded.path} (have: ${agentNames(loaded).join(", ") || "none"})`);
  const a = config.agents[index]!;
  const dataRoot = resolve(rootDir, config.fleet.data_dir);
  const dataDir = resolve(dataRoot, a.name);
  const clef = { ...config.clef, ...defined(a.clef) };
  const server = parseHostPort(a.body.server ?? clef.server, 25565);
  const attach = a.body.attach ? parseHostPort(a.body.attach, clef.base_port) : undefined;
  const port = a.body.port ?? attach?.port ?? clef.base_port + index;
  const reflexesOn = a.reflexes?.on ?? config.reflexes.default_on;
  return {
    name: a.name,
    index,
    personaPath: a.persona ? resolve(rootDir, a.persona) : undefined,
    dataDir,
    workspaceDir: resolve(dataDir, "workspace"),
    clefDir: resolve(dataDir, "clef"),
    shotsDir: resolve(dataDir, "shots"),
    tracePath: resolve(dataDir, "trace.jsonl"),
    body: {
      username: a.body.username ?? a.name,
      attach,
      token: a.body.token,
      host: attach?.host ?? clef.control_host,
      port,
      server,
      max_heap: a.body.max_heap ?? clef.max_heap,
    },
    clef: { ...clef, launcher: resolve(rootDir, clef.launcher) },
    mind: { ...config.mind, ...defined(a.mind), budget: { ...config.mind.budget, ...defined(a.mind?.budget) }, models: { plan: { ...config.mind.models.plan, ...defined(a.mind?.models?.plan) }, act: { ...config.mind.models.act, ...defined(a.mind?.models?.act) } } },
    drive: { ...config.drive, ...defined(a.drive) },
    chat: { ...config.chat, ...defined(a.chat) },
    players: config.players,
    comms: { ...config.comms, ...defined(a.comms), conversations: { ...config.comms.conversations, ...defined(a.comms?.conversations) } },
    etiquette: { ...config.etiquette, ...defined(a.etiquette) },
    reflexes: { on: reflexesOn, allow_custom: a.reflexes?.allow_custom ?? config.reflexes.allow_custom },
    bridge: { ...config.bridge, ...defined(a.bridge) },
    fleet: config.fleet,
  };
}

export interface Tokens { clef: string; mcp: string }

export function tokenPath(agent: AgentConfig): string { return resolve(agent.dataDir, "tokens.json"); }

/** Reads data/<name>/tokens.json, creating it with fresh random tokens if missing. */
export function ensureTokens(agent: AgentConfig): Tokens {
  const path = tokenPath(agent);
  let t: Partial<Tokens> = {};
  if (existsSync(path)) {
    try { t = JSON.parse(readFileSync(path, "utf8")); } catch { t = {}; }
  }
  let dirty = false;
  if (!t.clef) { t.clef = agent.body.token ?? randomBytes(24).toString("base64url"); dirty = true; }
  if (!t.mcp) { t.mcp = randomBytes(24).toString("base64url"); dirty = true; }
  if (dirty) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(t, null, 2) + "\n");
    chmodSync(path, 0o600);
  }
  return t as Tokens;
}
