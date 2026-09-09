CREATE TABLE "backtest_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"strategy_type" text NOT NULL,
	"config" jsonb NOT NULL,
	"corpus_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"metrics" jsonb,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"venue" text NOT NULL,
	"balances" jsonb NOT NULL,
	"mark_source" text,
	"snapshot_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"blueprint_id" text,
	"blueprint_revision_id" text,
	"config_snapshot" jsonb,
	"status" text DEFAULT 'stopped' NOT NULL,
	"creator_type" text DEFAULT 'user' NOT NULL,
	"creator_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"venue" text,
	"symbol" text,
	"interval" text,
	"from" timestamp with time zone,
	"to" timestamp with time zone,
	"file_path" text,
	"row_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_contexts" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"context_hash" text NOT NULL,
	"context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"decision_id" text,
	"instrument_id" text,
	"venue" text,
	"venue_account_id" text,
	"failure_code" text NOT NULL,
	"failure_message" text NOT NULL,
	"failure_class" text NOT NULL,
	"retryable" boolean DEFAULT false NOT NULL,
	"details" jsonb,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"intent" text NOT NULL,
	"target_size" numeric NOT NULL,
	"limit_price" numeric,
	"context_hash" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"action" text NOT NULL,
	"planned_orders" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"venue_ref_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric NOT NULL,
	"fee" numeric,
	"fee_currency" text,
	"realized_pnl_delta" numeric,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"venue" text NOT NULL,
	"type" text NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"tick_size" numeric NOT NULL,
	"lot_size" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text,
	"actor_id" text,
	"backtest_run_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_decision_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text,
	"decision_ids" jsonb,
	"source" text DEFAULT 'llm_strategy' NOT NULL,
	"context_hash" text NOT NULL,
	"context" jsonb NOT NULL,
	"prompt_payload" text NOT NULL,
	"prompt_version" text NOT NULL,
	"raw_response" text,
	"parsed_decision" jsonb,
	"parse_status" text NOT NULL,
	"parse_error" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_assessment_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assessment_run_id" text NOT NULL,
	"assessed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_actor_use_age" text NOT NULL,
	"max_wake_age" text NOT NULL,
	"assessment_version" integer DEFAULT 1 NOT NULL,
	"artifact_version" integer DEFAULT 1 NOT NULL,
	"ranking_policy_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allowed_presets" jsonb NOT NULL,
	"current_market_summary" text DEFAULT '' NOT NULL,
	"regime_summary" text DEFAULT '' NOT NULL,
	"scan_health_summary" text DEFAULT '' NOT NULL,
	"preset_rankings" jsonb NOT NULL,
	"recommended_preset" text,
	"relative_uplift" numeric,
	"confidence" numeric NOT NULL,
	"urgency" text DEFAULT 'low' NOT NULL,
	"reasoning_summary" text DEFAULT '' NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_market_assessment_artifacts_orderbook_perp" CHECK (
    ("market_assessment_artifacts"."instrument_kind" IN ('orderbook', 'perp') AND "market_assessment_artifacts"."symbol" IS NOT NULL AND "market_assessment_artifacts"."network" IS NULL AND "market_assessment_artifacts"."address" IS NULL)
    OR "market_assessment_artifacts"."instrument_kind" NOT IN ('orderbook', 'perp')
  ),
	CONSTRAINT "chk_market_assessment_artifacts_swap_dex" CHECK (
    ("market_assessment_artifacts"."instrument_kind" IN ('swap', 'dex') AND "market_assessment_artifacts"."network" IS NOT NULL AND "market_assessment_artifacts"."address" IS NOT NULL AND "market_assessment_artifacts"."symbol" IS NULL)
    OR "market_assessment_artifacts"."instrument_kind" NOT IN ('swap', 'dex')
  )
);
--> statement-breakpoint
CREATE TABLE "market_assessment_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"identity_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_refs" jsonb NOT NULL,
	"evidence_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scorecard_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calculation_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"assessment_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_market_assessment_runs_orderbook_perp" CHECK (
    ("market_assessment_runs"."instrument_kind" IN ('orderbook', 'perp') AND "market_assessment_runs"."symbol" IS NOT NULL AND "market_assessment_runs"."network" IS NULL AND "market_assessment_runs"."address" IS NULL)
    OR "market_assessment_runs"."instrument_kind" NOT IN ('orderbook', 'perp')
  ),
	CONSTRAINT "chk_market_assessment_runs_swap_dex" CHECK (
    ("market_assessment_runs"."instrument_kind" IN ('swap', 'dex') AND "market_assessment_runs"."network" IS NOT NULL AND "market_assessment_runs"."address" IS NOT NULL AND "market_assessment_runs"."symbol" IS NULL)
    OR "market_assessment_runs"."instrument_kind" NOT IN ('swap', 'dex')
  )
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"execution_plan_id" text,
	"venue_ref_id" text,
	"client_order_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"quantity" numeric NOT NULL,
	"price" numeric,
	"reference_price" numeric,
	"status" text DEFAULT 'pending' NOT NULL,
	"submission_state" text,
	"submit_attempted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"filled_quantity" numeric DEFAULT '0' NOT NULL,
	"avg_fill_price" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" text,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"instrument_id" text,
	"side" text NOT NULL,
	"size" numeric NOT NULL,
	"entry_price" numeric NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"mark_source" text,
	"exit_reason" text,
	"stop_loss" numeric,
	"take_profit" numeric,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_events" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_account_id" text NOT NULL,
	"result" text NOT NULL,
	"local_state" jsonb NOT NULL,
	"venue_state" jsonb NOT NULL,
	"diff" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_corpora" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"venue" text NOT NULL,
	"symbols" text NOT NULL,
	"format_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_market_events" (
	"id" text PRIMARY KEY NOT NULL,
	"corpus_id" text NOT NULL,
	"venue" text NOT NULL,
	"symbol" text NOT NULL,
	"event_type" text NOT NULL,
	"price" numeric NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "token_safety_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"bot_id" text,
	"venue_account_id" text NOT NULL,
	"network" text NOT NULL,
	"token_address" text NOT NULL,
	"reason_codes" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"decision_id" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_data" text NOT NULL,
	"encryption_meta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"venue" text NOT NULL,
	"label" text NOT NULL,
	"venue_account_ref" text,
	"credential_id" text,
	"venue_profile" jsonb,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_venue_account_id_venue_accounts_id_fk" FOREIGN KEY ("venue_account_id") REFERENCES "public"."venue_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_assessment_artifacts" ADD CONSTRAINT "market_assessment_artifacts_assessment_run_id_market_assessment_runs_id_fk" FOREIGN KEY ("assessment_run_id") REFERENCES "public"."market_assessment_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_accounts" ADD CONSTRAINT "venue_accounts_credential_id_user_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."user_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_status" ON "backtest_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_strategy_type" ON "backtest_runs" USING btree ("strategy_type");--> statement-breakpoint
CREATE INDEX "idx_backtest_runs_created_at" ON "backtest_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_balance_snapshots_venue_account_id" ON "balance_snapshots" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_balance_snapshots_snapshot_at" ON "balance_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_bots_owner_id" ON "bots" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_bots_status" ON "bots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_bots_creator_id" ON "bots" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "idx_bots_venue_account_id" ON "bots" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_datasets_owner_id" ON "datasets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_datasets_status" ON "datasets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_decision_id" ON "decision_contexts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_context_hash" ON "decision_contexts" USING btree ("context_hash");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_venue_account_id" ON "decision_contexts" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_decision_contexts_actor_id" ON "decision_contexts" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_decision_failures_actor" ON "decision_failures" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_decision_failures_failed_at" ON "decision_failures" USING btree ("failed_at");--> statement-breakpoint
CREATE INDEX "idx_decisions_venue_account_id" ON "decisions" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_decisions_actor_type" ON "decisions" USING btree ("actor_type");--> statement-breakpoint
CREATE INDEX "idx_decisions_actor_id" ON "decisions" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_decisions_created_at" ON "decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_decision_id" ON "execution_plans" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_venue_account_id" ON "execution_plans" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_execution_plans_actor_id" ON "execution_plans" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_fills_order_id" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "idx_fills_venue_account_id" ON "fills" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_fills_actor_id" ON "fills" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_fills_filled_at" ON "fills" USING btree ("filled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_instruments_venue_symbol" ON "instruments" USING btree ("venue","symbol");--> statement-breakpoint
CREATE INDEX "idx_journal_events_actor_id" ON "journal_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_journal_events_type" ON "journal_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_journal_events_created_at" ON "journal_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_journal_events_backtest_run_id" ON "journal_events" USING btree ("backtest_run_id");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_decision_id" ON "llm_decision_artifacts" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_decision_ids" ON "llm_decision_artifacts" USING btree ("decision_ids");--> statement-breakpoint
CREATE INDEX "idx_llm_decision_artifacts_context_hash" ON "llm_decision_artifacts" USING btree ("context_hash");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_assessment_run_id" ON "market_assessment_artifacts" USING btree ("assessment_run_id");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_expires_at" ON "market_assessment_artifacts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_assessed_at" ON "market_assessment_artifacts" USING btree ("assessed_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_artifacts_identity_lookup" ON "market_assessment_artifacts" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_artifacts_orderbook_active" ON "market_assessment_artifacts" USING btree ("instrument_kind","venue_family","style_tier","symbol") WHERE "market_assessment_artifacts"."status" = 'active' AND "market_assessment_artifacts"."instrument_kind" IN ('orderbook', 'perp');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_market_assessment_artifacts_swap_active" ON "market_assessment_artifacts" USING btree ("instrument_kind","venue_family","style_tier","network","address") WHERE "market_assessment_artifacts"."status" = 'active' AND "market_assessment_artifacts"."instrument_kind" IN ('swap', 'dex');--> statement-breakpoint
CREATE INDEX "idx_market_assessment_runs_status" ON "market_assessment_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_runs_started_at" ON "market_assessment_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_market_assessment_runs_identity_lookup" ON "market_assessment_runs" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_orders_venue_account_id" ON "orders" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_orders_actor_id" ON "orders" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "idx_orders_venue_ref_id" ON "orders" USING btree ("venue_ref_id");--> statement-breakpoint
CREATE INDEX "idx_orders_client_order_id" ON "orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE INDEX "idx_orders_status" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_positions_venue_account_id" ON "positions" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_positions_actor" ON "positions" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_positions_venue_symbol" ON "positions" USING btree ("venue_account_id","symbol");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_venue_account_id" ON "reconciliation_events" USING btree ("venue_account_id");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_created_at" ON "reconciliation_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_reconciliation_events_result" ON "reconciliation_events" USING btree ("result");--> statement-breakpoint
CREATE INDEX "idx_replay_corpora_venue" ON "replay_corpora" USING btree ("venue");--> statement-breakpoint
CREATE INDEX "idx_replay_market_events_corpus_symbol_time" ON "replay_market_events" USING btree ("corpus_id","symbol","event_at");--> statement-breakpoint
CREATE INDEX "idx_replay_market_events_corpus_type" ON "replay_market_events" USING btree ("corpus_id","event_type");--> statement-breakpoint
CREATE INDEX "idx_token_safety_overrides_actor" ON "token_safety_overrides" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "idx_token_safety_overrides_token" ON "token_safety_overrides" USING btree ("network","token_address");--> statement-breakpoint
CREATE INDEX "idx_token_safety_overrides_status" ON "token_safety_overrides" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_venue_accounts_owner_id" ON "venue_accounts" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_venue_accounts_credential_id" ON "venue_accounts" USING btree ("credential_id");