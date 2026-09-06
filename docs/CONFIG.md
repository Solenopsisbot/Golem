# golem.toml

One file per fleet. Anything under `[clef]`, `[mind]`, `[chat]`, `[drive]` is a default that each `[[agents]]` entry can override.

```toml
[fleet]
name = "homestead"
data_dir = "./data"            # data/<agent>/... lives here
mcp_bind = "127.0.0.1:8770"    # Golem's MCP endpoints; per-agent bearer tokens are generated into data/

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
permission_mode = "bypass"     # requested session mode; Golem still answers escalations by policy
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
agents = "bus"                 # bus | chat | both
conversations.max_turns = 12
conversations.cooldown = "2m"
fleets = []                    # other Golem processes to peer with: ["ws://cytonic:8771"]

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
