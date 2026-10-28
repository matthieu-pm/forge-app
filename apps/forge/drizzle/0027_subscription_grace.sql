CREATE TABLE "billing_event_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"environment" text NOT NULL,
	"event_id" text NOT NULL,
	"body_hash" text NOT NULL,
	"subscription_id" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_event_receipts_environment_event_unique" UNIQUE("environment","event_id"),
	CONSTRAINT "billing_event_receipts_environment_check" CHECK ("billing_event_receipts"."environment" IN ('sandbox','production')),
	CONSTRAINT "billing_event_receipts_hash_check" CHECK ("billing_event_receipts"."body_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "billing_event_receipts_outcome_check" CHECK ("billing_event_receipts"."outcome" IN ('applied','stale','unchanged'))
);
--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "provider_environment" text;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "provider_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "provider_state_hash" text;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "paid_activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "payment_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "grace_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "current_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "current_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_event_receipts" ADD CONSTRAINT "billing_event_receipts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_provider_identity_check" CHECK ("workspace_entitlements"."source" <> 'polar' OR ("workspace_entitlements"."provider_environment" IS NOT NULL AND "workspace_entitlements"."provider_environment" IN ('sandbox','production') AND "workspace_entitlements"."source_reference" IS NOT NULL AND "workspace_entitlements"."provider_updated_at" IS NOT NULL AND isfinite("workspace_entitlements"."provider_updated_at") AND "workspace_entitlements"."provider_state_hash" IS NOT NULL AND "workspace_entitlements"."provider_state_hash" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_period_check" CHECK (("workspace_entitlements"."current_period_start" IS NULL AND "workspace_entitlements"."current_period_end" IS NULL) OR ("workspace_entitlements"."current_period_start" IS NOT NULL AND "workspace_entitlements"."current_period_end" IS NOT NULL AND isfinite("workspace_entitlements"."current_period_start") AND isfinite("workspace_entitlements"."current_period_end") AND "workspace_entitlements"."current_period_start" < "workspace_entitlements"."current_period_end"));--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_grace_check" CHECK (("workspace_entitlements"."payment_failed_at" IS NULL AND "workspace_entitlements"."grace_expires_at" IS NULL) OR ("workspace_entitlements"."source" = 'polar' AND "workspace_entitlements"."status" = 'past_due' AND "workspace_entitlements"."payment_failed_at" IS NOT NULL AND "workspace_entitlements"."grace_expires_at" IS NOT NULL AND "workspace_entitlements"."paid_activated_at" IS NOT NULL AND isfinite("workspace_entitlements"."paid_activated_at") AND isfinite("workspace_entitlements"."payment_failed_at") AND "workspace_entitlements"."paid_activated_at" < "workspace_entitlements"."payment_failed_at" AND "workspace_entitlements"."grace_expires_at" = "workspace_entitlements"."payment_failed_at" + interval '168 hours'));
--> statement-breakpoint
-- Preserve the counter invariant while allowing only a validated, unexpired paid grace.
CREATE OR REPLACE FUNCTION public.forge_adjust_workspace_member_capacity(target_workspace text, amount integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF amount = 1 THEN
    -- The conditional UPDATE serializes admissions on one canonical row. Unlike
    -- a SELECT count followed by INSERT, two concurrent writers cannot both
    -- consume the final Free slot. All accepted roles count; invitations do not.
    UPDATE public.workspace_member_capacity AS capacity
    SET active_member_count = capacity.active_member_count + 1
    WHERE capacity.workspace_id = target_workspace
      AND (
        capacity.active_member_count < 5
        OR EXISTS (
          SELECT 1 FROM public.workspace_entitlements e
          WHERE e.workspace_id = target_workspace
            AND (
              (e.status IN ('active','trialing') AND (
                e.source <> 'polar' OR (
                  e.status = 'active'
                  AND e.paid_activated_at IS NOT NULL
                  AND isfinite(e.paid_activated_at)
                  AND e.paid_activated_at <= clock_timestamp()
                  AND e.current_period_start <= clock_timestamp()
                  AND e.current_period_end > clock_timestamp()
                )
              ))
              OR (e.status = 'past_due' AND e.source = 'polar'
                AND e.paid_activated_at IS NOT NULL
                AND e.paid_activated_at < e.payment_failed_at
                AND e.payment_failed_at <= clock_timestamp()
                AND e.grace_expires_at = e.payment_failed_at + interval '168 hours'
                AND e.grace_expires_at > clock_timestamp()
              )
            )
            -- Explicit legacy names remain valid until their planned migration.
            -- Unknown plans/statuses never acquire paid capacity by accident.
            AND e.plan IN ('basic', 'business', 'starter', 'plus', 'enterprise')
        )
      );
    IF NOT FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.workspace_member_capacity WHERE workspace_id = target_workspace) THEN
        RAISE EXCEPTION 'Workspace member capacity state is missing.'
          USING ERRCODE = 'P0001';
      END IF;
      RAISE EXCEPTION 'This Free workspace has reached its five-member limit.'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_free_member_limit';
    END IF;
  ELSIF amount = -1 THEN
    UPDATE public.workspace_member_capacity
    SET active_member_count = active_member_count - 1
    WHERE workspace_id = target_workspace AND active_member_count > 0;
    IF NOT FOUND AND EXISTS (SELECT 1 FROM public."organization" WHERE id = target_workspace) THEN
      RAISE EXCEPTION 'Workspace member capacity state is inconsistent.'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid workspace member capacity adjustment.';
  END IF;
END;
$$;

--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_adjust_workspace_member_capacity(text, integer) FROM PUBLIC;
