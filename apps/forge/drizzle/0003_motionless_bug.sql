ALTER TABLE "teams" ADD COLUMN "organization_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "identifier" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "icon_kind" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "icon_value" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
UPDATE "teams" AS "team"
SET "organization_id" = "organization"."id"
FROM "workspaces" AS "workspace"
JOIN "organization" AS "organization"
  ON "organization"."slug" = "workspace"."slug"
WHERE "team"."workspace_id" = "workspace"."id";--> statement-breakpoint
WITH "numbered_teams" AS (
  SELECT
    "id",
    row_number() OVER (PARTITION BY "organization_id" ORDER BY "created_at", "id") AS "team_number"
  FROM "teams"
)
UPDATE "teams" AS "team"
SET "identifier" = 'T' || upper(lpad(to_hex("numbered_teams"."team_number"), 4, '0'))
FROM "numbered_teams"
WHERE "team"."id" = "numbered_teams"."id";--> statement-breakpoint
UPDATE "teams" SET
  "icon_kind" = 'icon',
  "icon_value" = 'UserGroup03Icon',
  "color" = '#94a3b8',
  "timezone" = 'UTC';--> statement-breakpoint
UPDATE "teams" AS "team"
SET "created_by_user_id" = (
  SELECT "member"."user_id"
  FROM "member"
  WHERE "member"."organization_id" = "team"."organization_id"
  ORDER BY
    CASE "member"."role"
      WHEN 'owner' THEN 0
      WHEN 'admin' THEN 1
      ELSE 2
    END,
    "member"."created_at"
  LIMIT 1
);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "teams"
    WHERE "organization_id" IS NULL OR "created_by_user_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate teams: every legacy workspace must match an organization with at least one member';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_slug_unique";--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "teams" RENAME COLUMN "organization_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "identifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "icon_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "icon_value" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "color" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "timezone" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ALTER COLUMN "created_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_workspace_id_idx" ON "teams" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_slug_unique" UNIQUE("workspace_id","slug");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_identifier_unique" UNIQUE("workspace_id","identifier");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_icon_kind_check" CHECK ("teams"."icon_kind" in ('icon', 'emoji'));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_color_check" CHECK ("teams"."color" ~ '^#[0-9A-Fa-f]{6}$');--> statement-breakpoint
DROP TABLE "workspaces";
