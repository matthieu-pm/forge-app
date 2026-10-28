ALTER TABLE "workspace_entitlements" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "cancellation_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_cancellation_check" CHECK ((NOT "workspace_entitlements"."cancel_at_period_end" AND "workspace_entitlements"."cancellation_period_end" IS NULL) OR ("workspace_entitlements"."source" = 'polar' AND "workspace_entitlements"."cancel_at_period_end" AND "workspace_entitlements"."cancellation_period_end" IS NOT NULL AND isfinite("workspace_entitlements"."cancellation_period_end") AND "workspace_entitlements"."current_period_start" IS NOT NULL AND "workspace_entitlements"."current_period_end" IS NOT NULL AND "workspace_entitlements"."current_period_start" < "workspace_entitlements"."cancellation_period_end" AND "workspace_entitlements"."cancellation_period_end" <= "workspace_entitlements"."current_period_end"));
--> statement-breakpoint
-- Keep member admission aligned with time-aware scheduled cancellation.
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
              ((e.status IN ('active','trialing') OR (e.status = 'canceled' AND e.cancel_at_period_end)) AND (
                e.source <> 'polar' OR (
                  e.status IN ('active','canceled')
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
            AND (NOT e.cancel_at_period_end OR e.cancellation_period_end > clock_timestamp())
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
