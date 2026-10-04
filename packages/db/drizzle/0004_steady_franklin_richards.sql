CREATE TABLE "consumer_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text,
	"bot_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_consumer_notifications_created_at_id" ON "consumer_notifications" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "idx_consumer_notifications_agent_id" ON "consumer_notifications" USING btree ("agent_id");