CREATE TABLE "cycle_closures" (
	"cycle_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"target_cycle_id" uuid,
	"carryover" boolean NOT NULL,
	"closed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "cycle_closure_identity" UNIQUE("workspace_id","team_id","cycle_id"),
	CONSTRAINT "cycle_closure_target_different" CHECK ("cycle_closures"."target_cycle_id" IS NULL OR "cycle_closures"."target_cycle_id" <> "cycle_closures"."cycle_id")
);
--> statement-breakpoint
CREATE TABLE "cycle_membership_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"issue_revision" integer NOT NULL,
	"status_group" text NOT NULL,
	"carried" boolean NOT NULL,
	CONSTRAINT "cycle_membership_history_once" UNIQUE("cycle_id","issue_id"),
	CONSTRAINT "cycle_membership_history_revision" CHECK ("cycle_membership_history"."issue_revision" >= 0),
	CONSTRAINT "cycle_membership_history_status" CHECK ("cycle_membership_history"."status_group" IN ('backlog','unstarted','started','completed','canceled','duplicate'))
);
--> statement-breakpoint
CREATE TABLE "cycle_rollover_teams" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cycle_closures" ADD CONSTRAINT "cycle_closures_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_closures" ADD CONSTRAINT "cycle_closure_source_fk" FOREIGN KEY ("workspace_id","team_id","cycle_id") REFERENCES "public"."issue_cycles"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_closures" ADD CONSTRAINT "cycle_closure_target_fk" FOREIGN KEY ("workspace_id","team_id","target_cycle_id") REFERENCES "public"."issue_cycles"("workspace_id","team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_closure_fk" FOREIGN KEY ("workspace_id","team_id","cycle_id") REFERENCES "public"."cycle_closures"("workspace_id","team_id","cycle_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_membership_history" ADD CONSTRAINT "cycle_membership_history_issue_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_rollover_teams" ADD CONSTRAINT "cycle_rollover_teams_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_rollover_teams" ADD CONSTRAINT "cycle_rollover_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycle_membership_history_issue" ON "cycle_membership_history" USING btree ("workspace_id","issue_id");
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON cycle_rollover_teams FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('team_id','workspace_id','enabled_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON cycle_closures FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('cycle_id','workspace_id','team_id','target_cycle_id','carryover','closed_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON cycle_membership_history FOR EACH ROW EXECUTE FUNCTION forge_immutable_identity('id','workspace_id','team_id','cycle_id','issue_id','issue_revision','status_group','carried');
--> statement-breakpoint
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['cycle_rollover_teams','cycle_closures','cycle_membership_history'] LOOP
    EXECUTE format('CREATE TRIGGER forge_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forge_capture_recovery_event()',tab);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION forge_guard_closed_cycle_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cycle_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (OLD.cycle_id,OLD.team_id) IS NOT DISTINCT FROM (NEW.cycle_id,NEW.team_id) THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.team_id::text,4055));
  IF EXISTS(SELECT 1 FROM cycle_closures WHERE cycle_id=NEW.cycle_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='issues_cycle_closed', MESSAGE='This cycle is closed. Choose a current or upcoming cycle.';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_guard_closed_cycle_assignment BEFORE INSERT OR UPDATE OF cycle_id,team_id ON issues FOR EACH ROW EXECUTE FUNCTION forge_guard_closed_cycle_assignment();
