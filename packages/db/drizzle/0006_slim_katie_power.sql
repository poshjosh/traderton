CREATE TABLE "agent_scan_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	"scan_version" text NOT NULL,
	"active_preset_key" text NOT NULL,
	"preset_behavior_version" text NOT NULL,
	"instrument_kind" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"symbol" text,
	"network" text,
	"address" text,
	"raw_candidate_id" text,
	"resolution_status" text,
	"candidate_rank" integer NOT NULL,
	"scan_scope" text,
	"signal_facts" jsonb,
	"confidence" numeric,
	"regime_bucket" text,
	"volatility_fact" numeric,
	"data_freshness_ts" timestamp with time zone,
	"disposition" text DEFAULT 'discovered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_scan_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"preset_key" text NOT NULL,
	"preset_behavior_version" text NOT NULL,
	"venue_family" text NOT NULL,
	"style_tier" text NOT NULL,
	"scan_scope" jsonb,
	"scanned_at" timestamp with time zone NOT NULL,
	"candidates_discovered" integer DEFAULT 0 NOT NULL,
	"candidates_scored" integer DEFAULT 0 NOT NULL,
	"signals_generated" integer DEFAULT 0 NOT NULL,
	"scan_health" text NOT NULL,
	"top_confidence" numeric,
	"regime_bucket" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_agent_scanned" ON "agent_scan_candidates" USING btree ("agent_id","scanned_at");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_identity" ON "agent_scan_candidates" USING btree ("instrument_kind","venue_family","style_tier","symbol","network","address");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_rank" ON "agent_scan_candidates" USING btree ("agent_id","candidate_rank");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_disposition" ON "agent_scan_candidates" USING btree ("disposition");--> statement-breakpoint
CREATE INDEX "idx_scan_candidates_resolution" ON "agent_scan_candidates" USING btree ("resolution_status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_scan_candidates_agent_scan_rank" ON "agent_scan_candidates" USING btree ("agent_id","scanned_at","raw_candidate_id");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_agent_id" ON "agent_scan_metrics" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_preset_key" ON "agent_scan_metrics" USING btree ("preset_key");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_scanned_at" ON "agent_scan_metrics" USING btree ("scanned_at");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_scan_scope" ON "agent_scan_metrics" USING btree ("venue_family","style_tier");--> statement-breakpoint
CREATE INDEX "idx_agent_scan_metrics_preset_scanned_at" ON "agent_scan_metrics" USING btree ("preset_key","scanned_at");