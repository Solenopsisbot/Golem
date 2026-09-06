# Ideas, ranked

The answer to "what else should we incorporate". Top is "do this in the core", bottom is "someday".

1. **Reflexes are Shem.** Mindcraft's modes become `reflex` declarations the agent can read, toggle and, if allowed, rewrite. One language for the twitch layer and the plan layer.
2. **The world index.** Golem records every chest opened (position, contents on close), every death (where, what was carried, likely cause), beds, portals, villages seen. Written into the workspace as JSON. `fetch("iron_ingot", 12)` then works from memory instead of a search, and "where did I die" is a file read.
3. **Structured perception first.** `look_around` as a one-call, compact, exact summary. Screenshots only when the question is visual. Cheap, fast, and a model reads "3 zombies within 12 blocks, nearest at (4, 64, -2) NE" better than pixels.
4. **A Shem REPL for humans.** `golem shell Kiko` drives a body with Shem directly, no mind in the loop. This is how we debug primitives and how you play with the body at 3 a.m. It's also the eval harness's engine.
5. **Skill growth with tests.** A `.shem` file can carry `test` blocks that run in the eval world. `shem_check` plus a passing test is what promotes a script from `shem/` to `shem/lib/`. Voyager's loop, with a compiler in it.
6. **Eval tasks in CI.** `tasks/*.json` (goal, starting inventory via commands on the creative e2e server, success predicate, time limit). Reuse Clef's `scripts/e2e.sh` machinery. Numbers are how we know a change to the prompt or the library helped.
7. **Journal memory.** Golem writes a daily digest of events; the agent writes reflections. The last few entries are injected at session start. Cheap continuity across restarts for agents without `loadSession`.
8. **Owner fast path in chat.** `@Kiko met`, `@Kiko mode hunting off`, `@Kiko goal build a dock`, `@Kiko status` handled deterministically, no LLM turn. Instant and free.
9. **Replay.** Everything on the wire to and from the body goes to `trace.jsonl`. `golem replay` rebuilds the state mirror at any timestamp and prints what the bot saw and did. Debugging a death without it is guesswork.
10. **Blueprints and `build`.** A blueprint format (`map<pos, block>` plus helpers `box`, `fill`, `hollow`, `line`, `stairs`, `layer`), a `build` primitive that places bottom-up and fetches materials from the index, `check_build` for what's missing, and a screenshot from above for review. The mind *designs* by writing a generator script, which is exactly what it's good at.
11. **Top-down map and annotated screenshots.** Orthographic render from the raycaster's voxel snapshot; entity labels projected with known camera parameters. Makes `see` far more useful for "where are things relative to each other".
12. **Budgets and sleep.** Tokens per hour, turns per hour, and no prompts at all when nothing is happening and no goal is set. A bot that stands still should cost nothing.
13. **Etiquette as config.** Protected regions, PvP policy, slash-command allowlist, chat rate. Server manners in a TOML table, so a shared-server deployment is a config, not a fork.
14. **Ayusami bridge.** Same persona files for Kiko, Amelia and June; a small bus so the Discord side knows what the Minecraft side is doing ("Kiko is mining, back in a bit") and vice versa. A character who exists in two places is the computer-friends project in one feature. Your call whether Golem should know about Ayusami or the other way round.
15. **Cheap helpers via Logfare.** "Is this chat line addressed to me?" and "summarise this inbox" don't need the big model. Route those to a Logfare model, keep the ACP agent for thinking. Dogfooding, too.
16. **Squad control.** One mind, several bodies, each with its own Shem run queue. Leader assigns scripts to bodies over the bus. Later, but the architecture allows it because a body is just a client and a run queue.
17. **Peer fleets.** Golem processes on ladybug and cytonic peering over WebSocket so bots on different machines share a bus and, optionally, a world index.
18. **Voice.** Ayusami already has a voice pipeline and LiveKit lives on astral. A bot that talks in proximity chat is a plugin away once the rest works.
19. **Server-side companion mod (optional).** For servers you own: precise block-placed-by-whom data for grief avoidance, cheap teleport for eval setups, and a way to ask the server what a chest contains without opening it. Never required.
20. **Dashboard.** Transcript, tool calls, screenshot stream, run traces, inbox, per-agent tabs. Clef's own dashboard covers the body; this covers the mind. Keep it small and server-rendered.
