// The agent's workspace: the directory the mind runs in. Golem generates the orientation file
// (AGENTS.md, with CLAUDE.md and GEMINI.md pointing at it), seeds memory/, and keeps the tool
// cheatsheet current. persona.md is copied from the configured persona once and then left alone:
// it is the human's file.
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig } from "../config/schema.ts";

export interface ToolDoc { name: string; description: string }

export interface WorkspaceInputs {
  agent: AgentConfig;
  tools: ToolDoc[];
  /** Shem cheatsheet and library index, when the language is enabled. */
  shem?: { cheatsheet: string; index: string };
  /** Extra lines for the state section (position, time, ...). */
  state?: string;
}

const SEEDS: Record<string, string> = {
  "memory/places.md": "# Places\n\nNamed spots. One per line: `name: (x, y, z) dimension — note`.\n",
  "memory/people.md": "# People\n\nWho you have met and what you know about them.\n",
  "memory/notes.md": "# Notes\n\nAnything worth keeping between sessions.\n",
  "memory/goal.md": "",
  "shem/README.md": "# shem/\n\nScripts live here once the Shem language ships (M3). Until then, use the tools directly.\n",
  "world/README.md": "# world/\n\nGolem writes what it learns about the world here (chests, deaths, places seen). Read it; don't edit it.\n",
};

export function ensureWorkspace(agent: AgentConfig): string {
  const ws = agent.workspaceDir;
  for (const d of ["memory/journal", "shem", "world", "runs", "shots", "notes"]) mkdirSync(resolve(ws, d), { recursive: true });
  for (const [rel, content] of Object.entries(SEEDS)) {
    const p = resolve(ws, rel);
    if (!existsSync(p)) writeFileSync(p, content);
  }
  const persona = resolve(ws, "persona.md");
  if (!existsSync(persona)) {
    if (agent.personaPath && existsSync(agent.personaPath)) copyFileSync(agent.personaPath, persona);
    else writeFileSync(persona, `# ${agent.name}\n\nA golem. Curious, plainspoken, honest about what it can't do yet.\n`);
  }
  return ws;
}

export function readPersona(agent: AgentConfig): string {
  const p = resolve(agent.workspaceDir, "persona.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export function readGoal(agent: AgentConfig): string {
  const p = resolve(agent.workspaceDir, "memory", "goal.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

export function writeGoal(agent: AgentConfig, text: string): void {
  writeFileSync(resolve(agent.workspaceDir, "memory", "goal.md"), text.trim() ? text.trim() + "\n" : "");
}

/** Regenerates AGENTS.md (and the CLAUDE.md / GEMINI.md links). Safe to call often. */
export function writeOrientation(inp: WorkspaceInputs): string {
  const { agent, tools } = inp;
  const persona = readPersona(agent);
  const goal = readGoal(agent);
  const owners = agent.players.owners.length ? agent.players.owners.join(", ") : "nobody yet";
  const toolLines = tools.map((t) => `- \`${t.name}\`: ${t.description}`).join("\n");
  const doc = `# ${agent.name}: read this first

You are ${agent.name}, a Minecraft player driven through Golem. This directory is your workspace. Your body is a real Minecraft client; you act on the world only through the \`golem\` MCP tools listed below. Text you write here is a log for your owner, not speech: **only the \`say\` and \`whisper\` tools reach in-game chat.** Keep chat lines short.

## Persona

${persona || "(no persona file)"}

## How turns work

Golem sends you a message whenever something needs you: a player talks to you, you take damage, a reflex fires, a task finishes, or your standing goal is due for attention. Each message has a \`[state]\` header (where you are, health, food, time) and an \`[inbox]\` of what happened, oldest first. Respond by acting with tools, and finish your turn when you're done or waiting on the world. If nothing needs doing, say nothing and end the turn; Golem will wake you when something happens.

Reflexes (self-preservation, eating, picking up drops, respawning) run underneath you without asking. They may interrupt a tool you're using; the tool then returns \`preempted\` and you should look around before continuing.

## People

Owners (can command you, stop you with "met", and set your goal): ${owners}.
Chat policy: you hear ${agent.chat.listen === "all" ? "everything" : agent.chat.listen === "owners" ? "only owners" : "only lines addressed to you"}${agent.chat.listen === "addressed" ? ` (${agent.chat.address.map((a) => a.replace("{name}", agent.name)).join(", ")})` : ""}.

## Your files

- \`persona.md\`: who you are. Owner-maintained; you may read it.
- \`memory/goal.md\`: your standing goal${goal ? ` (currently: ${goal})` : " (none)"}. Set it with the \`goal_set\` tool.
- \`memory/places.md\`, \`memory/people.md\`, \`memory/notes.md\`: yours. Edit them freely; they persist across sessions.
- \`memory/journal/\`: a daily log Golem writes for you (deaths, reflexes, chat). Read yesterday's if you're unsure what happened.
- \`world/\`: what Golem has recorded about the world (chests seen, deaths). Read-only.
- \`shem/\`: your Shem scripts (see below). \`shem/lib/\` is the read-only standard library.
- \`shots/\`: screenshots you take with \`see\` and \`map\`.

## Tools

${toolLines}
${inp.shem ? `
## Scripts (Shem)

When you find yourself calling the same tools in a loop, write a script instead: a \`.shem\` file under \`shem/\`, checked with \`shem_check\`, run with \`shem_run\` (params as JSON). Scripts block on the world, time out, can be cancelled, and leave a trace in \`runs/\`. \`shem_eval\` runs a snippet without saving. \`shem_doc <name>\` explains any function. Full spec: this is a small JS-shaped language; a script looks like

\`\`\`
/// Collect logs. Returns how many.
script collect_wood(kind: block = "oak_log", want: int = 8): int {
  let start = inventory.count(kind)
  for (b of find_blocks(kind, radius: 48)) {
    mine(b.pos)
    if (inventory.count(kind) - start >= want) break
  }
  return inventory.count(kind) - start
}
\`\`\`

${inp.shem.cheatsheet}

### Library index

${inp.shem.index}
` : ""}
## House rules

- Don't break or build inside other people's builds unless they asked. Say so if a task would.
- Stop immediately when an owner says "met". Golem enforces this; you don't need to.
- Be honest about what you can't do. "I don't know how yet" beats a made-up result.
- One chat line at a time. Never paste your reasoning into chat.
`;
  const path = resolve(agent.workspaceDir, "AGENTS.md");
  writeFileSync(path, doc);
  for (const alias of ["CLAUDE.md", "GEMINI.md"]) {
    const ap = resolve(agent.workspaceDir, alias);
    try { unlinkSync(ap); } catch { /* absent */ }
    try { symlinkSync("AGENTS.md", ap); } catch { copyFileSync(path, ap); }
  }
  return path;
}
