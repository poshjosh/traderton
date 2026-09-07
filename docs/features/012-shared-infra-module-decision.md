# Decision: Extract herobids infra into a shared, versioned Terraform module library

**Status:** settled
**Date:** 2026-09-07
**Scope:** traderton Phase 10 (infra) + a cross-repo infra extraction from herobids
**Audience:** any agent working in the traderton or herobids repos who touches infra

## Context (read this first — assume no prior knowledge)

traderton is being extracted from herobids as its own deployable service with its
own TLD. The last phase of that extraction (Phase 10, per
`docs/009-extraction-roadmap.md`) is infrastructure. Unlike trading code — which
moves by copy-and-delete, leaving herobids to consume traderton — **infra cannot be
deleted from herobids.** Both systems need to run. So a naive copy would leave two
divergent copies of the same infra to maintain forever.

Instead, we will extract the proven herobids infra into a **standalone, versioned
Terraform module library** that any number of platforms (herobids, traderton, future
services) consume the way Terraform modules are normally consumed — by `source` +
pinned version — **not** by one codebase physically serving two consumers.

What the herobids infra is today (all under `herobids/infra/`):
- **Terraform (Hetzner):** `main.tf` (~290 lines: server, firewall, private network,
  agent node pool), `variables.tf` (~440 lines, already heavily parameterized),
  `outputs.tf`, tfvars.
- **cloud-init:** `cloud-init.yaml` (~530 lines, control-plane first-boot) and
  `cloud-init-nomad-client.yaml` (agent-node first-boot).
- **Bash script suite** (`scripts/`): provision/deploy/push/reset + the Nomad
  autoscaling machinery (scale-out, nightly scale-in, placement-failure safety-net,
  admin email alerting) + a test harness.
- **One Nomad job:** `browser-pool.nomad.hcl` (herobids agent web-browsing; a
  platform concern, NOT infra — stays herobids-side).

There are **two distinct autoscaling-related concerns**, and the whole design hinges
on separating them:
1. The **Nomad server** (control process on the control-plane host).
2. The **Nomad agent-node pool + the autoscaler** (disposable nodes + the scripts
   and systemd timers that grow/shrink them).

Both exist in herobids to scale **LLM agent containers** — a herobids platform
workload. traderton is mechanical trading and runs no per-agent containers, so
**traderton does not need the autoscaler at launch.** It needs a control-plane host
it can scale vertically (bigger server) and be *ready* to add horizontal scaling
later without a rewrite.

## The decision

Extract herobids infra into **two composable, independently versioned Terraform
modules** in **one git repository**, consumed via **git-ref sourcing with immutable
version tags**. Each consumer pins its own version.

### Module split

- **Module A — `app-host/hcloud`:** the control-plane substrate. VM, firewall,
  private network, TLS, cloud-init that provisions the host (default: git-clone the
  repo + run docker-compose), and the deploy scripts. This is what traderton needs on
  day one. Parameterized on app identity, domain, repo/branch, compose/env files.
- **Module B — `nomad-autoscaler/hcloud`:** the agent-node pool + the autoscaler
  (scale-out / scale-in / placement-failure safety-net / alerting scripts + their
  systemd timers). Composed **on top of** module A by consumers who want autoscaling.

Consumers compose:
```hcl
# herobids — wants autoscaling
module "host"       { source = "...//modules/app-host/hcloud?ref=v1.2.0"; app_name = "herobids"; enable_nomad = true; ... }
module "autoscaler" { source = "...//modules/nomad-autoscaler/hcloud?ref=v1.0.0"; ... }

# traderton — host only, autoscaling-ready but not enabled
module "host"       { source = "...//modules/app-host/hcloud?ref=v1.2.0"; app_name = "traderton"; enable_nomad = false; ... }
```
"Autoscaling-ready" is concrete: traderton becomes autoscaling-capable by adding a
`module "autoscaler"` block and flipping `enable_nomad = true` on the host — no fork,
no copy.

### Settled decisions and their rationale

1. **Two modules, not one flagged module.** Matches actual consumption (traderton = A
   only; herobids = A + B), isolates the complex/changing part (the autoscaler) from
   the module everyone depends on, and makes "autoscaling-ready" real rather than a
   dormant flag.

2. **Provider-specific, suffixed `hcloud` — NOT provider-agnostic.** Terraform has no
   real interface mechanism; a provider-agnostic module would either lose
   Hetzner-specific features or require painful HCL branching, designed blind to a
   second provider we may never adopt. The `hcloud` suffix is the entire hedge: it
   reserves the namespace and states honestly what's supported. The genuinely portable
   assets (cloud-init templates, autoscaler scripts) are already provider-independent,
   so a future provider becomes a cheap sibling module (`app-host/aws`) reusing them —
   only the ~290 lines of `main.tf` are Hetzner-specific. **Do not build provider
   abstraction now.**

3. **Distribution: plain git-ref sourcing with immutable version tags.** No Terraform
   registry, no infrastructure to run. The "central location" is one git repo with
   tags; cutting a version = `git tag vX.Y.Z`. Each consumer pins independently via
   `?ref=vX.Y.Z`. **Discipline: always pin an immutable tag; never `?ref=main`,** so
   consumer builds are reproducible. (Caveat: repo-wide tags mean tagging one module's
   release also re-refs the other at that ref even if unchanged — a non-issue at two
   modules; document that the version is repo-wide.)

4. **One repo, not two.** Repo-wide version tags, one release cycle. Simpler for
   two-to-a-few modules. Split into separate repos later if independent versioning ever
   becomes worth two release cycles (cheap to do then).

5. **Invest upfront in module B's *workload* genericity — but scope it tightly.**
   Today B hardcodes an agent shape (`node_class = "agent"`, memory-per-slot tied to
   herobids agent profiles, node naming `${server_name}-agent-N`). Parameterize
   exactly these:
   - `node_class` (string) — the class scaled nodes register as.
   - `memory_per_slot_mb` (number) — the sizing unit (no longer "agent"-named).
   - `node_name_prefix` (string).
   Keep B a **memory-driven, single-pool** Nomad autoscaler. **Do NOT** abstract the
   scaling policy, add pluggable metrics beyond memory, support multiple pools, or
   support non-Nomad orchestrators — that's speculative generality with no second
   consumer to validate it. Test: a parameter with exactly one real value across all
   foreseeable consumers is a constant with extra steps, not a parameter. `node_class`
   passes (herobids=agent, future traderton=worker); "pluggable metric source" fails.

6. **Provisioning seam: one coarse override, not a per-step pipeline.** Module A ships
   the git-clone+compose cloud-init as the **default**, and accepts a single optional
   `user_data_override` (a full replacement cloud-init) for a consumer wanting a
   radically different deploy model. **Do NOT** build individually swappable
   provisioning steps: cloud-init is a single templated `user_data` string, not a
   composable pipeline; per-step swap seams are fragile, ordering-sensitive, untestable
   with only one path exercised, and contradict the minimal-maintenance goal. The
   default path is the only one that must be tested and supported.

7. **Identity: a single `app_name` variable derives everything, with optional
   overrides.** In herobids the literal `herobids` is really three coupled axes:
   - **App identity** → paths (`/opt/<app>`, `/etc/<app>`), systemd unit names, log
     paths (~166 references).
   - **Env-var namespace** → `HEROBIDS_ENV` → `<APP>_ENV` (**232 references** across 24
     scripts; this is the single largest mechanical surface). It funnels through one
     seam: `scripts/_ssh_opts.sh` defines the env helper (`parse_env_flag`,
     `*_ENV_SHIFT`) and every script sources it — so the 232 refs collapse to "one
     helper defines it, N scripts consume it," not 232 independent edits.
   - **DB identity** → pg user/database/volume/docker-network names (~5 references,
     contained).
   `app_name` derives all three by convention; expose optional explicit overrides
   (`db_name`, `db_user`, `env_var_prefix`) for consumers who need them to differ.

8. **Nomad-server boundary: the Nomad *server* config stays in module A behind the
   `enable_nomad` flag; the *entire autoscaler* (pool + scripts + timers) is module B.**
   Rationale — this respects how cloud-init actually works: on Hetzner, cloud-init is
   delivered via the single `user_data` string of `hcloud_server`, set once at create
   time, `ignore_changes`. Module A owns that resource, so A owns the whole cloud-init
   document — including the (conditional) Nomad-server stanza. A "pure" module B that
   injects Nomad-server config into A's host would require merging cloud-init across a
   module boundary (fragile), or B re-implementing all of A's provisioning (duplication),
   or a post-boot orchestration step the stack doesn't have. All worse than the problem.
   The cost of this choice is purely cosmetic: A's *source* contains a Nomad conditional
   traderton never triggers; traderton's *provisioned host* has zero Nomad
   (`enable_nomad = false` → nothing installed, no server, no ports). **Composition
   contract:** using module B requires instantiating module A with `enable_nomad = true`;
   B cannot add autoscaling alone. Enforce with a `precondition` in B (check the Nomad
   server is reachable) and document the one-line contract.

9. **Node-health publisher is a herobids monitoring concern — OUT of the reusable
   module.** `cloud-init-nomad-client.yaml` (part of module B's agent template) embeds
   `agent-node-health.sh`, which publishes a node metrics snapshot to a Redis key
   namespaced `herobids:server-health:agent-server:${HOST}`. **Verified (2026-09-07):**
   the autoscaler's capacity logic (`scale-common.sh`, `check-nomad-capacity.sh`) makes
   scaling decisions **from the Nomad API only** — it never reads these Redis keys. The
   sole reader of the health keys is herobids' own worker/monitoring, which lives
   outside infra entirely. Therefore health-reporting is **decoupled** from scaling: the
   autoscaler behaves identically whether or not the publisher runs.
   Decision: **module B ships the pool + autoscaling only; the health publisher is out
   of scope.** herobids re-attaches its publisher via the `user_data_override` seam
   (decision 6) or a small supplementary file it owns.
   Rationale for excluding rather than parameterizing:
   - It is **monitoring, not scaling** — the same class of concern as the browser-pool
     job already ruled platform-side. Module B should do exactly one thing: grow/shrink
     a Nomad node pool from capacity.
   - Parameterizing only the key *prefix* (`${app_name}:...`) would still ship
     **herobids' `ServerHealthSnapshot` record shape** (the JSON structure the herobids
     worker deserializes: `serverType`, `nomadAllocations`, `availableMemoryMb`, etc.)
     inside the shared module. A second consumer flipping the flag on would emit a
     herobids-shaped payload into a key nothing on its side reads — a leaky abstraction
     dressed as a clean one.
   - Excluding it makes B's agent template smaller and truly app-neutral: no Redis, no
     `redis-tools` dependency, no health units. herobids keeps its own concern in its
     own repo, where the `ServerHealthSnapshot` schema already lives.
   Boundary test this applies (use it for any future "does this belong in the module?"):
   *would a second consumer use it as-is, or does it encode the first consumer's
   application semantics?* Autoscaler passes (memory-driven pool scaling is generic);
   health publisher fails (encodes herobids' monitoring schema).
   Caveat: if EVERY consumer later wants node telemetry AND a shared, app-neutral
   snapshot schema emerges (a real second consumer validating a real abstraction, per
   decision 5's bar), revisit toward parameterizing it into B. Not the case today; do
   not build for it today.

### Explicitly out of scope for the reusable modules
- `browser-pool.nomad.hcl` — herobids agent web-browsing, a platform concern; stays
  herobids-side.
- The node-health publisher (`agent-node-health.sh` + its units) — herobids monitoring
  concern (decision 9); herobids re-attaches via the override seam.
- Provider abstraction (see decision 2).
- Any scaling policy beyond memory-driven single-pool (see decision 5).
- Per-step swappable provisioning (see decision 6).

## Verified facts underpinning this (from reading herobids source, 2026-09-07)
- `main.tf`/`variables.tf` are ~90% module-ready; every consumer-varying value is
  already a variable. Blockers: ~7 `herobids` label literals → `app_name`.
- `scripts/scale-common.sh` (the autoscaler brain) is ~85% app-agnostic already —
  everything reads from env vars with defaults; the only herobids couplings are
  `TERRAFORM_DIR` default (`/opt/herobids/...`), the state key (`herobids/${env}/...`),
  and keying off `HEROBIDS_ENV`. The Nomad API / cooldown / flock / drain / capacity
  logic mentions no herobids business logic.
- The autoscaler decides scaling from the **Nomad API** (`check-nomad-capacity.sh`
  polls `/v1/nodes` + per-node resources); it does **not** consume the Redis
  `herobids:server-health:*` keys. Health publisher and autoscaler are decoupled
  (underpins decision 9).
- `HEROBIDS_ENV`: 232 refs / 24 scripts, single seam in `_ssh_opts.sh`.
- `/opt/herobids` + `/etc/herobids`: 166 refs.
- `node_class = "agent"` hardcoded in `cloud-init-nomad-client.yaml` and in
  `scale-common.sh`'s `list_eligible_agent_nodes` (greps `NodeClass == "agent"`) —
  covered by decision 5's parameterization.

## Timing
Extract during the **M1 library-consumer testing window** (the interim state where
herobids consumes traderton in-process as a library, undergoing exhaustive testing).
During that window herobids infra is stable (no trading-code churn beneath it).
**herobids is the live test harness for module B** — the only system with real agent
load that exercises scale-out/in/safety-net under production traffic — so keeping
herobids consuming B via `source`/`version` validates the module against the one
workload that stresses it. traderton meanwhile validates module A (does the host boot,
clone, compose-up, serve TLS). Do not rush a temporary infra for traderton that gets
thrown away; build the reusable module properly in this window.

## Consequence for the traderton extraction roadmap
Phase 10 (`infra`) is no longer "copy the trading slice of herobids infra and delete the
rest." It becomes "consume `app-host/hcloud` at a pinned version with `enable_nomad =
false`." The module extraction itself is a cross-repo effort scheduled in the M1 window,
with herobids as B's test harness. This is a **shape-level change** the roadmap did not
originally anticipate (it predates this decision); update `docs/009-extraction-roadmap.md`
accordingly and record this in `docs/004-decision-log.md`.
