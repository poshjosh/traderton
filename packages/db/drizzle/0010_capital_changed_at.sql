-- Capital-change baseline (bug-report 2026/11/21/001, plan item 2): when capital last changed
-- on an existing profile. Null = never edited (allocation period = whole lifetime), so no backfill.
ALTER TABLE "agent_trading_profiles" ADD COLUMN "capital_changed_at" timestamp with time zone;
