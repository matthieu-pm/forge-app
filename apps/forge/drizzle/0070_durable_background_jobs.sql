CREATE TABLE "background_job_recoveries" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"operator_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"step" text,
	"outcome" text,
	"evidence" text,
	"quiesced" boolean DEFAULT false NOT NULL,
	"database_role" text DEFAULT session_user NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_job_steps" (
	"job_id" uuid NOT NULL,
	"key" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"idempotency_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "background_job_steps_mode" CHECK ("background_job_steps"."mode" IN ('transactional','provider-idempotent','reconcile')),
	CONSTRAINT "background_job_steps_state" CHECK ("background_job_steps"."state" IN ('pending','started','completed')),
	CONSTRAINT "background_job_steps_atomic" CHECK ("background_job_steps"."mode"<>'transactional' OR "background_job_steps"."state"='completed'),
	CONSTRAINT "background_job_steps_deadline" CHECK ("background_job_steps"."mode"<>'provider-idempotent' OR "background_job_steps"."state"<>'started' OR "background_job_steps"."idempotency_until" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"identity" text NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"total_attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "background_jobs_state" CHECK ("background_jobs"."state" IN ('queued','running','retry','completed','dead','reconcile')),
	CONSTRAINT "background_jobs_attempts" CHECK ("background_jobs"."attempts">=0 AND "background_jobs"."total_attempts">="background_jobs"."attempts" AND "background_jobs"."max_attempts" BETWEEN 1 AND 20 AND "background_jobs"."generation">=0),
	CONSTRAINT "background_jobs_lease" CHECK (("background_jobs"."state"='running' AND "background_jobs"."lease_token" IS NOT NULL AND "background_jobs"."lease_until" IS NOT NULL) OR ("background_jobs"."state"<>'running' AND "background_jobs"."lease_token" IS NULL AND "background_jobs"."lease_until" IS NULL)),
	CONSTRAINT "background_jobs_completion" CHECK (("background_jobs"."state"='completed')=("background_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "background_job_recoveries" ADD CONSTRAINT "background_job_recoveries_job_id_background_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."background_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_steps" ADD CONSTRAINT "background_job_steps_job_id_background_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."background_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "background_job_steps_identity" ON "background_job_steps" USING btree ("job_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_identity" ON "background_jobs" USING btree ("kind","scope","identity");--> statement-breakpoint
CREATE INDEX "background_jobs_due" ON "background_jobs" USING btree ("state","available_at");