CREATE TABLE "loop_artifact_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"loop_run_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"storage_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loop_artifact_intents_storage_unique" UNIQUE("storage_reference")
);
--> statement-breakpoint
ALTER TABLE "loop_artifact_intents" ADD CONSTRAINT "loop_artifact_intents_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_artifact_intents" ADD CONSTRAINT "loop_artifact_intents_loop_run_id_loop_runs_id_fk" FOREIGN KEY ("loop_run_id") REFERENCES "public"."loop_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loop_artifact_intents" ADD CONSTRAINT "loop_artifact_intents_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loop_artifact_intents_source_idx" ON "loop_artifact_intents" USING btree ("workspace_id","loop_run_id");--> statement-breakpoint
CREATE INDEX "loop_artifact_intents_created_idx" ON "loop_artifact_intents" USING btree ("created_at");
--> statement-breakpoint
-- Reservations are committed before any bytes are put; publication retires the
-- same reservation atomically with artifact metadata. A failed delete retains
-- the reference for the next bounded cleanup pass.
CREATE OR REPLACE FUNCTION forge_loop_artifact_intent_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record;
BEGIN
  SELECT r.workspace_id,r.agent_run_id,r.event,r.error_code,r.state INTO source
    FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id
    WHERE r.id=NEW.loop_run_id AND l.enabled AND l.deleted_at IS NULL;
  IF NOT FOUND OR source.workspace_id<>NEW.workspace_id OR source.agent_run_id<>NEW.agent_run_id
    OR source.error_code='SOURCE_PURGED' OR source.state NOT IN ('running','waiting-for-approval') THEN
    RAISE EXCEPTION 'SOURCE_UNAVAILABLE' USING ERRCODE='check_violation';
  END IF;
  IF source.event->>'entity'='issue' THEN
    PERFORM id FROM issues WHERE workspace_id=source.workspace_id AND id::text=source.event->>'entityId'
      AND deleted_at IS NULL AND purge_started_at IS NULL AND purged_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_UNAVAILABLE' USING ERRCODE='check_violation'; END IF;
  END IF;
  PERFORM r.id FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id
    WHERE r.id=NEW.loop_run_id AND r.workspace_id=NEW.workspace_id AND r.agent_run_id=NEW.agent_run_id
      AND r.event IS NOT DISTINCT FROM source.event AND r.state IN ('running','waiting-for-approval')
      AND l.enabled AND l.deleted_at IS NULL FOR SHARE OF r,l;
  IF NOT FOUND THEN RAISE EXCEPTION 'SOURCE_UNAVAILABLE' USING ERRCODE='check_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER forge_loop_artifact_intent_fence BEFORE INSERT OR UPDATE ON loop_artifact_intents
FOR EACH ROW EXECUTE FUNCTION forge_loop_artifact_intent_fence();
