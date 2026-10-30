ALTER TABLE "issues" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION public.forge_increment_issue_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.revision:=OLD.revision+1;
 NEW.updated_at:=clock_timestamp();
 IF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
  NEW.properties:=jsonb_set(NEW.properties,'{statusChangedAt}',to_jsonb(NEW.updated_at),true);
  NEW.properties:=jsonb_set(NEW.properties,'{completedAt}',CASE WHEN EXISTS(SELECT 1 FROM issue_statuses WHERE workspace_id=NEW.workspace_id AND team_id=NEW.team_id AND id=NEW.status_id AND status_group='completed') THEN to_jsonb(NEW.updated_at) ELSE 'null'::jsonb END,true);
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_increment_issue_revision BEFORE UPDATE ON public.issues FOR EACH ROW EXECUTE FUNCTION public.forge_increment_issue_revision();
