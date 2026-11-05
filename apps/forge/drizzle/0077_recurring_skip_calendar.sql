ALTER TABLE "recurring_issue_events" ADD COLUMN "calendar" jsonb;--> statement-breakpoint
DROP TRIGGER forge_immutable_identity ON recurring_issue_events;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON recurring_issue_events FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','schedule_id','reason','from_date','to_date','count','created_at','calendar');
