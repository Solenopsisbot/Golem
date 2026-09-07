#!/usr/bin/env node
// Golem CLI.
//   golem up [agent...]        spawn bodies (and, from M2, minds) for the fleet or the named agents
//   golem body <agent>         spawn just the body and exit when it's up
//   golem attach <agent>       connect to a running body: print status, stream events
//   golem shell <agent> [-c "cmd; cmd"]   drive a body by hand
//   golem status <agent>       one line and exit
//   golem met <agent|all>      stop everything
//   golem talk <agent>         chat with a running agent as its first owner (via the bridge)
//   golem prompt <agent> "text"   push one line into a running agent's inbox
//   golem eval <task.json|dir> [agent] [--label name] [--keep-session]   run eval tasks, record results in data/eval/
//   golem eval-report [--label x]   results table from data/eval/
//   golem replay <agent> [--from HH:MM] [--to HH:MM] [--grep re] [--all]   the body trace as a timeline
//   golem gen-types            regenerate src/body/schema.gen.ts from Clef's schema.json
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../agent/runtime.ts";
import { AgentSession } from "../agent/session.ts";
import { GolemHttpHost } from "../mcp/server.ts";
import { ensureTokens } from "../config/load.ts";
import { ShemEngine } from "../shem/engine.ts";
import { EvalRunner } from "../eval/runner.ts";
import { loadTasks } from "../eval/task.ts";
import { replay } from "./replay.ts";
import { evalReport } from "../eval/report.ts";
import { readTranscript, renderCost, summarise } from "./cost.ts";
import { AgentBus } from "../comms/bus.ts";
import { parseDuration } from "../config/schema.ts";
import readline from "node:readline/promises";
import { agentNames, loadConfig, resolveAgent } from "../config/load.ts";
import { bodyLogPath, isBodyRunning, killBody, spawnBody, superviseBody, type Supervisor } from "../fleet/body.ts";
import { makeLog } from "../util/log.ts";
import { shellLoop } from "./shell.ts";

const log = makeLog("golem");

function usage(): never {
  console.error(`usage: golem <up|body|attach|shell|status|met|talk|prompt|eval|eval-report|cost|replay|gen-types> [agent|task] [-c "cmds"] [--config path] [--no-orient] [--label x] [--keep-session] [--from HH:MM] [--to HH:MM] [--grep re] [--all]`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let config: string | undefined;
  let oneShot: string | undefined;
  let noOrient = false;
  let label: string | undefined;
  let hours = 1;
  let keepSession = false;
  let from: string | undefined, to: string | undefined, grep: string | undefined, all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") config = argv[++i];
    else if (a === "-c") oneShot = argv[++i];
    else if (a === "--no-orient") noOrient = true;
    else if (a === "--label") label = argv[++i];
    else if (a === "--hours") hours = Number(argv[++i] ?? 1);
    else if (a === "--keep-session") keepSession = true;
    else if (a === "--from") from = argv[++i];
    else if (a === "--to") to = argv[++i];
    else if (a === "--grep") grep = argv[++i];
    else if (a === "--all") all = true;
    else if (a.startsWith("-")) usage();
    else positional.push(a);
  }
  return { positional, config, oneShot, noOrient, label, keepSession, from, to, grep, all, hours };
}

async function withRuntime(agentName: string, configPath: string | undefined, fn: (rt: AgentRuntime) => Promise<void>, opts: { waitForBodyMs?: number } = {}): Promise<void> {
  const loaded = loadConfig(configPath);
  const agent = resolveAgent(loaded, agentName);
  const rt = new AgentRuntime(agent, { reflex: (ev) => log.info(`[reflex] ${ev.name}: ${ev.note}`) });
  const stop = async () => { await rt.stop().catch(() => {}); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await rt.start(opts);
  rt.shem = new ShemEngine(rt);
  try { await fn(rt); }
  finally { await rt.stop().catch(() => {}); }
}

async function main(): Promise<void> {
  const { positional, config, oneShot, noOrient, label, keepSession, from, to, grep, all, hours } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  if (!cmd) usage();

  switch (cmd) {
    case "gen-types": {
      const here = dirname(fileURLToPath(import.meta.url));
      const r = spawnSync(process.execPath, [resolve(here, "../../scripts/gen-body-types.ts")], { stdio: "inherit" });
      process.exit(r.status ?? 1);
    }
    case "body": {
      const loaded = loadConfig(config);
      const name = rest[0] ?? agentNames(loaded)[0];
      if (!name) usage();
      const agent = resolveAgent(loaded, name);
      if (agent.body.attach) { log.info(`${name} attaches to ${agent.body.attach.host}:${agent.body.attach.port}; nothing to spawn`); return; }
      const pid = isBodyRunning(agent);
      if (pid) { log.info(`${name}: body already running (pid ${pid})`); return; }
      const child = spawnBody(agent);
      log.info(`${name}: launched; watch ${bodyLogPath(agent)}. Waiting for the control port...`);
      await withRuntime(name, config, async (rt) => { console.log(rt.mirror.summary(name)); }, { waitForBodyMs: 900_000 });
      child.unref();
      return;
    }
    case "up": {
      const loaded = loadConfig(config);
      const names = rest.length ? rest : agentNames(loaded);
      if (!names.length) { log.error("no agents in golem.toml"); process.exit(1); }
      const host = new GolemHttpHost(loaded.config.fleet.mcp_bind);
      await host.start();
      const bus = new AgentBus({ maxTurns: loaded.config.comms.conversations.max_turns, cooldownMs: parseDuration(loaded.config.comms.conversations.cooldown), mirrorInGame: loaded.config.comms.agents === "both" });
      host.setFleet({ bus, sharedWorldDir: names.length ? resolveAgent(loaded, names[0]!).sharedWorldDir : undefined });
      const supervisors: Supervisor[] = [];
      const sessions: AgentSession[] = [];
      const shutdown = async () => {
        log.info("shutting down");
        // Bodies first and in parallel with the minds: a mind can take ten seconds to wind down, and
        // a body that outlives this process keeps its username logged in and kicks its replacement.
        setTimeout(() => { log.warn("shutdown is taking too long; killing bodies and exiting"); for (const s of supervisors) s.killNow(); process.exit(0); }, 15_000).unref();
        await Promise.allSettled([...supervisors.map((s) => s.stop()), ...sessions.map((s) => s.stop())]);
        await host.stop().catch(() => {});
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      for (const name of names) {
        const agent = resolveAgent(loaded, name);
        if (!agent.body.attach) {
          if (isBodyRunning(agent)) log.info(`${name}: body already running (pid ${isBodyRunning(agent)}); adopting it`);
          else supervisors.push(superviseBody(agent));
        }
      }
      await Promise.all(names.map(async (name) => {
        const agent = resolveAgent(loaded, name);
        const s = await AgentSession.start(agent, host, { orient: !noOrient, bus });
        sessions.push(s);
        s.rt.body.on("chat", (d) => log.info(`[${name}] chat ${d.sender ? d.sender + ": " : ""}${d.text}`));
      }));
      log.info(`up: ${sessions.map((s) => s.rt.mirror.summary(s.agent.name)).join(" || ")}`);
      log.info(`bridge: http://${host.host}:${host.port}/agents/<name>/{inbox,say,status,events} (bearer token in data/<name>/tokens.json)`);
      for (const s of sessions) log.info(`dashboard: http://${host.host}:${host.port}/agents/${encodeURIComponent(s.agent.name)}/dash?token=${ensureTokens(s.agent).mcp}`);
      if (sessions.length > 1) log.info(`fleet dashboard: http://${host.host}:${host.port}/dash?token=${ensureTokens(resolveAgent(loaded, names[0]!)).mcp}`);
      await new Promise(() => {}); // run until signalled
      return;
    }
    case "cost": {
      // golem cost [agent...] [--hours N]  (default: every agent, last 1h)
      const loaded = loadConfig(config);
      const names = rest.filter((a) => !a.startsWith("--"));
      const agents = (names.length ? names : agentNames(loaded)).map((n) => resolveAgent(loaded, n));
      console.log(renderCost(agents.map((a) => summarise(a.name, readTranscript(resolve(a.dataDir, "transcript.jsonl")), hours))));
      return;
    }
    case "eval-report": {
      const loaded = loadConfig(config);
      console.log(evalReport(resolve(loaded.rootDir, loaded.config.eval.results_dir), label));
      return;
    }
    case "replay": {
      const name = rest[0]; if (!name) usage();
      const agent = resolveAgent(loadConfig(config), name);
      await replay(agent.tracePath, { from, to, grep, all }, (l) => console.log(l));
      return;
    }
    case "eval": {
      const target = rest[0]; if (!target) usage();
      const loaded = loadConfig(config);
      const name = rest[1] ?? agentNames(loaded)[0];
      if (!name) { log.error("no agents in golem.toml"); process.exit(1); }
      const tasks = loadTasks(target);
      log.info(`eval: ${tasks.length} task(s) with ${name}${label ? ` [${label}]` : ""}`);
      const host = new GolemHttpHost(loaded.config.fleet.mcp_bind);
      await host.start();
      const agent = resolveAgent(loaded, name);
      const sup = !agent.body.attach && !isBodyRunning(agent) ? superviseBody(agent) : undefined;
      const runner = new EvalRunner({ agentName: name, loaded, host, fresh: !keepSession, label });
      const results = [];
      const shutdown = async () => { runner.close(); await sup?.stop(); await host.stop().catch(() => {}); process.exit(0); };
      process.once("SIGINT", shutdown);
      for (const { path, task } of tasks) {
        log.info(`--- ${task.name}: ${task.description || task.goal}`);
        const r = await runner.run(task);
        r.path = path;
        results.push(r);
      }
      console.log("\n" + results.map((r) => `${r.status.padEnd(8)} ${r.name.padEnd(18)} ${r.seconds.toFixed(0).padStart(5)}s ${String(r.turns).padStart(3)} turns ${String(r.toolCalls).padStart(4)} calls ${String(r.deaths).padStart(2)} deaths  ${r.detail}`).join("\n"));
      console.log(`\n${results.filter((r) => r.status === "success").length}/${results.length} succeeded`);
      await shutdown();
      return;
    }
    case "talk":
    case "prompt": {
      const name = rest[0]; if (!name) usage();
      const loaded = loadConfig(config);
      const agent = resolveAgent(loaded, name);
      const tokens = ensureTokens(agent);
      const base = `http://${loaded.config.fleet.mcp_bind}/agents/${encodeURIComponent(name)}`;
      const headers = { authorization: `Bearer ${tokens.mcp}`, "content-type": "application/json" };
      const from = loaded.config.players.owners[0] ?? "owner";
      const send = async (text: string) => {
        const r = await fetch(`${base}/inbox`, { method: "POST", headers, body: JSON.stringify({ text, from, kind: "chat", priority: 80 }) });
        if (!r.ok) throw new Error(`inbox: ${r.status} ${await r.text()}`);
      };
      if (cmd === "prompt") { await send(rest.slice(1).join(" ")); console.log("sent"); return; }
      // Stream events so we see what the agent says and does.
      const ac = new AbortController();
      void (async () => {
        const r = await fetch(`${base}/events`, { headers, signal: ac.signal });
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (!ev || !data) continue;
            const d = JSON.parse(data);
            if (ev === "agent_text") process.stdout.write(d.text);
            else if (ev === "golem_tool") console.log(`\n  [tool] ${d.name} ${JSON.stringify(d.args)} -> ${String(d.result).split("\n")[0]}${d.isError ? " (error)" : ""}`);
            else if (ev === "turn_end") console.log(`\n  [turn ${d.stopReason}, ${(d.ms / 1000).toFixed(1)}s${d.tokens ? `, ${d.tokens} tokens` : ""}]`);
            else if (ev === "prompt") console.log(`\n  [prompt] ${String(d.text).split("\n").slice(0, 2).join(" | ")}`);
            else if (ev === "inbox" && d.item?.from !== from) console.log(`\n  [inbox] ${d.item?.kind}: ${d.item?.text}`);
          }
        }
      })().catch((e) => { if (!ac.signal.aborted) console.error(`events stream ended: ${(e as Error).message}`); });
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(`talking to ${name} as ${from} (Ctrl-D to quit)`);
      for (;;) {
        let line: string;
        try { line = await rl.question(`${from}> `); } catch { break; }
        if (!line.trim()) continue;
        try { await send(line); } catch (e) { console.log(`! ${(e as Error).message}`); }
      }
      ac.abort(); rl.close();
      return;
    }
    case "attach": {
      const name = rest[0]; if (!name) usage();
      await withRuntime(name, config, async (rt) => {
        console.log(rt.mirror.summary(name));
        rt.body.onAny((d, ev) => { if (ev !== "tick") console.log(`[${ev}] ${JSON.stringify(d)}`); });
        await new Promise(() => {});
      }, { waitForBodyMs: 30_000 });
      return;
    }
    case "shell": {
      const name = rest[0]; if (!name) usage();
      await withRuntime(name, config, (rt) => shellLoop(rt, oneShot), { waitForBodyMs: 30_000 });
      process.exit(0); // don't wait for straggling call timers
    }
    case "status": {
      const name = rest[0]; if (!name) usage();
      await withRuntime(name, config, async (rt) => { console.log(rt.mirror.summary(name)); }, { waitForBodyMs: 10_000 });
      return;
    }
    case "met": {
      const loaded = loadConfig(config);
      const names = rest[0] && rest[0] !== "all" ? [rest[0]] : agentNames(loaded);
      for (const name of names) {
        try { await withRuntime(name, config, async (rt) => { await rt.met(); console.log(`${name}: met.`); }, { waitForBodyMs: 5000 }); }
        catch (e) { console.log(`${name}: ${(e as Error).message}`); }
      }
      return;
    }
    default: usage();
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
