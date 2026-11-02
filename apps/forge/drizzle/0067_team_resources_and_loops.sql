CREATE TABLE "loop_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "loop_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"loop_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loop_revisions_identity" UNIQUE("loop_id","revision")
);
--> statement-breakpoint
CREATE TABLE "loop_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"loop_id" uuid NOT NULL,
	"loop_revision" integer NOT NULL,
	"event_key" text NOT NULL,
	"event_hash" text NOT NULL,
	"event" jsonb NOT NULL,
	"fields" jsonb NOT NULL,
	"authorizer_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"thread_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"agent_run_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"pending_decision" jsonb,
	"result" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"lease_at" timestamp with time zone,
	CONSTRAINT "loop_runs_event_unique" UNIQUE("loop_id","event_key"),
	CONSTRAINT "loop_runs_agent_unique" UNIQUE("agent_run_id"),
	CONSTRAINT "loop_runs_state_check" CHECK ("loop_runs"."state" IN ('queued','running','waiting-for-approval','completed','failed','cancelled','blocked','uncertain'))
);
--> statement-breakpoint
CREATE TABLE "team_loops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"fields" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_by_id" text,
	"enabled_at" timestamp with time zone,
	"webhook_secret_hash" text,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "team_loops_workspace_identity" UNIQUE("workspace_id","id"),
	CONSTRAINT "team_loops_revision_check" CHECK ("team_loops"."revision">0),
	CONSTRAINT "team_loops_enabled_authorizer" CHECK (NOT "team_loops"."enabled" OR ("team_loops"."enabled_by_id" IS NOT NULL AND "team_loops"."enabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "team_resource_boards" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"fields" jsonb DEFAULT '{"sections":[],"links":[],"order":[]}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "loop_events" ADD CONSTRAINT "loop_events_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_events" ADD CONSTRAINT "loop_events_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_revisions" ADD CONSTRAINT "loop_revisions_loop_fk" FOREIGN KEY ("workspace_id","loop_id") REFERENCES "public"."team_loops"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_runs" ADD CONSTRAINT "loop_runs_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_runs" ADD CONSTRAINT "loop_runs_loop_fk" FOREIGN KEY ("workspace_id","loop_id") REFERENCES "public"."team_loops"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_loops" ADD CONSTRAINT "team_loops_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_loops" ADD CONSTRAINT "team_loops_enabled_by_id_user_id_fk" FOREIGN KEY ("enabled_by_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_loops" ADD CONSTRAINT "team_loops_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_resource_boards" ADD CONSTRAINT "team_resource_boards_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loop_events_pending_idx" ON "loop_events" USING btree ("created_at","id") WHERE "loop_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "loop_runs_queue_idx" ON "loop_runs" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "team_loops_team_idx" ON "team_loops" USING btree ("workspace_id","team_id");--> statement-breakpoint
CREATE INDEX "team_loops_schedule_idx" ON "team_loops" USING btree ("next_run_at") WHERE "team_loops"."enabled" AND "team_loops"."deleted_at" IS NULL;
--> statement-breakpoint
-- FOR-62 native event producers. Install after team_loops and loop_events.
-- Invoker rights are intentional: ordinary application transactions own the effect.
-- No auth/session/credential/provider tables are captured. Worker reads must reauthorize.
-- Creation is deferred until final relationships exist. Updates retain actual OLD/NEW
-- snapshots; independent changes in one transaction may produce multiple update events.
CREATE OR REPLACE FUNCTION forge_loop_snapshot(p_entity text, p_id uuid, p_workspace text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  CASE p_entity
  WHEN 'issue' THEN
    SELECT to_jsonb(i) || jsonb_build_object(
      'teamIds', jsonb_build_array(i.team_id),
      'labelIds', COALESCE((SELECT jsonb_agg(l.label_id ORDER BY l.label_id)
        FROM issue_labels l WHERE l.workspace_id=p_workspace AND l.issue_id=i.id), '[]'::jsonb))
      INTO result FROM issues i WHERE i.workspace_id=p_workspace AND i.id=p_id;
  WHEN 'project' THEN
    SELECT to_jsonb(p) || jsonb_build_object('teamIds',
      COALESCE((SELECT jsonb_agg(t.team_id ORDER BY t.team_id) FROM project_teams t
        WHERE t.workspace_id=p_workspace AND t.project_id=p.id), '[]'::jsonb))
      INTO result FROM projects p WHERE p.workspace_id=p_workspace AND p.id=p_id;
  WHEN 'initiative' THEN
    SELECT to_jsonb(i) || jsonb_build_object(
      'projectIds', COALESCE((SELECT jsonb_agg(p.project_id ORDER BY p.project_id)
        FROM initiative_projects p WHERE p.workspace_id=p_workspace AND p.initiative_id=i.id), '[]'::jsonb),
      'teamIds', COALESCE((SELECT jsonb_agg(x.team_id ORDER BY x.team_id) FROM
        (SELECT DISTINCT t.team_id FROM initiative_projects p JOIN project_teams t
          ON t.workspace_id=p.workspace_id AND t.project_id=p.project_id
          WHERE p.workspace_id=p_workspace AND p.initiative_id=i.id) x), '[]'::jsonb))
      INTO result FROM initiatives i WHERE i.workspace_id=p_workspace AND i.id=p_id;
  WHEN 'cycle' THEN
    SELECT to_jsonb(c) || jsonb_build_object('teamIds', jsonb_build_array(c.team_id))
      INTO result FROM issue_cycles c WHERE c.workspace_id=p_workspace AND c.id=p_id;
  WHEN 'team' THEN
    SELECT to_jsonb(t) || jsonb_build_object('teamIds', jsonb_build_array(t.id),
      'members', COALESCE((SELECT jsonb_agg(m.user_id ORDER BY m.user_id) FROM team_members m
        WHERE m.workspace_id=p_workspace AND m.team_id=t.id), '[]'::jsonb))
      INTO result FROM teams t WHERE t.workspace_id=p_workspace AND t.id=p_id;
  ELSE RAISE EXCEPTION 'Unsupported Loop event entity %', p_entity;
  END CASE;
  RETURN result;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_emit(
  p_entity text, p_id uuid, p_workspace text, p_event text, p_before jsonb, p_after jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE audience uuid;
BEGIN
  IF nullif(current_setting('forge.loop_run_id', true), '') IS NOT NULL
    OR p_after IS NULL OR p_before IS NOT DISTINCT FROM p_after THEN RETURN; END IF;
  FOR audience IN
    SELECT DISTINCT value::uuid FROM (
      SELECT jsonb_array_elements_text(COALESCE(p_before->'teamIds', '[]'::jsonb)) value
      UNION SELECT jsonb_array_elements_text(COALESCE(p_after->'teamIds', '[]'::jsonb)) value
    ) teams_with_change
  LOOP
    IF EXISTS(SELECT 1 FROM team_loops l WHERE l.workspace_id=p_workspace
      AND l.enabled AND l.deleted_at IS NULL AND (l.team_id=audience OR
        (l.fields->>'teamAccess'='all-public-teams' AND EXISTS(SELECT 1 FROM teams source_team
          WHERE source_team.id=audience AND source_team.workspace_id=p_workspace
            AND source_team.visibility='workspace' AND source_team.deleted_at IS NULL)))) THEN
      INSERT INTO loop_events(workspace_id, team_id, entity, entity_id, event, before, after)
        VALUES(p_workspace, audience, p_entity, p_id, p_event, p_before, p_after);
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_was_created(p_entity text, p_id uuid)
RETURNS boolean LANGUAGE sql AS $$
  SELECT COALESCE(current_setting('forge.loop_created_' || p_entity || '_' || replace(p_id::text, '-', ''), true), '')='1';
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_mark_created()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Transaction-local bookkeeping only; this marker never grants authority.
  PERFORM set_config('forge.loop_created_' || TG_ARGV[0] || '_' || replace(NEW.id::text, '-', ''), '1', true);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_parent_created()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb;
BEGIN
  snapshot := forge_loop_snapshot(TG_ARGV[0], NEW.id, NEW.workspace_id);
  PERFORM forge_loop_emit(TG_ARGV[0], NEW.id, NEW.workspace_id, 'created', NULL, snapshot);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_parent_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb; previous jsonb; relation_key text;
BEGIN
  IF forge_loop_was_created(TG_ARGV[0], NEW.id) THEN RETURN NEW; END IF;
  snapshot := forge_loop_snapshot(TG_ARGV[0], NEW.id, NEW.workspace_id);
  previous := to_jsonb(OLD);
  FOREACH relation_key IN ARRAY ARRAY['teamIds','projectIds','labelIds','members'] LOOP
    IF snapshot ? relation_key THEN
      previous := previous || jsonb_build_object(relation_key, snapshot->relation_key);
    END IF;
  END LOOP;
  IF TG_ARGV[0] IN ('issue','cycle') THEN
    previous:=jsonb_set(previous, ARRAY['teamIds'], jsonb_build_array(OLD.team_id));
  END IF;
  PERFORM forge_loop_emit(TG_ARGV[0], NEW.id, NEW.workspace_id, 'updated', previous, snapshot);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_previous_collection(p_after jsonb, p_value text, p_added boolean)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb) FROM (
    SELECT DISTINCT value FROM jsonb_array_elements_text(COALESCE(p_after, '[]'::jsonb))
      WHERE NOT p_added OR value <> p_value
    UNION SELECT p_value WHERE NOT p_added
  ) previous_values;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_initiative_team_ids(p_workspace text, p_projects jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT COALESCE(jsonb_agg(team_id ORDER BY team_id), '[]'::jsonb) FROM (
    SELECT DISTINCT t.team_id FROM project_teams t
      WHERE t.workspace_id=p_workspace AND t.project_id IN
        (SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(p_projects, '[]'::jsonb)))
  ) scoped_teams;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_relationship_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; domain text; domain_id uuid; collection_key text; changed_value text;
  snapshot jsonb; previous jsonb; linked record; initiative_after jsonb; initiative_before jsonb;
  old_teams jsonb; affected_workspace text; was_added boolean;
BEGIN
  IF TG_OP='INSERT' THEN r:=to_jsonb(NEW); ELSE r:=to_jsonb(OLD); END IF;
  affected_workspace:=r->>'workspace_id'; was_added:=TG_OP='INSERT';
  CASE TG_TABLE_NAME
  WHEN 'team_members' THEN domain:='team'; domain_id:=(r->>'team_id')::uuid;
    collection_key:='members'; changed_value:=r->>'user_id';
  WHEN 'issue_labels' THEN domain:='issue'; domain_id:=(r->>'issue_id')::uuid;
    collection_key:='labelIds'; changed_value:=r->>'label_id';
  WHEN 'project_teams' THEN domain:='project'; domain_id:=(r->>'project_id')::uuid;
    collection_key:='teamIds'; changed_value:=r->>'team_id';
  WHEN 'initiative_projects' THEN domain:='initiative'; domain_id:=(r->>'initiative_id')::uuid;
    collection_key:='projectIds'; changed_value:=r->>'project_id';
  ELSE RAISE EXCEPTION 'Unsupported Loop relationship %', TG_TABLE_NAME;
  END CASE;
  IF forge_loop_was_created(domain, domain_id) THEN RETURN NULL; END IF;
  snapshot:=forge_loop_snapshot(domain, domain_id, affected_workspace);
  IF snapshot IS NULL THEN RETURN NULL; END IF;
  previous:=jsonb_set(snapshot, ARRAY[collection_key],
    forge_loop_previous_collection(snapshot->collection_key, changed_value, was_added));
  IF domain='initiative' THEN previous:=jsonb_set(previous, ARRAY['teamIds'],
    forge_loop_initiative_team_ids(affected_workspace, previous->'projectIds')); END IF;
  PERFORM forge_loop_emit(domain, domain_id, affected_workspace, 'updated', previous, snapshot);

  -- A project's team changes also change the audience of linked initiatives.
  IF domain='project' THEN
    old_teams:=previous->'teamIds';
    FOR linked IN SELECT p.initiative_id FROM initiative_projects p
      WHERE p.workspace_id=affected_workspace AND p.project_id=domain_id
    LOOP
      IF forge_loop_was_created('initiative', linked.initiative_id) THEN CONTINUE; END IF;
      initiative_after:=forge_loop_snapshot('initiative', linked.initiative_id, affected_workspace);
      SELECT jsonb_set(initiative_after, ARRAY['teamIds'],
        COALESCE(jsonb_agg(team_id ORDER BY team_id), '[]'::jsonb)) INTO initiative_before FROM (
          SELECT DISTINCT t.team_id FROM initiative_projects p JOIN project_teams t
            ON t.workspace_id=p.workspace_id AND t.project_id=p.project_id
            WHERE p.workspace_id=affected_workspace AND p.initiative_id=linked.initiative_id
              AND p.project_id<>domain_id
          UNION SELECT value::uuid FROM jsonb_array_elements_text(old_teams)
        ) prior_teams;
      PERFORM forge_loop_emit('initiative', linked.initiative_id, affected_workspace,
        'updated', initiative_before, initiative_after);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('issues','issue'), ('projects','project'), ('initiatives','initiative'),
    ('issue_cycles','cycle'), ('teams','team')
  ) AS native_tables(table_name, entity_name)
  LOOP
    EXECUTE format('CREATE TRIGGER forge_loop_mark_created AFTER INSERT ON %I FOR EACH ROW EXECUTE FUNCTION forge_loop_mark_created(%L)', item.table_name, item.entity_name);
    EXECUTE format('CREATE CONSTRAINT TRIGGER forge_loop_created AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION forge_loop_parent_created(%L)', item.table_name, item.entity_name);
    EXECUTE format('CREATE TRIGGER forge_loop_updated AFTER UPDATE ON %I FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION forge_loop_parent_updated(%L)', item.table_name, item.entity_name);
  END LOOP;
  FOR item IN SELECT table_name FROM (VALUES
    ('team_members'), ('issue_labels'), ('project_teams'), ('initiative_projects')
  ) AS relationships(table_name)
  LOOP
    EXECUTE format('CREATE TRIGGER forge_loop_relationship AFTER INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_loop_relationship_changed()', item.table_name);
  END LOOP;
END;
$$;
