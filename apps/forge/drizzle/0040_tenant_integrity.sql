ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_id_unique" UNIQUE("workspace_id","id");
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"team_id" uuid,
	"issue_id" uuid,
	"project_id" uuid,
	CONSTRAINT "documents_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "documents_one_source" CHECK (num_nonnulls("documents"."team_id", "documents"."issue_id", "documents"."project_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "initiative_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"initiative_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "initiative_projects_pair_unique" UNIQUE("initiative_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "initiatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "initiatives_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "issue_hierarchy_guards" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "issue_labels_pair_unique" UNIQUE("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "issue_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"related_issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "issue_relations_pair_unique" UNIQUE("issue_id","related_issue_id","kind"),
	CONSTRAINT "issue_relations_not_self" CHECK ("issue_relations"."issue_id" <> "issue_relations"."related_issue_id"),
	CONSTRAINT "issue_relations_kind" CHECK ("issue_relations"."kind" IN ('related','blocks','duplicates'))
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"project_id" uuid,
	"parent_id" uuid,
	CONSTRAINT "issues_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "issues_team_number_unique" UNIQUE("team_id","number"),
	CONSTRAINT "issues_number_positive" CHECK ("issues"."number" > 0),
	CONSTRAINT "issues_not_self_parent" CHECK ("issues"."parent_id" IS NULL OR "issues"."parent_id" <> "issues"."id")
);
--> statement-breakpoint
CREATE TABLE "project_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "project_teams_pair_unique" UNIQUE("project_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "projects_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "resource_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	CONSTRAINT "resource_labels_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_issue_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_initiative_fk" FOREIGN KEY ("workspace_id","initiative_id") REFERENCES "public"."initiatives"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiative_projects" ADD CONSTRAINT "initiative_projects_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_hierarchy_guards" ADD CONSTRAINT "issue_hierarchy_guards_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_issue_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_labels" ADD CONSTRAINT "issue_labels_label_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "public"."resource_labels"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_source_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relations" ADD CONSTRAINT "issue_relations_target_fk" FOREIGN KEY ("workspace_id","related_issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_id_issues_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_workspace_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_labels" ADD CONSTRAINT "resource_labels_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_labels" ADD CONSTRAINT "resource_labels_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_labels_workspace_name_unique" ON "resource_labels" USING btree ("workspace_id","name") WHERE "resource_labels"."team_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_labels_team_name_unique" ON "resource_labels" USING btree ("team_id","name") WHERE "resource_labels"."team_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "call_connections" ADD CONSTRAINT "call_connections_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_recurring_issues" ADD CONSTRAINT "team_recurring_issues_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_templates" ADD CONSTRAINT "team_templates_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--> statement-breakpoint
-- Identity/ownership cannot move out from under existing references. Mutable
-- links (issue parent/project/team) are validated separately; deletes still work.
CREATE FUNCTION public.forge_immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW)->col IS DISTINCT FROM to_jsonb(OLD)->col THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='forge_immutable_identity', MESSAGE='Resource identity and owning scope are immutable';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE r record; col text; args text;
BEGIN
  -- All current public PKs, including auth/composite receipts. Future tables
  -- must explicitly extend the inventory; DDL is owned by the migration role.
  FOR r IN SELECT c.table_name,string_agg(quote_literal(c.column_name),',' ORDER BY c.ordinal_position) AS keys
    FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage c
      ON tc.constraint_name=c.constraint_name AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name
    WHERE tc.table_schema='public' AND tc.constraint_type='PRIMARY KEY' GROUP BY c.table_name
  LOOP
    args := r.keys;
    FOR col IN SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=r.table_name AND column_name IN ('workspace_id','organization_id')
    LOOP args := args || ',' || quote_literal(col); END LOOP;
    CASE r.table_name
      WHEN 'agent_runs' THEN args := args || ',''thread_id''';
      WHEN 'agent_events' THEN args := args || ',''thread_id'',''run_id''';
      WHEN 'agent_artifacts' THEN args := args || ',''run_id''';
      WHEN 'agent_approvals' THEN args := args || ',''run_id''';
      WHEN 'agent_capability_invocations' THEN args := args || ',''run_id'',''approval_id''';
      WHEN 'model_catalog_entries' THEN args := args || ',''connection_id''';
      WHEN 'team_template_defaults' THEN args := args || ',''team_id''';
      WHEN 'team_templates' THEN args := args || ',''team_id''';
      WHEN 'resource_labels' THEN args := args || ',''team_id''';
      WHEN 'documents' THEN args := args || ',''team_id'',''issue_id'',''project_id''';
      WHEN 'call_actions' THEN args := args || ',''call_id''';
      WHEN 'call_notes' THEN args := args || ',''call_id''';
      WHEN 'business_workflow_effects' THEN args := args || ',''workflow_run_id''';
      ELSE NULL;
    END CASE;
    EXECUTE format('CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity(%s)',r.table_name,args);
  END LOOP;
END $$;
--> statement-breakpoint
-- Locked references and immutable ownership enforce indirect scoped relations
-- without adding mandatory fields to existing/rollback-compatible writers.
CREATE FUNCTION public.forge_check_tenant_relation(tab text, row_data jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner_workspace text; target_workspace text; owner_thread uuid; target_run uuid; target_team uuid;
BEGIN
  IF tab IN ('agent_runs','thread_model_preferences') THEN
    SELECT workspace_id INTO owner_workspace FROM public.agent_threads WHERE id=(row_data->>'thread_id')::uuid FOR KEY SHARE;
    IF tab='agent_runs' THEN target_run := (row_data->>'resolved_connection_id')::uuid;
    ELSE target_run := (row_data->>'selected_connection_id')::uuid; END IF;
    IF target_run IS NOT NULL THEN
      SELECT workspace_id INTO target_workspace FROM public.model_connections WHERE id=target_run FOR KEY SHARE;
      IF target_workspace IS DISTINCT FROM owner_workspace OR owner_workspace IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='forge_connection_workspace_fk', MESSAGE='Invalid resource relationship';
      END IF;
    END IF;
  ELSIF tab='agent_events' THEN
    SELECT thread_id INTO owner_thread FROM public.agent_runs WHERE id=(row_data->>'run_id')::uuid FOR KEY SHARE;
    IF owner_thread IS DISTINCT FROM (row_data->>'thread_id')::uuid THEN
      RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='forge_event_thread_run_fk', MESSAGE='Invalid resource relationship';
    END IF;
  ELSIF tab IN ('agent_approvals','agent_capability_invocations','workspace_usage_reservations') THEN
    IF row_data->>'run_id' IS NOT NULL THEN
      SELECT t.workspace_id INTO owner_workspace FROM public.agent_runs r JOIN public.agent_threads t ON t.id=r.thread_id WHERE r.id=(row_data->>'run_id')::uuid FOR KEY SHARE OF r,t;
      IF owner_workspace IS DISTINCT FROM row_data->>'workspace_id' THEN
        RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='forge_run_workspace_fk', MESSAGE='Invalid resource relationship';
      END IF;
    END IF;
    IF tab='agent_capability_invocations' THEN
      SELECT workspace_id,run_id INTO target_workspace,target_run FROM public.agent_approvals WHERE id=(row_data->>'approval_id')::uuid FOR KEY SHARE;
      IF target_workspace IS DISTINCT FROM row_data->>'workspace_id' OR target_run IS DISTINCT FROM (row_data->>'run_id')::uuid THEN
        RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='forge_invocation_approval_fk', MESSAGE='Invalid resource relationship';
      END IF;
    END IF;
  ELSIF tab='team_template_defaults' THEN
    SELECT workspace_id INTO owner_workspace FROM public.teams WHERE id=(row_data->>'team_id')::uuid FOR KEY SHARE;
    IF row_data->>'template_id' IS NOT NULL THEN
      SELECT workspace_id,team_id INTO target_workspace,target_team FROM public.team_templates WHERE id=(row_data->>'template_id')::uuid FOR KEY SHARE;
      IF target_workspace IS DISTINCT FROM owner_workspace OR (target_team IS NOT NULL AND target_team<>(row_data->>'team_id')::uuid) THEN
        RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='forge_template_default_scope_fk', MESSAGE='Invalid resource relationship';
      END IF;
    END IF;
  ELSIF tab='api_idempotency_keys' THEN
    SELECT metadata::jsonb->>'workspaceId' INTO owner_workspace FROM public.apikey WHERE id=row_data->>'credential_id' FOR KEY SHARE;
    IF owner_workspace IS DISTINCT FROM row_data->>'workspace_id' THEN
      RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='forge_idempotency_workspace_fk', MESSAGE='Invalid resource relationship';
    END IF;
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.forge_tenant_relation_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.forge_check_tenant_relation(TG_TABLE_NAME,to_jsonb(NEW));
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE tab text; row_data jsonb;
BEGIN
  FOREACH tab IN ARRAY ARRAY['agent_runs','thread_model_preferences','agent_events','agent_approvals','agent_capability_invocations','workspace_usage_reservations','team_template_defaults','api_idempotency_keys'] LOOP
    -- Fail atomically on legacy violations; never silently repair or delete data.
    FOR row_data IN EXECUTE format('SELECT to_jsonb(t) FROM public.%I t',tab) LOOP
      PERFORM public.forge_check_tenant_relation(tab,row_data);
    END LOOP;
    EXECUTE format('CREATE TRIGGER forge_tenant_relation BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.forge_tenant_relation_trigger()',tab);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.forge_apikey_workspace_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.metadata::jsonb->>'workspaceId' IS DISTINCT FROM OLD.metadata::jsonb->>'workspaceId' THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='forge_immutable_identity', MESSAGE='Credential workspace is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_apikey_workspace_immutable BEFORE UPDATE OF metadata ON public.apikey FOR EACH ROW EXECUTE FUNCTION public.forge_apikey_workspace_immutable();
--> statement-breakpoint
-- Updating a real row fences stale RR snapshots; an advisory lock alone cannot.
CREATE FUNCTION public.forge_lock_issue_graph(w text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.issue_hierarchy_guards(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;
  UPDATE public.issue_hierarchy_guards SET version=CASE WHEN version=2147483647 THEN 0 ELSE version+1 END WHERE workspace_id=w;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.forge_issue_graph_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.forge_lock_issue_graph(NEW.workspace_id);
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM public.issues WHERE id=NEW.parent_id AND workspace_id=NEW.workspace_id
      UNION
      SELECT p.id,p.parent_id FROM public.issues p JOIN ancestors a ON p.id=a.parent_id WHERE p.workspace_id=NEW.workspace_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='issues_parent_acyclic', MESSAGE='Issue parent cycle rejected';
  END IF;
  IF EXISTS(SELECT 1 FROM public.issue_labels il JOIN public.resource_labels l ON l.id=il.label_id WHERE il.issue_id=NEW.id AND l.team_id IS NOT NULL AND l.team_id<>NEW.team_id) THEN
    RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='issue_labels_team_fk', MESSAGE='Invalid resource relationship';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_issue_graph_guard BEFORE INSERT OR UPDATE OF parent_id,team_id ON public.issues FOR EACH ROW EXECUTE FUNCTION public.forge_issue_graph_guard();
--> statement-breakpoint
-- AFTER ROW sees all rows of a multi-row INSERT/UPDATE; rejecting any cycle
-- rolls back every edge in the statement and the surrounding transaction.
CREATE FUNCTION public.forge_issue_cycle_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id=NEW.id OR EXISTS (
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM public.issues WHERE id=NEW.parent_id AND workspace_id=NEW.workspace_id
      UNION
      SELECT p.id,p.parent_id FROM public.issues p JOIN ancestors a ON p.id=a.parent_id WHERE p.workspace_id=NEW.workspace_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='issues_parent_acyclic', MESSAGE='Issue parent cycle rejected';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_issue_cycle_after AFTER INSERT OR UPDATE OF parent_id ON public.issues FOR EACH ROW EXECUTE FUNCTION public.forge_issue_cycle_after();
--> statement-breakpoint
CREATE FUNCTION public.forge_issue_label_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE issue_team uuid; label_team uuid;
BEGIN
  PERFORM public.forge_lock_issue_graph(NEW.workspace_id);
  SELECT team_id INTO issue_team FROM public.issues WHERE id=NEW.issue_id AND workspace_id=NEW.workspace_id;
  SELECT team_id INTO label_team FROM public.resource_labels WHERE id=NEW.label_id AND workspace_id=NEW.workspace_id;
  IF label_team IS NOT NULL AND label_team IS DISTINCT FROM issue_team THEN
    RAISE EXCEPTION USING ERRCODE='23503', CONSTRAINT='issue_labels_team_fk', MESSAGE='Invalid resource relationship';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_issue_label_guard BEFORE INSERT OR UPDATE ON public.issue_labels FOR EACH ROW EXECUTE FUNCTION public.forge_issue_label_guard();
