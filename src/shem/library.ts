// The script library: the agent's shem/ plus the shipped shem/lib/. Parses on demand (cached by
// mtime), resolves `use` imports, and renders the index the orientation doc and shem_list show.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { File, ScriptDecl } from "./ast.ts";
import { check, type CheckOptions, type Diagnostic } from "./checker.ts";
import type { Program } from "./interpreter.ts";
import { ShemSyntaxError } from "./lexer.ts";
import { parse } from "./parser.ts";

export const SHIPPED_LIB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../shem/lib");
export const SHIPPED_REFLEX_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../shem/reflexes");

export interface LoadedFile { path: string; rel: string; file: File; mtime: number; error: ShemSyntaxError | null }

export class Library {
  private readonly workspaceDir: string;
  private readonly cache = new Map<string, LoadedFile>();
  constructor(workspaceDir: string) { this.workspaceDir = workspaceDir; }

  get roots(): { dir: string; prefix: string }[] {
    return [
      { dir: resolve(this.workspaceDir, "shem"), prefix: "" },
      { dir: SHIPPED_LIB_DIR, prefix: "lib/" },
      { dir: SHIPPED_REFLEX_DIR, prefix: "reflexes/" },
    ];
  }

  /** Resolve "lib/trees", "shem/lib/trees.shem", "/abs/path.shem" or "mine.shem" to an absolute path. */
  resolvePath(ref: string): string {
    const clean = ref.replace(/\.shem$/, "");
    if (clean.startsWith("/")) return clean + ".shem";
    const candidates = [
      resolve(this.workspaceDir, clean + ".shem"),
      resolve(this.workspaceDir, "shem", clean.replace(/^shem\//, "") + ".shem"),
      clean.startsWith("lib/") ? resolve(SHIPPED_LIB_DIR, clean.slice(4) + ".shem") : "",
      clean.startsWith("reflexes/") ? resolve(SHIPPED_REFLEX_DIR, clean.slice(9) + ".shem") : "",
    ].filter(Boolean);
    return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
  }

  load(pathOrRef: string): LoadedFile {
    const path = this.resolvePath(pathOrRef);
    if (!existsSync(path)) throw new Error(`no such script file: ${pathOrRef} (looked at ${path})`);
    const mtime = statSync(path).mtimeMs;
    const cached = this.cache.get(path);
    if (cached && cached.mtime === mtime) return cached;
    const rel = this.relName(path);
    let file: File;
    let error: ShemSyntaxError | null = null;
    try { file = parse(readFileSync(path, "utf8"), basename(path, ".shem")); }
    catch (e) { if (e instanceof ShemSyntaxError) { error = e; file = { uses: [], consts: [], scripts: [], reflexes: [], source: "", name: basename(path, ".shem") }; } else throw e; }
    const loaded = { path, rel, file, mtime, error };
    this.cache.set(path, loaded);
    return loaded;
  }

  relName(path: string): string {
    if (path.startsWith(SHIPPED_LIB_DIR)) return "lib/" + relative(SHIPPED_LIB_DIR, path).replace(/\.shem$/, "");
    if (path.startsWith(SHIPPED_REFLEX_DIR)) return "reflexes/" + relative(SHIPPED_REFLEX_DIR, path).replace(/\.shem$/, "");
    return relative(resolve(this.workspaceDir, "shem"), path).replace(/\.shem$/, "");
  }

  /** Parse a snippet as if it were a file, for shem_eval. */
  fromSource(src: string, name = "eval"): LoadedFile {
    return { path: `<${name}>`, rel: name, file: parse(src, name), mtime: 0, error: null };
  }

  /** Build the program for a file: its scripts plus everything reachable through `use`. */
  program(entry: LoadedFile): { program: Program; files: LoadedFile[] } {
    const scripts = new Map<string, ScriptDecl>();
    const consts: Program["consts"] = [];
    const files: LoadedFile[] = [];
    const seen = new Set<string>();
    const visit = (lf: LoadedFile) => {
      if (seen.has(lf.path)) return;
      seen.add(lf.path);
      if (lf.error) throw lf.error;
      files.push(lf);
      for (const u of lf.file.uses) visit(this.load(u.path));
      for (const c of lf.file.consts) consts.push({ name: c.name, value: c.value });
      for (const s of lf.file.scripts) if (!scripts.has(s.name) || lf === entry) scripts.set(s.name, s);
    };
    visit(entry);
    return { program: { scripts, consts }, files };
  }

  /** Run the checker on a file with its imports resolved. */
  check(lf: LoadedFile, opts: Omit<CheckOptions, "imported"> = {}): Diagnostic[] {
    if (lf.error) return [{ severity: "error", message: lf.error.message.replace(/^\d+:\d+: /, ""), loc: lf.error.loc }];
    const imported: NonNullable<CheckOptions["imported"]> = new Map();
    for (const u of lf.file.uses) {
      try {
        const dep = this.load(u.path);
        for (const s of dep.file.scripts) imported.set(s.name, { params: s.params.map((p) => ({ name: p.name, hasDefault: !!p.def, type: p.type?.name ?? null })) });
      } catch (e) {
        return [{ severity: "error", message: `use ${JSON.stringify(u.path)}: ${(e as Error).message}`, loc: u.loc }];
      }
    }
    const known = new Map<string, string>();
    for (const other of this.all()) if (other !== lf && !other.error) for (const sc of other.file.scripts) if (!known.has(sc.name)) known.set(sc.name, other.rel);
    return check(lf.file, { ...opts, imported, known, reflexFile: opts.reflexFile ?? lf.rel.startsWith("reflexes/") });
  }

  /** Every .shem file under the roots. */
  all(): LoadedFile[] {
    const out: LoadedFile[] = [];
    for (const r of this.roots) {
      if (!existsSync(r.dir)) continue;
      const walk = (d: string) => {
        for (const ent of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, ent.name);
          if (ent.isDirectory()) { if (d === resolve(this.workspaceDir, "shem") && ent.name === "lib") continue; walk(p); }
          else if (ent.name.endsWith(".shem")) { try { out.push(this.load(p)); } catch { /* skip unreadable */ } }
        }
      };
      walk(r.dir);
    }
    return out;
  }

  /** Markdown index: every script with its signature and doc. */
  index(): string {
    const lines: string[] = [];
    const groups = new Map<string, LoadedFile[]>();
    for (const lf of this.all()) {
      const g = lf.rel.startsWith("lib/") ? "Standard library (shem/lib, read-only)" : lf.rel.startsWith("reflexes/") ? "Reflexes" : "Your scripts (shem/)";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(lf);
    }
    for (const [g, files] of groups) {
      lines.push(`### ${g}`);
      for (const lf of files) {
        if (lf.error) { lines.push(`- \`${lf.rel}\`: SYNTAX ERROR ${lf.error.message}`); continue; }
        for (const s of lf.file.scripts) lines.push(`- \`${lf.rel}\` **${signatureOf(s)}**${s.doc ? `: ${s.doc.split("\n")[0]}` : ""}`);
        for (const r of lf.file.reflexes) lines.push(`- \`${lf.rel}\` reflex **${r.name}** on ${r.event.name}${r.doc ? `: ${r.doc.split("\n")[0]}` : ""}`);
      }
    }
    return lines.join("\n") || "(no scripts yet)";
  }
}

export function signatureOf(s: ScriptDecl): string {
  const ps = s.params.map((p) => `${p.name}${p.type ? `: ${p.type.name}` : ""}${p.def ? ` = ${exprSource(p.def)}` : ""}`).join(", ");
  return `${s.name}(${ps})${s.returnType ? `: ${s.returnType.name}` : ""}`;
}

function exprSource(e: import("./ast.ts").Expr): string {
  switch (e.kind) {
    case "int": case "float": return String(e.value);
    case "bool": return String(e.value);
    case "none": return "none";
    case "dur": return `${e.ms}ms`;
    case "string": return JSON.stringify(e.parts.map((p) => typeof p === "string" ? p : "${…}").join(""));
    case "ident": return e.name;
    case "tuple": return `(${e.items.map(exprSource).join(", ")})`;
    case "list": return `[${e.items.map(exprSource).join(", ")}]`;
    default: return "…";
  }
}
