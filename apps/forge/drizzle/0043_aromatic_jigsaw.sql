CREATE TABLE "command_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"actor_user_id" text NOT NULL,
	"operation" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_audit_command_unique" UNIQUE("command_id")
);
--> statement-breakpoint
CREATE TABLE "command_outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_outbox_command_ordinal_unique" UNIQUE("command_id","ordinal"),
	CONSTRAINT "command_outbox_ordinal_check" CHECK ("command_outbox_events"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "command_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"principal" text NOT NULL,
	"operation" text NOT NULL,
	"command_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"response_body" text,
	"response_status" integer,
	"resource_type" text,
	"resource_id" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_receipts_scope_key_unique" UNIQUE("workspace_id","principal","operation","command_key"),
	CONSTRAINT "command_receipts_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "command_receipts_hash_check" CHECK ("command_receipts"."input_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "command_receipts_result_check" CHECK (("command_receipts"."completed_at" IS NULL AND "command_receipts"."response_body" IS NULL AND "command_receipts"."response_status" IS NULL) OR ("command_receipts"."completed_at" IS NOT NULL AND "command_receipts"."response_status" BETWEEN 200 AND 299 AND "command_receipts"."resource_id" IS NOT NULL AND "command_receipts"."resource_type" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "command_audit_events" ADD CONSTRAINT "command_audit_receipt_fk" FOREIGN KEY ("workspace_id","command_id") REFERENCES "public"."command_receipts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_outbox_events" ADD CONSTRAINT "command_outbox_receipt_fk" FOREIGN KEY ("workspace_id","command_id") REFERENCES "public"."command_receipts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_receipts" ADD CONSTRAINT "command_receipts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "command_outbox_created_idx" ON "command_outbox_events" USING btree ("created_at","id");
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.command_receipts FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','user_id','principal','operation','command_key','input_hash','created_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.command_audit_events FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','command_id','actor_user_id','operation','resource_type','resource_id','created_at');
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.command_outbox_events FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','command_id','ordinal','topic','payload','created_at');
--> statement-breakpoint
-- Completed identity/result cannot be rewritten. Explicit result redaction retains
-- the key/hash tombstone so a content-retention sweep cannot re-admit the effect.
CREATE FUNCTION public.forge_command_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.completed_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='command_receipt_lifetime', MESSAGE='Retain command identity until workspace deletion';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.completed_at IS NOT NULL AND (
    NEW.completed_at IS DISTINCT FROM OLD.completed_at OR
    NEW.response_status IS DISTINCT FROM OLD.response_status OR
    NEW.resource_type IS DISTINCT FROM OLD.resource_type OR
    NEW.resource_id IS DISTINCT FROM OLD.resource_id OR
    (NEW.response_body IS DISTINCT FROM OLD.response_body AND NEW.response_body IS NOT NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='command_receipt_terminal', MESSAGE='Completed command evidence is immutable except result redaction';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_command_receipt_guard BEFORE UPDATE OR DELETE ON public.command_receipts FOR EACH ROW EXECUTE FUNCTION public.forge_command_receipt_guard();
--> statement-breakpoint
-- A command reservation is transaction-local, never a lease that can expire.
-- Check the final row at COMMIT, after business/history/outbox have been written.
CREATE FUNCTION public.forge_command_commit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt public.command_receipts;
BEGIN
  SELECT * INTO receipt FROM public.command_receipts WHERE id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF receipt.completed_at IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.command_audit_events a WHERE a.command_id=receipt.id
    AND a.workspace_id=receipt.workspace_id AND a.actor_user_id=receipt.user_id
    AND a.operation=receipt.operation AND a.resource_type=receipt.resource_type
    AND a.resource_id=receipt.resource_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='command_atomic_completion', MESSAGE='Command completion and matching audit must commit together';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER forge_command_commit_guard AFTER INSERT OR UPDATE ON public.command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forge_command_commit_guard();
