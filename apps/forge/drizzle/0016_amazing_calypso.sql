CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_user_unique" UNIQUE("team_id","user_id"),
	CONSTRAINT "team_members_role_check" CHECK ("team_members"."role" in ('lead', 'member'))
);
--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_workspace_slug_unique";--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_workspace_identifier_unique";--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "visibility" text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "team_members" ("workspace_id", "team_id", "user_id", "role", "created_at")
SELECT "workspace_id", "id", "created_by_user_id", 'member', "created_at"
FROM "teams"
ON CONFLICT ("team_id", "user_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "team_members_workspace_team_idx" ON "team_members" USING btree ("workspace_id","team_id");--> statement-breakpoint
CREATE INDEX "team_members_workspace_user_idx" ON "team_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_workspace_slug_unique" ON "teams" USING btree ("workspace_id","slug") WHERE "teams"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_workspace_identifier_unique" ON "teams" USING btree ("workspace_id","identifier") WHERE "teams"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "teams_workspace_lifecycle_idx" ON "teams" USING btree ("workspace_id","deleted_at");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_visibility_check" CHECK ("teams"."visibility" in ('workspace', 'private'));
