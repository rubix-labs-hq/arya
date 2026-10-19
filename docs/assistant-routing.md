# Assistant accounts and model routing

Arya suggests the user's own Claude Code and MCP workflow. Codex's documented client integration supports ChatGPT sign-in and account model discovery. Manual mode remains the default and keeps exact user choices. Auto is optional and can use only the models the user enables from a host-verified catalog.

Setup appears in Settings and can be opened directly from the Assistant composer. It guides the user through installing the official CLI, completing its own account sign-in, refreshing status, and choosing Manual or Auto. New/Open Project remain usable without connecting an assistant. A failed status request means unknown authentication, not a confirmed sign-out.

## Shared companion protocol

`GET /v1/status` keeps its version-1 provider status fields and adds `routingSupported`, `catalogs`, `checkedAt` and `loading`. Provider authentication, safe editing support, exact model binding and product distribution eligibility are separate facts. Catalogs contain exact IDs, provider descriptions, advertised efforts and input modalities. Prices and remaining usage are `null` unless a future provider integration actually reports them.

Provider `available` is canonical editing readiness: `true` requires an installed executable, confirmed authentication, a supported isolated adapter, no explicit unavailable result and no reported rate limit. Known blockers return `false`; missing or unknown installation/authentication remains `null` unless another known blocker applies. A failed or timed-out account probe keeps `authenticated: null`, so `available: false` is not evidence of sign-out. Custom adapters additionally require host configuration; their authentication remains adapter-managed, and readiness does not verify subscription billing or exact model binding. Model discovery runs only for ready providers.

Current account probes return sign-in status without a trusted opaque account/session identity. UI metadata may use a short display cache, but each routed dispatch refreshes account status and discovers its model catalog again, bypassing cached successes and retry throttles. Concurrent dispatch discovery is serialized; UI polls share an in-flight probe rather than spawning overlapping metadata processes. A failed fresh discovery removes the older catalog and rejects bound Manual/Auto requests instead of reusing another account's models. Arya does not read provider credential files or expose account identifiers to establish this freshness boundary.

An explicit account/model retry uses `GET /api/assistant/status?refresh=1` in the browser or `GET /v1/status?refresh=1` on the paired companion. It waits for a fresh account and model probe, bypassing display caches and failure throttles. Concurrent explicit refreshes coalesce, and fresh metadata work is serialized with dispatch discovery. Ordinary polling omits the query and retains caching. Saved Auto entries that become unusable remain removable; an unusable unchecked model cannot be enabled again until its metadata becomes ready. Model-pool setup can enable the currently usable entries together or clear the saved pool. Bulk enable uses the same eligibility rules as individual rows, preserves existing missing entries, respects host capabilities and stays within the 256-model limit.

Legacy Manual `POST /v1/runs` requests stay unchanged. Auto adds a `routing` object:

```json
{
  "mode": "auto",
  "provider": "claude-code",
  "model": "",
  "agent": "",
  "effort": "",
  "catalogBound": false,
  "priority": "balanced",
  "enabledModels": [],
  "allowAdditionalSpend": false,
  "allowAPIBilling": false
}
```

The provider/model/agent/effort fields retain Manual preferences while Auto is selected. They are not an execution choice in Auto. A named Claude agent restricts the pool to Claude Code. Manual with a catalog-selected model sets `catalogBound: true` and sends `routing`; an explicit effort also sends `routing`, with mode `manual`, so the host can validate that effort against the exact fresh model catalog. Catalog-bound Manual choices must remain listed, fresh and available; removal or discovery failure rejects without fallback. Advanced raw IDs are explicitly unverified legacy choices. A provider default is resolved to its exact listed model when effort is explicit.

The host reserves the request UUID before discovery awaits. It selects one exact provider/model/effort and emits a `route` event before text or tools. Cancellation during discovery prevents later agent launch. The choice is bound to the request; it never falls back to another provider after edits begin. Clients display the requested choice and rationale. Until the CLI reports an executed model ID, they do not claim that a provider substitution could not occur.

## Auto policy

The versioned `provider-description-v1` policy estimates fit from provider descriptions, not model names or invented benchmark scores. Short direct edits to a small selection favor descriptions associated with fast/simple work. Script, screenplay, long or broad creative requests favor descriptions associated with demanding work. Other requests favor everyday work. Speed and Quality explicitly change that category. Advertised low/medium/high effort is used only when the chosen model reports it; otherwise its actual default effort is retained.

Provider-described lower usage can break a fit tie. It is not an exact cost estimate. Unknown descriptions fall back to a provider default in the enabled pool, then user pool order, with that reason disclosed. Stale/incomplete catalogs, hidden/unavailable/retired models, unknown frame inspection support, unavailable authentication and unsafe adapters are excluded. Known extra-credit models need explicit opt-in. API or unverified adapter billing also needs opt-in; sign-in does not prove a zero price.

Custom Manual requests with a specific model also fail before launch if the adapter has no model binding. Custom Auto requires a host-configured verified catalog and literal `{model}` argument binding. Effort is advertised only when an `{effort}` binding exists. Custom account status remains adapter-managed. Google Antigravity editing stays unavailable because the inspected adapter cannot isolate permissions and MCP tools per run. Its actual listed models are not proof of safe editing support. No Gemini CLI editing adapter is advertised.

## Mobile and provider boundaries

CLI agents run on the companion Mac, not on iPhone/iPad. Mobile setup needs an authenticated HTTPS companion reachable from that device. A Mac loopback address cannot be used from another device. A manually configured endpoint is distinct from a complete managed discovery, pairing and TLS flow; that latter flow still needs implementation and real-device acceptance.

Claude account sign-in is supported in the user's own CLI. Anthropic's SDK documentation restricts third-party consumer subscription login without prior approval. Eligibility for an embedded public Arya distribution remains unverified; the external Claude Code/MCP path is kept explicit. This is separate from local account detection or technical adapter behavior.

## Evidence and validation

On 2026-10-03, a read-only installed Codex App Server probe returned eight actual models and their supported efforts. It sent `initialize`, `initialized` and paginated `model/list` only: no thread, turn or inference request. The sanitized recorded catalog is a regression fixture, not a runtime allowlist. Runtime discovery always queries the current provider.

Unit and actual child-process fixture tests cover catalog pagination, fragmented UTF-8, invalid/oversized output, timeout, API-key exclusion, routing, atomic preferences, stop during discovery, exact adapter arguments, and HTM/Preact rendering. Live provider inference, window-size QA and native builds are separate integration gates.

Primary provider references: [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Claude authentication](https://code.claude.com/docs/en/authentication), [Claude model configuration](https://code.claude.com/docs/en/model-config), [Claude Agent SDK eligibility](https://code.claude.com/docs/en/agent-sdk/overview), [Antigravity CLI](https://antigravity.google/docs/cli/headless/), [Antigravity permissions](https://antigravity.google/docs/permissions?tab=cli), and [Gemini CLI authentication](https://geminicli.com/docs/get-started/authentication/).
