CREATE INDEX "issue_relations_target_idx" ON "issue_relations" USING btree ("workspace_id","related_issue_id","kind","issue_id");--> statement-breakpoint
CREATE INDEX "issues_parent_idx" ON "issues" USING btree ("workspace_id","parent_id","id");--> statement-breakpoint
-- Existing edges, including recoverable deletions, must already form a DAG.
LOCK TABLE public.issues, public.issue_relations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (
  WITH RECURSIVE paths(workspace_id,source,target) AS (
   SELECT workspace_id,issue_id,related_issue_id FROM public.issue_relations WHERE kind='blocks'
   UNION
   SELECT p.workspace_id,p.source,r.related_issue_id FROM paths p JOIN public.issue_relations r
    ON r.workspace_id=p.workspace_id AND r.issue_id=p.target AND r.kind='blocks'
  ) SELECT 1 FROM paths WHERE source=target
 ) THEN
  RAISE EXCEPTION 'Existing blocking cycles must be resolved before enabling issue relationships';
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.forge_issue_blocking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_WHEN='BEFORE' THEN
  PERFORM public.forge_lock_issue_graph(NEW.workspace_id);
 END IF;
 IF NEW.kind='blocks' AND (NEW.issue_id=NEW.related_issue_id OR EXISTS (
  WITH RECURSIVE reachable(id) AS (
   SELECT NEW.related_issue_id
   UNION
   SELECT r.related_issue_id FROM public.issue_relations r JOIN reachable p ON r.issue_id=p.id
    WHERE r.workspace_id=NEW.workspace_id AND r.kind='blocks' AND r.id<>NEW.id
  ) SELECT 1 FROM reachable WHERE id=NEW.issue_id
 )) THEN
  RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='issue_relations_blocks_acyclic', MESSAGE='Issue blocking cycle rejected';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_issue_blocking_before BEFORE INSERT OR UPDATE ON public.issue_relations
 FOR EACH ROW EXECUTE FUNCTION public.forge_issue_blocking_guard();
--> statement-breakpoint
CREATE TRIGGER forge_issue_blocking_after AFTER INSERT OR UPDATE ON public.issue_relations
 FOR EACH ROW EXECUTE FUNCTION public.forge_issue_blocking_guard();
