-- Preserve the fencing row for the whole workspace lifetime. Deleting and
-- recreating it could otherwise let a repeatable-read transaction manufacture a
-- fresh mutex while retaining a stale graph snapshot. Workspace cascade is safe.
CREATE FUNCTION public.forge_issue_graph_guard_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='issue_graph_guard_lifetime', MESSAGE='Issue graph guard belongs to the workspace lifetime';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_issue_graph_guard_lifecycle BEFORE DELETE ON public.issue_hierarchy_guards FOR EACH ROW EXECUTE FUNCTION public.forge_issue_graph_guard_lifecycle();
