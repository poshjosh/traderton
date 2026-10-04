CREATE TABLE "agent_actor_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"venue_account_id" text NOT NULL,
	"venue" text NOT NULL,
	"venue_type" text NOT NULL,
	"desired_state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_actor_runs_owner_actor" ON "agent_actor_runs" USING btree ("owner_id","actor_id");