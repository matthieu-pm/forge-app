CREATE TABLE "product_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_state_scope_key" UNIQUE("workspace_id","owner_id","key")
);
--> statement-breakpoint
CREATE TABLE "team_issue_numbers" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_state" ADD CONSTRAINT "product_state_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_issue_numbers" ADD CONSTRAINT "team_issue_numbers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
