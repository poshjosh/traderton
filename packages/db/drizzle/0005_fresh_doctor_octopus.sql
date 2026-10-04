ALTER TABLE "agent_trading_profiles" ADD COLUMN "scan_mode" text;--> statement-breakpoint
ALTER TABLE "agent_trading_profiles" ADD COLUMN "creator_strategy" jsonb;--> statement-breakpoint
ALTER TABLE "agent_trading_profiles" ADD COLUMN "active_strategy" jsonb;