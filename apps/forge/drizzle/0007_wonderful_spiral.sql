CREATE TABLE "api_idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"operation_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_idempotency_credential_operation_key_unique" UNIQUE("credential_id","operation_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_credential_id_apikey_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_idempotency_expires_at_idx" ON "api_idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "api_idempotency_workspace_id_idx" ON "api_idempotency_keys" USING btree ("workspace_id");