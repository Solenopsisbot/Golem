# The bridge: hooking Golem into other systems

Every golem is reachable over plain HTTP on the Golem port (`fleet.mcp_bind`, default
`127.0.0.1:8770`), and every golem can push its events outward. Nothing here knows or cares what is
on the other end: a chat bot, a web page, a voice pipeline, a test harness. This is the contract.

## Auth

On a loopback bind with `fleet.dashboard_auth = "none"` (the default) none of the routes below need a
token; only the mind's own MCP endpoint does. Otherwise each agent has a bearer token in
`data/<name>/tokens.json` (`mcp`): send it as `Authorization: Bearer <token>`, or as `?token=` on GET
requests (event streams, pages). Fleet routes accept any agent's token. `GET /api/config` (always
public) says which mode is in effect.

## Inbound: talking to a golem

| route | body | what happens |
|---|---|---|
| `POST /agents/<name>/inbox` | `{text, from?, kind?, priority?}` | An inbox item the mind sees on its next turn (or, above the interrupt priority, right away). `kind` defaults to `bridge`. `priority` defaults to 80 when `from` is an owner, else 50. |
| `POST /agents/<name>/say` | `{text}` | Make the body speak in game chat, no mind involved. |
| `POST /fleet/inbox` | same as inbox | The same item to every agent. |
| `GET /agents/<name>/status` | | One-line state (position, health, food, held item, goal). |
| `GET /agents/<name>/info` | | The whole picture as JSON: `body` (account, server, control socket, protocol, connected/in world), `player` (position, facing, biome, light, xp, armour, effects, condition flags), `world` (clock, day, phase, weather), `players` online, nearby `entities` by type, the full `inventory` by slot (a live body read, cached 1.5 s), and `mind` (adapter, model, session, hourly turn/token budget, context). |
| `GET /fleet/status` | | Every agent's state line plus dashboard links. |
| `GET /fleet/shared` | | The shared task board, places and chest index as markdown. |
| `GET /fleet/bus` | | The last 150 agent-to-agent messages. |

`from` matters. When it names one of `players.owners`, the message is treated exactly like the owner
speaking in game, including the **fast path**: `goal <text>` sets the standing goal, `met` (or
`stop`) cancels everything the golem is doing, `status` answers in chat, `come` walks to the owner,
and `mode <reflex> on|off` toggles a reflex. None of those wake the mind, so they cost nothing.
Anything else from an owner arrives at priority 80, which is folded into a running turn. Messages
from anyone else arrive at 50 and wait for the next turn.

The reply to a message is not in the HTTP response; it comes back through the events below (the
mind answers with `say`, or with a `dm` if the sender was another golem).

## Outbound: hearing from a golem

`GET /agents/<name>/events` is a server-sent-events stream of everything that agent does;
`GET /fleet/events` is the same for every agent, each event tagged with `agent`. Each event is
`event: <type>` with a JSON `data:` line carrying `t` (ms since epoch) and type-specific fields:

| type | fields | meaning |
|---|---|---|
| `hello` | `state` (agent) or `agents` (fleet) | first message on connect |
| `said` | `text`, `kind` | the golem spoke in chat, from any path: the mind's `say`, the owner fast path, a reflex, or a mirrored dm (`comms.agents = "both"`, arriving as `Other: text`). Taken from the line echoing back from the server, so it is exactly what players saw. |
| `dm` | `to`, `text` | the golem messaged another golem |
| `bus` (fleet) | `from`, `to`, `text` | a bus message between golems |
| `inbox` | `kind`, `priority`, `from`, `text` | something entered the inbox (chat, damage, reflexes, your messages) |
| `prompt` | `text`, `model`, `planning`, `queued` | a turn started (or a message was queued into one) |
| `agent_text` | `text` | a chunk of the mind's own narration |
| `golem_tool` | `name`, `args`, `result`, `ms`, `isError` | a Golem tool was called |
| `tool_call`, `tool_call_update` | `id`, `title`, `status` | the agent's own tool activity |
| `turn_end` | `stopReason`, `ms`, `tokens`, `model`, `toolCalls` | a turn ended |
| `usage` | `used`, `size` | context size after the last model call |
| `reflex` | `name`, `note` | a reflex fired |
| `state` (fleet) | `agents` | every agent's state line, every 3 s |

The same events can be pushed instead of pulled. Per agent (or fleet-wide under `[bridge]`):

```toml
[bridge]
webhooks = [
  { url = "https://example.org/golem", events = ["said", "dm", "turn_end", "reflex"], headers = { "X-Token" = "..." } },
]
commands = [
  { on = "said", run = "jq -r .text >> /tmp/golem-said.log" },   # the event JSON is on stdin
]
```

`events` takes exact types, `*`, or a prefix like `tool_*`. Webhook bodies are the event plus
`agent`. Failures are logged and never stop the golem.

## A minimal integration

`examples/bridge-client.mjs` subscribes to the fleet stream, prints what the golems say and do, and
relays lines you type into one agent's inbox as an owner. That is the whole shape of a Discord
bot, a web chat, or a voice front end: subscribe to events, post to the inbox.

```bash
node examples/bridge-client.mjs --agent Clay --from YourName --token $(jq -r .mcp data/Clay/tokens.json)
```

## Notes for integrators

- The inbox is coalesced: several messages arriving while the mind is busy are delivered together.
  If you need an answer to a specific message, include something to recognise it in the text.
- `POST /say` bypasses the mind; use it for announcements, not conversation.
- The MCP endpoint (`/agents/<name>/mcp`) is the mind's own tool connection; other systems should
  use the routes above rather than driving the body directly.
- Keep the Golem port on a private network. The token is the only auth.
