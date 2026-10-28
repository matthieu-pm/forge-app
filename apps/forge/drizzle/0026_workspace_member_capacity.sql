CREATE TABLE "workspace_member_capacity" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"active_member_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_member_capacity_nonnegative" CHECK ("workspace_member_capacity"."active_member_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "workspace_member_capacity" ADD CONSTRAINT "workspace_member_capacity_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Keep the backfill and trigger installation consistent with concurrent writes.
-- Drizzle applies this migration in a transaction; no members are deleted.
LOCK TABLE public."organization", public."member" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO public.workspace_member_capacity (workspace_id, active_member_count)
SELECT o.id, count(m.id)::integer
FROM public."organization" o
LEFT JOIN public."member" m ON m.organization_id = o.id
GROUP BY o.id;
--> statement-breakpoint
CREATE FUNCTION public.forge_adjust_workspace_member_capacity(target_workspace text, amount integer)
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
            AND e.status IN ('active', 'trialing')
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
-- The helper is internal to the trusted database runtime, not a public RPC.
REVOKE ALL ON FUNCTION public.forge_adjust_workspace_member_capacity(text, integer) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.forge_track_workspace_member_capacity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_TABLE_NAME = 'organization' THEN
    INSERT INTO public.workspace_member_capacity (workspace_id) VALUES (NEW.id);
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.forge_adjust_workspace_member_capacity(NEW.organization_id, 1);
  ELSIF TG_OP = 'DELETE' THEN
    -- During organization cascade deletion its capacity row may be gone already.
    IF EXISTS (SELECT 1 FROM public."organization" WHERE id = OLD.organization_id) THEN
      PERFORM public.forge_adjust_workspace_member_capacity(OLD.organization_id, -1);
    END IF;
    RETURN OLD;
  ELSIF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    -- Deterministic locking for cross-workspace moves. A failed destination
    -- admission rolls back both the member move and the source decrement.
    PERFORM workspace_id FROM public.workspace_member_capacity
      WHERE workspace_id IN (OLD.organization_id, NEW.organization_id)
      ORDER BY workspace_id FOR UPDATE;
    PERFORM public.forge_adjust_workspace_member_capacity(OLD.organization_id, -1);
    PERFORM public.forge_adjust_workspace_member_capacity(NEW.organization_id, 1);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_member_capacity_new_organization
AFTER INSERT ON public."organization" FOR EACH ROW
EXECUTE FUNCTION public.forge_track_workspace_member_capacity();
--> statement-breakpoint
-- AFTER INSERT does not fire for ON CONFLICT DO NOTHING, preserving existing
-- member retries even in grandfathered, over-capacity Free workspaces.
CREATE TRIGGER workspace_member_capacity_membership_write
AFTER INSERT OR UPDATE OR DELETE ON public."member" FOR EACH ROW
EXECUTE FUNCTION public.forge_track_workspace_member_capacity();
