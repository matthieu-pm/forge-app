CREATE TABLE "account_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"field_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "account_preferences_version_check" CHECK ("account_preferences"."version" > 0 AND "account_preferences"."revision" >= 0),
	CONSTRAINT "account_preferences_objects_check" CHECK (jsonb_typeof("account_preferences"."values") = 'object' AND jsonb_typeof("account_preferences"."field_versions") = 'object')
);
--> statement-breakpoint
ALTER TABLE "account_preferences" ADD CONSTRAINT "account_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;