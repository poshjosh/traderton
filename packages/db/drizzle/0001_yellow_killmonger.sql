CREATE TABLE "boundary_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"consumer_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"terminal_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_boundary_invocations_key" ON "boundary_invocations" USING btree ("consumer_id","owner_id","tool_name","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_boundary_invocations_request_id" ON "boundary_invocations" USING btree ("request_id");