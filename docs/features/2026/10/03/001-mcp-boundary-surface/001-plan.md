# 001 — MCP boundary surface (Phase 3 T2.2) — traderton plan

**Status:** implemented on branch `phase3-mcp-surface` (NOT merged to `main`).
**Scope:** add an ADDITIVE MCP transport binding over the existing `tools:invoke`
dispatcher — off by default — so herobids' Phase-3 `McpTransport` has a
counterpart. No REST byte or behaviour changes.

## The ruling (settled)

Governed by the Contemplator ruling recorded in
[004 "MCP-FD"](../../../../initial/004-decision-log.md) and the Fixed-Decisions
rewording in [005 §Fixed Decisions](../../../../initial/005-consumer-boundary-contract.md):
**one core, two thin seams.** The MCP route authors ZERO execution semantics. It
parses a JSON-RPC `tools/call` frame into the identical 005 invocation envelope
and calls the SAME `ToolInvocationDispatcher.dispatch(envelope, pathMajor)` the
REST route calls. Only parse / authenticate-source / encode edges differ. The
dispatcher is neither forked nor modified.

## Normative mapping — pointer, not a copy

The wire mapping (field mapping, result encoding, pre-dispatch failure encoding,
dispatcher-exception → sanitized `-32603`, GET/DELETE → 405, batch → -32600,
`tools/list` cross-check) is **normative in herobids Step 10 §2.5 / §3** and in
ADR 016. It is deliberately NOT restated here (n35 — a second prose copy is
drift). The shared T0.3 signing vectors and T0.4 descriptor-conformance fixtures,
plus the executable guards below, pin both repos to the same bytes.

## Endpoint and enablement

- `POST /internal/v1/mcp` on the existing boundary listener (legacy Streamable
  HTTP, stateless JSON). `GET`/`DELETE` → `405 Allow: POST`, no auth, no side
  effect. No status route — reconcile a lost response by same-key re-issue.
- `BOUNDARY_MCP_ENABLED=true` mounts the route; `BOUNDARY_MCP_DESCRIPTOR_PATH`
  (optional, requires enabled) feeds `tools/list` from a signed descriptor
  wrapper served verbatim (D16 — served, never invented; the signature is
  herobids' verification concern). Unset descriptor → empty `tools/list`. A bad
  env value or unreadable/invalid descriptor fails the boundary at startup.

## Files

- `packages/boundary/src/request-material.ts` — shared signed-request helpers
  (moved out of `app.ts` in TC2 so REST and MCP authenticate identically).
- `packages/boundary/src/mcp/{constants,jsonrpc,tool-call,descriptor-tools,surface-config,server,route}.ts`.
- `packages/boundary/src/app.ts` — `BoundaryAppDeps.mcp?` + conditional
  `registerMcpRoute` (parser + REST handler blocks textually unchanged).
- `packages/boundary/src/bin.ts` — `resolveMcpSurfaceConfig` from env.
- `packages/boundary/src/index.ts` — exports `MCP_PATH`, `McpSurfaceConfig`,
  `McpToolDefinition`, `resolveMcpSurfaceConfig`.
- Env twins: `.env.example`, `infra/hetzner/.env.environment.example`.
- `pnpm-workspace.yaml` — `abitype>zod` override (keeps zod 4 strictly under the
  MCP SDK; app packages stay on zod 3.25.x).

## Tests

- Unit: `mcp/route.test.ts`, `mcp/descriptor-tools.test.ts`,
  `mcp/surface-config.test.ts`.
- SDK (real `@modelcontextprotocol/client` ↔ real listening app): `mcp/mcp.sdk.test.ts`.
- Integration (real Postgres): `packages/boundary/src/boundary.mcp.verification.integration.test.ts`
  (appended to `scripts/shell/tests/run-integration.sh`).

## Commits (branch `phase3-mcp-surface`)

- **TC2** `refactor(boundary): move signed-request material out of app.ts` — pure
  move; app/verification/vector tests green unmodified.
- **TC3** `feat(boundary): MCP route over the existing dispatcher, off by default`
  — deps, `mcp/*`, app/bin/index, env twins, unit + SDK tests, docs.
- **TC4** `test(boundary): MCP idempotency verification against real Postgres`.

## Gate 2 (coexistence)

- `app.test.ts`, `boundary.verification.integration.test.ts`, T0.3
  `signing-vectors.test.ts`, T0.4 `descriptor-conformance.test.ts` pass UNMODIFIED.
- The `addContentTypeParser` block and the REST `POST INVOKE_PATH` / `GET
  STATUS_PATH` handler bodies are textually identical to the pre-TC2 base.
- `createBoundaryApp` without `mcp` registers no MCP route.
