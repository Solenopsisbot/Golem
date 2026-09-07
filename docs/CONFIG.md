# golem.toml

One file per fleet. Anything under `[clef]`, `[mind]`, `[chat]`, `[drive]` is a default that each `[[agents]]` entry can override.

```toml
[fleet]
name = "homestead"
data_dir = "./data"            # data/<agent>/... lives here
mcp_bind = "127.0.0.1:8770"
dashboard_auth = "none"        # none: no token for dashboards/bridge on a loopback bind (the mind's MCP endpoint always needs one); token: always require one    # Golem's MCP endpoints; per-agent bearer tokens are generated into data/

[clef]
# How to get a body. Either spawn from the launcher jar...
launcher = "../MezzoSopranoClef/launcher/build/libs/mezzosopranoclef-launcher-0.1.0.jar"
java = "java"
max_heap = "768m"
server = "127.0.0.1:25565"
auth = "offline"               # offline | microsoft (device code; token cache lives in the body's game dir)
screenshot_backend = "software"
# ...or attach to one that's already running (per agent: body.attach = "127.0.0.1:8731", body.token = "...")

[mind]
command = "npx"
args = ["-y", "@agentclientprotocol/claude-agent-acp"]
env = {}                       # extra env for the agent process (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, ...)
permission_mode = "bypass"
compact_window = 100000        # Claude Code auto-compacts near this many tokens of context (CLAUDE_CODE_AUTO_COMPACT_WINDOW); 0 = harness default     # requested session mode; Golem still answers escalations by policy
allow_shell = true
model = ""                     # legacy single model (unused when models.* are set)
effort = ""
# Two-tier routing. Values are substrings matched against what the agent advertises; the newest
# version wins ("opus" -> claude-opus-5 over claude-opus-4-8). Empty = leave the agent's default.
models.plan = { model = "fable", effort = "high" }   # owner asks, deaths, goal changes, failures, first turn, plan_next, every plan_every turns
models.act  = { model = "opus",  effort = "" }       # everything else
budget.tokens_per_hour = 2_000_000
budget.turns_per_hour = 120

[drive]
interrupt_priority = 80        # inbox items at/above this cancel the current turn (death 95, low-hp damage 85, owner chat 80, self_preservation 65, trusted 55, addressed 50, other chat 40, joins 20, goal tick 10)
idle_wake = "90s"              # cadence for "continue toward your goal" when a goal is set and the inbox is empty
idle_wake_max = "10m"          # the cadence doubles toward this while goal turns make no tool calls; resets on real input
plan_every = 12                # force a planning-model turn at least every N turns (0 = never by count)
sleep_when_idle = true         # no goal + empty inbox = no prompts at all
cancel_runs_on_turn_cancel = false
inbox_max = 40                 # older items get summarised into one line

[chat]
listen = "addressed"           # all | addressed | owners
address = ["{name}", "@{name}", "hey {name}"]
speech = "explicit"            # explicit (only the say tool) | auto (agent text goes to chat)
rate = "1/3s"                  # say rate limit
max_len = 200

[players]
owners = ["Solenopsisbot"]     # can command, toggle reflexes, set goals, met
trusted = []                   # get answered, can't command
ignored = []

[comms]
agents = "bus"                 # bus: dms stay inside Golem. both: every dm is also said in public chat as "<to>: <text>" for players to watch. (chat-only is not implemented.)
                               # Golems never hear each other's in-game chat while a bus exists; they talk over the bus.
share_world = true             # one chest/place index for the fleet (data/shared/world), linked into every workspace as world/shared
conversations.max_turns = 12
conversations.cooldown = "2m"
fleets = []                    # other Golem processes to peer with: ["ws://other-host:8771"]

[etiquette]
pvp = "defend"                 # never | defend | always
protected_regions = []         # [{ name = "spawn", min = [0,0,0], max = [64,255,64] }] : no breaking/placing inside
slash_commands = ["msg", "tell", "home", "spawn", "sethome"]   # allowlist; everything else is blocked
no_grief_players = true        # don't break blocks a player placed in front of you (heuristic; needs blockUpdate events)

[reflexes]
default_on = ["self_preservation", "unstuck", "item_collecting", "auto_eat", "auto_respawn", "idle_staring"]
allow_custom = false           # agents may write their own reflexes into shem/reflexes/

[[agents]]
name = "Kiko"
persona = "personas/kiko.md"
body.username = "Kiko"
chat.speech = "auto"
reflexes.on = ["self_preservation", "unstuck", "item_collecting", "auto_eat", "auto_respawn", "cowardice"]

[[agents]]
name = "June"
persona = "personas/june.md"
body.username = "June"
mind.command = "gemini"
mind.args = ["--experimental-acp"]
reflexes.on = ["self_preservation", "unstuck", "self_defense", "hunting", "auto_eat", "auto_respawn"]
```

## Notes

- Tokens (Clef control tokens, Golem MCP bearer tokens) are never in this file. They live under `data/<agent>/` with `0600` permissions.
- `[etiquette]` is server-manners config, not a moral framework. It exists so a bot on a shared server doesn't dig through someone's floor because a script said "mine down".
- The CLI reads the same file: `golem up`, `golem up Kiko`, `golem attach Kiko`, `golem shell Kiko` (a Shem REPL against a live body, no mind involved), `golem met all`, `golem eval tasks/basic/*.json`, `golem replay data/Kiko/trace.jsonl --from 12:03`.

`mind.permission_mode` is matched against whatever modes the agent advertises (substring, case-insensitive). Claude Code: `bypass`. Codex: `full-access` (its no-prompt mode; the others are `read-only` and `auto`). If nothing matches, Golem logs the available modes and leaves the agent's default.

## Running a different mind (Codex)

`golem.codex.toml` runs OpenAI Codex as the mind through `adapters/codex-acp.ts`, a small
Golem-owned ACP adapter bridging ACP to `codex app-server` (the installed `codex` CLI's JSON-RPC
protocol). It drives your installed codex, so any model that codex supports works, including ones
newer than Zed's `@zed-industries/codex-acp` bundles. Set `mind.command = "node"`, `args =
["adapters/codex-acp.ts"]` (the loader resolves it to an absolute path), and `permission_mode =
"full-access"`. The adapter maps ACP prompts to codex `turn/start`, streams text and MCP tool calls
back, and auto-accepts codex's tool-consent elicitations and approvals. It needs `codex` on `PATH`
(`GOLEM_CODEX_BIN` overrides). Set `mind.env.CODEX_HOME` to an isolated dir (its own `config.toml`
plus a symlinked `auth.json`) to keep your global model default and skills out of the fleet;
`GOLEM_CODEX_MODEL`/`GOLEM_CODEX_EFFORT` seed the first turn. Reasoning effort is a live ACP config
option, so two-tier routing switches it per turn. Tested end to end on gpt-5.5 and gpt-6-astra.

## Custom LLM endpoints

Pointing a mind at a custom endpoint (a gateway, a self-hosted model, Logfare) depends on the wire protocol it speaks. See `docs/ENDPOINTS.md`: Anthropic Messages endpoints go through Claude Code env vars, OpenAI Responses endpoints through a Codex `model_providers` block plus `GOLEM_CODEX_PROVIDER`, and plain OpenAI Chat Completions endpoints need a small dedicated adapter (planned).

The `[bridge]` section (HTTP inbox/events on or off, webhooks, shell commands on events) is documented with the full HTTP contract in `docs/BRIDGE.md`.
