# Configuration Management

Traderton mirrors the herobids configuration discipline (its rules translate directly;
see herobids `docs/best-practices/configuration.md`), scoped to what Traderton is: a trading
library (`@traderton/*`) plus the M2 REST **boundary** process. Traderton owns no user-facing
instance-config UI — its config surfaces are (1) operator YAML for trading values and (2)
operator **environment variables** for the boundary's infra/secrets.

## Config layers — never mix them

| | Operator YAML | Operator env vars |
|--|---------------|-------------------|
| **What** | Trading values: venues, execution, risk defaults, market-data, streams, reconciliation | Infra + secrets: DB/Redis URLs, boundary HMAC signing creds, provider keys |
| **Where** | `config/default.yaml` (+ `config/{NODE_ENV}.yaml`), parsed by `AppConfigSchema` | `.env*` files / the deploy environment, read at the process entry point (`packages/boundary/src/bin.ts`) |
| **When** | Deploy/restart | Deploy/restart |
| **Validated** | At startup via Zod (`loadConfig` → `AppConfigSchema.parse`) — fail fast | At the boundary entry point — required vars must fail fast if absent |

Principle carried from herobids: **`config/default.yaml` is self-documenting** (inline comments
explain every trading value); **no magic numbers in business logic**; **read env only at the
entry point**, never in library/business code.

## Environment files — `.example` twins are the committed source of truth

Operator/deploy-time env inputs are supplied via `.env*` files. **Real `.env*` files are
gitignored; every `.env*` file has a committed `.example` twin, and the `.example` is the
source of truth** for what an operator must set to run the boundary.

```
.env             ← real values, gitignored (never committed)
.env.example     ← committed, self-documenting twin
```

The `.gitignore` enforces the mechanism (ignore all real `.env*`, then explicitly un-ignore
each `.example`):

```
.env
.env.*
!.env.example
```

### Why

A newcomer (human or agent) reads the committed `.example` and immediately knows **which
`.env` to create and exactly which keys it needs** — without reading the code or leaking a
secret. It is documentation that cannot drift silently, because the rule below keeps it in
lockstep with the code.

### The rule (authoring/implementing agents MUST follow)

- Every `.env*` file has a matching committed `.example` (same variable keys).
- `.example` values are **safe placeholders or blank** — never real secrets.
- Each variable gets a one-line `#` comment (on its own line) saying what it is and whether
  it's required.
- **When you ADD or CHANGE an env var (a new `process.env.X` read), update the matching
  `.example` in the SAME change.** The `.example` must stay in lockstep with the code.
- **When you introduce a NEW `.env` variant, create its `.example` immediately** and add a
  `!.env.<name>.example` un-ignore line to `.gitignore`.
- Scope: `.example` documents operator/deploy-time env inputs ONLY — not the trading values
  that live in `config/*.yaml`. Keep the two layers distinct so the `.example` never becomes
  a stale mirror.

### The boundary's env inputs (as of the L3 cutover)

The M2 boundary process (`packages/boundary/src/bin.ts`) reads these — they are documented in
`.env.example` at the repo root:

- **Required:** `DATABASE_URL`, `REDIS_URL`, `CREDENTIAL_ENCRYPTION_KEY`, and the HMAC consumer
  triple `BOUNDARY_CONSUMER_ID` / `BOUNDARY_KEY_ID` / `BOUNDARY_SIGNING_SECRET` (must match the
  herobids consumer's signing creds).
- **Boundary tuning (optional, have defaults):** `BOUNDARY_HOST`, `BOUNDARY_PORT`,
  `BOUNDARY_BASE_URL`, `BOUNDARY_CLOCK_SKEW_MS`, `BOUNDARY_IDEMPOTENCY_RETENTION_HOURS`.
- **Optional integrations (absent → feature degrades, not crashes):** `SCRAPFLY_API_KEY` +
  `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_TIMEOUT_MS` (economic-calendar acquisition).
- **Misc:** `NODE_ENV`, `LOG_FORMAT`, `DATASETS_DIR`.

Note on the alert-dispatcher cross-owner read: the operator fences it via the boundary
consumer's `allowedConsumers` / `allowedActorTypes: ['system']` config, not a plain env var —
see the L3 cutover notes in `docs/001-parity-ledger.md`.

## Anti-patterns (carried from herobids)

- Reading `process.env` outside the entry point / config loader.
- Committing a real `.env*` (only `.example` is committed).
- Letting `.example` drift from the code's `process.env.*` reads.
- Putting trading values in env vars (they belong in `config/*.yaml`), or putting infra/secrets
  in YAML (they belong in env).
- Inferring config from data (e.g. deriving a provider from a model name). Configuration must
  be explicit; if a required var is absent, fail fast — do not guess.
