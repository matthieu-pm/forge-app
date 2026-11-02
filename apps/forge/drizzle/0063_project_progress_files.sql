ALTER TABLE "resource_files" DROP CONSTRAINT "resource_files_attachment_state";--> statement-breakpoint
ALTER TABLE "resource_files" DROP CONSTRAINT "resource_files_one_resource";--> statement-breakpoint
ALTER TABLE "resource_files" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_files" ADD COLUMN "project_post_id" uuid;--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_project_post" CHECK ("resource_files"."project_post_id" IS NULL OR ("resource_files"."project_id" IS NOT NULL AND "resource_files"."attachment_state" IN ('attached','detached')));--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_attachment_state" CHECK ("resource_files"."attachment_state" IS NULL OR (( "resource_files"."issue_id" IS NOT NULL OR "resource_files"."project_id" IS NOT NULL) AND "resource_files"."attachment_state" IN ('unbound','attached','detached')));--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_one_resource" CHECK (num_nonnulls("resource_files"."issue_id", "resource_files"."document_id", "resource_files"."project_id") = 1);