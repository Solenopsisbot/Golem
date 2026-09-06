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

export const MindSection = z.object({
  command: z.string().default("npx"),
  args: z.array(z.string()).default(["-y", "@agentclientprotocol/claude-agent-acp"]),
  env: z.record(z.string(), z.string()).default({}),
  permission_mode: z.string().default("bypass"),
  allow_shell: z.boolean().default(true),
  model: z.string().default(""),
  effort: z.string().default(""),
  budget: z.object({
    tokens_per_hour: z.number().default(2_000_000),
    turns_per_hour: z.number().default(120),
  }).prefault({}),
});

export const DriveSection = z.object({
  interrupt_priority: z.number().int().default(80),
  idle_wake: DurationString.default("90s"),
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
    "auto_respawn", "self_preservation", "unstuck", "auto_eat", "item_collecting", "idle_staring",
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

export const GolemConfigSchema = z.object({
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
