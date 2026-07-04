# api — Efficient Reverse-Proxy Gateway

A lightweight, high-throughput **OpenAI-compatible reverse-proxy gateway** built in pure Node.js. It fronts one or many OpenAI-compatible upstreams (OpenAI, Azure OpenAI, DeepSeek, Gemini OpenAI-compat, local vLLM/Ollama, etc.) and adds:

- **Multi-concurrency** — async I/O event loop, per-upstream keep-alive connection pooling ([undici](https://github.com/nodejs/undici)), a bounded global concurrency limiter, and per-upstream semaphores so one slow backend can't starve the others.
- **Model list pulled from the gateway** — `GET /v1/models` concurrently fetches and aggregates `/models` from every configured upstream, dedupes, caches (TTL), and de-dupes concurrent refreshes (no thundering herd).
- **Streaming** — full SSE pass-through for `/v1/chat/completions` etc., with proper backpressure handling.
- **Failover** — retries 5xx/network errors across upstreams (round-robin with availability-aware selection).
- **Gateway auth** — optional shared `Bearer` secret so you don't expose upstream keys to clients.

## Quick start

```bash
cp .env.example .env
# Edit .env to point at your upstreams
npm install
npm start
```

```bash
# Pull the aggregated model list from the gateway
curl http://localhost:8787/v1/models

# Proxy a chat completion (streamed)
curl -N http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Configuration

All settings are environment variables (or a JSON file referenced by `GATEWAY_CONFIG`).

| Variable                     | Default     | Description                                              |
| ---------------------------- | ----------- | ------------------------------------------------------- |
| `PORT`                       | `8787`      | Listen port.                                            |
| `HOST`                       | `0.0.0.0`   | Bind address.                                           |
| `GATEWAY_API_KEY`            | _empty_     | Optional shared secret clients must send as `Bearer`.   |
| `UPSTREAMS`                  | _required_  | Comma/newline-separated upstream base URLs (e.g. `https://api.openai.com/v1`). |
| `UPSTREAM_API_KEYS`          | _empty_     | Comma-separated keys matching `UPSTREAMS` order; use `-` for "no key". |
| `UPSTREAM_REQUEST_TIMEOUT_MS`| `120000`    | Per-request upstream timeout (0 = none).               |
| `MAX_CONCURRENCY_PER_UPSTREAM`| `256`      | Max in-flight requests per upstream (0 = unlimited).    |
| `MAX_CONCURRENCY_TOTAL`       | `1024`     | Max in-flight requests across the whole gateway.        |
| `MODELS_CACHE_TTL_MS`         | `30000`    | How long the aggregated model list is cached.           |
| `MODELS_PATH`                 | `/models`  | Upstream path used to pull model lists.                 |
| `PRETTY_JSON`                 | `true`     | Pretty-print JSON when `Accept: text/html` or `?pretty=1`. |
| `LOG_LEVEL`                   | `info`     | `debug`/`info`/`warn`/`error`.                          |

### Multiple upstreams

List several and the gateway will load-balance (round-robin, availability-aware) and
aggregate their model lists:

```env
UPSTREAMS=https://api.openai.com/v1,https://api.deepseek.com/v1,https://generativelanguage.googleapis.com/v1beta/openai
UPSTREAM_API_KEYS=sk-openai,sk-deepseek,sk-google
```

`GET /v1/models` now returns a merged list, each entry tagged with its source `upstream`.

## Endpoints

| Method & path        | Behaviour                                              |
| -------------------- | ----------------------------------------------------- |
| `GET /`              | HTML status dashboard (live requests + debug logs).   |
| `GET /__status`      | JSON snapshot: counters, recent requests, recent logs.|
| `GET /healthz`       | Liveness probe — no upstream calls.                   |
| `GET /v1/models`     | Aggregated, cached model list pulled from upstreams.   |
| `*  /v1/*` (and `/*`)| Reverse-proxied to the chosen upstream with failover. |

## Per-model provider pinning

The gateway can pin specific models to a chosen OpenRouter provider by
injecting a `provider` object into the request body before proxying.

- A pin value of **`"price"`** injects `{sort:"price"}` — OpenRouter picks
  the cheapest usable provider and falls back automatically if it is
  unavailable (so the original provider is tried first when reachable).
- Any other string is treated as a provider slug and injects
  `{order:[slug], allow_fallbacks}` for an explicit pin (pipe-separated
  for a preference list).

Defaults (override via `MODEL_PROVIDERS` env):

```json
{
  "z-ai/glm-5.2": "siliconflow/fp8",
  "deepseek/deepseek-v4-pro": "alibaba"
}
```

Requests for these models carry `x-gateway-provider: <slug|price>` and the
audit log records `providerPin`. A client-supplied `provider` object is never
overridden. Set `MODEL_PROVIDER_ALLOW_FALLBACK=true` to allow fallback for
explicit `order` pins.


## Thinking-effort variants

The gateway exposes virtual **thinking-effort variant** models for Anthropic
reasoning models, baking in a specific reasoning effort level:

```
<base-model>-<effort>     e.g. anthropic/claude-opus-4.7-xhigh
```

Default base models: `anthropic/claude-opus-4.7`, `anthropic/claude-opus-4.8`,
`anthropic/claude-fable-5`. Default efforts: `low`, `medium`, `high`, `xhigh`,
`max` (per the [Claude 4.7 migration guide](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/model-migrations/claude-4-7)).

When a client requests a variant, the gateway rewrites the model id to the
base and injects `verbosity: <effort>` + `reasoning: {enabled:true, effort}`
before proxying. Variants appear in `GET /v1/models` tagged with
`upstream: gateway-variant` (and a `base_model` + `effort` field) so clients
can discover them. The response carries `x-gateway-variant: <base>:<effort>`.

Configure via env:

```env
VARIANTS_ENABLED=true
VARIANT_BASES=anthropic/claude-opus-4.7,anthropic/claude-opus-4.8,anthropic/claude-fable-5
VARIANT_EFFORTS=low,medium,high,xhigh,max
```


## Observability

Every proxied request is recorded in an in-memory audit log (ring buffer of
the last 500 requests) with:

- **model** and **provider** (derived from the model id prefix)
- **upstream** that served it
- **status** returned to the client + the upstream's own status
- **latency** (ms, end-to-end)
- **tokens** (prompt/completion/total) for buffered JSON responses
- **bytes** streamed
- **error** message and per-upstream **attempts** (with per-attempt latency)

Rolling counters track total / 2xx / 4xx / 5xx / streaming, plus per-provider
and per-upstream success/error tallies.

Structured log lines (debug/info/warn/error) are also buffered (last 300) and
shown in the dashboard's Debug log panel.

Open the dashboard at `http://localhost:8000/` — it polls `/__status` every 2s
and renders running state, counters, the recent-request table, per-provider
success bars, and a live debug-log tail. Use the **pause** toggle to freeze
the view.

## Architecture

```
client ──► gateway (Node http) ──► [round-robin pick] ──► upstream pool
              │                                                │
              ├─ global concurrency limiter                    ├─ keep-alive Agent (undici)
              ├─ /v1/models ─► concurrent fan-out + cache      └─ per-upstream semaphore
              └─ /v1/* ─────► streaming reverse proxy (SSE) + failover
```

- **`src/server.js`** — HTTP server, routing, global concurrency limiter, gateway auth, status dashboard.
- **`src/upstreams.js`** — connection-pooled upstream clients, model-list aggregation/caching.
- **`src/proxy.js`** — request forwarding with streaming + 5xx/network failover + audit logging.
- **`src/auditlog.js`** — in-memory request & log ring buffers + counters (powers the dashboard).
- **`src/dashboard.js`** — single-file HTML status dashboard.
- **`src/concurrency.js`** — promise-based semaphore.
- **`src/config.js`** / **`src/logger.js`** / **`src/util.js`** — config, structured logging, helpers.

## Tests

```bash
npm test
```

Includes unit tests (config, semaphore) and integration tests against a mock
OpenAI-compatible upstream covering model aggregation, SSE streaming,
multi-concurrency (40 parallel streaming requests), failover, and health checks.

## License

MIT
