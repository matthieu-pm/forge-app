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
-- FOR-62: source-owned Loop copies follow the canonical issue purge boundary.
-- These are invoker-rights fences, shared by ordinary application callbacks and
-- restored databases. Source identities remain after scrubbing; Loop config is
-- independently authored and is intentionally retained.
CREATE OR REPLACE FUNCTION forge_loop_issue_unavailable(
  p_workspace text, p_entity text, p_id text, p_include_deleted boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE unavailable boolean;
BEGIN
  IF p_entity IS DISTINCT FROM 'issue' OR p_id IS NULL THEN RETURN false; END IF;
  SELECT (i.purge_started_at IS NOT NULL OR i.purged_at IS NOT NULL
    OR (p_include_deleted AND i.deleted_at IS NOT NULL)) INTO unavailable
    FROM issues i WHERE i.workspace_id=p_workspace AND i.id::text=p_id FOR SHARE;
  RETURN COALESCE(unavailable, false);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_agent_source_purged(p_agent_run uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
  IF EXISTS(SELECT 1 FROM agent_runs a WHERE a.id=p_agent_run AND a.error_code='SOURCE_PURGED') THEN RETURN true; END IF;
  SELECT r.workspace_id, r.event, r.error_code INTO source FROM loop_runs r
    WHERE r.agent_run_id=p_agent_run;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN COALESCE(source.error_code='SOURCE_PURGED',false) OR forge_loop_issue_unavailable(
    source.workspace_id, source.event->>'entity', source.event->>'entityId', false);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_run_source_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.error_code='SOURCE_PURGED' OR forge_loop_issue_unavailable(
    OLD.workspace_id, OLD.event->>'entity', OLD.event->>'entityId', false)) THEN source:=OLD.event;
  ELSIF forge_loop_issue_unavailable(NEW.workspace_id, NEW.event->>'entity', NEW.event->>'entityId', false) THEN source:=NEW.event;
  END IF;
  IF source IS NOT NULL THEN
    NEW.event:=jsonb_build_object('entity','issue','entityId',source->>'entityId');
    NEW.state:='cancelled'; NEW.error_code:='SOURCE_PURGED'; NEW.result:=NULL;
    NEW.pending_decision:=NULL; NEW.lease_at:=NULL;
    NEW.finished_at:=COALESCE(NEW.finished_at,clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_run_source_fence BEFORE INSERT OR UPDATE ON loop_runs
FOR EACH ROW EXECUTE FUNCTION forge_loop_run_source_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_event_source_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND forge_loop_issue_unavailable(OLD.workspace_id,OLD.entity,OLD.entity_id::text,false) THEN RETURN NULL; END IF;
  IF forge_loop_issue_unavailable(NEW.workspace_id,NEW.entity,NEW.entity_id::text,TG_OP='INSERT') THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_event_source_fence BEFORE INSERT OR UPDATE ON loop_events
FOR EACH ROW EXECUTE FUNCTION forge_loop_event_source_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_agent_event_source_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF forge_loop_agent_source_purged(NEW.run_id) OR
    (TG_OP='UPDATE' AND forge_loop_agent_source_purged(OLD.run_id)) THEN NEW.payload_json:='{}'::jsonb; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_agent_event_source_fence BEFORE INSERT OR UPDATE ON agent_events
FOR EACH ROW EXECUTE FUNCTION forge_loop_agent_event_source_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_approval_source_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF forge_loop_agent_source_purged(NEW.run_id) OR
    (TG_OP='UPDATE' AND forge_loop_agent_source_purged(OLD.run_id)) THEN
    NEW.redacted_input_summary:='{}'::jsonb;
    IF NEW.state IN ('pending','approved') THEN NEW.state:='expired'; NEW.resolved_at:=COALESCE(NEW.resolved_at,clock_timestamp()); END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_approval_source_fence BEFORE INSERT OR UPDATE ON agent_approvals
FOR EACH ROW EXECUTE FUNCTION forge_loop_approval_source_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_agent_run_source_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF forge_loop_agent_source_purged(NEW.id) OR (TG_OP='UPDATE' AND OLD.error_code='SOURCE_PURGED') THEN
    NEW.state:='cancelled'; NEW.error_code:='SOURCE_PURGED'; NEW.completed_at:=COALESCE(NEW.completed_at,clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_agent_run_source_fence BEFORE INSERT OR UPDATE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION forge_loop_agent_run_source_fence();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_loop_artifact_source_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF forge_loop_agent_source_purged(NEW.run_id) OR
    (TG_OP='UPDATE' AND forge_loop_agent_source_purged(OLD.run_id)) THEN
    IF TG_OP='UPDATE' AND NEW.deleted_at IS NOT NULL AND (to_jsonb(NEW)-'deleted_at')=(to_jsonb(OLD)-'deleted_at') THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'SOURCE_PURGED' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_artifact_source_fence BEFORE INSERT OR UPDATE ON agent_artifacts
FOR EACH ROW EXECUTE FUNCTION forge_loop_artifact_source_fence();
--> statement-breakpoint
-- Replace the canonical producer so a soft-delete, purge claim or final scrub
-- cannot enqueue another snapshot containing the deleted issue's OLD content.
CREATE OR REPLACE FUNCTION forge_loop_emit(
  p_entity text, p_id uuid, p_workspace text, p_event text, p_before jsonb, p_after jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE audience uuid;
BEGIN
  IF nullif(current_setting('forge.loop_run_id', true), '') IS NOT NULL
    OR p_after IS NULL OR p_before IS NOT DISTINCT FROM p_after THEN RETURN; END IF;
  IF p_entity='issue' AND NOT EXISTS(SELECT 1 FROM issues i WHERE i.id=p_id AND i.workspace_id=p_workspace
    AND i.deleted_at IS NULL AND i.purge_started_at IS NULL AND i.purged_at IS NULL) THEN RETURN; END IF;
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
CREATE OR REPLACE FUNCTION forge_loop_parent_updated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb; previous jsonb; relation_key text;
BEGIN
  IF forge_loop_was_created(TG_ARGV[0], NEW.id) THEN RETURN NEW; END IF;
  IF TG_ARGV[0]='issue' THEN
    IF NEW.deleted_at IS NOT NULL OR NEW.purge_started_at IS NOT NULL OR NEW.purged_at IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  snapshot := forge_loop_snapshot(TG_ARGV[0], NEW.id, NEW.workspace_id);
  previous := to_jsonb(OLD);
  FOREACH relation_key IN ARRAY ARRAY['teamIds','projectIds','labelIds','members'] LOOP
    IF snapshot ? relation_key THEN previous := previous || jsonb_build_object(relation_key, snapshot->relation_key); END IF;
  END LOOP;
  IF TG_ARGV[0] IN ('issue','cycle') THEN previous:=jsonb_set(previous, ARRAY['teamIds'], jsonb_build_array(OLD.team_id)); END IF;
  PERFORM forge_loop_emit(TG_ARGV[0], NEW.id, NEW.workspace_id, 'updated', previous, snapshot);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The reserved non-login principal is not a human account. Defer until workspace
-- cascades have removed its threads/runs/model rows; retain it if still referenced.
CREATE OR REPLACE FUNCTION forge_loop_cleanup_principal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    DELETE FROM "user" u WHERE u.id='forge-loop:'||OLD.id::text
      AND u.email='loop-'||OLD.id::text||'@automation.invalid'
      AND NOT EXISTS(SELECT 1 FROM account a WHERE a.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM session s WHERE s.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM member m WHERE m.user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM agent_threads t WHERE t.created_by_user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.initiated_by_user_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM model_connections c WHERE c.created_by_user_id=u.id OR c.user_id=u.id);
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER forge_loop_cleanup_principal AFTER DELETE ON team_loops
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION forge_loop_cleanup_principal();

--> statement-breakpoint
-- Reservations are committed before any bytes are put; publication retires the
-- same reservation atomically with artifact metadata. A failed delete retains
-- the reference for the next bounded cleanup pass.
CREATE OR REPLACE FUNCTION forge_loop_artifact_intent_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
  SELECT r.workspace_id,r.agent_run_id,r.event,r.error_code,r.state INTO source
    FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id
    WHERE r.id=NEW.loop_run_id AND l.enabled AND l.deleted_at IS NULL;
  IF NOT FOUND OR source.workspace_id<>NEW.workspace_id OR source.agent_run_id<>NEW.agent_run_id
    OR source.error_code='SOURCE_PURGED' OR source.state NOT IN ('running','waiting-for-approval') THEN
    RAISE EXCEPTION 'SOURCE_UNAVAILABLE' USING ERRCODE='check_violation';
  END IF;
  IF source.event->>'entity'='issue' THEN
    PERFORM id FROM issues WHERE workspace_id=source.workspace_id AND id::text=source.event->>'entityId'
      AND deleted_at IS NULL AND purge_started_at IS NULL AND purged_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_UNAVAILABLE' USING ERRCODE='check_violation'; END IF;
  END IF;
  PERFORM r.id FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id
    WHERE r.id=NEW.loop_run_id AND r.workspace_id=NEW.workspace_id AND r.agent_run_id=NEW.agent_run_id
      AND r.event IS NOT DISTINCT FROM source.event AND r.state IN ('running','waiting-for-approval')
      AND l.enabled AND l.deleted_at IS NULL FOR SHARE OF r,l;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_UNAVAILABLE' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_artifact_intent_fence BEFORE INSERT OR UPDATE ON loop_artifact_intents
FOR EACH ROW EXECUTE FUNCTION forge_loop_artifact_intent_fence();
