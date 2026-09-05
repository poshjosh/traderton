# Anomalies & Deviations

**Status:** living
**Purpose:** log things discovered **during** copy-and-delete that force an
unplanned deviation from pure copy — genuinely broken source behaviour, or a
seam that cannot be preserved without authoring non-trivial logic.

## When to add an entry

Add an entry when, mid-extraction, you hit any of:

1. source behaviour that appears genuinely broken;
2. a seam that cannot be stubbed narrowly and would require authoring
   non-trivial logic to keep the build/tests green;
3. a copied test that cannot pass without a real (non-stub) change.

**Do not improvise a fix.** Stop, log it here, and surface it. A silent
authored fix is the exact failure mode this project exists to avoid.

## Not for this doc

- **Deliberate up-front design decisions** → [000-vision.md](./000-vision.md)
  decisions list + [001-parity-ledger.md](./001-parity-ledger.md) (Intentional
  divergence). Example: bots being mechanical-only is a planned decision, not an
  anomaly.

## Log

| Date | Where (file / seam) | What | Decision / status |
|------|---------------------|------|-------------------|
| _(none yet)_ | | | |
