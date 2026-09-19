ALTER TABLE "agent_trading_profile_changes" ADD COLUMN "forward_action" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_trading_profile_changes" ADD COLUMN "applied_revision" bigint;