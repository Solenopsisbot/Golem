// The eval runner: for each task, reset the world over RCON, start a session with a fresh mind,
// hand the goal over as an owner message, watch the predicates, record the result.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentSession } from "../agent/session.ts";
import type { LoadedConfig } from "../config/load.ts";
import { resolveAgent } from "../config/load.ts";
import { parseHostPort } from "../config/schema.ts";
import { GolemHttpHost } from "../mcp/server.ts";
import { fullId } from "../primitives/context.ts";
import { dist } from "../util/geom.ts";
import { makeLog } from "../util/log.ts";
import { Rcon } from "./rcon.ts";
import type { Predicate, Task, TaskResult } from "./task.ts";

const log = makeLog("eval");

export interface RunnerOptions { agentName: string; loaded: LoadedConfig; host: GolemHttpHost; fresh?: boolean; label?: string }

export class EvalRunner {
  private readonly opts: RunnerOptions;
  private rcon: Rcon | undefined;
  /** The session of the task in flight, so close() (Ctrl-C) can stop it instead of hanging on the mind. */
  private active: AgentSession | undefined;
  private aborted = false;
  constructor(opts: RunnerOptions) { this.opts = opts; }

  private async rconConnect(): Promise<Rcon> {
    if (this.rcon) return this.rcon;
    const { config, rootDir } = this.opts.loaded;
    const { host, port } = parseHostPort(config.eval.rcon, 25576);
    const pwFile = resolve(rootDir, config.eval.rcon_password_file);
    if (!existsSync(pwFile)) throw new Error(`no RCON password file at ${pwFile}; start the dev server with scripts/dev-server.sh (it enables RCON)`);
    const r = new Rcon(host, port, readFileSync(pwFile, "utf8").trim());
    await r.connect();
    this.rcon = r;
    return r;
  }

  private async reset(task: Task, bot: string): Promise<void> {
    const r = await this.rconConnect();
    const run = async (c: string) => { const out = await r.command(c.replace(/\{bot\}/g, bot)); log.debug(`rcon ${c} -> ${out.slice(0, 80)}`); };
    const s = task.setup;
    // Keep gear through death: a combat rung that respawns the bot into the fight must not strip it
    // to an empty inventory each death, or every retry is worse than the last. Also stop mobs from
    // burning up the moment they are summoned onto lit ground far from natural spawns.
    await run(`gamerule keepInventory true`);
    // A safe fallback respawn: a lit sky platform at (0, 200, 0). Without this, a death in a hostile
    // dimension dumps the bot at the overworld world-spawn, which on the shared dev world is a
    // night killing-floor, and it death-loops there instead of failing the rung cleanly. The
    // sea-lantern floor is light 15, so nothing spawns on it.
    await run(`execute in minecraft:overworld run fill -1 199 -1 1 199 1 minecraft:sea_lantern`);
    await run(`execute in minecraft:overworld run fill -1 200 -1 1 202 1 minecraft:air`);
    await run(`execute in minecraft:overworld run spawnpoint ${bot} 0 200 0`);
    if (s.gamemode) await run(`gamemode ${s.gamemode} ${bot}`);
    if (s.clear_inventory) await run(`clear ${bot}`);
    if (s.teleport) await run(`tp ${bot} ${s.teleport.join(" ")}`);
    if (s.spread) await run(`spreadplayers ${s.spread[0]} ${s.spread[1]} 1 ${s.spread[2]} false ${bot}`);
    if (s.arena) {
      const [cx, cy, cz] = s.arena.center, h = s.arena.half, ht = s.arena.height, adim = `minecraft:${s.arena.dimension}`;
      // fill silently does nothing in an unloaded chunk, and the arena is far from any player, so
      // force-load the span first; otherwise the bot arrives embedded in the original terrain and
      // the summoned mobs suffocate. Released at the end of setup.
      await run(`execute in ${adim} run forceload add ${cx - h - 1} ${cz - h - 1} ${cx + h + 1} ${cz + h + 1}`);
      // Kill any mob left inside from a previous run (blazes get sealed in and otherwise pile up),
      // and any hostile the terrain trapped, before we (re)build and summon.
      await run(`execute in ${adim} run kill @e[type=!minecraft:player,x=${cx - h - 2},y=${cy - 3},z=${cz - h - 2},dx=${2 * h + 4},dy=${ht + 6},dz=${2 * h + 4}]`);
      // Solid shell, then hollow interior, then a glowstone ceiling so it is fully lit.
      await run(`execute in ${adim} run fill ${cx - h - 1} ${cy - 1} ${cz - h - 1} ${cx + h + 1} ${cy + ht + 1} ${cz + h + 1} minecraft:stone`);
      await run(`execute in ${adim} run fill ${cx - h} ${cy} ${cz - h} ${cx + h} ${cy + ht} ${cz + h} minecraft:air`);
      await run(`execute in ${adim} run fill ${cx - h} ${cy + ht} ${cz - h} ${cx + h} ${cy + ht} ${cz + h} minecraft:glowstone`);
      await run(`execute in ${adim} run tp ${bot} ${cx + 0.5} ${cy} ${cz + 0.5}`);
      // Respawn back into the arena (not the overworld sky platform), so a death returns the bot to
      // the fight instead of stranding it a dimension away. The arena is lit and sealed, so the only
      // thing that can kill it there is the mobs it is meant to be fighting.
      await run(`execute in ${adim} run spawnpoint ${bot} ${cx} ${cy} ${cz}`);
      log.info(`built a ${2 * h + 1}×${ht}×${2 * h + 1} arena at ${cx},${cy},${cz} in ${s.arena.dimension}`);
    }
    const dim = s.dimension ? `minecraft:${s.dimension}` : undefined;
    if (s.arena) { /* arena placed the bot; skip structure/dimension placement */ }
    else if (s.locate) {
      // "The nearest minecraft:fortress is at [X, ~, Z] (N blocks away)"; the source position matters, so give it one.
      const out = await r.command(`execute ${dim ? `in ${dim} ` : ""}positioned 0 64 0 run locate structure minecraft:${s.locate.structure}`);
      const m = out.match(/\[(-?\d+),\s*~?-?\d*,\s*(-?\d+)\]/);
      if (!m) throw new Error(`locate ${s.locate.structure} failed: ${out.slice(0, 120)}`);
      const x = Number(m[1]) + s.locate.offset, z = Number(m[2]) + s.locate.offset;
      if (dim === "minecraft:the_nether") {
        // The Nether has no safe "surface": spreadplayers lands on magma bridges over lava and the bot
        // burns to death before it can move. Neutralise the hazard around the structure instead of
        // trusting the terrain: clear lava and magma from a generous box (lava outside can't reach the
        // centre), lay a solid floor, clear standing room, and stand the bot on it. The fortress
        // (nether brick) is left intact a few blocks away for the bot to walk to.
        const y = s.locate.y;
        log.info(`located ${s.locate.structure} at ${x},${z}; clearing lava and building a pad at y${y}`);
        await run(`execute in ${dim} run fill ${x - 6} ${y - 3} ${z - 6} ${x + 6} ${y + 5} ${z + 6} minecraft:netherrack replace minecraft:lava`);
        await run(`execute in ${dim} run fill ${x - 6} ${y - 3} ${z - 6} ${x + 6} ${y + 5} ${z + 6} minecraft:air replace minecraft:magma_block`);
        await run(`execute in ${dim} run fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y - 1} ${z + 3} minecraft:netherrack`);
        await run(`execute in ${dim} run fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y + 2} ${z + 3} minecraft:air`);
        await run(`execute in ${dim} run tp ${bot} ${x + 0.5} ${y} ${z + 0.5}`);
      } else if (s.locate.spread) {
        log.info(`located ${s.locate.structure} at ${x},${z}; spreading nearby`);
        await run(`execute ${dim ? `in ${dim} ` : ""}run spreadplayers ${x} ${z} 1 ${s.locate.radius} false ${bot}`);
      } else {
        log.info(`located ${s.locate.structure} at ${x},${z}; teleporting`);
        await run(`execute ${dim ? `in ${dim} ` : ""}run tp ${bot} ${x} ${s.locate.y} ${z}`);
      }
      // Respawn where it started, next to the structure, not at the far sky platform: a death diving
      // a stronghold otherwise strands the bot hundreds of blocks away with no way back.
      await run(`execute at ${bot} run spawnpoint ${bot} ~ ~ ~`);
    } else if (dim === "minecraft:the_end") {
      await run(`execute in ${dim} run spreadplayers 0 0 5 60 false ${bot}`);   // safe ground on the main island
      // Respawn in the dimension the rung put you in. Without this a death in the End sends the bot
      // to the overworld sky platform, a dimension and a thousand blocks from the fight, and the run
      // is over however much time is left on the clock.
      await run(`execute at ${bot} run spawnpoint ${bot} ~ ~ ~`);
    } else if (dim) {
      await run(`execute in ${dim} run tp ${bot} ~ 70 ~`);
      await run(`execute at ${bot} run spawnpoint ${bot} ~ ~ ~`);
    }
    // Wherever the bot landed, take the magma and fire out from under it: spreadplayers counts a
    // magma block as solid footing, and a bot that starts on one loses a heart a second.
    if (s.locate || dim || s.spread || s.teleport) {
      await run(`execute at ${bot} run fill ~-2 ~-1 ~-2 ~2 ~-1 ~2 ${dim === "minecraft:the_nether" ? "minecraft:netherrack" : "minecraft:stone"} replace minecraft:magma_block`);
      await run(`execute at ${bot} run fill ~-2 ~ ~-2 ~2 ~2 ~2 minecraft:air replace minecraft:fire`);
      await run(`execute at ${bot} run fill ~-2 ~ ~-2 ~2 ~2 ~2 minecraft:air replace minecraft:soul_fire`);
    }
    if (s.time) await run(`time set ${s.time}`);
    if (s.weather) await run(`weather ${s.weather}`);
    // Armour in the give list is worn, not just dropped in the bag: with keepInventory a bot that
    // starts and respawns already armoured can survive the opening seconds of a swarm long enough to
    // fight back, instead of dying unarmoured before it can equip anything.
    // Armour only. A carved pumpkin is head gear mechanically, but wearing one is a *tactic* (endermen
    // ignore a pumpkin-wearer's gaze), and pre-wearing it hands the agent the answer to the End's main
    // hazard. Give it in the bag and let the agent work out what it is for.
    const ARMOR: Record<string, string> = { helmet: "head", chestplate: "chest", leggings: "legs", boots: "feet" };
    const wear: { slot: string; item: string }[] = [];
    for (const g of s.give) {
      const bare = g.split(/\s+/)[0]!.replace(/^minecraft:/, "");
      const piece = Object.keys(ARMOR).find((k) => bare.endsWith(k));
      if (piece) wear.push({ slot: ARMOR[piece]!, item: bare });
      else await run(`give ${bot} ${g.startsWith("minecraft:") ? g : "minecraft:" + g}`);
    }
    for (const c of s.commands) await run(c);
    for (const sm of s.summon) {
      const parts = sm.split(/\s+/);
      const mob = parts[0]!, count = Number(parts[1] ?? 1);
      // Optional "hp<N>" token weakens the mob (a teleporting enderman with 40 hp out-teleports a
      // turn-based attacker; at 7 hp one sword blow kills it before it can flee). PersistenceRequired
      // always, so nothing despawns mid-fight.
      const hp = Number(/(?:^|\s)hp(\d+)/.exec(sm)?.[1] ?? 0);
      const nbt = hp > 0 ? `{PersistenceRequired:1b,Health:${hp}f,Attributes:[{id:"minecraft:generic.max_health",base:${hp}}]}` : `{PersistenceRequired:1b}`;
      for (let i = 0; i < count; i++) {
        // PersistenceRequired so a summoned mob never despawns mid-fight. In an arena, place them at
        // fixed ring positions inside it rather than relative to the bot: `execute at <bot>` can fire
        // against a stale position right after the teleport and drop the mob outside the walls.
        if (s.arena) {
          const [cx, cy, cz] = s.arena.center, ang = (i / count) * Math.PI * 2, rad = Math.min(s.arena.half - 2, 4 + i);
          const x = Math.round(cx + Math.cos(ang) * rad), z = Math.round(cz + Math.sin(ang) * rad);
          await run(`execute in minecraft:${s.arena.dimension} run summon minecraft:${mob} ${x} ${cy} ${z} ${nbt}`);
        } else {
          await run(`execute at ${bot} run summon minecraft:${mob} ~${3 + i} ~ ~${(i % 2 ? -1 : 1) * 3} ${nbt}`);
        }
      }
    }
    // Dress the bot last, once the world has stopped moving under it. Sent during placement the
    // equipment does not stick - the body is still settling into the chunk it was teleported to and
    // only the final slot survives - so this waits, applies, and checks, retrying once.
    if (wear.length) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await new Promise((r) => setTimeout(r, 800));
        for (const w of wear) await run(`item replace entity ${bot} armor.${w.slot} with minecraft:${w.item}`);
        const worn = await (await this.rconConnect()).command(`data get entity ${bot} equipment`);
        const missing = wear.filter((w) => !worn.includes(w.item));
        if (!missing.length) break;
        log.warn(`armour did not stick (${missing.map((m) => m.item).join(", ")}); retrying`);
      }
    }
    if (s.arena) {
      // The bot itself now keeps the arena chunks loaded, so drop the forceload we added for the fill.
      const [cx, , cz] = s.arena.center, h = s.arena.half;
      await run(`execute in minecraft:${s.arena.dimension} run forceload remove ${cx - h - 1} ${cz - h - 1} ${cx + h + 1} ${cz + h + 1}`);
    }
  }

  private async check(session: AgentSession, preds: Predicate[], said: string[], deaths: number): Promise<{ ok: boolean; detail: string }> {
    const p = session.rt.p;
    const details: string[] = [];
    let ok = true;
    for (const pr of preds) {
      let hit = false;
      switch (pr.type) {
        case "inventory": {
          const inv = await p.inventory();
          const pat = pr.item.includes("*") ? new RegExp("^" + fullId(pr.item).replace(/\*/g, ".*") + "$") : null;
          const n = pat ? inv.items.filter((i) => pat.test(i.item)).reduce((a, i) => a + i.count, 0) : inv.count(pr.item);
          hit = pr.count === 0 ? true : n >= pr.count;
          details.push(`${pr.item}: ${n}/${pr.count}`);
          break;
        }
        case "block": { const b = await p.blockAt({ x: pr.pos[0], y: pr.pos[1], z: pr.pos[2] }); hit = b.id === fullId(pr.block); details.push(`block ${pr.pos.join(",")}=${b.short}`); break; }
        case "near": { const d = dist(session.rt.mirror.pos, { x: pr.pos[0], y: pr.pos[1], z: pr.pos[2] }); hit = d <= pr.radius; details.push(`dist ${d.toFixed(1)}/${pr.radius}`); break; }
        case "said": { hit = said.some((l) => l.toLowerCase().includes(pr.includes.toLowerCase())); details.push(`said "${pr.includes}": ${hit}`); break; }
        case "alive": { hit = deaths === 0; details.push(`deaths ${deaths}`); break; }
        case "script_exists": { hit = existsSync(resolve(session.agent.workspaceDir, "shem", `${pr.name}.shem`)); details.push(`script ${pr.name}: ${hit}`); break; }
        case "dimension": { const d = session.rt.mirror.dimension.replace("minecraft:", ""); hit = d === pr.is; details.push(`dimension ${d}`); break; }
        case "rcon": {
          const out = await (await this.rconConnect()).command(pr.command.replace(/\{bot\}/g, session.agent.body.username));
          hit = (!pr.expect || out.includes(pr.expect)) && (!pr.absent || !out.includes(pr.absent));
          details.push(`rcon "${pr.command.slice(0, 40)}" -> ${out.slice(0, 40).replace(/\n/g, " ")}`);
          break;
        }
      }
      if (!hit) ok = false;
    }
    return { ok, detail: details.join("; ") };
  }

  /**
   * Move the agent's own scripts aside so a rung starts from the shipped library. Archived rather
   * than deleted: what it wrote last time is evidence about the run, and deleting evidence to tidy a
   * fixture is a bad trade.
   */
  private archiveScripts(agent: { workspaceDir: string; name: string }, t0: number): void {
    const dir = resolve(agent.workspaceDir, "shem");
    if (!existsSync(dir)) return;
    const scripts = readdirSync(dir).filter((f) => f.endsWith(".shem"));
    if (!scripts.length) return;
    const into = resolve(dir, `_archive-${new Date(t0).toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(into, { recursive: true });
    for (const f of scripts) renameSync(resolve(dir, f), resolve(into, f));
    log.info(`archived ${scripts.length} of ${agent.name}'s scripts to ${into}; the rung starts from the library`);
  }

  async run(task: Task): Promise<TaskResult> {
    const { agentName, loaded, host } = this.opts;
    const agent = resolveAgent(loaded, agentName);
    const t0 = Date.now();
    const said: string[] = [];
    let deaths = 0, turns = 0, toolCalls = 0, tokens = 0, lastContext = 0;
    // Before the session starts, because orientation reads the workspace and lists what it finds.
    if (task.fresh_workspace) this.archiveScripts(agent, t0);
    const session = await AgentSession.start(agent, host, { waitForBodyMs: 900_000, orient: false, freshMind: task.fresh_session && (this.opts.fresh ?? true) });
    this.active = session;
    // Count as things happen: the final turn is usually still running when the predicate passes.
    const off = session.subscribeEvents((ev) => {
      if (ev.type === "prompt" && !ev.queued) turns++;
      else if (ev.type === "golem_tool") toolCalls++;
      else if (ev.type === "turn_end") tokens += Number(ev.tokens ?? 0);
      else if (ev.type === "usage") lastContext = Number(ev.used ?? 0);
    });
    session.rt.body.on("chat", (d: { text: string; sender?: string }) => { if (d.sender === agent.body.username) said.push(d.text); });
    session.rt.body.on("death", () => { deaths++; });
    let status: TaskResult["status"] = "timeout";
    let detail = "";
    try {
      await this.reset(task, agent.body.username);
      await session.rt.mirror.refresh();
      session.drive.goal = task.goal;
      session.drive.push({ kind: "goal", priority: 80, from: loaded.config.players.owners[0] ?? "eval", text: `${loaded.config.players.owners[0] ?? "eval"} set your goal: ${task.goal}` });
      const deadline = t0 + task.timeout_s * 1000;
      while (Date.now() < deadline && !this.aborted) {
        await new Promise((r) => setTimeout(r, 5000));
        if (this.aborted) break;
        const s = await this.check(session, task.success, said, deaths);
        if (s.ok) { status = "success"; detail = s.detail; break; }
        detail = s.detail;
        if (task.fail.length) { const f = await this.check(session, task.fail, said, deaths); if (f.ok) { status = "failed"; detail = `fail predicate: ${f.detail}`; break; } }
      }
      if (this.aborted && status === "timeout") { status = "error"; detail = "aborted"; }
    } catch (e) {
      status = "error"; detail = this.aborted ? "aborted" : (e as Error).message;
    } finally {
      off();
      session.drive.goal = "";
      await session.stop().catch(() => {});
      this.active = undefined;
    }
    const result: TaskResult = {
      name: task.name, path: "", status, seconds: (Date.now() - t0) / 1000, turns, toolCalls, tokens: tokens || lastContext, deaths, detail,
      startedAt: t0, endedAt: Date.now(), model: { plan: agent.mind.models.plan.model, act: agent.mind.models.act.model },
    };
    this.record(result);
    return result;
  }

  private record(r: TaskResult): void {
    const dir = resolve(this.opts.loaded.rootDir, this.opts.loaded.config.eval.results_dir);
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${new Date(r.startedAt).toISOString().replace(/[:.]/g, "-")}-${r.name}.json`);
    writeFileSync(file, JSON.stringify({ ...r, label: this.opts.label ?? null }, null, 2));
    log.info(`${r.name}: ${r.status} in ${r.seconds.toFixed(0)}s (${r.turns} turns, ${r.toolCalls} tool calls, ${r.deaths} deaths) ${r.detail}`);
  }

  /** Stop whatever is running: the poll loop, the live session (mind and body connection), RCON. */
  async close(): Promise<void> {
    this.aborted = true;
    this.rcon?.close();
    await this.active?.stop().catch(() => {});
  }
}
