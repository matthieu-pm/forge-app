CREATE TABLE "workspace_trial_redemptions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"initial_plan" text NOT NULL,
	"actor_user_id" text,
	"start_request_id" uuid NOT NULL,
	"start_body_hash" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"allowance_usd_micros" bigint DEFAULT 5000000 NOT NULL,
	CONSTRAINT "workspace_trial_redemption_plan_check" CHECK ("workspace_trial_redemptions"."initial_plan" IN ('starter','plus')),
	CONSTRAINT "workspace_trial_redemption_window_check" CHECK (isfinite("workspace_trial_redemptions"."started_at") AND isfinite("workspace_trial_redemptions"."expires_at") AND "workspace_trial_redemptions"."expires_at"="workspace_trial_redemptions"."started_at"+interval '336 hours'),
	CONSTRAINT "workspace_trial_redemption_allowance_check" CHECK ("workspace_trial_redemptions"."allowance_usd_micros"=5000000),
	CONSTRAINT "workspace_trial_redemption_hash_check" CHECK ("workspace_trial_redemptions"."start_body_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD COLUMN "trial_redemption_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_trial_redemptions" ADD CONSTRAINT "workspace_trial_redemptions_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_trial_redemptions" ADD CONSTRAINT "workspace_trial_redemptions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_trial_redemption_id_unique" ON "workspace_trial_redemptions" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_trial_redemption_binding_unique" ON "workspace_trial_redemptions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_trial_redemption_request_unique" ON "workspace_trial_redemptions" USING btree ("start_request_id");--> statement-breakpoint
CREATE INDEX "workspace_trial_redemption_expiry_idx" ON "workspace_trial_redemptions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "workspace_entitlements" ADD CONSTRAINT "workspace_entitlements_trial_binding_fk" FOREIGN KEY ("workspace_id","trial_redemption_id") REFERENCES "public"."workspace_trial_redemptions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION public.forge_trial_eligibility() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM id FROM public.organization WHERE id=NEW.workspace_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM public.workspace_entitlements e WHERE e.workspace_id=NEW.workspace_id
    AND (e.source <> 'internal' OR e.plan <> 'free' OR e.status <> 'active' OR e.source_reference IS NOT NULL
      OR e.paid_activated_at IS NOT NULL OR e.provider_environment IS NOT NULL OR e.refunded_periods <> '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Trial requires a never-paid workspace.' USING ERRCODE='23514',CONSTRAINT='workspace_trial_never_paid';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER workspace_trial_eligibility BEFORE INSERT ON public.workspace_trial_redemptions
FOR EACH ROW EXECUTE FUNCTION public.forge_trial_eligibility();
--> statement-breakpoint
CREATE FUNCTION public.forge_guard_trial_redemption() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'Trial redemption cannot be removed.' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW)-'actor_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'actor_user_id')
    OR (NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id AND NEW.actor_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Trial redemption is immutable.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER workspace_trial_immutable BEFORE UPDATE OR DELETE ON public.workspace_trial_redemptions
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_trial_redemption();
--> statement-breakpoint
CREATE FUNCTION public.forge_guard_trial_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE t public.workspace_trial_redemptions%ROWTYPE;
BEGIN
  IF NEW.source <> 'forge-trial' THEN
    NEW.trial_redemption_id := NULL;
    RETURN NEW;
  END IF;
  SELECT * INTO t FROM public.workspace_trial_redemptions
    WHERE workspace_id=NEW.workspace_id AND id=NEW.trial_redemption_id;
  IF NOT FOUND OR NEW.source_reference IS DISTINCT FROM t.id::text
    OR NEW.current_period_start IS DISTINCT FROM t.started_at OR NEW.current_period_end IS DISTINCT FROM t.expires_at
    OR NEW.provider_environment IS NOT NULL OR NEW.provider_updated_at IS NOT NULL OR NEW.provider_state_hash IS NOT NULL
    OR NEW.paid_activated_at IS NOT NULL OR NEW.payment_failed_at IS NOT NULL OR NEW.grace_expires_at IS NOT NULL
    OR NEW.paid_upgrade_order_id IS NOT NULL OR NEW.terminated_at IS NOT NULL OR NEW.unsupported_pause_at IS NOT NULL
    OR NEW.cancel_at_period_end OR NEW.cancellation_period_end IS NOT NULL
    OR NEW.refunded_periods <> '[]'::jsonb OR NEW.feature_overrides <> '{}'::jsonb
    OR NOT ((NEW.status='trialing' AND NEW.plan=CASE t.initial_plan WHEN 'starter' THEN 'basic' ELSE 'business' END)
      OR (NEW.status='canceled' AND NEW.plan='free' AND clock_timestamp() >= t.expires_at)) THEN
    RAISE EXCEPTION 'Invalid trial entitlement binding.' USING ERRCODE='23514',CONSTRAINT='workspace_trial_projection';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER workspace_trial_projection BEFORE INSERT OR UPDATE ON public.workspace_entitlements
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_trial_projection();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.forge_effective_workspace_plan(target_workspace text)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE
  e public.workspace_entitlements%ROWTYPE;
  at timestamptz := clock_timestamp();
  selected text;
  has_upgrade boolean;
BEGIN
  SELECT * INTO e FROM public.workspace_entitlements WHERE workspace_id=target_workspace;
  IF NOT FOUND OR e.terminated_at IS NOT NULL OR
    (e.unsupported_pause_at IS NOT NULL AND e.unsupported_pause_at <= at) THEN RETURN 'free'; END IF;
  selected := CASE WHEN e.plan IN ('basic','starter') THEN 'starter'
    WHEN e.plan IN ('business','plus') THEN 'plus'
    WHEN e.plan='enterprise' THEN 'enterprise' ELSE 'free' END;
  IF selected='free' THEN RETURN 'free'; END IF;
  IF e.source='forge-trial' THEN
    IF e.status='trialing' AND e.provider_environment IS NULL AND e.paid_activated_at IS NULL
      AND NOT e.cancel_at_period_end AND e.current_period_start <= at AND e.current_period_end > at
      AND EXISTS(SELECT 1 FROM public.workspace_trial_redemptions t
        WHERE t.workspace_id=target_workspace AND t.id=e.trial_redemption_id AND t.id::text=e.source_reference
          AND t.started_at=e.current_period_start AND t.expires_at=e.current_period_end
          AND selected=t.initial_plan) THEN RETURN selected; END IF;
    RETURN 'free';
  END IF;
  IF e.source='polar' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(e.refunded_periods) r
    WHERE r->>'environment'=e.provider_environment AND r->>'subscriptionId'=e.source_reference
      AND (r->>'start')::timestamptz < e.current_period_end AND (r->>'end')::timestamptz > e.current_period_start
      AND r->>'kind' IS DISTINCT FROM 'upgrade'
  ) THEN RETURN 'free'; END IF;
  IF e.cancel_at_period_end AND (e.cancellation_period_end IS NULL OR e.cancellation_period_end <= at) THEN RETURN 'free'; END IF;
  IF e.source='polar' THEN
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(e.refunded_periods) r
      WHERE r->>'kind'='upgrade' AND r->>'environment'=e.provider_environment AND r->>'subscriptionId'=e.source_reference
        AND (r->>'start')::timestamptz < e.current_period_end AND (r->>'end')::timestamptz > e.current_period_start
        AND (e.paid_upgrade_order_id IS NULL OR r->>'orderId'=e.paid_upgrade_order_id::text)
    ) INTO has_upgrade;
    IF has_upgrade THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(e.refunded_periods) r
        WHERE r->>'kind'='upgrade' AND r->>'environment'=e.provider_environment AND r->>'subscriptionId'=e.source_reference
          AND (r->>'start')::timestamptz < e.current_period_end AND (r->>'end')::timestamptz > e.current_period_start
          AND (e.paid_upgrade_order_id IS NULL OR r->>'orderId'=e.paid_upgrade_order_id::text)
          AND r->>'starterOrderId' IS NOT NULL
          AND (r->>'basePeriodStart')::timestamptz <= at AND (r->>'basePeriodEnd')::timestamptz > at
      ) THEN RETURN 'starter'; ELSE RETURN 'free'; END IF;
    END IF;
  END IF;
  IF e.status IN ('active','trialing') OR (e.source='polar' AND e.status='canceled' AND e.cancel_at_period_end) THEN
    IF e.source='polar' AND (
      e.status NOT IN ('active','canceled') OR e.paid_activated_at IS NULL OR NOT isfinite(e.paid_activated_at)
      OR e.paid_activated_at > at OR e.current_period_start IS NULL OR e.current_period_end IS NULL
      OR e.current_period_start >= e.current_period_end OR e.current_period_start > at OR e.current_period_end <= at
    ) THEN RETURN 'free'; END IF;
    RETURN selected;
  END IF;
  IF e.status='past_due' AND e.source='polar' AND e.paid_activated_at IS NOT NULL
    AND isfinite(e.paid_activated_at) AND e.paid_activated_at < e.payment_failed_at
    AND e.payment_failed_at <= at AND e.grace_expires_at=e.payment_failed_at+interval '168 hours'
    AND e.grace_expires_at > at THEN RETURN selected; END IF;
  RETURN 'free';
END;
$$;
--> statement-breakpoint
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
        OR public.forge_effective_workspace_plan(target_workspace) <> 'free'
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
