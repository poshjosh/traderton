# Consumer Boundary Contract

**Status:** living
**Created:** 2026-09-05

## Purpose

Define the production boundary through which a consuming platform, agent
runtime, or internal caller invokes Traderton trading tools. This contract is
the same whether the consumer is temporarily repo-local during extraction or a
separate service later.

> **This document describes the M2 (API) adapter.** Per the two-milestone model in
> [000-vision.md](./000-vision.md) ("Two consumption milestones — same ports, two
> adapters"), Traderton is consumed first at **M1** as an **in-process library via
> dependency injection / hexagonal ports** (herobids injects the platform-owned values
> it still holds — resolved `venueAccountId`, grant validity, the `maxBots` decision,
> `ownerId`/`actor` — at the call site). This REST/API contract is the **M2 adapter over
> those same ports**: the request/response, auth, deadline, retry, and idempotency
> semantics below are the HTTP expression of the M1 ports, not a different core. M1 is
> reached first and requires no authored boundary code; the M2 adapter defined here is
> authored after M1 lands and a holistic review. The ports-carry-values invariant
> (000/004) applies to both adapters: a caller injects platform-owned values, never
> trading behaviour.

## Scope

This doc includes:

1. the shared invocation transport, endpoint shape, and contract envelope for
   tool calls into Traderton
2. authentication, authorization, deadline, retry, idempotency, and result
   semantics for that boundary
3. readiness and health behavior that consumers must respect before sending
   new traffic

This doc does not include:

1. Traderton internal module design
2. public end-user control-plane routes
3. business logic inside any specific tool or subsystem

## Non-Goals

1. Do not use direct database access or in-process imports as an integration
   shortcut.
2. Do not embed consumer-specific skill, route, or visibility semantics in the
   boundary envelope.
3. Do not expose provider secrets, raw venue errors, or stack traces over the
   boundary.
4. Do not block the first working integration on MCP or skills; direct API is
   sufficient.

## Fixed Decisions

1. Tool invocation uses synchronous HTTPS JSON.
2. Every consumer uses the same versioned invocation and status endpoints,
   plus the same standard health endpoints.
3. The invocation endpoint is the only execution entry point.
4. Traderton accepts authenticated `ownerId` + `actor` context at the
   boundary; it does not resolve user identity itself.
5. Tool payload schemas remain Traderton-owned. Consumers submit payloads; they
   do not become the schema authority.
6. Consumers may wrap this direct API later with skills, MCP, or their own
   route surface without changing the underlying contract.

## Endpoints

Consumers integrate against these boundary endpoints:

```text
POST /internal/v1/tools:invoke
GET  /internal/v1/invocations/:requestId
GET  /health/live
GET  /health/ready
```

`POST /internal/v1/tools:invoke` is the only endpoint that executes work.
`GET /internal/v1/invocations/:requestId` exists only to resolve an ambiguous
timeout with the original `requestId`; it must never trigger a second
execution.

## Invocation Contract

The boundary envelope is generic over `toolName` and `payload`, but it carries
the caller and subject context Traderton needs for authorization and audit.

```ts
type TradertonToolInvocationV1 = {
  contractVersion: '1.0';
  requestId: string;
  idempotencyKey: string;
  correlationId: string;
  issuedAt: string;
  deadlineAt: string;
  caller: {
    consumerId: string;
    keyId: string;
  };
  subject: {
    ownerId: string;
    actor: { type: 'agent' | 'bot' | 'user' | 'system'; id: string };
  };
  toolName: string;
  payload: unknown;
};
```

Traderton validates the outer envelope first, then validates `toolName`, then
validates the tool payload against the Traderton-owned schema for that tool. An
unknown tool or payload that does not parse is a terminal validation failure.
Unknown keys in the outer request envelope are rejected.

The terminal result shape is:

```ts
type TradertonToolResultV1 = {
  contractVersion: '1.0';
  requestId: string;
  correlationId: string;
  outcome:
    | { kind: 'success'; payload: unknown }
    | {
        kind: 'failure';
        code: TradertonBoundaryFailureCode;
        message: string;
        retryable: boolean;
        details?: Record<string, unknown>;
      };
};
```

The invocation-status shape is:

```ts
type TradertonToolInvocationStatusV1 =
   | {
         contractVersion: '1.0';
         requestId: string;
         correlationId: string;
         state: 'in_progress';
      }
   | {
         contractVersion: '1.0';
         requestId: string;
         correlationId: string;
         state: 'terminal';
         result: TradertonToolResultV1;
      };
```

`POST /internal/v1/tools:invoke` returns one of these two shapes:

1. `TradertonToolResultV1` for a fresh invocation that reaches a terminal
   outcome during the request
2. `TradertonToolInvocationStatusV1` when the same idempotency key is reused
   while the original invocation is still in progress

The status endpoint returns `state: 'in_progress'` while the original request
is still executing and returns `state: 'terminal'` plus `result` once the
request reaches a terminal outcome.

`TradertonBoundaryFailureCode` is a closed union:

```text
validation.invalid_payload
authentication.invalid_caller
authorization.denied
not_found.resource
precondition.not_ready
rate_limit.exceeded
deadline.expired
upstream.transient
internal.non_retryable
contract.unsupported_version
```

## Version Compatibility

1. The path major version and `contractVersion` major version must match.
2. Minor releases may add optional response fields and detail properties only;
   they must not change the meaning or type of existing fields.
3. Any new outer request-envelope field requires an explicit compatibility
   rollout where receivers support it before callers send it by default.
4. Unsupported versions fail with `contract.unsupported_version` before any
   side effect.
5. A breaking change requires a new path major, a new contract literal, and an
   overlap period where both majors are supported.

## Authentication And Authorization

Every request is authenticated with an HMAC-SHA-256 signature over this exact
canonical string:

```text
METHOD + "\n" + PATH + "\n" + X-Traderton-Timestamp + "\n" + SHA256(raw JSON body)
```

Required headers are:

```text
Content-Type: application/json
X-Traderton-Consumer-Id: <consumer identifier>
X-Traderton-Key-Id: <active key identifier>
X-Traderton-Timestamp: <RFC 3339 UTC>
X-Traderton-Signature: sha256=<hex digest>
X-Request-Deadline-At: <same value as body.deadlineAt>
```

The header values and the body `caller` fields must match exactly. A mismatch
fails with `authentication.invalid_caller` before authorization or side
effects.

Traderton accepts only configured consumer IDs and key IDs, rejects timestamps
outside the configured clock-skew window, and uses constant-time signature
comparison. Private-network placement is defense in depth, not an
authentication substitute.

After authentication, Traderton authorizes the request by verifying:

1. the caller is allowed to use the boundary
2. the request contains a non-empty `ownerId` and `actor`
3. the actor provenance is valid for the requested tool
4. any tool-specific readiness or binding prerequisites are satisfied

The consumer is the authority for authenticating the end user or upstream
agent. Traderton trusts only the signed boundary assertion, not a user-originated
HTTP request.

## Deadlines, Retries, And Idempotency

The consumer sets `deadlineAt` before dispatch. It must not send a request
after that deadline. Traderton rejects a request whose deadline has already
passed before validation, and checks it again immediately before every
downstream side effect.

Only the consumer retries transport failures. It may retry only when all of
these are true:

1. the deadline has not expired
2. no terminal response was received
3. the same `requestId` and `idempotencyKey` are reused

Traderton may retry a downstream venue or provider call internally only when
the operation is idempotent under the same persisted invocation key, and only
before `deadlineAt`.

Each side-effecting invocation is persisted before any side effect. The unique
idempotency key is:

```text
(consumer_id, owner_id, tool_name, idempotency_key)
```

The record stores a request fingerprint, request ID, correlation ID, state,
terminal response, timestamps, and expiry. A reused key with a different
fingerprint returns `validation.invalid_payload`; a reused key with the same
fingerprint behaves as follows:

1. if the original invocation is still running, `POST /internal/v1/tools:invoke`
   returns `TradertonToolInvocationStatusV1` with `state: 'in_progress'` and no
   second side effect
2. if the original invocation has already finished, the same call returns the
   original terminal result

Consumers may use `GET /internal/v1/invocations/:requestId` to resolve an
ambiguous timeout without creating a second execution attempt.

The default retention is configured as
`boundary.idempotencyRetentionHours: 168`. The implementation may not hard-code
this retention period.

## Consumer Result Mapping

Consumers may map Traderton results into their own runtime surface, but they
must preserve the retryable vs non-retryable distinction and must not leak
service credentials, raw provider responses, or internal authorization detail.

Suggested mapping:

Consumers must treat the failure envelope's `retryable` field as authoritative.
The table below is default semantic guidance, not a license to override the
returned retryability flag.

| Contract outcome | Consumer-facing meaning |
| --- | --- |
| success | Success with the returned payload. |
| `validation.invalid_payload`, `not_found.resource`, `precondition.not_ready`, `rate_limit.exceeded`, `contract.unsupported_version` | User, contract, or readiness failure. Respect the returned `retryable` flag. |
| `authentication.invalid_caller`, `authorization.denied` | Security failure; log it and respect the returned `retryable` flag. |
| `deadline.expired` | Deadline failure. Respect the returned `retryable` flag. |
| `upstream.transient` | Infrastructure or dependency failure. Respect the returned `retryable` flag. |
| `internal.non_retryable` | Internal service failure. Respect the returned `retryable` flag. |

## Configuration

There are two config surfaces.

Consumer-side transport config:

```yaml
traderton:
   baseUrl: https://traderton.internal
   consumerId: consumerA
   requestTimeoutMs: 10000
   keyId: current
   secretRef: ${TRADERTON_SIGNING_SECRET_REF}
```

Traderton-side caller verification config:

```yaml
boundary:
  clockSkewMs: 30000
  idempotencyRetentionHours: 168
  allowedConsumers:
      consumerA:
         keyId: current
         secretRef: ${BOUNDARY_CONSUMER_A_SIGNING_SECRET_REF}
```

The exact consumer IDs and secret references are operator config, not runtime
payload fields. The consumer-side `consumerId` and `keyId` drive the signed
headers and must match the body `caller` object on every request. `secretRef`
is local signing material; it never crosses the boundary.

In local development, TLS may terminate at an ingress or service-mesh edge and
forward privately to a repo-local Traderton process. That does not change the
consumer-facing contract: consumers still treat the boundary as HTTPS.

## Deployment And Health

Health semantics are fixed:

1. `/health/live` confirms that the process can serve requests.
2. `/health/ready` confirms that configuration, persistence, boundary
   validation, and mandatory downstream dependencies are ready.
3. When readiness is false, consumers stop sending new write traffic and treat
   the service as degraded.
4. In-flight invocations resolve to `upstream.transient` or `deadline.expired`
   according to the observed outcome.
5. Recovery after an ambiguous timeout happens by retrying with the same
   `idempotencyKey` or querying the status endpoint with the original
   `requestId`.

## Required Verification

Integration is not complete until automated tests prove:

1. valid signed calls succeed and invalid, expired, replayed, or unauthorized
   signatures fail before execution
2. malformed envelopes and payloads produce typed validation failures
3. deadline expiry prevents side effects
4. retrying a side-effecting call with the same key yields one persisted
   invocation and one downstream effect
5. a different payload with the same key is rejected
6. readiness failure blocks new traffic without triggering hidden fallback
7. compose or staging startup reaches a healthy `/health/ready` state