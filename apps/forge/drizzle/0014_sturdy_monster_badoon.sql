CREATE TABLE "business_workflow_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_run_id" uuid NOT NULL,
	"effect_key" text NOT NULL,
	"provider_reference" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_workflow_effects_run_effect_key_unique" UNIQUE("business_run_id","effect_key"),
	CONSTRAINT "business_workflow_effects_state_check" CHECK ("business_workflow_effects"."state" in ('pending', 'sending', 'completed', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "business_workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"sdk_run_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"start_attempts" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_workflow_runs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "business_workflow_runs_sdk_run_id_unique" UNIQUE("sdk_run_id"),
	CONSTRAINT "business_workflow_runs_state_check" CHECK ("business_workflow_runs"."state" in ('queued', 'starting', 'running', 'completed', 'failed-to-start', 'failed', 'cancelled')),
	CONSTRAINT "business_workflow_runs_start_attempts_check" CHECK ("business_workflow_runs"."start_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "desktop_release_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"architecture" text NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"public_url" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"notarization_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_release_artifacts_release_platform_arch_kind_unique" UNIQUE("release_id","platform","architecture","kind"),
	CONSTRAINT "desktop_release_artifacts_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "desktop_release_artifacts_platform_check" CHECK ("desktop_release_artifacts"."platform" = 'darwin'),
	CONSTRAINT "desktop_release_artifacts_architecture_check" CHECK ("desktop_release_artifacts"."architecture" in ('arm64', 'x64')),
	CONSTRAINT "desktop_release_artifacts_kind_check" CHECK ("desktop_release_artifacts"."kind" in ('dmg', 'zip')),
	CONSTRAINT "desktop_release_artifacts_size_check" CHECK ("desktop_release_artifacts"."size_bytes" > 0),
	CONSTRAINT "desktop_release_artifacts_sha256_check" CHECK ("desktop_release_artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "desktop_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"release_notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	CONSTRAINT "desktop_releases_version_unique" UNIQUE("version"),
	CONSTRAINT "desktop_releases_state_check" CHECK ("desktop_releases"."state" in ('draft', 'promoted', 'paused', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "business_workflow_effects" ADD CONSTRAINT "business_workflow_effects_business_run_id_business_workflow_runs_id_fk" FOREIGN KEY ("business_run_id") REFERENCES "public"."business_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_workflow_runs" ADD CONSTRAINT "business_workflow_runs_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_release_artifacts" ADD CONSTRAINT "desktop_release_artifacts_release_id_desktop_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."desktop_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_workflow_effects_run_state_idx" ON "business_workflow_effects" USING btree ("business_run_id","state");--> statement-breakpoint
CREATE INDEX "business_workflow_runs_workspace_state_idx" ON "business_workflow_runs" USING btree ("workspace_id","state","updated_at");--> statement-breakpoint
CREATE INDEX "business_workflow_runs_subject_idx" ON "business_workflow_runs" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "desktop_release_artifacts_release_idx" ON "desktop_release_artifacts" USING btree ("release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_releases_one_promoted_unique" ON "desktop_releases" USING btree ("state") WHERE "desktop_releases"."state" = 'promoted';