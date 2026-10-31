ALTER TABLE "projects" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION advance_project_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_revision BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION advance_project_revision();
--> statement-breakpoint
CREATE FUNCTION advance_project_team_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE projects SET revision = revision WHERE id = OLD.project_id; END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.project_id <> OLD.project_id) THEN
    UPDATE projects SET revision = revision WHERE id = NEW.project_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_teams_revision AFTER INSERT OR UPDATE OR DELETE ON project_teams FOR EACH ROW EXECUTE FUNCTION advance_project_team_revision();
