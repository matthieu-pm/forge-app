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
