// Eval tasks: a goal for the mind, a world reset, a success predicate, a clock. Results are how we
// know a change to the library, the prompts or the model routing helped.
import { z } from "zod";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const Pos = z.tuple([z.number(), z.number(), z.number()]);

export const PredicateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inventory"), item: z.string(), count: z.number().int().min(1).default(1) }),
  z.object({ type: z.literal("block"), pos: Pos, block: z.string() }),
  z.object({ type: z.literal("near"), pos: Pos, radius: z.number().default(3) }),
  z.object({ type: z.literal("said"), includes: z.string() }),
  z.object({ type: z.literal("alive") }),
  z.object({ type: z.literal("script_exists"), name: z.string() }),
  /** The bot is in this dimension ("the_nether", "the_end", "overworld"). */
  z.object({ type: z.literal("dimension"), is: z.string() }),
  /** A server command's reply must contain `expect` (and not contain `absent`). "execute if entity @e[type=ender_dragon]" replies "Test passed"/"Test failed". */
  z.object({ type: z.literal("rcon"), command: z.string(), expect: z.string().optional(), absent: z.string().optional() }),
]);
export type Predicate = z.infer<typeof PredicateSchema>;

export const TaskSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  /** The standing goal the mind gets (as an owner message). */
  goal: z.string(),
  timeout_s: z.number().min(30).max(7200).default(600),
  /** Fresh mind session per task (default) so earlier tasks don't leak context. */
  fresh_session: z.boolean().default(true),
  setup: z.object({
    /** Server commands via RCON, run in order before the task. `{bot}` is replaced with the bot's username. */
    commands: z.array(z.string()).default([]),
    clear_inventory: z.boolean().default(true),
    teleport: Pos.optional(),
    /** `spreadplayers x z 1 range`: put the bot on safe surface ground within `range` of (x, z). */
    spread: z.tuple([z.number(), z.number(), z.number()]).optional(),
    time: z.enum(["day", "noon", "night", "midnight"]).optional(),
    weather: z.enum(["clear", "rain", "thunder"]).optional(),
    gamemode: z.enum(["survival", "creative"]).optional(),
    give: z.array(z.string()).default([]),   // "oak_log 8", "iron_pickaxe"
    /** Move the bot to another dimension first: spreadplayers on the End island, or a plain tp elsewhere. */
    dimension: z.enum(["overworld", "the_nether", "the_end"]).optional(),
    /** Teleport near the nearest structure of this kind (server `locate`), in `dimension` if set. */
    locate: z.object({ structure: z.string(), y: z.number().default(70), offset: z.number().default(0) }).optional(),
    /** Summon mobs next to the bot after everything else: "enderman 3". */
    summon: z.array(z.string()).default([]),
  }).prefault({}),
  /** All predicates must hold at the same check for success. */
  success: z.array(PredicateSchema).min(1),
  /** Any of these ends the task as failed early. */
  fail: z.array(PredicateSchema).default([]),
  tags: z.array(z.string()).default([]),
});
export type Task = z.infer<typeof TaskSchema>;

export function loadTasks(pathOrDir: string): { path: string; task: Task }[] {
  const abs = resolve(pathOrDir);
  const files = statSync(abs).isDirectory()
    ? readdirSync(abs).filter((f) => extname(f) === ".json").sort().map((f) => join(abs, f))
    : [abs];
  return files.map((path) => {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = TaskSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    if (!parsed.data.name) parsed.data.name = basename(path, ".json");
    return { path, task: parsed.data };
  });
}

export interface TaskResult {
  name: string;
  path: string;
  status: "success" | "failed" | "timeout" | "error";
  seconds: number;
  turns: number;
  toolCalls: number;
  tokens: number;
  deaths: number;
  detail: string;
  startedAt: number;
  endedAt: number;
  model: { plan: string; act: string };
}
