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
  /**
   * Archive the agent's own shem/ scripts before the run, so it starts from the shipped library.
   * A fresh mind with a workspace full of its previous attempts is not a fresh run: the scripts are
   * listed in its orientation, so run N inherits run N-1's habits and the results stop comparing.
   * Off by default — accumulating scripts is the point in normal play, just not in a measurement.
   */
  fresh_workspace: z.boolean().default(false),
  setup: z.object({
    /** Server commands via RCON, run in order before the task. `{bot}` is replaced with the bot's username. */
    commands: z.array(z.string()).default([]),
    clear_inventory: z.boolean().default(true),
    /**
     * Keep the bot's gear through death. On by default, because a combat rung that strips the bot on
     * every death makes each retry strictly worse than the last and measures despair rather than
     * skill.
     *
     * Turn it OFF to make dying actually cost something: the bot drops everything where it fell and
     * has to go and get it back, which is the real game and which makes "minimal deaths" mean what
     * it sounds like. Expect a rung to need a way home before this is fair - a bed sets the
     * overworld spawn, and beds explode in the Nether and the End.
     */
    keep_inventory: z.boolean().default(true),
    teleport: Pos.optional(),
    /** `spreadplayers x z 1 range`: put the bot on safe surface ground within `range` of (x, z). */
    spread: z.tuple([z.number(), z.number(), z.number()]).optional(),
    time: z.enum(["day", "noon", "night", "midnight"]).optional(),
    weather: z.enum(["clear", "rain", "thunder"]).optional(),
    gamemode: z.enum(["survival", "creative"]).optional(),
    give: z.array(z.string()).default([]),   // "oak_log 8", "iron_pickaxe"
    /** Move the bot to another dimension first: spreadplayers on the End island, or a plain tp elsewhere. */
    dimension: z.enum(["overworld", "the_nether", "the_end"]).optional(),
    /**
     * Put the bot near the nearest structure of this kind (server `locate`), in `dimension` if set.
     * `spread` (default) uses spreadplayers within `radius` blocks of the structure's origin, which only
     * picks solid, non-lava footing (under the bedrock roof in the Nether); `spread: false` is a raw
     * tp to `y`, which in the Nether is usually inside a wall or over lava.
     */
    locate: z.object({ structure: z.string(), y: z.number().default(70), offset: z.number().default(0), spread: z.boolean().default(true), radius: z.number().default(12) }).optional(),
    /**
     * Build a sealed, lit stone arena and stand the bot in the middle of it. This sidesteps the
     * terrain lottery for combat rungs: real generated ground in the Nether (magma over a lava sea)
     * or a wild structure often kills the bot on arrival before it can act. The arena is a solid
     * stone shell with a hollow, glowstone-ceilinged interior, so nothing intrudes and nothing spawns.
     * `summon` mobs then appear inside it next to the bot.
     */
    arena: z.object({
      dimension: z.enum(["overworld", "the_nether", "the_end"]).default("the_nether"),
      center: z.tuple([z.number(), z.number(), z.number()]),
      half: z.number().default(6),     // interior half-width in blocks
      height: z.number().default(5),   // interior height in blocks
    }).optional(),
    /**
     * Build a lit stone room in the overworld with a working 3x3 end portal, and stand the bot in it.
     *
     * This is the way home for a rung that turns `keep_inventory` off. Dying then drops the bot's
     * gear where it fell, which is the point - but a death also has to be survivable as a setback
     * rather than as the end of the run, and the End has no respawn of its own. So the overworld
     * spawn is set here, three blocks from a portal the bot can walk back through.
     *
     * The portal is built rather than found. A stronghold's own portal needs twelve eyes and sits at
     * coordinates that differ per world; none of that is what the rung is measuring, and `end_portal`
     * blocks placed directly work exactly like the real thing (verified - a pig stood in one and
     * arrived in the End on the next tick).
     */
    portal_room: z.object({
      center: z.tuple([z.number(), z.number(), z.number()]).default([200, 70, 200]),
      /**
       * Stock a chest by the portal with `spares` more copies of the `give` kit.
       *
       * Without this, one early death ends the rung rather than setting it back. Tester lost its
       * diamond kit to an enderman four minutes in, the drops despawned while it walked to the wrong
       * dimension, and it spent the rest of the run trying to rebuild from two jungle logs on normal
       * difficulty - which is not a dragon fight, and not a measurement of anything the rung is for.
       *
       * A real player who dies to the dragon goes back to a base with spare gear. This is that base.
       * Death still costs a trip and a kit, so "minimal deaths" keeps its teeth; it just stops one
       * bad minute from deciding the whole run.
       */
      spares: z.number().int().min(0).default(2),
    }).optional(),
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
