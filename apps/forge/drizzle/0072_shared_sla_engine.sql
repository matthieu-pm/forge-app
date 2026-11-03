CREATE TABLE "issue_sla_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"changes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "issue_sla_event_once" UNIQUE("commitment_id","kind"),
	CONSTRAINT "issue_sla_event_kind" CHECK ("issue_sla_events"."kind" IN ('applied','removed','breached'))
);
--> statement-breakpoint
CREATE TABLE "issue_sla_intents" (
	"commitment_id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_sla_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commitment_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "issue_sla_window_order" CHECK ("issue_sla_windows"."closed_at" IS NULL OR "issue_sla_windows"."closed_at">="issue_sla_windows"."opened_at")
);
--> statement-breakpoint
CREATE TABLE "issue_slas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"rule_id" uuid NOT NULL,
	"policy_revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"anchor_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"high_risk_at" timestamp with time zone NOT NULL,
	"moderate_risk_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"current" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"owed_at" timestamp with time zone,
	"classified_through" timestamp with time zone,
	"gate_identity" text NOT NULL,
	"gate_uncertain" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "issue_sla_tenant_identity" UNIQUE("workspace_id","issue_id","id"),
	CONSTRAINT "issue_sla_generation" UNIQUE("issue_id","generation"),
	CONSTRAINT "issue_sla_state" CHECK ("issue_slas"."state" IN ('running','completed','canceled','removed','superseded')),
	CONSTRAINT "issue_sla_generation_positive" CHECK ("issue_slas"."generation">0 AND "issue_slas"."policy_revision">0)
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"values" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "sla_policy_revision" CHECK ("sla_policies"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "sla_policy_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "sla_policy_period_order" CHECK ("sla_policy_periods"."closed_at" IS NULL OR "sla_policy_periods"."closed_at">="sla_policy_periods"."opened_at")
);
--> statement-breakpoint
ALTER TABLE "issue_sla_events" ADD CONSTRAINT "issue_sla_events_workspace_id_issue_id_commitment_id_issue_slas_workspace_id_issue_id_id_fk" FOREIGN KEY ("workspace_id","issue_id","commitment_id") REFERENCES "public"."issue_slas"("workspace_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sla_intents" ADD CONSTRAINT "issue_sla_intents_commitment_id_issue_slas_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."issue_slas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sla_windows" ADD CONSTRAINT "issue_sla_windows_commitment_id_issue_slas_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."issue_slas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_slas" ADD CONSTRAINT "issue_slas_workspace_id_issue_id_issues_workspace_id_id_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policy_periods" ADD CONSTRAINT "sla_policy_periods_workspace_id_sla_policies_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."sla_policies"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_sla_history" ON "issue_sla_events" USING btree ("workspace_id","issue_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_sla_one_open_window" ON "issue_sla_windows" USING btree ("commitment_id") WHERE "issue_sla_windows"."closed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "issue_sla_window_commitment" ON "issue_sla_windows" USING btree ("commitment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_sla_one_current" ON "issue_slas" USING btree ("issue_id") WHERE "issue_slas"."current";--> statement-breakpoint
CREATE INDEX "issue_sla_workspace_due" ON "issue_slas" USING btree ("workspace_id","deadline_at");--> statement-breakpoint
CREATE INDEX "sla_policy_period_workspace" ON "sla_policy_periods" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_policy_one_open_period" ON "sla_policy_periods" USING btree ("workspace_id") WHERE "sla_policy_periods"."closed_at" IS NULL;
--> statement-breakpoint
-- All functions use invoker rights. Only authenticated application commands or
-- the fenced worker supply transaction-local gate context; no request flags do.
CREATE FUNCTION forge_sla_local(p_wall timestamp, p_zone text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE normal timestamptz; candidate timestamptz; resolved timestamptz; shift interval; best interval;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=p_zone) THEN RAISE EXCEPTION 'Invalid SLA timezone'; END IF;
  normal:=p_wall AT TIME ZONE p_zone;
  FOR shift IN SELECT DISTINCT ((t AT TIME ZONE p_zone)-(t AT TIME ZONE 'UTC')) FROM unnest(ARRAY[normal-interval '2 days',normal,normal+interval '2 days']) t LOOP
    candidate:=(p_wall-shift) AT TIME ZONE 'UTC';
    IF candidate AT TIME ZONE p_zone=p_wall AND (resolved IS NULL OR candidate<resolved) THEN resolved:=candidate; END IF;
  END LOOP;
  IF resolved IS NOT NULL THEN RETURN resolved; END IF;
  -- In a gap, select the offset that moves wall time forward by the gap.
  FOR shift IN SELECT DISTINCT ((t AT TIME ZONE p_zone)-(t AT TIME ZONE 'UTC')) FROM unnest(ARRAY[normal-interval '2 days',normal,normal+interval '2 days']) t LOOP
    candidate:=(p_wall-shift) AT TIME ZONE 'UTC';
    IF (candidate AT TIME ZONE p_zone)>p_wall AND (best IS NULL OR (candidate AT TIME ZONE p_zone)-p_wall<best) THEN
      best:=(candidate AT TIME ZONE p_zone)-p_wall; resolved:=candidate;
    END IF;
  END LOOP;
  RETURN coalesce(resolved,normal);
END $$;
--> statement-breakpoint
CREATE FUNCTION forge_sla_shift(p_anchor timestamptz, p_count integer, p_unit text, p_week text, p_zone text) RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE wall timestamp; day date; remaining integer:=abs(p_count); direction integer:=sign(p_count); working integer[];
BEGIN
  IF p_unit='hour' THEN RETURN p_anchor+p_count*interval '1 hour'; END IF;
  IF p_unit='day' THEN RETURN p_anchor+p_count*interval '24 hours'; END IF;
  IF p_unit='week' THEN RETURN p_anchor+p_count*interval '168 hours'; END IF;
  IF p_unit<>'business-day' OR p_week NOT IN ('mon-fri','sun-thu') OR remaining>365 THEN RAISE EXCEPTION 'Invalid SLA duration'; END IF;
  IF p_count=0 THEN RETURN p_anchor; END IF;
  working:=CASE p_week WHEN 'mon-fri' THEN ARRAY[1,2,3,4,5] ELSE ARRAY[0,1,2,3,4] END;
  wall:=p_anchor AT TIME ZONE p_zone; day:=wall::date;
  WHILE remaining>0 LOOP
    day:=day+direction;
    IF extract(dow FROM day)::integer=ANY(working) THEN remaining:=remaining-1; END IF;
  END LOOP;
  RETURN forge_sla_local(day+wall::time,p_zone);
END $$;
--> statement-breakpoint
CREATE FUNCTION forge_sla_policy_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE at_time timestamptz:=clock_timestamp(); cfg jsonb:=NEW.values;
BEGIN
  IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR jsonb_typeof(cfg->'enabled') IS DISTINCT FROM 'boolean' OR coalesce(cfg->>'workWeek','') NOT IN ('mon-fri','sun-thu') OR jsonb_typeof(cfg->'rules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid SLA policy' USING ERRCODE='check_violation';
  END IF;
  IF TG_OP='UPDATE' THEN NEW.revision:=OLD.revision+1; END IF;
  NEW.updated_at:=at_time;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_sla_policy_validate BEFORE INSERT OR UPDATE ON sla_policies FOR EACH ROW EXECUTE FUNCTION forge_sla_policy_period();
--> statement-breakpoint
CREATE FUNCTION forge_sla_policy_enablement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.values->>'enabled'=NEW.values->>'enabled' THEN RETURN NEW; END IF;
    UPDATE sla_policy_periods SET closed_at=NEW.updated_at WHERE workspace_id=NEW.workspace_id AND closed_at IS NULL;
  END IF;
  IF (NEW.values->>'enabled')::boolean THEN
    INSERT INTO sla_policy_periods(workspace_id,opened_at) VALUES(NEW.workspace_id,NEW.updated_at);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_sla_policy_enablement AFTER INSERT OR UPDATE ON sla_policies FOR EACH ROW EXECUTE FUNCTION forge_sla_policy_enablement();
--> statement-breakpoint
CREATE FUNCTION forge_sla_touch(p_id uuid, p_at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE g issue_slas; moment timestamptz; gate_on boolean; identity text;
BEGIN
  SELECT * INTO g FROM issue_slas WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  gate_on:=coalesce(current_setting('forge.sla.enabled',true),'')='on' AND current_setting('forge.sla.workspace',true)=g.workspace_id;
  identity:=coalesce(current_setting('forge.sla.identity',true),'unknown');
  SELECT min(greatest(g.deadline_at,w.opened_at,p.opened_at,coalesce(g.classified_through+interval '1 microsecond',g.deadline_at))) INTO moment
  FROM issue_sla_windows w JOIN sla_policy_periods p ON p.workspace_id=g.workspace_id
  WHERE w.commitment_id=g.id AND greatest(g.deadline_at,w.opened_at,p.opened_at,coalesce(g.classified_through+interval '1 microsecond',g.deadline_at))<=least(coalesce(w.closed_at,p_at),coalesce(p.closed_at,p_at),p_at);
  UPDATE issue_slas SET owed_at=coalesce(owed_at,moment),
    gate_uncertain=CASE WHEN gate_on AND deadline_at>p_at AND owed_at IS NULL AND moment IS NULL THEN false
      WHEN owed_at IS NULL AND moment IS NOT NULL AND (NOT gate_on OR identity<>gate_identity) THEN true ELSE gate_uncertain END,
    gate_identity=CASE WHEN gate_on AND deadline_at>p_at AND owed_at IS NULL AND moment IS NULL THEN identity ELSE gate_identity END
  WHERE id=p_id;
END $$;
--> statement-breakpoint
CREATE FUNCTION forge_sla_breach(p_id uuid, p_at timestamptz) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE g issue_slas;
BEGIN
  SELECT * INTO g FROM issue_slas WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR g.owed_at IS NULL OR g.gate_uncertain OR coalesce(current_setting('forge.sla.enabled',true),'')<>'on'
    OR current_setting('forge.sla.workspace',true)<>g.workspace_id
    OR NOT EXISTS(SELECT 1 FROM sla_policies WHERE workspace_id=g.workspace_id AND ("values"->>'enabled')::boolean) THEN RETURN false; END IF;
  INSERT INTO issue_sla_events(workspace_id,issue_id,commitment_id,kind,deadline_at,effective_at,changes,created_at)
  VALUES(g.workspace_id,g.issue_id,g.id,'breached',g.deadline_at,g.owed_at,jsonb_build_array(jsonb_build_object('field','sla','from','','to','breached')),p_at)
  ON CONFLICT(commitment_id,kind) DO NOTHING;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION forge_sla_rule(p_values jsonb, p_team uuid, p_priority text, p_status text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT value FROM jsonb_array_elements(p_values->'rules') WITH ORDINALITY e(value,position)
 WHERE coalesce((value->>'enabled')::boolean,false)
 AND (NOT value->'filters' ? 'teamIds' OR value->'filters'->'teamIds' ? p_team::text)
 AND (NOT value->'filters' ? 'priorities' OR value->'filters'->'priorities' ? coalesce(p_priority,'No priority'))
 AND (NOT value->'filters' ? 'statusIds' OR value->'filters'->'statusIds' ? p_status)
 ORDER BY position LIMIT 1;
$$;
--> statement-breakpoint
CREATE FUNCTION forge_issue_sla() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g issue_slas; p sla_policies; at_time timestamptz; rule jsonb; entry jsonb; snap jsonb; zone text; week text; anchor timestamptz; deadline timestamptz;
  group_name text; can_apply boolean; relevant boolean; fresh boolean:=false; carry boolean:=false; previous_due text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.purged_at IS NOT NULL THEN DELETE FROM issue_slas WHERE issue_id=NEW.id; RETURN NEW; END IF;
  -- Imported history does not establish a new response commitment.
  IF TG_OP='INSERT' AND NEW.legacy_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT * INTO g FROM issue_slas WHERE issue_id=NEW.id AND current FOR UPDATE;
  SELECT * INTO p FROM sla_policies WHERE workspace_id=NEW.workspace_id FOR SHARE;
  IF p.workspace_id IS NULL AND g.id IS NULL THEN RETURN NEW; END IF;
  -- Sample after all locks; client timestamps and transaction-start now() are not authority.
  at_time:=clock_timestamp();
  can_apply:=coalesce(current_setting('forge.sla.enabled',true),'')='on' AND current_setting('forge.sla.workspace',true)=NEW.workspace_id AND coalesce((p.values->>'enabled')::boolean,false);
  SELECT status_group INTO group_name FROM issue_statuses WHERE workspace_id=NEW.workspace_id AND team_id=NEW.team_id AND id=NEW.status_id;
  relevant:=TG_OP='INSERT';
  IF TG_OP='UPDATE' THEN relevant:=coalesce(relevant,false) OR NEW.team_id IS DISTINCT FROM OLD.team_id OR NEW.status_id IS DISTINCT FROM OLD.status_id OR NEW.properties->>'priority' IS DISTINCT FROM OLD.properties->>'priority'; END IF;
  IF g.id IS NOT NULL THEN
    PERFORM forge_sla_touch(g.id,at_time); PERFORM forge_sla_breach(g.id,at_time);
    IF TG_OP='UPDATE' AND NEW.properties->>'dueDate' IS DISTINCT FROM OLD.properties->>'dueDate' AND coalesce(NEW.properties->>'dueDate','')<>'' THEN
      UPDATE issue_sla_windows SET closed_at=at_time WHERE commitment_id=g.id AND closed_at IS NULL;
      UPDATE issue_slas SET current=false,state='removed' WHERE id=g.id;
      INSERT INTO issue_sla_events(workspace_id,issue_id,commitment_id,kind,deadline_at,effective_at,changes,created_at)
      VALUES(g.workspace_id,g.issue_id,g.id,'removed',g.deadline_at,at_time,'[{"field":"sla","from":"active","to":"removed"}]',at_time) ON CONFLICT DO NOTHING;
      RETURN NEW;
    END IF;
    IF group_name IN ('canceled','duplicate','completed') OR NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.purge_started_at IS NOT NULL THEN
      UPDATE issue_sla_windows SET closed_at=at_time WHERE commitment_id=g.id AND closed_at IS NULL;
      IF group_name='completed' THEN
        UPDATE issue_slas SET state='completed',completed_at=coalesce(completed_at,at_time) WHERE id=g.id;
      ELSIF group_name IN ('canceled','duplicate') THEN UPDATE issue_slas SET state='canceled',current=false WHERE id=g.id; END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF group_name IN ('completed','canceled','duplicate') OR NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.purge_started_at IS NOT NULL THEN RETURN NEW; END IF;
  IF can_apply AND relevant THEN
    rule:=forge_sla_rule(p.values,NEW.team_id,NEW.properties->>'priority',NEW.status_id);
  END IF;
  IF g.id IS NOT NULL AND rule->>'action'='remove' THEN
    UPDATE issue_sla_windows SET closed_at=at_time WHERE commitment_id=g.id AND closed_at IS NULL;
    UPDATE issue_slas SET current=false,state='removed' WHERE id=g.id;
    INSERT INTO issue_sla_events(workspace_id,issue_id,commitment_id,kind,deadline_at,effective_at,changes,created_at)
    VALUES(g.workspace_id,g.issue_id,g.id,'removed',g.deadline_at,at_time,'[{"field":"sla","from":"active","to":"removed"}]',at_time) ON CONFLICT DO NOTHING;
    RETURN NEW;
  END IF;
  IF g.id IS NOT NULL AND g.state='completed' THEN
    IF g.completed_at<=at_time-interval '720 hours' THEN
      IF can_apply THEN
        carry:=rule IS NULL OR rule->>'id'=g.rule_id::text;
        IF carry THEN rule:=g.snapshot->'rule'; END IF;
        fresh:=true;
      ELSE
        UPDATE issue_slas SET current=false,state='superseded' WHERE id=g.id; RETURN NEW;
      END IF;
    ELSE UPDATE issue_slas SET state='running',completed_at=NULL WHERE id=g.id; END IF;
  END IF;
  IF g.id IS NOT NULL AND rule->>'action'='apply' AND rule->>'id'<>g.rule_id::text THEN fresh:=true; END IF;
  IF g.id IS NOT NULL AND NOT fresh THEN
    INSERT INTO issue_sla_windows(commitment_id,opened_at) SELECT g.id,at_time WHERE NOT EXISTS(SELECT 1 FROM issue_sla_windows WHERE commitment_id=g.id AND closed_at IS NULL);
    PERFORM forge_sla_touch(g.id,at_time); PERFORM forge_sla_breach(g.id,at_time);
    -- Do not allow an unrelated stale draft to resurrect a due date while SLA is active.
    NEW.properties:=jsonb_set(NEW.properties,'{dueDate}','""'); RETURN NEW;
  END IF;
  IF NOT can_apply OR rule IS NULL OR rule->>'action'<>'apply' THEN RETURN NEW; END IF;
  IF g.id IS NOT NULL THEN
    UPDATE issue_sla_windows SET closed_at=at_time WHERE commitment_id=g.id AND closed_at IS NULL;
    UPDATE issue_slas SET current=false,state='superseded' WHERE id=g.id;
  END IF;
  IF carry THEN snap:=g.snapshot; anchor:=at_time;
  ELSE
    SELECT timezone INTO zone FROM teams WHERE id=NEW.team_id AND workspace_id=NEW.workspace_id;
    week:=p.values->>'workWeek'; snap:=jsonb_build_object('rule',rule,'timezone',zone,'workWeek',week);
    anchor:=CASE rule->>'startMode' WHEN 'issueCreation' THEN NEW.created_at ELSE at_time END;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=snap->>'timezone') THEN RAISE EXCEPTION 'Invalid SLA timezone'; END IF;
  deadline:=forge_sla_shift(anchor,(rule->'duration'->>'value')::integer,rule->'duration'->>'unit',snap->>'workWeek',snap->>'timezone');
  previous_due:=coalesce(NEW.properties->>'dueDate',''); NEW.properties:=jsonb_set(NEW.properties,'{dueDate}','""');
  INSERT INTO issue_slas(workspace_id,issue_id,generation,rule_id,policy_revision,snapshot,anchor_at,deadline_at,high_risk_at,moderate_risk_at,gate_identity,created_at)
  VALUES(NEW.workspace_id,NEW.id,(SELECT coalesce(max(generation),0)+1 FROM issue_slas WHERE issue_id=NEW.id),(rule->>'id')::uuid,CASE WHEN carry THEN g.policy_revision ELSE p.revision END,snap,anchor,deadline,
    forge_sla_shift(deadline,CASE rule->'duration'->>'unit' WHEN 'business-day' THEN -1 ELSE -24 END,CASE rule->'duration'->>'unit' WHEN 'business-day' THEN 'business-day' ELSE 'hour' END,snap->>'workWeek',snap->>'timezone'),
    forge_sla_shift(deadline,CASE rule->'duration'->>'unit' WHEN 'business-day' THEN -7 ELSE -168 END,CASE rule->'duration'->>'unit' WHEN 'business-day' THEN 'business-day' ELSE 'hour' END,snap->>'workWeek',snap->>'timezone'),
    current_setting('forge.sla.identity',true),at_time) RETURNING * INTO g;
  INSERT INTO issue_sla_windows(commitment_id,opened_at) VALUES(g.id,at_time);
  INSERT INTO issue_sla_intents(commitment_id) VALUES(g.id);
  INSERT INTO issue_sla_events(workspace_id,issue_id,commitment_id,kind,deadline_at,effective_at,changes,created_at)
  VALUES(g.workspace_id,g.issue_id,g.id,'applied',deadline,at_time,jsonb_build_array(jsonb_build_object('field','sla','from','','to',deadline::text))||CASE WHEN previous_due<>'' THEN jsonb_build_array(jsonb_build_object('field','dueDate','from',left(previous_due,1000),'to','')) ELSE '[]'::jsonb END,at_time);
  PERFORM forge_sla_touch(g.id,at_time); PERFORM forge_sla_breach(g.id,at_time);
  RETURN NEW;
END $$;
--> statement-breakpoint
-- Deferred tenant FK permits creation of issue, SLA, history and intent in one INSERT,
-- without a second issue update/revision or duplicate automation event.
CREATE TRIGGER forge_sla_issue BEFORE INSERT OR UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION forge_issue_sla();
--> statement-breakpoint
CREATE FUNCTION forge_sla_snapshot(p_issue uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id',g.id,'deadline',g.deadline_at::text,'anchor',g.anchor_at::text,'timezone',g.snapshot->>'timezone',
    'status',CASE WHEN g.gate_uncertain THEN 'reconciliation' WHEN g.state='completed' THEN CASE WHEN g.completed_at<g.deadline_at THEN 'achieved' ELSE 'failed' END
      WHEN g.deadline_at<=statement_timestamp() THEN 'breached' WHEN g.high_risk_at<=statement_timestamp() THEN 'high-risk' WHEN g.moderate_risk_at<=statement_timestamp() THEN 'moderate-risk' ELSE 'low-risk' END,
    'completedAt',g.completed_at::text)
  FROM issue_slas g WHERE g.issue_id=p_issue AND g.current AND g.state IN ('running','completed');
$$;
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['sla_policies','sla_policy_periods','issue_slas','issue_sla_windows','issue_sla_events','issue_sla_intents'] LOOP
    EXECUTE format('CREATE TRIGGER forge_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_capture_recovery_event()',tab);
  END LOOP;
END $$;

--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON sla_policies FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('workspace_id');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON sla_policy_periods FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','opened_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_slas FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','issue_id','generation','rule_id','policy_revision','snapshot','anchor_at','deadline_at','high_risk_at','moderate_risk_at','created_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_sla_windows FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','commitment_id','opened_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_sla_events FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','issue_id','commitment_id','kind','deadline_at','effective_at','changes','created_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_sla_intents FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('commitment_id','created_at');
