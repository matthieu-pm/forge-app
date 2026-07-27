ALTER TABLE "workspace_approved_domains" ALTER COLUMN "verified_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_approved_domains" ALTER COLUMN "verified_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_approved_domains" ADD COLUMN "verification_code" text;--> statement-breakpoint
ALTER TABLE "workspace_approved_domains" ADD COLUMN "verification_expires_at" timestamp with time zone;