ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_member_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."member"("organization_id","user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Complete immutable indirect ownership, extending 0040 without editing an
-- already rehearsed/applied migration. Transfers require a future explicit flow.
DROP TRIGGER forge_immutable_identity ON public.business_workflow_effects;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.business_workflow_effects FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','business_run_id');
--> statement-breakpoint
DROP TRIGGER forge_immutable_identity ON public.member;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.member FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','organization_id','user_id');
--> statement-breakpoint
DROP TRIGGER forge_immutable_identity ON public.apikey;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.apikey FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','reference_id');
--> statement-breakpoint
DROP TRIGGER forge_immutable_identity ON public.agent_threads;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.agent_threads FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','created_by_user_id');
--> statement-breakpoint
DROP TRIGGER forge_immutable_identity ON public.model_connections;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.model_connections FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','user_id','scope');
--> statement-breakpoint
DROP TRIGGER forge_immutable_identity ON public.call_connections;
--> statement-breakpoint
CREATE TRIGGER forge_immutable_identity BEFORE UPDATE ON public.call_connections FOR EACH ROW EXECUTE FUNCTION public.forge_immutable_identity('id','workspace_id','user_id');
