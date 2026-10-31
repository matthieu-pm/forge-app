CREATE INDEX "command_outbox_issue_history_idx" ON "command_outbox_events" USING btree ("workspace_id",("payload"->>'issueId'),"created_at","id");
--> statement-breakpoint
-- Delivery state belongs in worker receipts, never in committed history facts.
-- Deletes remain available for workspace/retention cleanup through existing FKs.
CREATE FUNCTION public.forge_committed_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Committed command events are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_committed_event_immutable BEFORE UPDATE ON public.command_outbox_events
FOR EACH ROW EXECUTE FUNCTION public.forge_committed_event_immutable();
--> statement-breakpoint
CREATE TRIGGER forge_committed_event_immutable BEFORE UPDATE ON public.command_audit_events
FOR EACH ROW EXECUTE FUNCTION public.forge_committed_event_immutable();
