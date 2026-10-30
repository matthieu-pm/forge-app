ALTER TABLE "issues" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "purge_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "purge_token" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "purge_error" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.forge_track_workspace_issue_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='organization' THEN
  INSERT INTO public.workspace_issue_capacity(workspace_id) VALUES(NEW.id); RETURN NEW;
 ELSIF TG_OP='DELETE' THEN
  IF (OLD.archived_at IS NULL AND OLD.deleted_at IS NULL) AND EXISTS(SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
   PERFORM public.forge_adjust_workspace_issue_capacity(OLD.workspace_id,-1);
  END IF; RETURN OLD;
 ELSIF TG_OP='INSERT' THEN
  IF (NEW.archived_at IS NULL AND NEW.deleted_at IS NULL) THEN PERFORM public.forge_adjust_workspace_issue_capacity(NEW.workspace_id,1); END IF;
 ELSE
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
   PERFORM id FROM public.organization WHERE id IN(OLD.workspace_id,NEW.workspace_id) ORDER BY id FOR NO KEY UPDATE;
  END IF;
  IF (OLD.archived_at IS NULL AND OLD.deleted_at IS NULL) AND ((NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL) OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
   PERFORM public.forge_adjust_workspace_issue_capacity(OLD.workspace_id,-1);
  END IF;
  IF (NEW.archived_at IS NULL AND NEW.deleted_at IS NULL) AND ((OLD.archived_at IS NOT NULL OR OLD.deleted_at IS NOT NULL) OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
   PERFORM public.forge_adjust_workspace_issue_capacity(NEW.workspace_id,1);
  END IF;
 END IF; RETURN NEW;
END $$;

--> statement-breakpoint
CREATE INDEX issues_purge_due_idx ON public.issues(deleted_at,id) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION public.forge_issue_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND
  (OLD.purge_started_at IS NOT NULL OR OLD.deleted_at + interval '30 days' <= clock_timestamp()) THEN
  RAISE EXCEPTION 'The issue recovery period has ended.' USING ERRCODE='23514',CONSTRAINT='issue_recovery_expired';
 END IF;
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
  RAISE EXCEPTION 'The deletion deadline cannot be renewed.';
 END IF;
 IF OLD.purged_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.purged_at IS DISTINCT FROM OLD.purged_at OR NEW.title<>'' OR NEW.properties<>'{}'::jsonb) THEN
  RAISE EXCEPTION 'Purged issues cannot be recreated.';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_issue_lifecycle_guard BEFORE UPDATE ON public.issues FOR EACH ROW EXECUTE FUNCTION public.forge_issue_lifecycle_guard();
