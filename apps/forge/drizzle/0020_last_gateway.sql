CREATE TABLE "team_template_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"template_id" uuid
);
--> statement-breakpoint
CREATE TABLE "team_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_template_defaults" ADD CONSTRAINT "team_template_defaults_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_template_defaults" ADD CONSTRAINT "team_template_defaults_template_id_team_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."team_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_templates" ADD CONSTRAINT "team_templates_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_templates" ADD CONSTRAINT "team_templates_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_templates" ADD CONSTRAINT "team_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_template_defaults_audience_unique" ON "team_template_defaults" USING btree ("team_id","audience");--> statement-breakpoint
CREATE INDEX "team_templates_team_idx" ON "team_templates" USING btree ("workspace_id","team_id");