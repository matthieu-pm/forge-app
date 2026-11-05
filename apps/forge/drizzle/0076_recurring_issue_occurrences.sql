CREATE TABLE "recurring_issue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"from_date" text,
	"to_date" text,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_issue_events_count_check" CHECK ("recurring_issue_events"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recurring_issue_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"schedule_id" uuid NOT NULL,
	"due_date" text NOT NULL,
	"scheduled_at" timestamp (3) with time zone NOT NULL,
	"snapshot" jsonb NOT NULL,
	"revision" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"issue_id" uuid,
	"reason" text,
	"job_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_issue_occurrence_identity" UNIQUE("schedule_id","due_date"),
	CONSTRAINT "recurring_issue_occurrence_state_check" CHECK ("recurring_issue_occurrences"."state" in ('pending','created','skipped') and ("recurring_issue_occurrences"."state" <> 'created' or "recurring_issue_occurrences"."issue_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD COLUMN "state" text DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD COLUMN "activated_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD COLUMN "next_index" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD COLUMN "next_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD COLUMN "last_reason" text;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD COLUMN "skipped_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD CONSTRAINT "team_recurring_issues_workspace_identity" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "recurring_issue_events" ADD CONSTRAINT "recurring_issue_events_workspace_id_schedule_id_team_recurring_issues_workspace_id_id_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "public"."team_recurring_issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_issue_occurrences" ADD CONSTRAINT "recurring_issue_occurrences_workspace_id_schedule_id_team_recurring_issues_workspace_id_id_fk" FOREIGN KEY ("workspace_id","schedule_id") REFERENCES "public"."team_recurring_issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_issue_events_schedule_idx" ON "recurring_issue_events" USING btree ("schedule_id","created_at");--> statement-breakpoint
CREATE INDEX "recurring_issue_occurrences_pending_idx" ON "recurring_issue_occurrences" USING btree ("state","job_id");--> statement-breakpoint
CREATE INDEX "team_recurring_issues_due_idx" ON "team_recurring_issues" USING btree ("state","next_at");--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD CONSTRAINT "team_recurring_issues_state_check" CHECK ("team_recurring_issues"."state" in ('inactive','active','disabled','paused','deleted'));--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD CONSTRAINT "team_recurring_issues_cursor_check" CHECK ("team_recurring_issues"."next_index" >= 0 and "team_recurring_issues"."skipped_count" >= 0);
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON recurring_issue_occurrences FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','schedule_id','due_date','scheduled_at','snapshot','revision');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON recurring_issue_events FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','schedule_id','reason','from_date','to_date','count','created_at');
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON recurring_issue_occurrences FOR EACH ROW EXECUTE FUNCTION forge_capture_recovery_event();
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON recurring_issue_events FOR EACH ROW EXECUTE FUNCTION forge_capture_recovery_event();
