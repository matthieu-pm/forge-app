CREATE TABLE "workspace_preferences" (
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "workspace_preferences_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id"),
	CONSTRAINT "workspace_preferences_version_check" CHECK ("workspace_preferences"."version" > 0 AND "workspace_preferences"."revision" >= 0),
	CONSTRAINT "workspace_preferences_objects_check" CHECK (jsonb_typeof("workspace_preferences"."values") = 'object' AND jsonb_typeof("workspace_preferences"."field_versions") = 'object')
);
--> statement-breakpoint
ALTER TABLE "workspace_preferences" ADD CONSTRAINT "workspace_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_preferences" ADD CONSTRAINT "workspace_preferences_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;