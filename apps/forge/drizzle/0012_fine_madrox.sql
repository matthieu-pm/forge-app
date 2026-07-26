CREATE TABLE "agent_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_reference" text NOT NULL,
	"checksum" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_attachments_storage_reference_unique" UNIQUE("storage_reference"),
	CONSTRAINT "agent_attachments_size_check" CHECK ("agent_attachments"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_attachments" ADD CONSTRAINT "agent_attachments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_attachments_owner_expiry_idx" ON "agent_attachments" USING btree ("workspace_id","user_id","expires_at");--> statement-breakpoint
CREATE INDEX "agent_attachments_expiry_idx" ON "agent_attachments" USING btree ("expires_at","deleted_at");