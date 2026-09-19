CREATE TABLE "agent_trading_profiles" (
  "id" text PRIMARY KEY NOT NULL,
  "owner_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "venue_account_id" text NOT NULL,
  "capital" text,
  "risk_posture" jsonb,
  "risk_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "execution_defaults" jsonb,
  "revision" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_trading_profiles_owner_actor_venue" ON "agent_trading_profiles" USING btree ("owner_id","actor_id","venue_account_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_trading_profiles_owner_venue" ON "agent_trading_profiles" USING btree ("owner_id","venue_account_id");
--> statement-breakpoint
CREATE TABLE "agent_trading_profile_changes" (
  "operation_id" text NOT NULL,
  "action_id" text NOT NULL,
  "owner_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "venue_account_id" text NOT NULL,
  "preimage" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY("operation_id", "action_id")
);