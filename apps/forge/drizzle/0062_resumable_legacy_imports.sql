CREATE TABLE "legacy_import_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"legacy_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"canonical_id" uuid NOT NULL,
	"target_fingerprint" text NOT NULL,
	CONSTRAINT "legacy_import_aliases_source_unique" UNIQUE("workspace_id","team_id","kind","legacy_id","fingerprint")
);
--> statement-breakpoint
CREATE TABLE "legacy_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"encoded_manifest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_imports_source_unique" UNIQUE("workspace_id","user_id","fingerprint")
);
--> statement-breakpoint
ALTER TABLE "legacy_import_aliases" ADD CONSTRAINT "legacy_import_aliases_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_imports" ADD CONSTRAINT "legacy_imports_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_imports" ADD CONSTRAINT "legacy_imports_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;