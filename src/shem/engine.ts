// The Shem engine: one per agent. Ties the library, checker, interpreter and run manager together
// and exposes the operations the MCP tools and the shell use.
import type { AgentRuntime } from "../agent/runtime.ts";
import { GolemError } from "../primitives/errors.ts";
import { BUILTINS, BUILTIN_BY_NAME, EVENTS, GETTERS, GETTER_BY_NAME, signature } from "./builtins.ts";
import { formatDiagnostics, type Diagnostic } from "./checker.ts";
import { makeRegistry, makeShemHost } from "./host.ts";
import { Interpreter } from "./interpreter.ts";
import { Library, signatureOf, type LoadedFile } from "./library.ts";
import { RunManager, describeRun, type Run, type RunOptions } from "./runs.ts";
import { truthy, type Value } from "./values.ts";
import type { Reflex, ReflexEngine } from "../reflexes/engine.ts";
import { CancelToken } from "../primitives/errors.ts";
import type { RunCtx } from "./interpreter.ts";
import { Env } from "./values.ts";

export class ShemEngine {
  readonly rt: AgentRuntime;
  readonly library: Library;
  readonly interpreter: Interpreter;
  readonly runs: RunManager;
  private readonly registry: ReturnType<typeof makeRegistry>;

  constructor(rt: AgentRuntime) {
    this.rt = rt;
    this.library = new Library(rt.agent.workspaceDir);
    this.interpreter = new Interpreter(makeShemHost(rt));
    this.runs = new RunManager(this.interpreter, rt.agent.workspaceDir);
    this.registry = makeRegistry(rt);
  }

  /** Check a file (path or lib ref). Returns diagnostics and a formatted summary. */
  check(ref: string): { diagnostics: Diagnostic[]; text: string; file: LoadedFile | null } {
    let lf: LoadedFile;
    try { lf = this.library.load(ref); }
    catch (e) { return { diagnostics: [], text: (e as Error).message, file: null }; }
    const diagnostics = this.library.check(lf, { registry: this.registry });
    return { diagnostics, text: formatDiagnostics(diagnostics, lf.rel), file: lf };
  }

  checkSource(src: string): { diagnostics: Diagnostic[]; text: string } {
    try {
      const lf = this.library.fromSource(src);
      const d = this.library.check(lf, { registry: this.registry });
      return { diagnostics: d, text: formatDiagnostics(d) };
    } catch (e) { return { diagnostics: [], text: (e as Error).message }; }
  }

  /** Start a run of a script in a file. Throws on syntax/check errors (warnings are allowed). */
  run(ref: string, script: string | undefined, params: Record<string, Value>, opts: RunOptions = {}): Run {
    const lf = this.library.load(ref);
    if (lf.error) throw new GolemError("failed", `syntax error in ${lf.rel}: ${lf.error.message}`);
    const errors = this.library.check(lf, { registry: this.registry }).filter((d) => d.severity === "error");
    if (errors.length) throw new GolemError("failed", `${lf.rel} has check errors; fix them first:\n${formatDiagnostics(errors, lf.rel)}`);
    const { program } = this.library.program(lf);
    const own = lf.file.scripts.map((x) => x.name);
    // Be forgiving about where the script name went: `params.script` naming a script counts.
    if (!script && typeof params.script === "string" && program.scripts.has(params.script) ) { script = params.script; params = { ...params }; delete params.script; }
    let name = script;
    if (!name) {
      if (program.scripts.has(lf.file.name)) name = lf.file.name;
      else if (program.scripts.has("main")) name = "main";
      else if (own.length === 1) name = own[0]!;
      else throw new GolemError("not_found", `${lf.rel} has several scripts and none is called main or ${lf.file.name}; pass script: one of ${own.join(", ")}`);
    }
    if (!program.scripts.has(name)) throw new GolemError("not_found", `${lf.rel} has no script named ${name} (has: ${[...program.scripts.keys()].join(", ") || "none"})`);
    return this.runs.start(program, name, params, { ...opts, label: `${lf.rel}:${name}`, parent: opts.background ? undefined : this.rt.foregroundToken });
  }

  /** Run a snippet (a script body, or a full file) without saving it. */
  eval(src: string, params: Record<string, Value> = {}, opts: RunOptions = {}): Run {
    const isFile = /^\s*(script|use|const|reflex|\/\/\/)/m.test(src) && /\bscript\s+\w+\s*\(/.test(src);
    const lf = this.library.fromSource(isFile ? src : `script main() {\n${src}\n}`);
    const errors = this.library.check(lf, { registry: this.registry }).filter((d) => d.severity === "error");
    if (errors.length) throw new GolemError("failed", `snippet has check errors:\n${formatDiagnostics(errors)}`);
    const { program } = this.library.program(lf);
    const name = program.scripts.has("main") ? "main" : lf.file.scripts[0]!.name;
    return this.runs.start(program, name, params, { ...opts, label: `eval:${name}`, parent: opts.background ? undefined : this.rt.foregroundToken });
  }

  /** Wait for a run to end (bounded). Returns its description. */
  async wait(run: Run, timeoutMs: number): Promise<string> {
    await Promise.race([run.promise.catch(() => {}), new Promise((r) => setTimeout(r, timeoutMs))]);
    return describeRun(run);
  }

  list(): string { return this.library.index(); }

  doc(name: string): string {
    const b = BUILTIN_BY_NAME.get(name);
    if (b) return `${signature(b)}\n${b.doc}${b.blocking ? "\n(blocks until the world agrees)" : ""}${b.stub ? "\nNOT IMPLEMENTED YET: fails with 'unsupported'." : ""}`;
    const g = GETTER_BY_NAME.get(name);
    if (g) return `${g.name}: ${g.returns}\n${g.doc}`;
    if (name in EVENTS) return `event ${name}(${EVENTS[name]!.join(", ")})\nUse in: on ${name}(${EVENTS[name]!.join(", ")}) when <cond> { ... }`;
    for (const lf of this.library.all()) {
      for (const s of lf.file.scripts) if (s.name === name) return `${lf.rel}: ${signatureOf(s)}\n${s.doc || "(no doc)"}`;
    }
    return `nothing named ${name}. Try shem_list, or one of: ${BUILTINS.slice(0, 8).map((x) => x.name).join(", ")}...`;
  }

  /**
   * Register every `reflex` declared under shem/reflexes/ (shipped and the agent's own, when
   * allowed) with the reflex engine. `on tick when <cond>` reflexes evaluate their condition on the
   * engine's cadence; event reflexes arm on the event and fire on the next engine tick.
   */
  loadReflexes(engine: ReflexEngine, allowCustom: boolean): string[] {
    const names: string[] = [];
    for (const lf of this.library.all()) {
      if (!lf.rel.startsWith("reflexes/") && !lf.path.includes("/shem/reflexes/")) continue;
      if (!lf.rel.startsWith("reflexes/") && !allowCustom) continue;
      if (lf.error) { this.rt.log.warn(`reflex file ${lf.rel}: ${lf.error.message}`); continue; }
      const { program } = this.library.program(lf);
      const host = (this.interpreter as unknown as { host: import("./interpreter.ts").Host }).host;
      for (const decl of lf.file.reflexes) {
        const interp = this.interpreter;
        const makeRun = (token: CancelToken): RunCtx => ({
          id: `reflex:${decl.name}`, token, log: (l) => this.rt.log.debug(`[${decl.name}] ${l}`), trace: () => {},
          budget: { deadline: Date.now() + 60_000, calls: 0, maxCalls: 200, loops: 0, maxLoops: 10_000, depth: 0, maxDepth: 32 }, tasks: new Set(), handlerError: null,
        });
        let pending: Value[] | null = null;
        if (decl.event.name !== "tick") host.onEvent(decl.event.name, (args) => { pending = args; });
        const evalWhen = async (args: Value[]): Promise<boolean> => {
          if (!decl.when) return true;
          const env = new Env();
          for (const c of program.consts) env.declare(c.name, await interp.evalExpr(c.value, env, makeRun(new CancelToken())), false);
          decl.event.args.forEach((n, i) => env.declare(n, args[i] ?? null));
          return truthy(await interp.evalExpr(decl.when, env, makeRun(new CancelToken())));
        };
        const reflex: Reflex<Value[]> = {
          name: decl.name,
          description: `${decl.doc.split("\n")[0] || "(shem reflex)"} [${lf.rel}]`,
          priority: decl.priority ?? 50,
          interrupts: (decl.priority ?? 50) >= 60,
          cooldownMs: 3000,
          check: async () => {
            if (decl.event.name === "tick") return (await evalWhen([])) ? [] : null;
            if (!pending) return null;
            const args = pending; pending = null;
            return (await evalWhen(args)) ? args : null;
          },
          act: async (p, args) => {
            const env = new Env();
            for (const c of program.consts) env.declare(c.name, await interp.evalExpr(c.value, env, makeRun(p.ctx.token)), false);
            for (const sc of program.scripts.values()) env.declare(sc.name, (interp as unknown as { scriptClosure: (s: typeof sc, e: Env) => Value }).scriptClosure(sc, env), false);
            decl.event.args.forEach((n, i) => env.declare(n, args[i] ?? null));
            await interp.execBlock(decl.body, env, makeRun(p.ctx.token));
            return `${decl.name} ran`;
          },
        };
        engine.register(reflex);
        names.push(decl.name);
      }
    }
    return names;
  }

  /** The cheatsheet embedded in the workspace orientation. */
  cheatsheet(): string {
    const lines: string[] = [];
    lines.push("Values: `here` (pos) `eye` `me` `health` `food` `phase` `weather` `inventory.count(item)` `inventory.has(item, n)` `idle`.");
    lines.push("Statements: `let x = …`, `if (c) { } else { }`, `for (x of list) { }`, `while (c) { }`, `repeat (n) { }`, `wait 5s`, `wait until c timeout 20s else { }`, `<call> timeout 30s`, `timeout 30s { } else { }`, `parallel { } { }`, `race { } { }`, `let t = spawn { }`, `try { } catch (e) { } finally { }`, `on damage(amount) when health < 6 { fail \"ow\" }`, `log \"…\"`, `say \"…\"`, `fail \"…\"`, `return x`.");
    lines.push("Literals: durations `500ms 30s 2m`, positions `(x, y, z)`, strings with `${expr}`, block/item ids as strings (\"oak_log\").");
    lines.push("Functions (all block until done): " + BUILTINS.filter((b) => !b.stub).map((b) => `\`${b.name}(${b.params.map((p) => p.name + (p.def !== undefined ? "?" : "")).join(", ")})\``).join(" "));
    lines.push("Events for `on`: " + Object.keys(EVENTS).join(", ") + ".");
    lines.push("Errors have kinds: timeout, unreachable, not_found, missing_item, cant_place, cant_break, blocked, cancelled, preempted, unsupported, failed. `catch (e)` gives `e.kind`, `e.message`.");
    lines.push("Getters: " + GETTERS.map((g) => g.name).join(", ") + ".");
    return lines.join("\n");
  }
}

export { describeRun };
