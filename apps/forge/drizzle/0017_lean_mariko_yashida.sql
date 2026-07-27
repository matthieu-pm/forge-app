CREATE TABLE "workspace_approved_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"domain" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_approved_domains_source_check" CHECK ("workspace_approved_domains"."source" in ('manual', 'sso'))
);
--> statement-breakpoint
CREATE TABLE "workspace_entitlements" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"feature_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'internal' NOT NULL,
	"source_reference" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_entitlements_plan_check" CHECK ("workspace_entitlements"."plan" in ('free', 'basic', 'business', 'enterprise')),
	CONSTRAINT "workspace_entitlements_status_check" CHECK ("workspace_entitlements"."status" in ('active', 'trialing', 'past_due', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "workspace_security_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target" text,
	"outcome" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_security_audit_events_outcome_check" CHECK ("workspace_security_audit_events"."outcome" in ('succeeded', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "workspace_security_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"invite_links_enabled" boolean DEFAULT true NOT NULL,
	"invite_link_version" integer DEFAULT 1 NOT NULL,
	"google_authentication_enabled" boolean DEFAULT true NOT NULL,
	"email_passkey_authentication_enabled" boolean DEFAULT true NOT NULL,
	"invitation_policy" text DEFAULT 'all-members' NOT NULL,
	"team_creation_policy" text DEFAULT 'admins' NOT NULL,
	"workspace_labels_policy" text DEFAULT 'admins' NOT NULL,
	"workspace_templates_policy" text DEFAULT 'admins' NOT NULL,
	"loops_policy" text DEFAULT 'admins' NOT NULL,
	"api_key_creation_policy" text DEFAULT 'all-members' NOT NULL,
	"agent_guidance_policy" text DEFAULT 'admins' NOT NULL,
	"restrict_file_uploads" boolean DEFAULT false NOT NULL,
	"allowed_upload_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_third_party_applications" boolean DEFAULT false NOT NULL,
	"reduce_support_pii" boolean DEFAULT false NOT NULL,
	"block_guest_agent_access" boolean DEFAULT false NOT NULL,
	"share_ai_usage_data" boolean DEFAULT false NOT NULL,
	"agent_web_search_enabled" boolean DEFAULT false NOT NULL,
	"external_loop_sources_enabled" boolean DEFAULT false NOT NULL,
	"mcp_servers_enabled" boolean DEFAULT false NOT NULL,
	"hipaa_enabled" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_security_settings_version_check" CHECK ("workspace_security_settings"."version" > 0 and "workspace_security_settings"."invite_link_version" > 0),
	CONSTRAINT "workspace_security_settings_invitation_policy_check" CHECK ("workspace_security_settings"."invitation_policy" in ('all-members', 'admins')),
	CONSTRAINT "workspace_security_settings_team_creation_policy_check" CHECK ("workspace_security_settings"."team_creation_policy" in ('all-members', 'admins')),
	CONSTRAINT "workspace_security_settings_labels_policy_check" CHECK ("workspace_security_settings"."workspace_labels_policy" in ('all-members', 'admins')),
	CONSTRAINT "workspace_security_settings_templates_policy_check" CHECK ("workspace_security_settings"."workspace_templates_policy" in ('all-members', 'admins')),
	CONSTRAINT "workspace_security_settings_loops_policy_check" CHECK ("workspace_security_settings"."loops_policy" in ('all-members', 'admins')),
	CONSTRAINT "workspace_security_settings_api_key_policy_check" CHECK ("workspace_security_settings"."api_key_creation_policy" in ('all-members', 'admins')),
	CONSTRAINT "workspace_security_settings_agent_guidance_policy_check" CHECK ("workspace_security_settings"."agent_guidance_policy" in ('all-members', 'admins'))
);
--> statement-breakpoint
ALTER TABLE "workspace_approved_domains" ADD CONSTRAINT "workspace_approved_domains_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_approved_domains" ADD CONSTRAINT "workspace_approved_domains_added_by_user_id_user_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_security_audit_events" ADD CONSTRAINT "workspace_security_audit_events_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_security_audit_events" ADD CONSTRAINT "workspace_security_audit_events_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_security_settings" ADD CONSTRAINT "workspace_security_settings_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_security_settings" ADD CONSTRAINT "workspace_security_settings_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_approved_domains_workspace_idx" ON "workspace_approved_domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_approved_domains_domain_unique" ON "workspace_approved_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "workspace_security_audit_events_workspace_created_idx" ON "workspace_security_audit_events" USING btree ("workspace_id","created_at");