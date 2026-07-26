ALTER TABLE "teams" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "estimation_scheme" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "issue_email_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "detailed_history_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_estimation_scheme_check" CHECK ("teams"."estimation_scheme" in ('none', 'exponential', 'fibonacci', 'linear', 'tshirt'));