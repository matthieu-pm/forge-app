CREATE TABLE "agent_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"requested_for_user_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"risk" text NOT NULL,
	"input_hash" text NOT NULL,
	"redacted_input_summary" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"nonce" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	CONSTRAINT "agent_approvals_nonce_unique" UNIQUE("nonce"),
	CONSTRAINT "agent_approvals_risk_check" CHECK ("agent_approvals"."risk" in ('read', 'reversible-write', 'important-write', 'destructive')),
	CONSTRAINT "agent_approvals_state_check" CHECK ("agent_approvals"."state" in ('pending', 'approved', 'denied', 'expired', 'consumed')),
	CONSTRAINT "agent_approvals_input_hash_check" CHECK ("agent_approvals"."input_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_reference" text NOT NULL,
	"checksum" text NOT NULL,
	"retention_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_artifacts_size_check" CHECK ("agent_artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"payload_json" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_events_run_sequence_unique" UNIQUE("run_id","sequence"),
	CONSTRAINT "agent_events_run_source_event_unique" UNIQUE("run_id","source_event_id"),
	CONSTRAINT "agent_events_source_check" CHECK ("agent_events"."source" in ('eve', 'codex', 'claude', 'forge')),
	CONSTRAINT "agent_events_sequence_check" CHECK ("agent_events"."sequence" > 0),
	CONSTRAINT "agent_events_schema_version_check" CHECK ("agent_events"."schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"initiated_by_user_id" text NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"execution_kind" text NOT NULL,
	"requested_selection" jsonb NOT NULL,
	"resolved_connection_id" uuid,
	"resolved_model_id" text,
	"reasoning_effort" text,
	"routing_policy_version" text,
	"routing_reason" text,
	"runtime_run_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_runtime_run_unique" UNIQUE("execution_kind","runtime_run_id"),
	CONSTRAINT "agent_runs_state_check" CHECK ("agent_runs"."state" in ('created', 'connecting', 'running', 'waiting-for-approval', 'reconnecting', 'cancelled', 'failed', 'completed')),
	CONSTRAINT "agent_runs_execution_kind_check" CHECK ("agent_runs"."execution_kind" in ('forge-native', 'external-agent')),
	CONSTRAINT "agent_runs_effort_check" CHECK ("agent_runs"."reasoning_effort" is null or "agent_runs"."reasoning_effort" in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
	CONSTRAINT "agent_runs_token_counters_check" CHECK ("agent_runs"."input_tokens" >= 0 and "agent_runs"."output_tokens" >= 0 and "agent_runs"."cached_input_tokens" >= 0 and "agent_runs"."cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"title" text DEFAULT 'New chat' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"runtime_kind" text DEFAULT 'eve' NOT NULL,
	"runtime_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_threads_runtime_session_unique" UNIQUE("runtime_kind","runtime_session_id"),
	CONSTRAINT "agent_threads_status_check" CHECK ("agent_threads"."status" in ('active', 'archived')),
	CONSTRAINT "agent_threads_runtime_kind_check" CHECK ("agent_threads"."runtime_kind" in ('eve', 'codex', 'claude'))
);
--> statement-breakpoint
CREATE TABLE "model_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"selection_id" text NOT NULL,
	"provider_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"provider_label" text NOT NULL,
	"source_label" text NOT NULL,
	"execution_kind" text NOT NULL,
	"input_modalities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_code" boolean DEFAULT false NOT NULL,
	"supported_reasoning_efforts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_window_tokens" integer,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_entries_selection_id_unique" UNIQUE("selection_id"),
	CONSTRAINT "model_catalog_entries_connection_model_unique" UNIQUE("connection_id","provider_model_id"),
	CONSTRAINT "model_catalog_entries_execution_kind_check" CHECK ("model_catalog_entries"."execution_kind" in ('forge-native', 'external-agent')),
	CONSTRAINT "model_catalog_entries_status_check" CHECK ("model_catalog_entries"."status" in ('available', 'unavailable', 'deprecated', 'hidden')),
	CONSTRAINT "model_catalog_entries_context_window_check" CHECK ("model_catalog_entries"."context_window_tokens" is null or "model_catalog_entries"."context_window_tokens" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text,
	"scope" text NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"execution_kind" text NOT NULL,
	"locality" text NOT NULL,
	"billing_mode" text NOT NULL,
	"credential_owner" text NOT NULL,
	"display_name" text NOT NULL,
	"masked_credential_suffix" text,
	"secret_reference" text,
	"executable_reference" text,
	"endpoint_url" text,
	"status" text DEFAULT 'ready' NOT NULL,
	"status_reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone,
	"last_health_checked_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connections_scope_check" CHECK ("model_connections"."scope" in ('personal', 'workspace')),
	CONSTRAINT "model_connections_scope_owner_check" CHECK (("model_connections"."scope" = 'personal' and "model_connections"."user_id" is not null) or ("model_connections"."scope" = 'workspace' and "model_connections"."user_id" is null)),
	CONSTRAINT "model_connections_kind_check" CHECK ("model_connections"."kind" in ('managed', 'api-key', 'workload-identity', 'local-agent')),
	CONSTRAINT "model_connections_execution_kind_check" CHECK ("model_connections"."execution_kind" in ('forge-native', 'external-agent')),
	CONSTRAINT "model_connections_locality_check" CHECK ("model_connections"."locality" in ('local-only', 'server-capable')),
	CONSTRAINT "model_connections_billing_mode_check" CHECK ("model_connections"."billing_mode" in ('forge-managed', 'subscription', 'token-plan', 'pay-as-you-go')),
	CONSTRAINT "model_connections_credential_owner_check" CHECK ("model_connections"."credential_owner" in ('forge-local-vault', 'forge-server-vault', 'provider-process')),
	CONSTRAINT "model_connections_status_check" CHECK ("model_connections"."status" in ('ready', 'login-required', 'expired', 'repair-required', 'unavailable', 'policy-blocked'))
);
--> statement-breakpoint
CREATE TABLE "thread_model_preferences" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'auto' NOT NULL,
	"selected_connection_id" uuid,
	"selected_model_id" text,
	"selected_effort" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_model_preferences_mode_check" CHECK ("thread_model_preferences"."mode" in ('auto', 'manual')),
	CONSTRAINT "thread_model_preferences_selection_check" CHECK (("thread_model_preferences"."mode" = 'auto' and "thread_model_preferences"."selected_connection_id" is null and "thread_model_preferences"."selected_model_id" is null) or ("thread_model_preferences"."mode" = 'manual' and "thread_model_preferences"."selected_connection_id" is not null and "thread_model_preferences"."selected_model_id" is not null)),
	CONSTRAINT "thread_model_preferences_effort_check" CHECK ("thread_model_preferences"."selected_effort" is null or "thread_model_preferences"."selected_effort" in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'))
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_requested_for_user_id_user_id_fk" FOREIGN KEY ("requested_for_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_initiated_by_user_id_user_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_resolved_connection_id_model_connections_id_fk" FOREIGN KEY ("resolved_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD CONSTRAINT "agent_threads_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog_entries" ADD CONSTRAINT "model_catalog_entries_connection_id_model_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."model_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_model_preferences" ADD CONSTRAINT "thread_model_preferences_thread_id_agent_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_model_preferences" ADD CONSTRAINT "thread_model_preferences_selected_connection_id_model_connections_id_fk" FOREIGN KEY ("selected_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_approvals_pending_idx" ON "agent_approvals" USING btree ("requested_for_user_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "agent_approvals_run_idx" ON "agent_approvals" USING btree ("run_id","requested_at");--> statement-breakpoint
CREATE INDEX "agent_artifacts_run_created_idx" ON "agent_artifacts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_artifacts_checksum_idx" ON "agent_artifacts" USING btree ("checksum");--> statement-breakpoint
CREATE INDEX "agent_events_thread_occurred_idx" ON "agent_events" USING btree ("thread_id","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_runs_thread_created_idx" ON "agent_runs" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_state_idx" ON "agent_runs" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "agent_threads_workspace_activity_idx" ON "agent_threads" USING btree ("workspace_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "agent_threads_user_activity_idx" ON "agent_threads" USING btree ("created_by_user_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "model_catalog_entries_connection_status_idx" ON "model_catalog_entries" USING btree ("connection_id","status");--> statement-breakpoint
CREATE INDEX "model_connections_workspace_idx" ON "model_connections" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "model_connections_owner_idx" ON "model_connections" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "model_connections_provider_idx" ON "model_connections" USING btree ("workspace_id","provider");