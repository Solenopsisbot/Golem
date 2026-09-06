// The eval runner: for each task, reset the world over RCON, start a session with a fresh mind,
// hand the goal over as an owner message, watch the predicates, record the result.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    if (s.gamemode) await run(`gamemode ${s.gamemode} ${bot}`);
    if (s.clear_inventory) await run(`clear ${bot}`);
    if (s.teleport) await run(`tp ${bot} ${s.teleport.join(" ")}`);
    if (s.time) await run(`time set ${s.time}`);
    if (s.weather) await run(`weather ${s.weather}`);
    for (const g of s.give) await run(`give ${bot} ${g.startsWith("minecraft:") ? g : "minecraft:" + g}`);
    for (const c of s.commands) await run(c);
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
      }
      if (!hit) ok = false;
    }
    return { ok, detail: details.join("; ") };
  }

  async run(task: Task): Promise<TaskResult> {
    const { agentName, loaded, host } = this.opts;
    const agent = resolveAgent(loaded, agentName);
    const t0 = Date.now();
    const said: string[] = [];
    let deaths = 0, turns = 0, toolCalls = 0, tokens = 0;
    if (task.fresh_session && (this.opts.fresh ?? true)) { try { rmSync(resolve(agent.dataDir, "session.json")); } catch { /* none */ } }
    const session = await AgentSession.start(agent, host, { waitForBodyMs: 900_000, orient: false });
    const off = host.mcpUrl(agentName) ? session.subscribeEvents((ev) => {
      if (ev.type === "turn_end") { turns++; tokens += Number(ev.tokens ?? 0); toolCalls += Number(ev.toolCalls ?? 0); }
    }) : () => {};
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
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        const s = await this.check(session, task.success, said, deaths);
        if (s.ok) { status = "success"; detail = s.detail; break; }
        detail = s.detail;
        if (task.fail.length) { const f = await this.check(session, task.fail, said, deaths); if (f.ok) { status = "failed"; detail = `fail predicate: ${f.detail}`; break; } }
      }
    } catch (e) {
      status = "error"; detail = (e as Error).message;
    } finally {
      off();
      session.drive.goal = "";
      await session.stop().catch(() => {});
    }
    const result: TaskResult = {
      name: task.name, path: "", status, seconds: (Date.now() - t0) / 1000, turns, toolCalls, tokens, deaths, detail,
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

  close(): void { this.rcon?.close(); }
}
