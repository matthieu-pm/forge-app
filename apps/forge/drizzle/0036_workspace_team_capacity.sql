CREATE TABLE "workspace_team_capacity" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"active_team_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_team_capacity_nonnegative" CHECK ("workspace_team_capacity"."active_team_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_team_capacity" ADD CONSTRAINT "workspace_team_capacity_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Preserve grandfathered teams while installing an exact active counter.
LOCK TABLE public.organization, public.teams IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO public.workspace_team_capacity(workspace_id,active_team_count)
SELECT o.id,count(t.id)::integer FROM public.organization o
LEFT JOIN public.teams t ON t.workspace_id=o.id AND t.deleted_at IS NULL GROUP BY o.id;
--> statement-breakpoint
-- Mirrors subscriptionAccess, including verified Starter fallback after a
-- refunded Plus upgrade. VOLATILE obtains fresh state after an admission waits.
CREATE FUNCTION public.forge_effective_workspace_plan(target_workspace text)
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
REVOKE ALL ON FUNCTION public.forge_effective_workspace_plan(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.forge_adjust_workspace_team_capacity(target_workspace text, amount integer)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_plan text; team_limit integer;
BEGIN
  -- Same workspace fence as billing reconciliation. NO KEY UPDATE is compatible
  -- with the FK KEY SHARE held by concurrent team inserts, avoiding lock upgrades.
  PERFORM id FROM public.organization WHERE id=target_workspace FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF amount=1 THEN
    current_plan := public.forge_effective_workspace_plan(target_workspace);
    team_limit := CASE current_plan WHEN 'free' THEN 2 WHEN 'starter' THEN 5 ELSE NULL END;
    UPDATE public.workspace_team_capacity SET active_team_count=active_team_count+1
    WHERE workspace_id=target_workspace AND (team_limit IS NULL OR active_team_count < team_limit);
    IF NOT FOUND THEN
      IF NOT EXISTS (SELECT 1 FROM public.workspace_team_capacity WHERE workspace_id=target_workspace) THEN
        RAISE EXCEPTION 'Workspace team capacity state is missing.' USING ERRCODE='P0001';
      END IF;
      RAISE EXCEPTION 'The workspace has reached its plan team limit.'
        USING ERRCODE='23514',CONSTRAINT='workspace_team_limit';
    END IF;
  ELSIF amount=-1 THEN
    UPDATE public.workspace_team_capacity SET active_team_count=active_team_count-1
    WHERE workspace_id=target_workspace AND active_team_count>0;
    IF NOT FOUND THEN RAISE EXCEPTION 'Workspace team capacity state is inconsistent.' USING ERRCODE='P0001'; END IF;
  ELSE RAISE EXCEPTION 'Invalid workspace team capacity adjustment.'; END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_adjust_workspace_team_capacity(text,integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.forge_track_workspace_team_capacity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='organization' THEN
    INSERT INTO public.workspace_team_capacity(workspace_id) VALUES(NEW.id); RETURN NEW;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.deleted_at IS NULL THEN PERFORM public.forge_adjust_workspace_team_capacity(NEW.workspace_id,1); END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.deleted_at IS NULL AND EXISTS(SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
      PERFORM public.forge_adjust_workspace_team_capacity(OLD.workspace_id,-1);
    END IF; RETURN OLD;
  ELSE
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
      PERFORM id FROM public.organization WHERE id IN (OLD.workspace_id,NEW.workspace_id) ORDER BY id FOR NO KEY UPDATE;
    END IF;
    IF OLD.deleted_at IS NULL AND (NEW.deleted_at IS NOT NULL OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
      PERFORM public.forge_adjust_workspace_team_capacity(OLD.workspace_id,-1);
    END IF;
    IF NEW.deleted_at IS NULL AND (OLD.deleted_at IS NOT NULL OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
      PERFORM public.forge_adjust_workspace_team_capacity(NEW.workspace_id,1);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_team_capacity_new_organization AFTER INSERT ON public.organization
FOR EACH ROW EXECUTE FUNCTION public.forge_track_workspace_team_capacity();
--> statement-breakpoint
-- AFTER INSERT leaves ON CONFLICT DO NOTHING retries unchanged at/over capacity.
CREATE TRIGGER workspace_team_capacity_team_write AFTER INSERT OR UPDATE OR DELETE ON public.teams
FOR EACH ROW EXECUTE FUNCTION public.forge_track_workspace_team_capacity();
