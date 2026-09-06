// The Shem-less REPL: drive a body by hand through the primitives. This is the dev loop for M1 and
// the engine the eval harness will reuse. `golem shell <agent>` for interactive, or
// `golem shell <agent> -c "status; goto 10 64 -3"` for one-shots.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentRuntime } from "../agent/runtime.ts";
import { GolemError } from "../primitives/errors.ts";
import { fmtPos, parsePos } from "../util/geom.ts";
import { describeRun } from "../shem/runs.ts";

const HELP = `
commands (positions are block coords):
  status | st                     one-line state
  look                            structured look-around
  inv                             inventory
  ents [radius]                   nearby entities
  players                         tab list
  block x y z                     block at
  find <kind> [radius] [max]      findBlocks (needs the body's findBlocks command)
  goto x y z [reach] | goto x z   path there and wait
  nearest <block>                 baritone: go to the nearest block of that kind
  follow <player> [dist]          baritone follow (until stop)
  mineall <block> [count]         baritone mine until count collected
  surface | explore
  stop                            stop moving/mining/pathing
  lookat x y z | lookat #id
  mine x y z                      break one block (auto tool)
  place <item> x y z              place an item at a position
  attack [#id | type]             fight an entity (nearest hostile when omitted)
  eat [item] | equip <item> | drop <item> [n]
  open x y z | close | deposit <item> | withdraw <item> | container
  say <text> | whisper <player> <text>
  bar <baritone command>          raw baritone
  see [w h]                       screenshot to data/<agent>/shots/
  target                          what the crosshair is on (protocol 2)
  recipes <item> | craftable | craft <item> [n]   (protocol 2)
  navcheck x y z [reach]          can Baritone get there? (protocol 2)
  map [radius]                    top-down render (protocol 2)
  history [n]                     recent chat (protocol 2)
  reflexes | reflex <name> on|off
  wait <seconds>                  idle (reflexes keep running; useful in -c scripts)
  shem <file> [script] [k=v ...]  run a Shem script (file: lib/wood, shem/mine.shem, /abs/path.shem)
  check <file>                    check a Shem file
  eval <code>                     run a Shem snippet, e.g. eval say "hi"; goto((1,64,1), reach: 2)
  runs | run <id> | cancel [id]   Shem runs
  doc <name> | lib                Shem docs and library index
  met                             stop everything
  help | quit
`;

function num(s: string | undefined, name: string): number {
  const n = Number(s);
  if (s === undefined || !Number.isFinite(n)) throw new GolemError("failed", `${name} must be a number`);
  return n;
}

export async function runShellCommand(rt: AgentRuntime, line: string): Promise<string> {
  const [cmd, ...args] = line.trim().split(/\s+/);
  if (!cmd) return "";
  const rest = args.join(" ");
  return rt.foreground(cmd, async (p) => {
    switch (cmd) {
      case "help": return HELP;
      case "status": case "st": { await rt.mirror.refresh(); return rt.mirror.summary(rt.agent.name); }
      case "look": return p.lookAround(args[0] ? num(args[0], "radius") : 16);
      case "inv": return (await p.inventory()).describe();
      case "ents": {
        const es = await p.entities({ radius: args[0] ? num(args[0], "radius") : 16 });
        return es.length ? es.map((e) => `#${e.id} ${e.isPlayer ? e.name : e.short}${e.hostile ? " (hostile)" : ""} ${e.distance.toFixed(1)}m ${fmtPos(e.pos)}`).join("\n") : "no entities nearby";
      }
      case "players": return (await p.players()).map((x) => `${x.name} (${x.ping}ms)`).join(", ") || "nobody";
      case "block": { const q = parsePos(rest); if (!q) throw new GolemError("failed", "block x y z"); const b = await p.blockAt(q); return `${b.short} at ${fmtPos(q)}${b.air ? " (air)" : ""}${b.liquid ? " (liquid)" : ""}`; }
      case "find": {
        if (!args[0]) throw new GolemError("failed", "find <kind> [radius] [max]");
        const hits = await p.findBlocks(args[0], { radius: args[1] ? num(args[1], "radius") : 32, max: args[2] ? num(args[2], "max") : 16 });
        return hits.length ? hits.map((h) => `${h.block.replace("minecraft:", "")} ${fmtPos(h)} ${h.dist.toFixed(1)}m`).join("\n") : `no ${args[0]} nearby`;
      }
      case "goto": {
        if (args.length === 2) { const r = await p.gotoXZ(num(args[0], "x"), num(args[1], "z")); return `arrived ${fmtPos(r.pos)} in ${(r.ms / 1000).toFixed(1)}s`; }
        const q = parsePos(args.slice(0, 3).join(" ")); if (!q) throw new GolemError("failed", "goto x y z [reach]");
        const r = await p.goto(q, { reach: args[3] ? num(args[3], "reach") : 1 });
        return `arrived ${fmtPos(r.pos)} (${r.distance.toFixed(1)} from goal) in ${(r.ms / 1000).toFixed(1)}s`;
      }
      case "nearest": { if (!args[0]) throw new GolemError("failed", "nearest <block>"); const r = await p.gotoNearestBlock(args[0]); return `at ${fmtPos(r.pos)} after ${(r.ms / 1000).toFixed(1)}s`; }
      case "follow": { if (!args[0]) throw new GolemError("failed", "follow <player> [dist]"); await p.follow({ player: args[0] }, args[1] ? num(args[1], "dist") : undefined); return `following ${args[0]} (stop to end)`; }
      case "mineall": { if (!args[0]) throw new GolemError("failed", "mineall <block> [count]"); const r = await p.mineAll(args[0], args[1] ? num(args[1], "count") : 1); return `got ${r.got} ${r.item} in ${(r.ms / 1000).toFixed(0)}s`; }
      case "surface": await p.surface(); return "on the surface";
      case "explore": await p.explore(); return "exploring (stop to end)";
      case "stop": await p.stop(); return "stopped";
      case "lookat": {
        if (args[0]?.startsWith("#")) { const a = await p.lookAt({ entityId: num(args[0].slice(1), "id") }); return `yaw ${a.yaw.toFixed(1)} pitch ${a.pitch.toFixed(1)}`; }
        const q = parsePos(rest); if (!q) throw new GolemError("failed", "lookat x y z | lookat #id");
        const a = await p.lookAt(q); return `yaw ${a.yaw.toFixed(1)} pitch ${a.pitch.toFixed(1)}`;
      }
      case "mine": { const q = parsePos(rest); if (!q) throw new GolemError("failed", "mine x y z"); const r = await p.mine(q); return r.broken ? `broke ${r.block} in ${(r.ms / 1000).toFixed(1)}s` : `${fmtPos(q)} was already air`; }
      case "place": { const q = parsePos(args.slice(1).join(" ")); if (!args[0] || !q) throw new GolemError("failed", "place <item> x y z"); const r = await p.place(args[0], q); return `placed ${args[0]} at ${fmtPos(q)} in ${(r.ms / 1000).toFixed(1)}s`; }
      case "attack": {
        let target;
        if (args[0]?.startsWith("#")) target = num(args[0].slice(1), "id");
        else { const es = await p.entities({ radius: 16, kinds: args[0] ? [args[0]] : undefined, hostileOnly: !args[0] }); if (!es[0]) throw new GolemError("not_found", "nothing to attack"); target = es[0].id; }
        const r = await p.attack(target); return `${r.killed ? "killed" : "stopped"} after ${r.hits} hits (${(r.ms / 1000).toFixed(1)}s)`;
      }
      case "eat": { const r = await p.eat(args[0]); return r.ate ? `ate ${r.ate}, food ${r.food}` : "not hungry"; }
      case "equip": { if (!args[0]) throw new GolemError("failed", "equip <item>"); await p.equip(args[0]); return `equipped ${args[0]}`; }
      case "drop": { if (!args[0]) throw new GolemError("failed", "drop <item> [n]"); const r = await p.drop(args[0], args[1] ? num(args[1], "n") : undefined); return `dropped ${r.dropped}`; }
      case "open": { const q = parsePos(rest); if (!q) throw new GolemError("failed", "open x y z"); const c = await p.openContainer(q); return describeContainer(c); }
      case "container": return describeContainer(await p.container());
      case "close": await p.closeScreen(); return "closed";
      case "deposit": { if (!args[0]) throw new GolemError("failed", "deposit <item>"); const r = await p.deposit(args[0]); return `deposited ${r.moved}`; }
      case "withdraw": { if (!args[0]) throw new GolemError("failed", "withdraw <item>"); const r = await p.withdraw(args[0]); return `withdrew ${r.moved}`; }
      case "say": { const r = await p.say(rest); return `said: ${r.sent}`; }
      case "whisper": { if (args.length < 2) throw new GolemError("failed", "whisper <player> <text>"); const r = await p.whisper(args[0]!, args.slice(1).join(" ")); return `sent: ${r.sent}`; }
      case "bar": await p.baritone(rest); return `baritone: ${rest}`;
      case "see": { const r = await p.screenshot({ width: args[0] ? num(args[0], "w") : 960, height: args[1] ? num(args[1], "h") : 540 }); return `${r.path} (${r.png.length} bytes, ${r.backend}, ${r.ms.toFixed(0)}ms)`; }
      case "target": return JSON.stringify(await p.target());
      case "recipes": { if (!args[0]) throw new GolemError("failed", "recipes <item>"); return JSON.stringify(await p.recipes(args[0]), null, 1); }
      case "craftable": { const c = await p.craftable(); return c.length ? c.map((x) => `${x.item.replace("minecraft:", "")} x${x.count}`).join(", ") : "nothing craftable"; }
      case "craft": { if (!args[0]) throw new GolemError("failed", "craft <item> [n]"); const r = await p.craft(args[0], args[1] ? num(args[1], "n") : 1); return `crafted ${r.crafted} ${r.item}`; }
      case "navcheck": { const q = parsePos(args.slice(0, 3).join(" ")); if (!q) throw new GolemError("failed", "navcheck x y z [reach]"); return JSON.stringify(await p.navCheck(q, args[3] ? num(args[3], "reach") : 1)); }
      case "map": { const r = await p.map(args[0] ? num(args[0], "radius") : 48); return `${r.path} (${r.png.length} bytes)`; }
      case "history": { const h = await p.chatHistory(args[0] ? num(args[0], "n") : 20); return h.map((l) => `${l.sender ? l.sender + ": " : ""}${l.text}`).join("\n") || "no chat yet"; }
      case "reflexes": return rt.reflexes.list().map((r) => `${r.on ? "on " : "off"} ${r.name.padEnd(18)} p${r.priority}${r.active ? " ACTIVE" : ""}  ${r.description}`).join("\n");
      case "reflex": { if (!args[0] || !["on", "off"].includes(args[1] ?? "")) throw new GolemError("failed", "reflex <name> on|off"); rt.reflexes.enable(args[0], args[1] === "on"); return `${args[0]} ${args[1]}`; }
      case "wait": { const secs = num(args[0], "seconds"); await new Promise((r) => setTimeout(r, secs * 1000)); await rt.mirror.refresh(); return rt.mirror.summary(rt.agent.name); }
      case "shem": {
        const e = rt.shem; if (!e) throw new GolemError("unsupported", "no Shem engine");
        if (!args[0]) throw new GolemError("failed", "shem <file> [script] [k=v ...]");
        const kv = args.slice(1).filter((x) => x.includes("="));
        const script = args[1] && !args[1].includes("=") ? args[1] : undefined;
        const params: Record<string, unknown> = {};
        for (const x of kv) { const [k, ...v] = x.split("="); const raw = v.join("="); params[k!] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw; }
        const run = e.run(args[0], script, params as never, { interrupt: true });
        return e.wait(run, 600_000);
      }
      case "check": { const e = rt.shem; if (!e || !args[0]) throw new GolemError("failed", "check <file>"); return e.check(args[0]).text; }
      case "eval": { const e = rt.shem; if (!e) throw new GolemError("unsupported", "no Shem engine"); const run = e.eval(rest, {}, { interrupt: true }); return e.wait(run, 600_000); }
      case "runs": { const e = rt.shem; if (!e) throw new GolemError("unsupported", "no Shem engine"); const rs = e.runs.list().slice(0, 15); return rs.length ? rs.map((r) => `${r.id} ${r.label} p${r.priority}${r.background ? " bg" : ""}: ${r.status}`).join("\n") : "no runs"; }
      case "run": { const e = rt.shem; const r = e?.runs.get(args[0] ?? ""); if (!r) throw new GolemError("not_found", `no run ${args[0]}`); return describeRun(r, 30, true); }
      case "cancel": { const e = rt.shem; if (!e) throw new GolemError("unsupported", "no Shem engine"); return `cancelled ${e.runs.cancel(args[0], "shell cancel")}`; }
      case "doc": { const e = rt.shem; if (!e || !args[0]) throw new GolemError("failed", "doc <name>"); return e.doc(args[0]); }
      case "lib": { const e = rt.shem; if (!e) throw new GolemError("unsupported", "no Shem engine"); return e.list(); }
      case "met": await rt.met(); return "met.";
      default: throw new GolemError("failed", `unknown command ${cmd} (try help)`);
    }
  });
}

function describeContainer(c: { handler: string; slots: { slot: number; item: string; count: number }[]; trades?: unknown[] }): string {
  const items = c.slots.filter((s) => s.item && s.item !== "empty" && s.item !== "minecraft:air");
  const lines = [`${c.handler}: ${items.length} stacks`];
  for (const s of items) lines.push(`  [${s.slot}] ${s.item.replace("minecraft:", "")} x${s.count}`);
  if (c.trades?.length) lines.push(`  trades: ${JSON.stringify(c.trades)}`);
  return lines.join("\n");
}

export async function shellLoop(rt: AgentRuntime, oneShot?: string): Promise<void> {
  const run = async (line: string) => {
    const t0 = Date.now();
    try {
      const out = await runShellCommand(rt, line);
      if (out) console.log(out);
    } catch (e) {
      if (e instanceof GolemError) console.log(`! ${e.kind}: ${e.message}`);
      else console.log(`! ${(e as Error).message ?? e}`);
    }
    const ms = Date.now() - t0;
    if (ms > 1500) console.log(`  (${(ms / 1000).toFixed(1)}s)`);
  };
  if (oneShot !== undefined) {
    for (const part of oneShot.split(";")) { const l = part.trim(); if (l) { console.log(`> ${l}`); await run(l); } }
    return;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log(`${rt.mirror.summary(rt.agent.name)}\n(type help)`);
  for (;;) {
    let line: string;
    try { line = await rl.question(`${rt.agent.name}> `); } catch { break; }
    if (line.trim() === "quit" || line.trim() === "exit") break;
    await run(line);
  }
  rl.close();
}
