CREATE TABLE "issue_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	CONSTRAINT "issue_cycles_team_start" UNIQUE("team_id","start_date"),
	CONSTRAINT "issue_cycles_workspace_identity" UNIQUE("workspace_id","team_id","id"),
	CONSTRAINT "issue_cycles_dates" CHECK ("issue_cycles"."start_date" ~ '^\d{4}-\d{2}-\d{2}$' AND "issue_cycles"."end_date" >= "issue_cycles"."start_date")
);
--> statement-breakpoint
CREATE TABLE "product_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"owner_user_id" text,
	"team_id" uuid,
	"key" text NOT NULL,
	"encoded_value" text,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_state_scope_key" UNIQUE("workspace_id","owner_id","key"),
	CONSTRAINT "product_state_owner_scope" CHECK (("product_state"."owner_id"='workspace' AND "product_state"."owner_user_id" IS NULL) OR ("product_state"."owner_user_id" IS NOT NULL AND "product_state"."owner_id"='user:' || "product_state"."owner_user_id"))
);
--> statement-breakpoint
CREATE TABLE "team_issue_numbers" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_issue_capacity" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"active_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_issue_capacity_nonnegative" CHECK ("workspace_issue_capacity"."active_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "assignee_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "creator_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "cycle_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_state" ADD CONSTRAINT "product_state_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_state" ADD CONSTRAINT "product_state_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_state" ADD CONSTRAINT "product_state_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_issue_numbers" ADD CONSTRAINT "team_issue_numbers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_issue_capacity" ADD CONSTRAINT "workspace_issue_capacity_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_cycle_fk" FOREIGN KEY ("workspace_id","team_id","cycle_id") REFERENCES "public"."issue_cycles"("workspace_id","team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_team_legacy_unique" UNIQUE("workspace_id","team_id","legacy_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_legacy_unique" UNIQUE("workspace_id","legacy_id");
--> statement-breakpoint
LOCK TABLE public.organization, public.issues IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO public.workspace_issue_capacity(workspace_id,active_count)
SELECT o.id,count(i.id)::integer FROM public.organization o LEFT JOIN public.issues i
 ON i.workspace_id=o.id AND i.archived_at IS NULL GROUP BY o.id;
--> statement-breakpoint
CREATE FUNCTION public.forge_adjust_workspace_issue_capacity(target_workspace text, amount integer)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM id FROM public.organization WHERE id=target_workspace FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF amount=1 THEN
  UPDATE public.workspace_issue_capacity SET active_count=active_count+1
  WHERE workspace_id=target_workspace AND
   (active_count<250 OR public.forge_effective_workspace_plan(target_workspace)<>'free');
  IF NOT FOUND THEN
   RAISE EXCEPTION 'This workspace has reached the Free plan limit of 250 active issues. Archive an issue or upgrade to create more.'
   USING ERRCODE='23514',CONSTRAINT='workspace_active_issue_limit';
  END IF;
 ELSE
  UPDATE public.workspace_issue_capacity SET active_count=active_count-1 WHERE workspace_id=target_workspace AND active_count>0;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace issue capacity is inconsistent.'; END IF;
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.forge_track_workspace_issue_capacity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='organization' THEN
  INSERT INTO public.workspace_issue_capacity(workspace_id) VALUES(NEW.id); RETURN NEW;
 ELSIF TG_OP='DELETE' THEN
  IF OLD.archived_at IS NULL AND EXISTS(SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
   PERFORM public.forge_adjust_workspace_issue_capacity(OLD.workspace_id,-1);
  END IF; RETURN OLD;
 ELSIF TG_OP='INSERT' THEN
  IF NEW.archived_at IS NULL THEN PERFORM public.forge_adjust_workspace_issue_capacity(NEW.workspace_id,1); END IF;
 ELSE
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
   PERFORM id FROM public.organization WHERE id IN(OLD.workspace_id,NEW.workspace_id) ORDER BY id FOR NO KEY UPDATE;
  END IF;
  IF OLD.archived_at IS NULL AND (NEW.archived_at IS NOT NULL OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
   PERFORM public.forge_adjust_workspace_issue_capacity(OLD.workspace_id,-1);
  END IF;
  IF NEW.archived_at IS NULL AND (OLD.archived_at IS NOT NULL OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
   PERFORM public.forge_adjust_workspace_issue_capacity(NEW.workspace_id,1);
  END IF;
 END IF; RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workspace_issue_capacity_new_organization AFTER INSERT ON public.organization FOR EACH ROW EXECUTE FUNCTION public.forge_track_workspace_issue_capacity();
--> statement-breakpoint
CREATE TRIGGER workspace_issue_capacity_issue_write AFTER INSERT OR UPDATE OR DELETE ON public.issues FOR EACH ROW EXECUTE FUNCTION public.forge_track_workspace_issue_capacity();
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON issue_cycles FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','team_id','start_date');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON workspace_issue_capacity FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('workspace_id');
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON issue_cycles FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event();
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON workspace_issue_capacity FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event();

--> statement-breakpoint
INSERT INTO team_issue_numbers(team_id,last_number) SELECT team_id,max(number) FROM issues GROUP BY team_id;
--> statement-breakpoint
CREATE FUNCTION forge_track_issue_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO team_issue_numbers(team_id,last_number) VALUES(NEW.team_id,NEW.number)
 ON CONFLICT(team_id) DO UPDATE SET last_number=greatest(team_issue_numbers.last_number,EXCLUDED.last_number);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_track_issue_number AFTER INSERT ON issues FOR EACH ROW EXECUTE FUNCTION forge_track_issue_number();
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON product_state FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','owner_id','key');
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON product_state FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event();
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON team_issue_numbers FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('team_id');
--> statement-breakpoint
CREATE TRIGGER forge_recovery_capture AFTER INSERT OR DELETE OR UPDATE ON team_issue_numbers FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event();

--> statement-breakpoint
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
