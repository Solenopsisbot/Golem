// golem.toml schema (zod 4). Sections under [clef], [mind], [drive], [chat], [players], [comms],
// [etiquette], [reflexes], [bridge] are fleet-wide defaults; each [[agents]] entry may override
// any of them section-by-section (shallow merge, see load.ts).
//
// Note: zod 4's `.default()` returns the default WITHOUT parsing it, so nested defaults would not
// fill in. `.prefault({})` parses the default through the schema, which is what we want for sections.
import { z } from "zod";

export const DurationString = z.string().regex(/^\d+(ms|s|m|h)$/, "duration like 500ms, 30s, 2m, 1h");
export const RateString = z.string().regex(/^\d+\/\d+(ms|s|m)$/, "rate like 1/3s");

export const FleetSection = z.object({
  name: z.string().default("golem"),
  data_dir: z.string().default("./data"),
  mcp_bind: z.string().default("127.0.0.1:8770"),
  /**
   * "none": the dashboard, bridge and fleet routes need no token when Golem is bound to loopback
   * (the mind's own MCP endpoint always needs its token). Bound to anything else, "none" is ignored
   * with a warning and tokens are required. "token": always require a bearer token.
   */
  dashboard_auth: z.enum(["none", "token"]).default("none"),
});

export const ClefSection = z.object({
  launcher: z.string().default("../MezzoSopranoClef/launcher/build/libs/mezzosopranoclef-launcher-0.1.0.jar"),
  java: z.string().default("java"),
  max_heap: z.string().default("768m"),
  server: z.string().default("127.0.0.1:25565"),
  auth: z.enum(["offline", "microsoft"]).default("offline"),
  screenshot_backend: z.enum(["software", "gl"]).default("software"),
  control_host: z.string().default("127.0.0.1"),
  base_port: z.number().int().default(8731),
});

/** A model choice for a kind of turn. `model` and `effort` are matched as substrings against what the agent advertises ("fable", "opus", "high"). Empty = leave the agent's default. */
export const ModelProfile = z.object({
  model: z.string().default(""),
  effort: z.string().default(""),
});

export const MindSection = z.object({
  command: z.string().default("npx"),
  args: z.array(z.string()).default(["-y", "@agentclientprotocol/claude-agent-acp"]),
  env: z.record(z.string(), z.string()).default({}),
  permission_mode: z.string().default("bypass"),
  allow_shell: z.boolean().default(true),
  /**
   * Context size (tokens) at which the harness's own auto-compaction runs. Claude Code compacts
   * near this window instead of near the model's real one, so a 1M-context model runs turns at
   * ~50-80k of context: cheaper per call, no long-context pricing tier, and compaction is the
   * summarisation the model was trained with. 0 = leave the harness default.
   */
  compact_window: z.number().int().default(100_000),
  model: z.string().default(""),
  effort: z.string().default(""),
  /** Two-tier model routing: `plan` turns (owner asks, deaths, goal changes, failures, every Nth turn, or when the agent calls plan_next) vs `act` turns (everything else). */
  models: z.object({
    plan: ModelProfile.prefault({ model: "fable", effort: "high" }),
    act: ModelProfile.prefault({ model: "opus", effort: "" }),
  }).prefault({}),
  budget: z.object({
    tokens_per_hour: z.number().default(2_000_000),
    turns_per_hour: z.number().default(120),
  }).prefault({}),
});

export const DriveSection = z.object({
  interrupt_priority: z.number().int().default(80),
  /** How a high-priority chat item reaches a busy mind: "queue" folds it into the running turn when
   *  the agent supports prompt queueing (no lost work); "cancel" ends the turn first. Deaths always cancel. */
  interrupt_mode: z.enum(["queue", "cancel"]).default("queue"),
  idle_wake: DurationString.default("90s"),
  /** Idle wake backs off (doubling) toward this when consecutive goal turns did nothing. */
  idle_wake_max: DurationString.default("10m"),
  /** Force a planning-model turn at least this often (turns). 0 = never by count. */
  plan_every: z.number().int().default(12),
  sleep_when_idle: z.boolean().default(true),
  cancel_runs_on_turn_cancel: z.boolean().default(false),
  inbox_max: z.number().int().default(40),
});

export const ChatSection = z.object({
  listen: z.enum(["all", "addressed", "owners"]).default("addressed"),
  address: z.array(z.string()).default(["{name}", "@{name}", "hey {name}"]),
  speech: z.enum(["explicit", "auto"]).default("explicit"),
  rate: RateString.default("1/3s"),
  max_len: z.number().int().default(200),
});

export const PlayersSection = z.object({
  owners: z.array(z.string()).default([]),
  trusted: z.array(z.string()).default([]),
  ignored: z.array(z.string()).default([]),
});

export const CommsSection = z.object({
  agents: z.enum(["bus", "chat", "both"]).default("bus"),
  conversations: z.object({
    max_turns: z.number().int().default(12),
    cooldown: DurationString.default("2m"),
  }).prefault({}),
  fleets: z.array(z.string()).default([]),
  /** One chest/place index for the whole fleet (data/shared/world), linked into every workspace as world/shared. */
  share_world: z.boolean().default(true),
});

export const RegionSchema = z.object({
  name: z.string(),
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()]),
});

export const EtiquetteSection = z.object({
  pvp: z.enum(["never", "defend", "always"]).default("defend"),
  protected_regions: z.array(RegionSchema).default([]),
  slash_commands: z.array(z.string()).default(["msg", "tell", "w", "home", "spawn", "sethome"]),
  no_grief_players: z.boolean().default(true),
});

export const ReflexesSection = z.object({
  default_on: z.array(z.string()).default([
    "auto_respawn", "bunker", "self_preservation", "unstuck", "auto_eat", "item_collecting", "idle_staring",
  ]),
  allow_custom: z.boolean().default(false),
});

/** Generic hooks so a persona/agent can be wired into anything (Discord, Ayusami, a web page...). */
export const BridgeSection = z.object({
  /** Expose POST /agents/<name>/inbox, /say and GET /agents/<name>/events (SSE) on the Golem HTTP port. */
  http: z.boolean().default(true),
  /** POST every matching event as JSON to these URLs. `events: ["*"]` for everything. */
  webhooks: z.array(z.object({
    url: z.string(),
    events: z.array(z.string()).default(["*"]),
    headers: z.record(z.string(), z.string()).default({}),
  })).default([]),
  /** Run a shell command on an event; the event JSON is on stdin. */
  commands: z.array(z.object({ on: z.string(), run: z.string() })).default([]),
});

export const AgentEntry = z.object({
  name: z.string().min(1),
  persona: z.string().optional(),
  body: z.object({
    username: z.string().optional(),
    /** "host:port" of an already-running body instead of spawning one. */
    attach: z.string().optional(),
    token: z.string().optional(),
    port: z.number().int().optional(),
    server: z.string().optional(),
    max_heap: z.string().optional(),
  }).prefault({}),
  clef: ClefSection.partial().optional(),
  mind: MindSection.partial().optional(),
  drive: DriveSection.partial().optional(),
  chat: ChatSection.partial().optional(),
  comms: CommsSection.partial().optional(),
  etiquette: EtiquetteSection.partial().optional(),
  reflexes: z.object({
    on: z.array(z.string()).optional(),
    allow_custom: z.boolean().optional(),
  }).optional(),
  bridge: BridgeSection.partial().optional(),
});

export const EvalSection = z.object({
  rcon: z.string().default("127.0.0.1:25576"),
  /** File holding the RCON password (default: the dev server's). */
  rcon_password_file: z.string().default("./data/server/rcon.password"),
  results_dir: z.string().default("./data/eval"),
});

export const GolemConfigSchema = z.object({
  eval: EvalSection.prefault({}),
  fleet: FleetSection.prefault({}),
  clef: ClefSection.prefault({}),
  mind: MindSection.prefault({}),
  drive: DriveSection.prefault({}),
  chat: ChatSection.prefault({}),
  players: PlayersSection.prefault({}),
  comms: CommsSection.prefault({}),
  etiquette: EtiquetteSection.prefault({}),
  reflexes: ReflexesSection.prefault({}),
  bridge: BridgeSection.prefault({}),
  agents: z.array(AgentEntry).default([]),
});

export type GolemConfig = z.infer<typeof GolemConfigSchema>;
export type ClefConfig = z.infer<typeof ClefSection>;
export type MindConfig = z.infer<typeof MindSection>;
export type DriveConfig = z.infer<typeof DriveSection>;
export type ChatConfig = z.infer<typeof ChatSection>;
export type PlayersConfig = z.infer<typeof PlayersSection>;
export type CommsConfig = z.infer<typeof CommsSection>;
export type EtiquetteConfig = z.infer<typeof EtiquetteSection>;
export type BridgeConfig = z.infer<typeof BridgeSection>;
export type Region = z.infer<typeof RegionSchema>;

/** Fully resolved per-agent configuration: fleet defaults merged with the agent's overrides. */
export interface AgentConfig {
  name: string;
  index: number;
  personaPath: string | undefined;
  dataDir: string;        // data/<name>
  workspaceDir: string;   // data/<name>/workspace
  clefDir: string;        // data/<name>/clef (game dir)
  shotsDir: string;       // data/<name>/shots
  tracePath: string;      // data/<name>/trace.jsonl
  sharedWorldDir: string | undefined;   // data/shared/world when comms.share_world; every agent in the fleet reads and writes it
  body: {
    username: string;
    attach: { host: string; port: number } | undefined;
    token: string | undefined;
    host: string;
    port: number;
    server: { host: string; port: number };
    max_heap: string;
  };
  clef: ClefConfig;
  mind: MindConfig;
  drive: DriveConfig;
  chat: ChatConfig;
  players: PlayersConfig;
  comms: CommsConfig;
  etiquette: EtiquetteConfig;
  reflexes: { on: string[]; allow_custom: boolean };
  bridge: BridgeConfig;
  fleet: z.infer<typeof FleetSection>;
}

/** Parses "500ms" | "30s" | "2m" | "1h" into milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s);
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60_000, h: n * 3_600_000 }[m[2] as "ms" | "s" | "m" | "h"];
}

/** Parses "1/3s" into { count, perMs }. */
export function parseRate(s: string): { count: number; perMs: number } {
  const m = /^(\d+)\/(\d+)(ms|s|m)$/.exec(s);
  if (!m) throw new Error(`bad rate: ${s}`);
  return { count: Number(m[1]), perMs: parseDuration(`${m[2]}${m[3]}`) };
}

export function parseHostPort(s: string, defaultPort: number): { host: string; port: number } {
  const i = s.lastIndexOf(":");
  if (i < 0) return { host: s, port: defaultPort };
  const port = Number(s.slice(i + 1));
  return { host: s.slice(0, i) || "127.0.0.1", port: Number.isFinite(port) ? port : defaultPort };
}
