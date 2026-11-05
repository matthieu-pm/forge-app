CREATE TABLE "inbox_activation" (
	"consumer" text PRIMARY KEY NOT NULL,
	"activated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_activity" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "inbox_activity_workspace_id_user_id_issue_id_command_id_pk" PRIMARY KEY("workspace_id","user_id","issue_id","command_id"),
	CONSTRAINT "inbox_activity_kind" CHECK ("inbox_activity"."kind" IN ('assignment','mention','comment','reply','status','update','reaction'))
);
--> statement-breakpoint
CREATE TABLE "inbox_deliveries" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "command_outbox_events" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "inbox_activity" ADD CONSTRAINT "inbox_activity_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_activity" ADD CONSTRAINT "inbox_activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_activity" ADD CONSTRAINT "inbox_activity_event_id_command_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."command_outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_activity" ADD CONSTRAINT "inbox_activity_workspace_id_issue_id_issues_workspace_id_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_activity" ADD CONSTRAINT "inbox_activity_workspace_id_command_id_command_receipts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","command_id") REFERENCES "public"."command_receipts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_deliveries" ADD CONSTRAINT "inbox_deliveries_event_id_command_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."command_outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_activity_recipient_order" ON "inbox_activity" USING btree ("workspace_id","user_id","occurred_at","command_id");