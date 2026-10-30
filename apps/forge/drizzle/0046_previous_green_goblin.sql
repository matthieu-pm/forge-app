CREATE TABLE "file_upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"command_key" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"target" jsonb NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" text NOT NULL,
	"storage_reference" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"rejection_reason" text,
	"cleaned_at" timestamp with time zone,
	CONSTRAINT "file_upload_intents_command_unique" UNIQUE("workspace_id","user_id","command_key"),
	CONSTRAINT "file_upload_intents_reference_unique" UNIQUE("storage_reference"),
	CONSTRAINT "file_upload_intents_state" CHECK ("file_upload_intents"."state" IN ('pending','ready','rejected','expired')),
	CONSTRAINT "file_upload_intents_size" CHECK ("file_upload_intents"."size_bytes" > 0 AND "file_upload_intents"."size_bytes" <= 100000000),
	CONSTRAINT "file_upload_intents_checksum" CHECK ("file_upload_intents"."checksum" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "file_upload_intents_ready" CHECK (("file_upload_intents"."state" = 'ready') = ("file_upload_intents"."result" IS NOT NULL)),
	CONSTRAINT "file_upload_intents_expiry" CHECK ("file_upload_intents"."expires_at" > "file_upload_intents"."created_at")
);
--> statement-breakpoint
CREATE INDEX "file_upload_intents_account_usage_idx" ON "file_upload_intents" USING btree ("user_id","state","completed_at");--> statement-breakpoint
CREATE INDEX "file_upload_intents_workspace_usage_idx" ON "file_upload_intents" USING btree ("workspace_id","state","completed_at");--> statement-breakpoint
CREATE INDEX "file_upload_intents_cleanup_idx" ON "file_upload_intents" USING btree ("state","cleaned_at","expires_at");