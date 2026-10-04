# 000 — Wave E overview: actor events + lifecycle (the never-authored "item C2")

**Status:** Traderton (`-T`) phases DONE (E0, E2, E3-T, E1-T); herobids (`-H`) phases
GATED (awaiting human go); E4/E5 separate folders, not started. **Date:** 2026-10-04.
**Backlog:** [011 Wave E](../../../../initial/011-premerge-backlog.md). **Ledger:**
[001 "Actor event + lifecycle callbacks never authored (item C2)"](../../../../initial/001-parity-ledger.md).
**Anomaly:** [003, 2026-10-04](../../../../initial/003-anomalies-and-deviations.md).
**Rulings:** [004 "Preset assessment is a trading charge"; "Bots resume after a graceful Traderton deploy"](../../../../initial/004-decision-log.md).

## What Wave E restores

When trading moved from herobids to Traderton, the actor callbacks were stubbed as
"M1 no-op → item C2" and never rebuilt. Wave E rebuilds them.

| Item | What | Plan | Repos |
|---|---|---|---|
| E0 | `bot:stop:*` subscriber, so `stop_bot` actually stops a running bot | DONE (2026-10-04) | traderton |
| E2 | Bot status stays true; bots survive restarts | [001](./001-e2-bot-status-and-restart-plan.md) — **DONE** | traderton only |
| E3 | Traderton → consumer event channel (scan results, wakes, breaker inputs, bot/agent status) | [002](./002-e3-consumer-event-channel-plan.md) — **E3-T DONE; E3-H GATED** | traderton, then herobids |
| E1 | Agent technical scan loop, explicit agent-actor lifecycle, agent→bot cascade stop + orphan sweep | [003](./003-e1-agent-scan-loop-plan.md) — **E1-T DONE; E1-H GATED** | traderton, then herobids |
| E4 | Agent-actor lease + owner routing (safe multi-replica) | [../002-agent-actor-lease-and-routing/001-plan.md](../002-agent-actor-lease-and-routing/001-plan.md) | traderton only; after E1 |
| E5 | `journal_events` retention + partitioning | [../003-journal-retention/001-plan.md](../003-journal-retention/001-plan.md) | traderton only; independent, best before real data |

**Out of scope:** moving the preset assessment (market-assessment workflow, metering,
billing, preset tools) to Traderton. It follows Wave E. That includes re-pointing herobids'
scheduled preset-review runner onto Traderton scan data.

## Order and gating

1. **E2** (Traderton only), which can start any time.
2. **E3-T** (Traderton producer), then **E3-H** (herobids relay).
3. **E1-T** (Traderton scan loop + lifecycle tools + cascade/sweep), then **E1-H**
   (herobids profile fields + session start/stop calls).
4. **E4** (agent-actor lease + routing), after E1-T, Traderton only.
5. **E5** (journal retention), independent and Traderton only. Do it before real data
   exists, because converting the table is trivial while it's empty.

**Herobids gate:** another agent is working in herobids. Every `-H` phase starts only
after an explicit human go. Each `-T` phase is shippable on its own: Traderton keeps
working with an older herobids. New events accumulate unread, and new profile fields
are optional.

E1-T depends on E3-T: scan results are only visible to agents through the channel. E1's
cascade/sweep completes E2's bot-lifecycle story.

## Shared design decisions (settled; do not reopen in a phase)

- **Event transport = a dedicated outbox table** (`consumer_notifications`, Traderton
  Postgres; human-approved 2026-10-04), **not** `journal_events`, which would pollute the
  audit log and the agent journal views. Traderton writes notifications from
  composition-level callbacks. Herobids polls the new system-only tool
  `scan_consumer_notifications` and republishes to the **existing** herobids message
  types, so herobids consumers stay unchanged. Notifications are pruned after
  `notifications.retentionDays`. Traderton never writes herobids Redis. External MCP
  consumers can poll the same way.
- **No copied file is modified to emit events.** All new emission is wiring in
  `packages/worker/src/composition/*` (callbacks and journal wrappers), so the
  copied-module 1:1 discipline holds.
- **Resume ruling:** a graceful Traderton shutdown leaves bot rows `running`, and the
  next process reclaims them. Only explicit stops and halts write `stopped`.
- **Tool names** are verb_noun (`start_agent_actor`, `stop_agent_actor`).
  Side-effecting tools follow 005 idempotency (caller-supplied key, `boundary_invocations`
  dedup).
- **Multiple boundary replicas now safe** (E4 landed; was "single replica assumed" in E1).
  `infra/hetzner/compose.yaml` still runs one `boundary` service, but both bots AND agent
  actors are now lease-protected, so running more than one is safe. See
  [002-agent-actor-lease-and-routing](../002-agent-actor-lease-and-routing/001-plan.md).

## Doc updates on completion (all phases)

- 001: flip the C2-table rows to **Met** / **Improved** (bot resume) as each lands;
  fix the `stop_bot` / drive-target notes (see E2 finding F1).
- 011: tick E1–E3; record follow-ups.
- 005: add the `consumer_notifications` vocabulary + `scan_consumer_notifications` + `start_agent_actor` / `stop_agent_actor`
  contracts + the new agent-trading-profile fields.
- CANONICAL-STATE §2.1: replace the "no producer" correction with the live state.
- herobids (when the gate opens): `CHANGELOG.md`; the optional pointer in
  `docs/features/2026/10/03/001-phase3-completion-note.md` "Next".

## Cross-phase risks

| Risk | Mitigation |
|---|---|
| Notification volume (a row per agent per scan interval) | Separate table with pruning + a scan payload cap (E3). Adds nothing to `journal_events`. |
| `journal_events` (audit log) has no retention (pre-existing) | Planned: [003-journal-retention](../003-journal-retention/001-plan.md) (monthly partitions + operator retention policy). Tracked as 011 Wave E E5. |
| Agent actors have no lease. A second boundary replica would run duplicate scan loops and duplicate decisions. | RESOLVED (E4): [002-agent-actor-lease-and-routing](../002-agent-actor-lease-and-routing/001-plan.md) landed — agent actors carry a `lease:instance:agent:{agentId}` lease; the lazy ensure, boot rehydrate, and orphan sweep acquire it before constructing, and non-owner decisions forward to the owner. Multiple replicas are now safe. |
| Relay down for a long time, then replays stale wakes | Persisted cursor initialised to "now", plus a max-event-age skip for wakes/scans (E3). |
| Reclaim loop restarts a bot that keeps failing | Mark `crashed` before releasing the lease (E2). Reclaim only loads `running`. |
