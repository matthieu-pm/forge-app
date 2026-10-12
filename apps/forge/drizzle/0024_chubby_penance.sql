CREATE TABLE "workspace_emojis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"image" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspace_emojis_name_check" CHECK ("workspace_emojis"."name" ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
	CONSTRAINT "workspace_emojis_image_size_check" CHECK (length("workspace_emojis"."image") <= 350000)
);
--> statement-breakpoint
ALTER TABLE "workspace_emojis" ADD CONSTRAINT "workspace_emojis_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_emojis" ADD CONSTRAINT "workspace_emojis_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_emojis_active_name_unique" ON "workspace_emojis" USING btree ("workspace_id","name") WHERE "workspace_emojis"."deleted_at" is null;