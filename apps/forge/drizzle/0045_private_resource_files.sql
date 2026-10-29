CREATE TABLE "resource_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"issue_id" uuid,
	"document_id" uuid,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"storage_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "resource_files_storage_reference_unique" UNIQUE("storage_reference"),
	CONSTRAINT "resource_files_one_resource" CHECK (num_nonnulls("resource_files"."issue_id", "resource_files"."document_id") = 1),
	CONSTRAINT "resource_files_size_positive" CHECK ("resource_files"."size_bytes" > 0),
	CONSTRAINT "resource_files_checksum" CHECK ("resource_files"."checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "resource_files_reference" CHECK ("resource_files"."storage_reference" ~ '^files/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_issue_fk" FOREIGN KEY ("workspace_id","issue_id") REFERENCES "public"."issues"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_files" ADD CONSTRAINT "resource_files_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."documents"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.resource_files FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','created_by_user_id','issue_id','document_id','storage_reference','checksum','size_bytes');
