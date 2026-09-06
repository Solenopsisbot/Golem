// Runs: one invocation of a script, with an id, a priority, a cancel token, a budget and a trace
// file (runs/<id>.log in the workspace). The manager serialises foreground runs by priority and
// lets background runs coexist.
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CancelToken, GolemError } from "../primitives/errors.ts";
import type { Interpreter, Program, RunCtx } from "./interpreter.ts";
import { show, type Value } from "./values.ts";

export type RunStatus = "running" | "done" | "failed" | "cancelled" | "preempted" | "timeout";

export interface RunOptions {
  priority?: number;     // 0..100, default 50
  interrupt?: boolean;   // preempt lower-priority foreground runs
  background?: boolean;  // don't block the caller; don't count as foreground
  timeoutMs?: number;    // wall budget (default 10 min, max 1 h)
  maxCalls?: number;
  maxLoops?: number;
  label?: string;
  /** Parent token (e.g. the runtime's foreground token) so met/preempt reach the run. */
  parent?: CancelToken;
}

export interface Run {
  id: string;
  label: string;
  script: string;
  params: Record<string, Value>;
  priority: number;
  background: boolean;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  result: Value;
  error: GolemError | null;
  current: string;        // last primitive called
  token: CancelToken;
  promise: Promise<Value>;
  tracePath: string;
  tail: string[];         // last N trace lines
}

export class RunManager {
  private readonly runs = new Map<string, Run>();
  private counter = 0;
  private readonly interpreter: Interpreter;
  private readonly runsDir: string;
  private readonly listeners = new Set<(ev: { type: "run_done" | "run_failed"; run: Run }) => void>();

  constructor(interpreter: Interpreter, workspaceDir: string) {
    this.interpreter = interpreter;
    this.runsDir = resolve(workspaceDir, "runs");
    mkdirSync(this.runsDir, { recursive: true });
  }

  onEnd(l: (ev: { type: "run_done" | "run_failed"; run: Run }) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  get(id: string): Run | undefined { return this.runs.get(id); }
  list(): Run[] { return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt); }
  active(): Run[] { return this.list().filter((r) => r.status === "running"); }

  start(program: Program, script: string, params: Record<string, Value>, opts: RunOptions = {}): Run {
    const priority = opts.priority ?? 50;
    const background = opts.background ?? false;
    if (!background && opts.interrupt) {
      for (const r of this.active()) if (!r.background && r.priority < priority) { r.status = "preempted"; r.token.cancel(`preempted by ${script} (p${priority})`); }
    } else if (!background) {
      const busy = this.active().find((r) => !r.background);
      if (busy) throw new GolemError("blocked", `run ${busy.id} (${busy.script}, p${busy.priority}) is already in the foreground; pass interrupt: true or background: true`);
    }
    const id = `r${++this.counter}-${Date.now().toString(36)}`;
    const token = opts.parent ? opts.parent.child() : new CancelToken();
    const tracePath = resolve(this.runsDir, `${id}.log`);
    const tail: string[] = [];
    const t0 = Date.now();
    const write = (line: string) => {
      const stamped = `+${((Date.now() - t0) / 1000).toFixed(1)}s ${line}`;
      tail.push(stamped); if (tail.length > 60) tail.shift();
      try { appendFileSync(tracePath, stamped + "\n"); } catch { /* trace is best-effort */ }
    };
    const timeoutMs = Math.min(opts.timeoutMs ?? 600_000, 3_600_000);
    const ctx: RunCtx = {
      id, token,
      log: (l) => write(`log ${l}`),
      trace: (what, detail, ms) => { run.current = what; write(`${what} ${detail}${ms !== undefined ? ` (${ms}ms)` : ""}`); },
      budget: { deadline: t0 + timeoutMs, calls: 0, maxCalls: opts.maxCalls ?? 2000, loops: 0, maxLoops: opts.maxLoops ?? 100_000, depth: 0, maxDepth: 64 },
      tasks: new Set(), handlerError: null,
    };
    write(`start ${script}(${Object.entries(params).map(([k, v]) => `${k}: ${show(v)}`).join(", ")}) p${priority}${background ? " background" : ""}`);
    const run: Run = {
      id, label: opts.label ?? script, script, params, priority, background,
      status: "running", startedAt: t0, endedAt: null, result: null, error: null, current: "", token, tracePath, tail,
      promise: Promise.resolve(null),
    };
    run.promise = this.interpreter.run(program, script, params, ctx).then(
      (v) => { run.status = "done"; run.result = v; run.endedAt = Date.now(); write(`done -> ${show(v)}`); this.emit("run_done", run); return v; },
      (e) => {
        const err = e instanceof GolemError ? e : new GolemError("failed", String((e as Error)?.message ?? e));
        run.error = err; run.endedAt = Date.now();
        if (run.status === "running") run.status = err.kind === "cancelled" ? "cancelled" : err.kind === "preempted" ? "preempted" : err.kind === "timeout" && Date.now() >= ctx.budget.deadline ? "timeout" : "failed";
        if (token.cancelled && token.reason.startsWith("preempted")) run.status = "preempted";
        write(`${run.status} !! ${err.kind}: ${err.message}`);
        this.emit("run_failed", run);
        throw err;
      },
    );
    run.promise.catch(() => {});
    this.runs.set(id, run);
    // keep the table bounded
    if (this.runs.size > 200) { const oldest = this.list().filter((r) => r.status !== "running").slice(-50); for (const r of oldest) this.runs.delete(r.id); }
    return run;
  }

  cancel(id?: string, reason = "cancelled"): number {
    const targets = id ? [this.runs.get(id)].filter((r): r is Run => !!r) : this.active();
    let n = 0;
    for (const r of targets) if (r.status === "running") { r.token.cancel(reason); n++; }
    return n;
  }

  private emit(type: "run_done" | "run_failed", run: Run): void {
    for (const l of this.listeners) { try { l({ type, run }); } catch { /* listener's problem */ } }
  }
}

export function describeRun(r: Run, tailLines = 12): string {
  const dur = ((r.endedAt ?? Date.now()) - r.startedAt) / 1000;
  const head = `${r.id} ${r.script} p${r.priority}${r.background ? " bg" : ""}: ${r.status} (${dur.toFixed(1)}s)${r.status === "running" && r.current ? `, in ${r.current}` : ""}`;
  const res = r.status === "done" ? `\nresult: ${show(r.result)}` : r.error ? `\nerror: ${r.error.kind}: ${r.error.message}` : "";
  const tail = r.tail.slice(-tailLines).join("\n");
  return `${head}${res}\ntrace:\n${tail}`;
}
