# Corvo Cortex Client Integration Guide: Header-Driven Routing

Date: 2026-02-15
Applies to: `POST /v1/chat/completions`

This document describes how client apps (including Kinisi) can use Corvo Cortex header-driven routing for speed, latency control, quality, and observability.

## 1. What Changed

Corvo Cortex now supports opt-in routing hints via `x-kinisi-*` request headers and always returns deterministic `x-corvo-cortex-*` response headers.

Key behaviors:

- Legacy behavior is unchanged when no `x-kinisi-*` headers are present.
- Header mode is enabled when at least one `x-kinisi-*` header is present.
- Invalid header values are treated as missing and replaced with defaults.
- `x-kinisi-model` overrides request body `model`.
- Strict schema mode (`response_format.json_schema`) is enforced.

## 2. Request Contract

All headers are optional, but at least one must be present to enable header-driven mode.

| Header | Allowed values | Default in header mode |
|---|---|---|
| `x-kinisi-llm-stage` | `week_1`, `week_n`, `refine_week_1` | `week_n` |
| `x-kinisi-routing-strategy` | `speed`, `balanced`, `quality` | `balanced` |
| `x-kinisi-provider-prefer` | CSV provider order (`fireworks,openrouter`) | `fireworks,openrouter` |
| `x-kinisi-provider-allow` | CSV allowlist (`fireworks`, `openrouter`) | unset |
| `x-kinisi-provider-block` | CSV denylist (`fireworks`, `openrouter`) | unset |
| `x-kinisi-request-priority` | `low`, `normal`, `high` | `normal` |
| `x-kinisi-max-latency-ms` | positive integer ms | stage budget |
| `x-kinisi-request-role` | `primary`, `hedge`, `fallback` | `primary` |
| `x-kinisi-model` | model identifier string | unset |

### Constraint conflict handling

If `provider-allow` and `provider-block` together eliminate all routes, Corvo Cortex ignores those conflicting constraints and proceeds with safe default routing.

## 3. Model and Schema Rules

## Model precedence

If both are provided:
1. `x-kinisi-model`
2. request body `model`
3. client default model

## Strict schema mode

If request body includes `response_format.json_schema`, Corvo Cortex validates generated output against that schema.

- If all candidates fail schema validation: `422` with `error.class = "schema_invalid"`.
- Corvo Cortex does not return malformed fallback text in strict mode.

## Streaming restriction

`stream=true` is rejected with `400` when strict schema mode is active.

## 4. Stage + Strategy Routing Defaults

Default route chain (primary -> secondary -> final safe):

| Stage | Strategy | Route chain | Hedge |
|---|---|---|---|
| `week_1` | `speed` | fireworks.fast_json -> openrouter.fast_json -> openrouter.safe_json | off |
| `week_1` | `balanced` | openrouter.balanced_json -> fireworks.fast_json -> openrouter.safe_json | off |
| `week_1` | `quality` | openrouter.quality_json -> fireworks.quality_json -> openrouter.safe_json | off |
| `week_n` | `speed` | fireworks.fast_json -> openrouter.fast_json -> openrouter.safe_json | on (delayed) |
| `week_n` | `balanced` | fireworks.fast_json -> openrouter.balanced_json -> openrouter.safe_json | off |
| `week_n` | `quality` | openrouter.quality_json -> fireworks.quality_json -> openrouter.safe_json | off |
| `refine_week_1` | `speed` | mapped to `refine_week_1 + balanced` | off |
| `refine_week_1` | `balanced` | openrouter.balanced_json -> fireworks.fast_json -> openrouter.safe_json | off |
| `refine_week_1` | `quality` | openrouter.quality_json -> fireworks.quality_json -> openrouter.safe_json | off |

Notes:

- Unspecified combinations map to balanced behavior for that stage.
- Hedging is only enabled for `week_n + speed` and only when `x-kinisi-request-role=primary`.

## 5. Response Metadata Headers

Corvo Cortex returns these on both success and error responses:

- `x-corvo-cortex-provider`
- `x-corvo-cortex-model`
- `x-corvo-cortex-route-id`
- `x-corvo-cortex-fallback-used`
- `x-corvo-cortex-hedge-used`
- `x-corvo-cortex-cache-hit`
- `x-corvo-cortex-ttft-ms`
- `x-corvo-cortex-latency-ms`

If unavailable, the value is `unknown`.

### Important semantics

- `x-corvo-cortex-fallback-used=true` means Corvo Cortex attempted a non-primary candidate at any point.
- On terminal errors, provider/model may be `unknown` if no winning upstream call exists.

## 6. Error Contract and Reason Codes

Corvo Cortex classifies route failures with reason codes:

- `timeout`
- `upstream_4xx`
- `upstream_5xx`
- `schema_invalid`
- `throttled`

Example `422` strict-schema failure:

```json
{
  "error": {
    "class": "schema_invalid",
    "stage": "week_n",
    "strategy": "speed",
    "route_id": "...",
    "reason_codes": ["schema_invalid"],
    "message": "All candidate responses failed caller-provided JSON schema"
  }
}
```

Example route exhaustion:

```json
{
  "error": {
    "class": "route_exhausted",
    "stage": "week_1",
    "strategy": "speed",
    "route_id": "...",
    "reason_codes": ["timeout", "upstream_5xx"],
    "message": "No upstream route satisfied constraints and schema guarantees"
  }
}
```

## 7. Recommended Client Patterns

## Primary request

Use for the main build/hydration call:

- `x-kinisi-request-role: primary`
- include `x-kinisi-llm-stage`, `x-kinisi-routing-strategy`, and `x-kinisi-max-latency-ms`

## Hedge request (optional client-side race)

If client also does hedging, set:

- `x-kinisi-request-role: hedge`

This prevents Corvo Cortex from launching an additional hedge for that request.

## Fallback request

If client triggers explicit fallback request, set:

- `x-kinisi-request-role: fallback`

## 8. Request Examples

## Speed-optimized week_n request

```bash
curl -X POST "https://cortex.corvolabs.com/v1/chat/completions" \
  -H "Authorization: Bearer <client-key>" \
  -H "Content-Type: application/json" \
  -H "x-kinisi-llm-stage: week_n" \
  -H "x-kinisi-routing-strategy: speed" \
  -H "x-kinisi-provider-prefer: fireworks,openrouter" \
  -H "x-kinisi-request-role: primary" \
  -H "x-kinisi-max-latency-ms: 8000" \
  -d '{
    "model": "gpt-5-mini",
    "messages": [{"role":"user","content":"Generate week blueprint JSON"}]
  }'
```

## Strict schema request (non-streaming)

```json
{
  "model": "gpt-5-mini",
  "messages": [{ "role": "user", "content": "Generate week blueprint JSON" }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "week_blueprint",
      "schema": {
        "type": "object",
        "required": ["weeks"],
        "properties": {
          "weeks": {
            "type": "array",
            "minItems": 1
          }
        }
      }
    }
  }
}
```

## 9. Observability Integration Checklist (Client)

Capture and log per request:

- `x-corvo-cortex-route-id`
- `x-corvo-cortex-provider`
- `x-corvo-cortex-model`
- `x-corvo-cortex-fallback-used`
- `x-corvo-cortex-hedge-used`
- `x-corvo-cortex-latency-ms`

Recommended dashboards/alerts:

- p50/p95 latency by `stage` and `strategy`
- fallback and hedge rates
- strict schema failure rate (`schema_invalid`)
- route exhaustion rate

## 10. Migration Checklist

1. Add `x-kinisi-*` headers to calls that need routing control.
2. Keep other calls header-free to preserve legacy behavior.
3. Ensure strict-schema calls are non-streaming.
4. Parse and persist `x-corvo-cortex-*` response headers.
5. Use `x-kinisi-request-role` consistently when client-side hedging is enabled.
6. Roll out by stage (`week_n` speed first), then expand.
