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

## OpenAI Chat Completions endpoint (Logfare, OpenRouter, vLLM, most gateways)

Neither shipped harness fits this directly: Claude Code wants Anthropic Messages, and this Codex
wants the Responses API, not Chat Completions. Three ways to close it, in order of preference:

1. **A Chat-Completions ACP adapter (not yet built).** The same shape as `adapters/codex-acp.ts`:
   a small ACP agent that runs its own tool-calling loop against `POST /v1/chat/completions`, exposes
   Golem's MCP tools as OpenAI function tools, and streams the reply back. This is the direct way to
   use Logfare (or any OpenAI-compatible endpoint) as a mind, and Golem would own it end to end.
2. **A translating proxy.** Put a Chat-Completions -> Responses (or -> Anthropic Messages) shim in
   front of your endpoint, then use the Codex or Claude path above. No Golem code, but another moving
   part to run.
3. **opencode.** It speaks Chat Completions to many providers natively; usable as a mind if it
   exposes an ACP server. Heavier dependency, and its ACP support is unconfirmed here.

The recommendation is (1) when you want Logfare as a first-class mind: it is the least infrastructure
and keeps everything inside Golem.
