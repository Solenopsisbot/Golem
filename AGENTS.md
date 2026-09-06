# Golem: orientation for coding agents working on this repo

Golem is an embodied-agent framework for Minecraft. Read `README.md`, then `docs/ARCHITECTURE.md`. Everything below is about working *on* Golem; the workspace a Golem-driven agent sees in-game is generated separately (see `docs/ACP.md`).

## Ground rules

- **Body is MezzoSopranoClef** (`../MezzoSopranoClef`). Its WebSocket contract is `clients/schema.json` there. Do not reimplement protocol or physics here. If the body can't do something, it goes in `docs/CLEF-CHANGES.md`, not into a workaround that polls `blockAt` 200,000 times.
- **Mind is an ACP agent.** Golem is the ACP *client*. Do not write an LLM loop in this repo. If you think you need one, you probably need a reflex (deterministic code) or a Shem script.
- **Shem is the language.** Spec is `docs/SHEM.md`; the spec is the source of truth and the interpreter follows it, not the other way round. Change the spec first.
- **Primitives block until the world agrees.** A primitive returns when the effect is observable (block is air, bot is within reach, item is in inventory) or throws with a typed error. Never "fire and forget" from a primitive.
- **Every run leaves a trace.** Script runs write `runs/<id>.log` in the agent workspace. If you add a primitive, it logs.
- **Reflexes are Golem's job, not the model's.** Self-preservation, unstuck, item pickup and friends run as code with no LLM in the loop and only *notify* the mind.
- **Kill switch is sacred.** `met` must always work: cancel every run, clear movement input, stop mining, stop Baritone. Nothing may swallow it.

## Map

`src/body` (Clef client, mirror, trace) → `src/primitives` (typed world ops) → `src/reflexes` (twitch layer) → `src/agent` (runtime, session) → `src/drive` (inbox, turns, chat routing) → `src/mind` (ACP client, fs jail) → `src/mcp` (tools, HTTP host, bridge) → `src/shem` (the language: lexer, parser, checker, interpreter, runs, library, host) → `src/eval` (RCON, tasks, runner) → `src/cli` (golem, shell, replay) → `src/dashboard` (one HTML page). Shipped scripts in `shem/lib` and `shem/reflexes`; eval tasks in `tasks/`.

## Toolchain

TypeScript on Node 26 (native type stripping) or Bun 1.3. Dependencies kept minimal: `@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`, `minecraft-data` (1.21.8 tables for id validation and recipes), `zod`. Tests with `node --test`. No framework.

## Where things run

- Bodies (Clef JVMs, ~1 GB heap each) run on any x86-64 machine with Java 21; not on linux-arm64, where Mojang ships no LWJGL natives. `docs/DEPLOY.md` covers running them away from the mind.
- Minds run wherever the agent CLI is logged in; the Golem process runs next to the minds and attaches to bodies over their control port.
