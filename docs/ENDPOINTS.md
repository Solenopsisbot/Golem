# Custom LLM endpoints

The mind is whatever ACP agent you point Golem at, so "use a custom endpoint" means "make that agent
talk to your endpoint." What works depends on the wire protocol your endpoint speaks.

## Anthropic Messages API endpoint -> Claude Code, env only

Claude Code reads these from the environment; set them in `mind.env` and no code changes are needed:

```toml
[[agents]]
name = "Clay"
[agents.mind.env]
ANTHROPIC_BASE_URL = "https://your-gateway.example/anthropic"
ANTHROPIC_AUTH_TOKEN = "..."        # or ANTHROPIC_API_KEY
ANTHROPIC_MODEL = "your-model-id"
# ANTHROPIC_CUSTOM_HEADERS = "X-Foo: bar"
```

Bedrock and Vertex work the same way (`CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1` plus
the usual AWS/GCP env). The endpoint must speak the Anthropic Messages API.

## OpenAI Responses API endpoint -> Codex custom provider

Codex reaches custom providers through `model_providers` in its `CODEX_HOME` config. Our adapter
(`adapters/codex-acp.ts`) already uses an isolated `CODEX_HOME`; drop a provider block there and
select it with `GOLEM_CODEX_PROVIDER`:

```toml
# data/codex-home/config.toml
model = "your-model-id"
model_reasoning_effort = "low"
model_provider = "mygw"

[model_providers.mygw]
name = "My gateway"
base_url = "https://your-gateway.example/v1"
env_key = "MYGW_API_KEY"
wire_api = "responses"              # this codex only accepts "responses", not "chat"
```

```toml
[agents.mind.env]
CODEX_HOME = "/abs/path/to/data/codex-home"
MYGW_API_KEY = "..."
GOLEM_CODEX_PROVIDER = "mygw"
GOLEM_CODEX_MODEL = "your-model-id"
```

The endpoint must implement the OpenAI **Responses** API. `codex --oss` (with `--local-provider
ollama|lmstudio`) covers local models.

## Any endpoint, any wire -> adapters/llm-acp.ts

`adapters/llm-acp.ts` is a Golem-owned ACP mind that owns the agent loop: it reads the workspace
`AGENTS.md` as its system prompt, connects to Golem's MCP server as a client to get and call the
tools, and drives a tool-calling loop against a configured HTTP endpoint. It speaks three wires, so
any endpoint works on whichever protocol it implements, including plain OpenAI Chat Completions
(Logfare, OpenRouter, vLLM, ollama) that neither CLI harness accepts.

`golem.llm.example.toml` is the template. Configure it entirely through `mind.env`:

```toml
[mind]
command = "node"
args = ["adapters/llm-acp.ts"]
[mind.env]
GOLEM_LLM_WIRE = "chat"                 # chat (OpenAI Chat Completions) | responses (OpenAI Responses) | anthropic (Anthropic Messages)
GOLEM_LLM_BASE_URL = "https://logfare.ai/v1"
GOLEM_LLM_MODEL = "your-model-id"
GOLEM_LLM_KEY_ENV = "LOGFARE_API_KEY"   # the name of the .env var holding the key; or GOLEM_LLM_API_KEY directly
# GOLEM_LLM_HEADERS = "{\"X-Org\":\"foo\"}"   GOLEM_LLM_MAX_STEPS = "16"   GOLEM_LLM_MAX_TOKENS = "4096"
```

The key is read from the named env var, which the adapter also loads from the nearest `.env`
(gitignored) walking up from the workspace, so no secret goes in a tracked config. Because the wire
is a setting, you can point this at Codex's endpoint with `anthropic`, or an Anthropic model with
`chat` if a gateway translates, in any combination. `look_around` -> tool execution -> reply is
tested end to end on the chat wire; all three wire serialisers have unit tests.
