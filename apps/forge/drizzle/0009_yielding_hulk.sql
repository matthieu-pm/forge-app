CREATE TABLE "agent_capability_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"capability_id" text NOT NULL,
	"capability_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"state" text DEFAULT 'in-progress' NOT NULL,
	"result_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_capability_invocations_unique" UNIQUE("workspace_id","user_id","run_id","capability_id","capability_version","idempotency_key"),
	CONSTRAINT "agent_capability_invocations_state_check" CHECK ("agent_capability_invocations"."state" in ('in-progress', 'completed')),
	CONSTRAINT "agent_capability_invocations_input_hash_check" CHECK ("agent_capability_invocations"."input_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD COLUMN "capability_version" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_capability_invocations" ADD CONSTRAINT "agent_capability_invocations_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_invocations" ADD CONSTRAINT "agent_capability_invocations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_invocations" ADD CONSTRAINT "agent_capability_invocations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_capability_invocations_expires_at_idx" ON "agent_capability_invocations" USING btree ("expires_at");