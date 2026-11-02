CREATE TABLE "saved_view_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"view_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "saved_view_favorites_actor" UNIQUE("workspace_id","user_id","view_id")
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"visibility" text NOT NULL,
	"team_id" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "saved_views_workspace_identity" UNIQUE("workspace_id","id"),
	CONSTRAINT "saved_views_visibility" CHECK ("saved_views"."visibility" IN ('personal','workspace','team') AND ("saved_views"."visibility" <> 'team' OR "saved_views"."team_id" IS NOT NULL)),
	CONSTRAINT "saved_views_revision" CHECK ("saved_views"."revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "saved_view_favorites" ADD CONSTRAINT "saved_view_favorites_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view_favorites" ADD CONSTRAINT "saved_view_favorites_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view_favorites" ADD CONSTRAINT "saved_view_favorites_view_fk" FOREIGN KEY ("workspace_id","view_id") REFERENCES "public"."saved_views"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_views_directory" ON "saved_views" USING btree ("workspace_id","visibility","owner_id","id");