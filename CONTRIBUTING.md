# Contributing

Golem is small enough to read in an afternoon. Start with `docs/ARCHITECTURE.md` (the decisions), then `docs/DEV.md` (how to run it).

## Before you open a pull request

```
npm run typecheck
npm test
npm run gen:tools      # if you added or changed an MCP tool: docs/MCP-TOOLS.md is generated
```

CI runs the first two on every push.

## Conventions

- TypeScript, run directly by Node's type stripping: no build step, no decorators, `import type` for types.
- Comments explain why, not what. Anything non-obvious about the Minecraft protocol, Baritone, or the body's quirks belongs in a comment next to the code that works around it.
- Tools are for things a mind can't do in Shem. Before adding an MCP tool, check whether a Shem builtin or a library script under `shem/lib/` covers it; every tool call costs the model a full round trip.
- A behaviour change that a golem could notice (a reflex, a prompt header line, a tool result format) should come with a line in `docs/ARCHITECTURE.md` or `docs/SHEM.md` saying what changed and why.
- Keep personal machine names, addresses and usernames out of the tree. `golem.toml` is ignored; `golem.example.toml` is the template.

## Reporting a bug in the body

The body is MezzoSopranoClef, a separate project. Golem works around some of its edges (see `docs/CLEF-CHANGES.md`); if you hit one, that file is where to note it.
