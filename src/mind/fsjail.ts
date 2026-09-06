// The workspace jail for the mind's fs/read_text_file and fs/write_text_file requests. Reads are
// allowed anywhere under the workspace (and the shipped Shem library); writes only where the agent
// owns the files. Everything else is refused with a message the model can read.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentConfig } from "../config/schema.ts";
import type { MindFs } from "./acp.ts";

const WRITABLE_PREFIXES = ["shem/", "memory/", "notes/"];
const PROTECTED = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "persona.md"]);

function inside(root: string, path: string): string | null {
  const abs = resolve(path);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || rel.startsWith(sep)) return null;
  // Resolve symlinks for existing paths so a link can't escape the workspace.
  const probe = existsSync(abs) ? realpathSync(abs) : abs;
  const relReal = relative(realpathSync(root), probe);
  if (relReal.startsWith("..")) return null;
  return rel.split(sep).join("/");
}

export function makeFsJail(agent: AgentConfig, hooks: { onWrite?: (relPath: string) => void } = {}): MindFs {
  const root = agent.workspaceDir;
  return {
    async read(path, line, limit) {
      const rel = inside(root, path);
      if (!rel) throw new Error(`read refused: ${path} is outside the workspace ${root}`);
      if (!existsSync(path)) throw new Error(`no such file: ${rel}`);
      let text = readFileSync(path, "utf8");
      if (line != null || limit != null) {
        const lines = text.split("\n");
        const start = Math.max(0, (line ?? 1) - 1);
        text = lines.slice(start, limit != null ? start + limit : undefined).join("\n");
      }
      return text;
    },
    async write(path, content) {
      const rel = inside(root, path);
      if (!rel) throw new Error(`write refused: ${path} is outside the workspace ${root}`);
      if (PROTECTED.has(rel) || rel.startsWith("world/") || rel.startsWith("runs/") || rel.startsWith("shots/")) {
        throw new Error(`write refused: ${rel} is maintained by Golem or your owner. You may write under ${WRITABLE_PREFIXES.join(", ")}`);
      }
      if (!WRITABLE_PREFIXES.some((p) => rel.startsWith(p)) && rel.includes("/")) {
        throw new Error(`write refused: ${rel}. You may write under ${WRITABLE_PREFIXES.join(", ")} or top-level files of your own`);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      hooks.onWrite?.(rel);
    },
  };
}
