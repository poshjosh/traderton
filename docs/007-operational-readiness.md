# Operational Readiness

**Status:** living
**Created:** 2026-09-05

## Purpose

Define the evidence required before production consumer traffic moves from the
source system or any legacy execution path onto Traderton.

## Scope

This doc includes:

1. the latency budget model for boundary invocation into Traderton
2. the equivalence or shadow-validation protocol for cutover from the source
   system
3. the restart-resilience requirements for Traderton as an independently
   restartable service
4. the load-test expectations for concurrent consumer traffic
5. the cutover decision criteria and rollback conditions

This doc does not include:

1. tool-specific business validation inside Traderton itself
2. consumer-specific UX or route migration policy
3. observability stack design beyond what the checks require
4. final public API packaging for MCP or skills

## Non-Goals

1. Do not treat "it booted" as sufficient proof.
2. Do not require a production-sized environment before the first validation;
   local compose or staging is sufficient initially.
3. Do not hard-code latency budgets.
4. Do not assume restart safety or equivalence from design intent alone.

## Fixed Decisions

1. Traderton must pass the readiness checklist in this doc before full
   production cutover from the source system.
2. Latency budgets are operator-configurable; this doc defines the measurement
   protocol and default targets.
3. Equivalence or shadow validation is mandatory before the legacy execution
   path is removed for extracted source behavior.
4. Restart resilience must be proven by automated test.
5. Cutover is a deliberate operator decision with explicit rollback criteria,
   not a side effect of deployment.

## Latency Budget

### Model

End-to-end latency is measured from the moment the consumer dispatches a
request to Traderton to the moment the consumer receives the mapped terminal
result. This includes request construction, signing, transport, Traderton
validation, internal dispatch, and response mapping.

Boundary overhead is the difference between end-to-end latency and the
Traderton-reported internal request duration or, when available, downstream
venue-execution time. The goal is to separate boundary cost from underlying
venue latency.

### Default Targets

| Metric | Default target | Config path |
| --- | --- | --- |
| p50 latency | 200ms | `boundary.latencyTargets.p50Ms` |
| p95 latency | 500ms | `boundary.latencyTargets.p95Ms` |
| p99 latency | 2000ms | `boundary.latencyTargets.p99Ms` |
| Hard timeout | 10000ms | consumer `traderton.requestTimeoutMs` |

### Measurement Protocol

1. record timestamps at consumer dispatch and consumer receipt
2. record Traderton-side request duration for overhead separation
3. report p50, p95, p99, max, and error-rate by tool category
4. fail the test when p95 boundary overhead exceeds the configured budget

## Equivalence Or Shadow Validation

### Protocol

Before full cutover for extracted source behavior:

1. dispatch each affected tool call through both the legacy path and Traderton
2. return the legacy result to the caller while logging the Traderton result
   for comparison
3. record total calls, matching results, mismatches by tool, latency delta,
   and any Traderton-only failures
4. cover at least one representative workload cycle with active position
   management

If a capability is genuinely new and has no legacy equivalent, replay against
copied tests and historical journals can substitute. For extracted source
behavior, side-by-side equivalence against herobids remains mandatory before
irreversible cutover.

### Equivalence Criteria

Equivalence passes when all of the following hold:

1. result-payload equivalence is at or above 99% for each tool category,
   allowing expected timing differences in read-heavy market-data surfaces
2. no Traderton failure category appears that the legacy path does not also
   produce under the same conditions
3. p95 latency remains within the configured budget
4. no idempotency violation is detected

### Mismatch Resolution

1. timing-related differences in market-data reads may be acceptable when they
   are documented explicitly
2. logic differences in side-effecting tools such as `submit_decision` or bot
   lifecycle actions are blocking
3. transient infrastructure failures are acceptable only if they do not recur
   under steady-state conditions

## Restart Resilience

### Requirements

Traderton must survive an independent restart without causing consumer-visible
errors beyond the health-gating window:

1. when the process stops, `/health/ready` becomes unreachable or unhealthy
2. consumers detect the health failure within one health-check cycle and stop
   sending new write traffic
3. in-flight invocations resolve to `upstream.transient` or `deadline.expired`
4. no durable state is lost and no consumer session crashes or hangs because
   the service restarted
5. after restart, `/health/ready` returns healthy and new calls succeed
6. retrying an ambiguous call with the original idempotency key yields the
   correct idempotent result

### Test Shape

The restart-resilience test must:

1. confirm the service is healthy
2. dispatch at least one in-flight invocation
3. restart or stop the service mid-flight
4. confirm the in-flight call resolves with the expected transient outcome
5. confirm consumers stop routing new write traffic while readiness is false
6. wait for recovery
7. confirm a new call succeeds after recovery
8. retry the original invocation with the same idempotency key and confirm
   correct idempotent behavior

## Load-Test Expectations

### Scope

Before cutover, the load test must exercise:

1. at least one write-path tool, specifically `submit_decision`
2. at least one read-path tool, such as `get_price` or `list_positions`
3. concurrent simulated consumer sessions at representative peak load or an
   agreed multiplier of current average load

### Metrics To Record

| Metric | Required |
| --- | --- |
| p50, p95, p99, max end-to-end latency per tool | yes |
| p50, p95 boundary overhead | yes |
| throughput | yes |
| error rate by failure code | yes |
| idempotency-violation count | yes, must be zero |
| CPU, memory, connection utilization | recommended |

### Pass Criteria

The load test passes when:

1. p95 latency is within budget for every tested tool
2. error rate for non-transient failures is zero
3. idempotency-violation count is zero
4. no resource exhaustion occurs during the test
5. the service returns to healthy within one health-check cycle after the load
   ramp-down

## Cutover Decision Criteria

Production cutover may proceed only when all of the following are satisfied:

1. equivalence criteria are met
2. load-test pass criteria are met
3. restart-resilience test passes
4. consumer routing can move traffic to Traderton by config or deployment
   change rather than semantic code rewrites
5. a rollback path exists to the prior trusted execution path while the
   migration is still reversible
6. the acceptance criteria in
   [005-consumer-boundary-contract.md](./005-consumer-boundary-contract.md)
   are satisfied, the inventory in
   [006-source-capability-manifest.md](./006-source-capability-manifest.md)
   is fully accounted for, and the live statuses in
   [001-parity-ledger.md](./001-parity-ledger.md) support cutover

## Rollback Conditions

Operators may roll traffic back when any of the following occur after cutover:

1. p95 latency exceeds the configured budget for more than one health-check
   cycle under normal load
2. a previously unseen failure code appears at a rate above 1% of invocations
3. an idempotency violation is detected
4. the service fails to recover from a restart within the configured health
   timeout

Rollback must be a routing or operator-config change, not a data-destructive
repair step.

## Validation

Readiness is fit for implementation use only when:

1. the latency budget model and measurement protocol are explicit
2. the equivalence protocol and mismatch rules are explicit
3. the restart-resilience requirements and test shape are explicit
4. the load-test scope, metrics, and pass criteria are explicit
5. the cutover decision and rollback criteria are explicit