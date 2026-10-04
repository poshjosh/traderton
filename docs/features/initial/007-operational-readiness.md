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

> Consumer-side instrumentation note: the herobids consumer measures end-to-end
> boundary latency, throughput, and error-rate-by-code via the metrics layer
> documented in its repo at `docs/tech/architecture/observability.md`. Item 2 of that layer —
> the Traderton-reported internal request duration needed for boundary-overhead
> separation (step 2 below) — is a Phase 2 additive field on the boundary result
> contract, stamped by the Traderton dispatcher. Until then the consumer records
> end-to-end latency only.

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

### Post-Removal Oracle Protocol

If the legacy implementation has already been removed from the active tree,
run it from a read-only git worktree pinned immediately before removal. Do not
restore it to the shipping branch or route production traffic through it. The
verification plan must record the pin, identical-input corpus, dependency
fixtures, nondeterministic-field normalization, and comparison report format.

For the Herobids cutover, the pinned oracle is
`1f6978d740d45e466cf4149617b8afc1c721e751`, the parent of trading-package
removal commit `55c5375664bceb093444832b0145419d4d9ef684`. Copied parity tests,
boundary end-to-end suites, A8/C5 runs, and soak evidence are supporting
evidence; they do not replace the differential report.

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

## Multi-Replica Boundary (agent-actor ownership)

Running more than one `boundary` replica is now SAFE for agent actors, as it
already was for bots. Each agent actor is owned by exactly one replica via a
Redis lease `lease:instance:agent:{agentId}` (`InstanceLease`, 30s TTL,
auto-renewed at half-TTL). The lazy ensure, boot rehydrate, and orphan sweep all
acquire the lease before constructing; a replica that loses the acquire race is a
no-op (the owner runs the actor). A `submit_decision` for a non-owned agent is
forwarded to the owner's command list (`agent-actor:cmd:{ownerWorkerId}`), and
the owner writes the reply on the shared `agent:decision:reply:{decisionId}` key
the decision tool already waits on. Read tools are owner-independent and run on
any replica.

### Takeover window on owner death

When the owning replica dies, its lease expires after the TTL (30s), and the
orphan sweep on a surviving replica re-ensures every `desiredState='running'`
agent with no live lease. The sweep cadence is the operator config
`agentScanner.orphanSweepIntervalMs` (default 60000ms; wired into the boundary as
the sweep interval in `bin.ts`). The upper bound on takeover is therefore
≤ lease TTL (30s) + the orphan-sweep interval.

During that window, a decision forwarded to the dead owner never reaches a live
actor and hits the decision tool's existing 30s BLPOP deadline, returning the
tool's existing `decision_reply_timeout` outcome. There is NO automatic
transport retry here: per the lease/forwarding design (S3), the forwarded
not-ready replies are not transport-retryable (the copied `submit_decision` tool
ignores the top-level `retryable` field and derives retryability only from
`capability_denied:*` codes), and the timeout path simply returns
`decision_reply_timeout`. The caller re-submits via its own reasoning loop; its
next decision re-ensures a concrete owner (or takes over locally once the lease
is free).

Takeover rebuilds in-memory actor state (equity peak, circuit breaker) on the new
owner — the same semantics as today's restart/rebuild; daily realized loss
rehydrates from fills. This is not new behavior introduced by the lease.

Reference: the lease + routing design in
[002-agent-actor-lease-and-routing](../2026/10/04/002-agent-actor-lease-and-routing/001-plan.md)
and the integration proof
`packages/boundary/src/agent-actor-multi-replica.integration.test.ts`. This lifts
the former "one boundary replica only" constraint tracked in 011 Wave E E4.

## Journal Retention & Partitioning

`journal_events` (Traderton's own Postgres) is an append-only trading audit log —
decisions, risk rejections, orders, fills, reconciliation, strategy errors, stream
disconnects, and backtest-run events. Growth is proportional to trading activity.
Migration `packages/db/drizzle/0008_journal_partitioning.sql` converts it into a
table RANGE-partitioned by month on `created_at` (PK `(id, created_at)`), so a whole
month can be dropped instantly and lock-light instead of a large `DELETE`. A
`journal_events_default` partition catches any out-of-range insert, so a write never
fails if the maintenance loop lags.

Design + decisions:
[003-journal-retention plan](../2026/10/04/003-journal-retention/001-plan.md) and
the "exempt-via-guard" rationale in
[004-decision-log.md](./004-decision-log.md#why-backtest-journal-rows-are-exempt-via-guard-not-a-separate-table).

### Retention knobs

Operator config under `journal.retention.*` in `config/default.yaml`, validated at
startup by the domain schema (`packages/domain/src/config/schema.ts`). The schema
rejects startup on an invalid combination, so a misconfiguration fails fast rather
than at the first maintenance tick.

| Key | Default | Meaning |
| --- | --- | --- |
| `auditRetentionMonths` | `null` | Months of audit history to keep. `null` = keep forever (drop nothing) — the shipped default. When set, partitions whose whole month precedes the cutoff are dropped. |
| `backtestRetentionMonths` | `null` | `null` = never drop a partition that holds backtest rows (`backtest_run_id IS NOT NULL`). Backtest rows live in the same partitions as live events, so they are exempt from the `auditRetentionMonths` cutoff unless this is set — a backtest-bearing partition is dropped only when this is set and its month precedes the backtest cutoff. This is the S1 "exempt-via-guard" protection. |
| `archiveBeforeDrop` | `false` | Export a partition to `archiveDir` before dropping it. |
| `archiveDir` | `null` | Local directory for gzip archives. REQUIRED when `archiveBeforeDrop` is `true` — the schema rejects startup otherwise. |
| `premakeMonths` | `3` | Monthly partitions provisioned ahead of the current month on each tick. |
| `maintenanceIntervalMs` | `86400000` (24h) | Maintenance loop cadence. |

With the shipped defaults (`auditRetentionMonths: null`) nothing is ever dropped; the
loop only provisions future partitions. Enabling retention is a separate
product/compliance decision — the mechanism ships without waiting on it.

### How the maintenance loop runs

The loop runs in the `boundary` process (`packages/boundary/src/journal-maintenance.ts`,
wired in `bin.ts`). It is self-rescheduling (a `setTimeout` chain, not `setInterval`)
and reschedules on failure, so a slow or failed tick never overlaps the next or kills
the loop. It fires once per `maintenanceIntervalMs` (daily by default).

Each tick is single-flight across replicas via a dedicated Redis lease. The lease id
is `journal-maintenance`, and because `InstanceLease` prefixes ids with
`lease:instance:`, the REAL Redis key is **`lease:instance:journal-maintenance`** (not
`lease:journal-maintenance`). A replica that loses the acquire race is a no-op for that
tick; the owner releases the lease in a `finally`.

Per tick, in order:

1. Provision the next `premakeMonths` monthly partitions — ALWAYS, even when retention
   is `null`.
2. Only when `auditRetentionMonths` is set: list partitions whose whole month precedes
   the audit cutoff and drop each one, skipping any partition that holds backtest rows
   unless `backtestRetentionMonths` is set and that partition's month precedes the
   backtest cutoff. If `archiveBeforeDrop` is `true`, the partition is archived to
   `archiveDir` first. Per-partition failures are logged and skipped so one bad
   partition cannot stall the rest of the tick.

### How archives relate to the Hetzner backup jobs

These are two SEPARATE, complementary artifacts:

- **Full-DB backup** (`infra/hetzner/backup.sh` → `infra/hetzner/backup-job.sh`): a
  `pg_dump -Fc` of the entire `traderton` database plus a Redis RDB snapshot, pushed to
  a restic repository and pruned with `--keep-daily 7 --keep-weekly 4 --keep-monthly 6`.
  The temp staging dir is created under `/srv/traderton` (the restic-backed volume).
- **Journal partition archive**: when `archiveBeforeDrop` is on, the maintenance loop
  writes a per-partition CSV gzip at `<archiveDir>/journal_events_YYYY_MM.csv.gz`
  (streamed via `COPY (SELECT * FROM <partition>) TO STDOUT WITH CSV` through gzip)
  immediately before dropping that month's partition.

The partition archive is a finer-grained artifact that preserves a dropped month's
audit rows as CSV independently of the restic snapshots. This matters because
restic's `--keep-monthly 6` would otherwise be the only copy of a dropped month, and
only for six months — once a month ages past the audit cutoff AND past restic's
monthly retention, it is gone unless it was archived.

**Recommended operator setup:** mount `archiveDir` on `/srv/traderton` (the
restic-backed volume). The `*.csv.gz` archives are then themselves captured by the
restic backup, giving the dropped months the same off-host durability as the full-DB
dumps while remaining individually restorable.

### How to restore an archived month

Given `<archiveDir>/journal_events_YYYY_MM.csv.gz` for the UTC month `YYYY-MM`:

1. Ensure the target monthly partition exists. Either let the maintenance loop
   re-create it (it only provisions current-and-future months, so a long-past month
   must be created by hand), or create it directly with the fixed naming + UTC bounds
   scheme — partition `journal_events_YYYY_MM`, `FROM 'YYYY-MM-01 00:00:00+00'` TO the
   first instant of the next month:

   ```sql
   -- Example for 2026-10:
   CREATE TABLE IF NOT EXISTS journal_events_2026_10
     PARTITION OF journal_events
     FOR VALUES FROM ('2026-10-01 00:00:00+00') TO ('2026-11-01 00:00:00+00');
   ```

   (Alternatively create a standalone table with the same columns, `COPY` into it, then
   `ALTER TABLE journal_events ATTACH PARTITION ... FOR VALUES FROM ... TO ...`.)

2. Load the archived rows straight into the partition. `COPY FROM` targets the
   partition directly; the rows route correctly because they are already within that
   month's range:

   ```sql
   COPY journal_events_2026_10
     FROM PROGRAM 'gunzip -c /srv/traderton/journal-archive/journal_events_2026_10.csv.gz'
     WITH CSV;
   ```

   `COPY FROM PROGRAM` runs the decompression on the DB server and needs a superuser.
   Where that is not available, stream the gunzipped CSV from the client instead with
   psql's `\copy`:

   ```sh
   gunzip -c /srv/traderton/journal-archive/journal_events_2026_10.csv.gz \
     | psql "$DATABASE_URL" -c "\copy journal_events_2026_10 FROM STDIN WITH CSV"
   ```

Monthly partitions are always named `journal_events_YYYY_MM` for the UTC month, with
bounds `FROM 'YYYY-MM-01 00:00:00+00'` (inclusive) TO the first instant of the next
month (exclusive). Keep that scheme exact — the maintenance loop derives names and
bounds from it, and a mismatched bound is refused rather than dropped.

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