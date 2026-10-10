-- CUSTOM MIGRATION — preset assessment data-only (004 "Preset assessment becomes
-- data-only and free", plan 004-preset-assessment-data-only S1).
--
-- 1. market_assessment_artifacts: drop the LLM-only columns (narrative summaries,
--    rankings' pros/cons/score, confidence, urgency, recommendedPreset,
--    relativeUplift, reasoningSummary, and the age/version bookkeeping) and add the
--    data-only columns (evidence, presets, current_strategy).
-- 2. market_assessment_requests: new table (request/cooldown bookkeeping, no billing).
-- 3. agent_strategy_changes: new table (audit trail + review-screen source).
--
-- Greenfield: the assessment tables are empty (the herobids assessment machinery
-- never ran against Traderton's DB), so the column drops are safe.

ALTER TABLE "market_assessment_artifacts" DROP COLUMN "max_actor_use_age";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "max_wake_age";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "assessment_version";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "artifact_version";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "ranking_policy_version";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "current_market_summary";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "regime_summary";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "scan_health_summary";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "preset_rankings";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "recommended_preset";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "relative_uplift";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "confidence";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "urgency";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" DROP COLUMN "reasoning_summary";--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" ADD COLUMN "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" ADD COLUMN "presets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" ADD COLUMN "current_strategy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_trading_profiles" ADD COLUMN "preset_policy" jsonb;--> statement-breakpoint

CREATE TABLE "market_assessment_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"request_group_key" text NOT NULL,
	"status" text NOT NULL,
	"assessment_artifact_id" text,
	"failure_code" text,
	"failure_message" text,
	"requested_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "idx_market_assessment_requests_identity_lookup" ON "market_assessment_requests" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_requests_agent_requested" ON "market_assessment_requests" USING btree ("agent_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_requests_group_attempt" ON "market_assessment_requests" USING btree ("request_group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_requests_group_in_progress" ON "market_assessment_requests" USING btree ("request_group_key") WHERE "market_assessment_requests"."status" = 'in_progress';--> statement-breakpoint

CREATE TABLE "agent_strategy_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"from_strategy" jsonb,
	"to_strategy" jsonb NOT NULL,
	"artifact_id" text NOT NULL,
	"reason" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "idx_agent_strategy_changes_actor" ON "agent_strategy_changes" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_strategy_changes_owner" ON "agent_strategy_changes" USING btree ("owner_id","created_at");