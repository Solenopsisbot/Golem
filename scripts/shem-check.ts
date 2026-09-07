// Check every shipped Shem library file (and any files given) against the registry, no body needed.
//   node scripts/shem-check.ts            # shem/lib/*.shem
//   node scripts/shem-check.ts path.shem  # specific files
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "../src/shem/parser.ts";
import { check, formatDiagnostics, type Registry } from "../src/shem/checker.ts";
import { mcData } from "../src/primitives/context.ts";
import { Library } from "../src/shem/library.ts";

const mc = mcData();
const tables = { block: mc.blocksByName, item: mc.itemsByName, entity: mc.entitiesByName } as Record<string, Record<string, unknown>>;
const registry: Registry = { has: (kind, id) => id in tables[kind]!, suggest: () => [] };
const libDir = resolve(import.meta.dirname, "..", "shem", "lib");
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(libDir).filter((f) => f.endsWith(".shem")).map((f) => resolve(libDir, f));
const lib = new Library(resolve(import.meta.dirname, "..", "data", "_check", "workspace"));
let bad = 0;
for (const f of files) {
  let diags;
  try {
    const rel = f.includes("/shem/lib/") ? `lib/${basename(f, ".shem")}` : f;
    const lf = f.includes("/shem/lib/") ? lib.load(rel) : { path: f, rel: basename(f), file: parse(readFileSync(f, "utf8"), basename(f, ".shem")), mtime: 0, error: null };
    if (lf.error) { console.log(`${basename(f)}: syntax error: ${lf.error.message}`); bad++; continue; }
    diags = lib.check(lf, { registry });
  } catch (e) { console.log(`${basename(f)}: ${(e as Error).message}`); bad++; continue; }
  const errors = diags.filter((d) => d.severity === "error");
  console.log(`${basename(f)}: ${errors.length ? errors.length + " error(s)" : "ok"}${diags.length && !errors.length ? ` (${diags.length} note(s))` : ""}`);
  if (diags.length) console.log("  " + formatDiagnostics(diags, basename(f)).split("\n").join("\n  "));
  if (errors.length) bad++;
}
process.exit(bad ? 1 : 0);
