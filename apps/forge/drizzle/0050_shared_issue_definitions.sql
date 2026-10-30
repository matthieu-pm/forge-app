CREATE TABLE "issue_definition_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid,
	"scope_key" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "issue_definition_scopes_key" UNIQUE("workspace_id","scope_key"),
	CONSTRAINT "issue_definition_scopes_revision" CHECK ("issue_definition_scopes"."revision" >= 0),
	CONSTRAINT "issue_definition_scopes_identity" CHECK ("issue_definition_scopes"."scope_key" = coalesce("issue_definition_scopes"."team_id"::text, 'workspace'))
);
--> statement-breakpoint
CREATE TABLE "issue_statuses" (
	"row_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status_group" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "issue_statuses_identity" UNIQUE("workspace_id","team_id","id"),
	CONSTRAINT "issue_statuses_group" CHECK ("issue_statuses"."status_group" IN ('backlog','unstarted','started','completed','canceled','duplicate')),
	CONSTRAINT "issue_statuses_color" CHECK ("issue_statuses"."color" ~ '^#[0-9a-fA-F]{6}$'),
	CONSTRAINT "issue_statuses_name" CHECK (length(trim("issue_statuses"."name")) BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "issue_labels" DROP CONSTRAINT "issue_labels_label_fk";
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "status_id" text DEFAULT 'backlog' NOT NULL;--> statement-breakpoint
ALTER TABLE "resource_labels" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "issue_definition_scopes" ADD CONSTRAINT "issue_definition_scopes_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_definition_scopes" ADD CONSTRAINT "issue_definition_scopes_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_statuses" ADD CONSTRAINT "issue_statuses_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_statuses" ADD CONSTRAINT "issue_statuses_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_statuses_name_unique" ON "issue_statuses" USING btree ("team_id",lower("name"));--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "public"."resource_labels"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Seed canonical defaults for existing and future teams, without importing browser data.
CREATE FUNCTION forge_seed_issue_statuses() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO issue_statuses(workspace_id,team_id,id,name,status_group,description,color,position)
  SELECT NEW.workspace_id,NEW.id,v.* FROM (VALUES
    ('backlog','Backlog','backlog','','#bec2c8',0),
    ('todo','Todo','unstarted','','#bec2c8',1),
    ('in-progress','In Progress','started','','#f2c400',2),
    ('in-review','In Review','started','Pull request is being reviewed','#4cb782',3),
    ('done','Done','completed','','#5e6ad2',4),
    ('canceled','Canceled','canceled','','#95a2b3',5),
    ('duplicate','Duplicate','duplicate','','#95a2b3',6)
  ) v(id,name,status_group,description,color,position);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_seed_issue_statuses AFTER INSERT ON teams FOR EACH ROW EXECUTE FUNCTION forge_seed_issue_statuses();
--> statement-breakpoint
INSERT INTO issue_statuses(workspace_id,team_id,id,name,status_group,description,color,position)
SELECT t.workspace_id,t.id,v.* FROM teams t CROSS JOIN (VALUES
    ('backlog','Backlog','backlog','','#bec2c8',0),
    ('todo','Todo','unstarted','','#bec2c8',1),
    ('in-progress','In Progress','started','','#f2c400',2),
    ('in-review','In Review','started','Pull request is being reviewed','#4cb782',3),
    ('done','Done','completed','','#5e6ad2',4),
    ('canceled','Canceled','canceled','','#95a2b3',5),
    ('duplicate','Duplicate','duplicate','','#95a2b3',6)
) v(id,name,status_group,description,color,position);
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_status_fk" FOREIGN KEY ("workspace_id","team_id","status_id") REFERENCES "public"."issue_statuses"("workspace_id","team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION forge_check_issue_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE config jsonb;
BEGIN
  IF OLD.team_id = NEW.team_id AND OLD.status_id <> NEW.status_id AND coalesce(current_setting('forge.definition_migration',true),'') <> 'true' THEN
    SELECT value INTO config FROM issue_definition_scopes WHERE workspace_id=NEW.workspace_id AND team_id=NEW.team_id FOR SHARE;
    IF config->'transitions' ? OLD.status_id AND NOT (config->'transitions'->OLD.status_id ? NEW.status_id) THEN
      RAISE EXCEPTION 'This status transition is not allowed by the team workflow.' USING ERRCODE='23514', CONSTRAINT='issues_allowed_transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_check_issue_transition BEFORE UPDATE OF status_id,team_id ON issues FOR EACH ROW EXECUTE FUNCTION forge_check_issue_transition();

--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_statuses FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('row_id','workspace_id','team_id','id');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_definition_scopes FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','team_id','scope_key');
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON issue_statuses FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event();
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON issue_definition_scopes FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event();
--> statement-breakpoint
-- JSON template references predate the canonical issue model. Serialize their
-- writes with definition edits and validate each issue property against the
-- current team catalog; project-template root properties retain their own model.
CREATE FUNCTION public.forge_validate_template_issue_definitions() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE property jsonb; team_key text; label_key text; label_row public.resource_labels%ROWTYPE; previous jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id,4040));
  previous:=CASE WHEN TG_OP='UPDATE' THEN OLD.payload ELSE '{}'::jsonb END;
  FOR property IN
    SELECT NEW.payload->'properties' WHERE NEW.payload->>'kind' IS DISTINCT FROM 'project'
    UNION ALL SELECT item->'properties' FROM jsonb_array_elements(coalesce(NEW.payload->'issues','[]'::jsonb)) item
    UNION ALL SELECT item->'properties' FROM jsonb_array_elements(coalesce(NEW.payload->'subIssues','[]'::jsonb)) item
  LOOP
    team_key:=coalesce(nullif(property->'teamIds'->>0,''),NEW.team_id::text);
    IF team_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.issue_statuses s WHERE s.workspace_id=NEW.workspace_id AND s.team_id::text=team_key AND (s.id=property->>'status' OR s.name=property->>'status')) THEN
      RAISE EXCEPTION 'Choose a status from this team workflow.' USING ERRCODE='23514',CONSTRAINT='template_issue_status_definition';
    END IF;
    FOR label_key IN SELECT jsonb_array_elements_text(coalesce(property->'labels','[]'::jsonb)) LOOP
      SELECT * INTO label_row FROM public.resource_labels l WHERE l.workspace_id=NEW.workspace_id AND l.id::text=label_key AND (l.team_id IS NULL OR l.team_id::text=team_key);
      IF NOT FOUND OR (coalesce((label_row.definition->>'archived')::boolean,false) AND NOT jsonb_path_exists(previous,'$.**.labels[*] ? (@ == $id)',jsonb_build_object('id',label_key))) THEN
        RAISE EXCEPTION 'Choose active labels available to this team.' USING ERRCODE='23514',CONSTRAINT='template_issue_label_definition';
      END IF;
    END LOOP;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_validate_template_issue_definitions BEFORE INSERT OR UPDATE OF payload ON team_templates FOR EACH ROW EXECUTE FUNCTION public.forge_validate_template_issue_definitions();
--> statement-breakpoint
CREATE TRIGGER forge_validate_template_issue_definitions BEFORE INSERT OR UPDATE OF payload ON team_recurring_issues FOR EACH ROW EXECUTE FUNCTION public.forge_validate_template_issue_definitions();
