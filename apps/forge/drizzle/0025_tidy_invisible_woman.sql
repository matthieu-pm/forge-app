CREATE TABLE "call_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"title" text NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"completed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret" text,
	"oauth_state_hash" text,
	"oauth_verifier" text,
	"oauth_expires_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"sync_lease_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "call_connections_account_unique" UNIQUE("workspace_id","user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "call_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"body" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration" integer DEFAULT 0 NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary_status" text DEFAULT 'pending' NOT NULL,
	"summary_lease_at" timestamp with time zone,
	CONSTRAINT "calls_source_unique" UNIQUE("workspace_id","provider","external_id")
);
--> statement-breakpoint
ALTER TABLE "call_actions" ADD CONSTRAINT "call_actions_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_connections" ADD CONSTRAINT "call_connections_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_connections" ADD CONSTRAINT "call_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_connections" ADD CONSTRAINT "call_connections_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_notes" ADD CONSTRAINT "call_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_settings" ADD CONSTRAINT "call_settings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_connections_state_idx" ON "call_connections" USING btree ("oauth_state_hash");--> statement-breakpoint
CREATE INDEX "calls_workspace_date_idx" ON "calls" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_team_date_idx" ON "calls" USING btree ("team_id","started_at");