DROP INDEX "background_job_steps_identity";--> statement-breakpoint
ALTER TABLE "background_job_steps" ADD CONSTRAINT "background_job_steps_pk" PRIMARY KEY("job_id","key");