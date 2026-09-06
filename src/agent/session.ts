// One live agent end to end: body runtime + workspace + MCP/bridge registration + mind + drive.
// `golem up` builds one of these per agent; `golem shell` uses just the AgentRuntime underneath.
import { resolve } from "node:path";
import type { AgentConfig } from "../config/schema.ts";
import { ensureTokens } from "../config/load.ts";
import { AgentRuntime } from "./runtime.ts";
import { Drive } from "../drive/drive.ts";
import { Journal, Transcript } from "../drive/transcript.ts";
import { Mind } from "../mind/acp.ts";
import { makeFsJail } from "../mind/fsjail.ts";
import type { BridgeEvent, GolemHttpHost } from "../mcp/server.ts";
import { toolDocs } from "../mcp/tools.ts";
import { makeHookSink } from "../bridge/hooks.ts";
import { ensureWorkspace, writeOrientation } from "../workspace/generate.ts";
import { ShemEngine } from "../shem/engine.ts";
import { describeRun } from "../shem/runs.ts";
import { makeLog, type Logger } from "../util/log.ts";
import type { AgentBus } from "../comms/bus.ts";

export class AgentSession {
  readonly agent: AgentConfig;
  readonly rt: AgentRuntime;
  readonly log: Logger;
  mind!: Mind;
  drive!: Drive;
  private readonly host: GolemHttpHost;
  private readonly listeners = new Set<(ev: BridgeEvent) => void>();
  private readonly transcript: Transcript;
  private readonly journal: Journal;
  private stopping = false;
  private mindRestarts = 0;
  private unregisterBus: (() => void) | undefined;

  private constructor(agent: AgentConfig, host: GolemHttpHost) {
    this.agent = agent;
    this.host = host;
    this.log = makeLog(agent.name);
    this.rt = new AgentRuntime(agent, { reflex: (ev) => { this.drive?.onReflex(ev); for (const l of this.listeners) { try { l({ t: ev.at, type: "reflex", name: ev.name, note: ev.note }); } catch { /* listener's problem */ } } } });
    this.transcript = new Transcript(resolve(agent.dataDir, "transcript.jsonl"));
    ensureWorkspace(agent);
    this.journal = new Journal(agent.workspaceDir);
  }

  static async start(agent: AgentConfig, host: GolemHttpHost, opts: { waitForBodyMs?: number; orient?: boolean; freshMind?: boolean; bus?: AgentBus } = {}): Promise<AgentSession> {
    const s = new AgentSession(agent, host);
    await s.rt.start({ waitForBodyMs: opts.waitForBodyMs ?? 900_000 });
    s.journal.note(`session started; ${s.rt.mirror.summary(agent.name)}`);
    const shem = new ShemEngine(s.rt);
    s.rt.shem = shem;
    const shemReflexes = shem.loadReflexes(s.rt.reflexes, agent.reflexes.allow_custom);
    for (const name of agent.reflexes.on) if (shemReflexes.includes(name)) s.rt.reflexes.enable(name);
    const orient = () => writeOrientation({ agent, tools: toolDocs(), shem: { cheatsheet: shem.cheatsheet(), index: shem.list() } });
    orient();
    shem.onSaved = (rel) => { s.log.info(`script saved by tool: ${rel}`); orient(); };
    const tokens = ensureTokens(agent);
    const hooks = makeHookSink(agent.name, agent.bridge, s.log.child("hooks"));
    const emit = (ev: { type: string; [k: string]: unknown }) => {
      const full: BridgeEvent = { t: Date.now(), ...ev, type: ev.type };
      for (const l of s.listeners) { try { l(full); } catch { /* listener's problem */ } }
      hooks(ev);
    };
    s.mind = new Mind({
      agent, log: s.log.child("mind"), cwd: agent.workspaceDir,
      mcp: { name: "golem", url: host.mcpUrl(agent.name), token: tokens.mcp },
      fs: makeFsJail(agent, { onWrite: (rel) => { if (rel.endsWith(".shem")) { s.log.info(`script written: ${rel}`); try { orient(); } catch (e) { s.log.warn(`orientation regen failed: ${(e as Error).message}`); } } } }),
      onUpdate: (u) => s.drive?.onUpdate(u),
      onExit: () => s.onMindExit(),
    });
    s.drive = new Drive({ rt: s.rt, mind: s.mind, log: s.log.child("drive"), transcript: s.transcript, journal: s.journal, emit, bus: opts.bus });
    if (opts.bus) s.unregisterBus = opts.bus.register({ name: agent.name, deliver: (m) => s.drive.deliverFromBus(m), state: () => s.drive.stateHeader().replace(/^\[state\]\s*/, ""), say: (text) => s.rt.p.say(text) });
    s.rt.drive = s.drive;
    host.register(agent.name, { rt: s.rt, drive: s.drive, shem, token: tokens.mcp, transcriptPath: resolve(agent.dataDir, "transcript.jsonl"), subscribe: (l) => { s.listeners.add(l); return () => s.listeners.delete(l); } });
    shem.runs.onEnd(({ type, run }) => {
      if (!run.background) return;   // foreground runs report back through the tool that started them
      s.drive.push({ kind: type, priority: type === "run_failed" ? 45 : 40, text: describeRun(run, 4) });
    });
    await s.mind.start({ fresh: !!opts.freshMind });
    s.drive.start();
    if (s.mind.resumed) {
      s.drive.push({ kind: "system", priority: 30, text: "(Golem restarted; your session was resumed with its history. The world may have moved on: check status before acting on old assumptions.)" });
    } else if (opts.orient ?? true) {
      const tail = s.journal.tail(20);
      s.drive.push({ kind: "system", priority: 50, text: `You just woke up in the world. Look around, say hello briefly if anyone is nearby, then wait for something to happen.${tail ? `\nRecent journal:\n${tail}` : ""}` });
    }
    return s;
  }

  /** Subscribe to this agent's bridge events (what the SSE stream carries). */
  subscribeEvents(listener: (ev: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onMindExit(): void {
    if (this.stopping) return;
    this.mindRestarts++;
    if (this.mindRestarts > 5) { this.log.error("mind died too many times; not restarting"); return; }
    const delay = 5000 * this.mindRestarts;
    this.log.warn(`mind died; restarting in ${delay / 1000}s`);
    setTimeout(() => {
      this.mind.start()
        .then(() => this.drive.push({ kind: "system", priority: 40, text: "(your mind process restarted; this is a fresh session. Check memory/ and the journal if you need context.)" }))
        .catch((e) => this.log.error(`mind restart failed: ${(e as Error).message}`));
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unregisterBus?.();
    this.drive?.stop();
    await this.mind?.stop().catch(() => {});
    this.host.unregister(this.agent.name);
    await this.rt.stop().catch(() => {});
  }
}
