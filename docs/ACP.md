# Driving the mind over ACP

Golem is an ACP **client**. The mind is an ACP **agent** subprocess. Everything below uses `@agentclientprotocol/sdk` (1.4.x) on the client side and, by default, `@agentclientprotocol/claude-agent-acp` (0.75.x; the old `@zed-industries/claude-code-acp` name is deprecated) as the agent. Codex (`codex-acp`), Gemini CLI (`gemini --experimental-acp`), Kimi, OpenCode and the rest are config changes.

## Lifecycle

1. **Spawn.** `spawn(mind.command, mind.args, { env, stdio: pipe })`. Wrap stdin/stdout with `ndJsonStream`. Build the client with `acp.client({ name: "golem" })`, register handlers, `connectWith(stream)`.
2. **Initialize.** `initialize({ protocolVersion, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } })`. Read back `agentCapabilities`: `loadSession`, `promptCapabilities.image`, `mcpCapabilities.http`.
3. **Session.** `session/new` with `cwd = data/<agent>/workspace` (absolute) and `mcpServers = [{ type: "http", name: "golem", url, headers: [Authorization: Bearer <token>] }]`. If the agent lacks `mcpCapabilities.http`, pass the stdio shim instead: `{ name: "golem", command: "golem", args: ["mcp-stdio", "--agent", name], env: [...] }`.
4. **Mode.** For Claude Code, request `bypassPermissions` (alias `bypass`) as the session mode so the adapter stops asking. Golem still receives `requestPermission` for anything the adapter escalates, and answers by policy (below). The adapter refuses bypass when running as root; Golem never runs as root.
5. **Orient.** First prompt turn is the `orient` content: persona, place, inbox, how scripts work. Cheap, because the workspace `AGENTS.md`/`CLAUDE.md` carries most of it and the adapter reads it anyway.
6. **Turns.** See below.
7. **Resume.** On restart, if `agentCapabilities.loadSession`, call `session/load` with the saved `sessionId` and replay; otherwise open a new session and prepend the last journal entries and `goal.md` to the orient prompt.

## Prompt turns

The drive builds each turn from the inbox (see ARCHITECTURE.md):

```
[state] Kiko | (118, 64, -27) overworld | day, clear | hp 18/20 food 14 | held: iron_axe | run: none | reflexes: sp,unstuck,collect
[inbox]
12:03:11 chat   Solenopsisbot: kiko can you grab me some birch?
12:03:15 reflex item_collecting picked up 3 birch_log
12:03:40 run    collect_wood finished: 8 logs (41s)
```

Text goes in a `text` content block. When an item carries a picture (a death, an owner asking "what does this look like", a build review), an `image` block is appended, guarded by `promptCapabilities.image`.

Handling `session/update`:

| kind | Golem does |
|---|---|
| `agent_message_chunk` | Append to transcript. If `chat.speech = auto`, buffer by sentence and `say` it (rate-limited). |
| `agent_thought_chunk` | Transcript only. |
| `tool_call` / `tool_call_update` | Dashboard and transcript. Nothing else: Golem's MCP tools already know what they did. |
| `plan` | Dashboard. |
| `usage_update` | Budget accounting. Over budget: finish the turn, then sleep until the window resets. |

The turn ends with a `stopReason`. `end_turn` is normal. `max_tokens`/`max_turn_requests` are logged and the next turn carries a note. `cancelled` means Golem interrupted it.

## Interrupts

An inbox item above `drive.interrupt_priority` while a turn is running: `session/cancel`, wait for the `cancelled` stop reason, then prompt with the whole inbox. The cancelled turn's partial text is kept in the transcript with a marker. Optionally (`drive.cancel_runs_on_turn_cancel`) active Shem runs are cancelled too; default is **not**, because a half-finished bridge is worse than a finished one.

## Permissions

`requestPermission` is answered by policy, never by a human at 3 a.m.:

- Golem MCP tools: allow.
- File reads anywhere under the workspace: allow. Outside: deny (the agent may read `shem/lib` docs; everything else it needs is in the workspace).
- File writes under `workspace/shem/`, `workspace/memory/`, `workspace/notes/`: allow. Writes to `AGENTS.md`, `persona.md`, `world/`, `runs/`: deny with a message explaining who owns those.
- Shell: allow if `mind.allow_shell` (default true for Claude Code, since it's how it greps its own scripts). Network from the shell is the agent's own sandbox concern; Golem does not proxy it.

Because Golem advertises the `fs` capability, file reads and writes route through Golem's `readTextFile`/`writeTextFile` handlers. That is where the workspace jail lives, and where a write to `shem/*.shem` triggers a re-index of the library and a regeneration of the orientation doc.

## The workspace

```
data/<agent>/workspace/
  AGENTS.md         generated: persona summary, tool cheatsheet, Shem cheatsheet, library index, house rules
  CLAUDE.md         symlink to AGENTS.md (Codex reads AGENTS.md, Claude reads CLAUDE.md, Gemini reads GEMINI.md)
  GEMINI.md         symlink to AGENTS.md
  persona.md        the character, human-owned
  shem/             the agent's scripts; shem/lib/ is a read-only mount of the shipped library
  memory/           places.md people.md notes.md goal.md journal/
  world/            Golem-written: chests.json deaths.json seen.json
  runs/             traces
  shots/            screenshots saved to disk (also returned inline)
```

Regenerating `AGENTS.md` on every library change keeps the mind's map of its own skills current without a prompt turn.

## Other agents

| Agent | Command | Notes |
|---|---|---|
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp` | Images, http MCP, loadSession, modes, model and effort options. Default. |
| Codex | `codex-acp` | Check `mcpCapabilities` at init; fall back to the stdio shim. |
| Gemini CLI | `gemini --experimental-acp` | Same. |
| Anything else | config | `mind.command`, `mind.args`, `mind.env`. |

Golem never assumes an agent-specific feature without checking the capability the agent advertised at `initialize`.
