ALTER TABLE "initiatives" ADD COLUMN "number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
WITH numbered AS (SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY id)::integer n FROM initiatives)
UPDATE initiatives SET number = numbered.n FROM numbered WHERE numbered.id = initiatives.id;
--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_workspace_number_unique" UNIQUE("workspace_id","number");
--> statement-breakpoint
CREATE FUNCTION advance_initiative_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END;
$$;
--> statement-breakpoint
CREATE TRIGGER initiatives_revision BEFORE UPDATE ON initiatives FOR EACH ROW EXECUTE FUNCTION advance_initiative_revision();
--> statement-breakpoint
CREATE FUNCTION advance_initiative_project_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN UPDATE initiatives SET revision = revision WHERE id = OLD.initiative_id; END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP = 'INSERT' OR NEW.initiative_id <> OLD.initiative_id) THEN
    UPDATE initiatives SET revision = revision WHERE id = NEW.initiative_id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER initiative_projects_revision AFTER INSERT OR UPDATE OR DELETE ON initiative_projects FOR EACH ROW EXECUTE FUNCTION advance_initiative_project_revision();
