CREATE TABLE "workspace_usage_carryovers" (
	"source_period_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"target_period_id" uuid NOT NULL,
	"effective_at" timestamp (3) with time zone NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_carryover_kind_check" CHECK ("workspace_usage_carryovers"."kind" IN ('trial-expiry','paid-to-free') AND "workspace_usage_carryovers"."source_period_id"<>"workspace_usage_carryovers"."target_period_id" AND isfinite("workspace_usage_carryovers"."effective_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_usage_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"period_key" text NOT NULL,
	"kind" text NOT NULL,
	"binding" text NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ends_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_period_kind_check" CHECK ("workspace_usage_periods"."kind" IN ('free','trial','paid')),
	CONSTRAINT "workspace_usage_period_window_check" CHECK (isfinite("workspace_usage_periods"."started_at") AND isfinite("workspace_usage_periods"."ends_at") AND "workspace_usage_periods"."started_at"<"workspace_usage_periods"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_usage_receipts" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"reservation_id" uuid NOT NULL,
	"body_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_receipt_hash_check" CHECK ("workspace_usage_receipts"."body_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_usage_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"operation_id" uuid NOT NULL,
	"run_id" uuid,
	"actor_user_id" text,
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"pricing_fingerprint" text NOT NULL,
	"billing_mode" text NOT NULL,
	"feature" text DEFAULT 'agent' NOT NULL,
	"uses_pool" boolean NOT NULL,
	"maximum_cost_usd_micros" bigint NOT NULL,
	"reserved_usd_micros" bigint NOT NULL,
	"settled_usd_micros" bigint DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_usage_reservation_state_check" CHECK ("workspace_usage_reservations"."state" IN ('held','uncertain','settled','released','reconciliation-required')),
	CONSTRAINT "workspace_usage_reservation_payer_check" CHECK ("workspace_usage_reservations"."billing_mode" IN ('forge-managed','subscription','token-plan','pay-as-you-go') AND "workspace_usage_reservations"."feature" IN ('agent','calls','signals')),
	CONSTRAINT "workspace_usage_reservation_money_check" CHECK ("workspace_usage_reservations"."maximum_cost_usd_micros" BETWEEN 0 AND 9007199254740991 AND "workspace_usage_reservations"."reserved_usd_micros" BETWEEN 0 AND "workspace_usage_reservations"."maximum_cost_usd_micros" AND "workspace_usage_reservations"."settled_usd_micros" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "workspace_usage_reservation_state_money_check" CHECK (("workspace_usage_reservations"."state" IN ('held','uncertain') AND "workspace_usage_reservations"."reserved_usd_micros"="workspace_usage_reservations"."maximum_cost_usd_micros" AND "workspace_usage_reservations"."settled_usd_micros"=0) OR ("workspace_usage_reservations"."state" IN ('settled','released','reconciliation-required') AND "workspace_usage_reservations"."reserved_usd_micros"=0 AND ("workspace_usage_reservations"."state"<>'released' OR "workspace_usage_reservations"."settled_usd_micros"=0))),
	CONSTRAINT "workspace_usage_reservation_hashes_check" CHECK ("workspace_usage_reservations"."request_hash" ~ '^[a-f0-9]{64}$' AND "workspace_usage_reservations"."pricing_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "workspace_usage_carryover_target_idx" ON "workspace_usage_carryovers" USING btree ("workspace_id","target_period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_period_key_unique" ON "workspace_usage_periods" USING btree ("workspace_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_period_binding_unique" ON "workspace_usage_periods" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_request_unique" ON "workspace_usage_reservations" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_operation_unique" ON "workspace_usage_reservations" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "workspace_usage_reservation_period_idx" ON "workspace_usage_reservations" USING btree ("workspace_id","period_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_reservation_binding_unique" ON "workspace_usage_reservations" USING btree ("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "workspace_usage_carryovers" ADD CONSTRAINT "workspace_usage_carryovers_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_carryovers" ADD CONSTRAINT "workspace_usage_carryover_source_fk" FOREIGN KEY ("workspace_id","source_period_id") REFERENCES "public"."workspace_usage_periods"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_carryovers" ADD CONSTRAINT "workspace_usage_carryover_target_fk" FOREIGN KEY ("workspace_id","target_period_id") REFERENCES "public"."workspace_usage_periods"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_periods" ADD CONSTRAINT "workspace_usage_periods_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_receipts" ADD CONSTRAINT "workspace_usage_receipts_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_receipts" ADD CONSTRAINT "workspace_usage_receipt_reservation_fk" FOREIGN KEY ("workspace_id","reservation_id") REFERENCES "public"."workspace_usage_reservations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_reservations" ADD CONSTRAINT "workspace_usage_reservations_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_reservations" ADD CONSTRAINT "workspace_usage_reservations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_reservations" ADD CONSTRAINT "workspace_usage_reservations_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage_reservations" ADD CONSTRAINT "workspace_usage_reservation_period_fk" FOREIGN KEY ("workspace_id","period_id") REFERENCES "public"."workspace_usage_periods"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION public.forge_guard_usage_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE source public.workspace_usage_periods%ROWTYPE; target public.workspace_usage_periods%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM public.organization WHERE id=OLD.workspace_id) THEN
      RAISE EXCEPTION 'Usage history cannot be deleted while its workspace exists.' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME<>'workspace_usage_reservations' THEN
    RAISE EXCEPTION 'Usage history is immutable.' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='workspace_usage_carryovers' THEN
    SELECT * INTO source FROM public.workspace_usage_periods WHERE workspace_id=NEW.workspace_id AND id=NEW.source_period_id;
    SELECT * INTO target FROM public.workspace_usage_periods WHERE workspace_id=NEW.workspace_id AND id=NEW.target_period_id;
    IF source.id IS NULL OR target.id IS NULL OR target.kind<>'free'
      OR source.kind<>(CASE NEW.kind WHEN 'trial-expiry' THEN 'trial' ELSE 'paid' END)
      OR NEW.effective_at<source.started_at OR NEW.effective_at<target.started_at OR NEW.effective_at>=target.ends_at
      OR (source.kind='trial' AND NEW.effective_at<>source.ends_at) THEN
      RAISE EXCEPTION 'Invalid usage carryover binding.' USING ERRCODE='23514',CONSTRAINT='workspace_usage_carryover_binding';
    END IF;
  END IF;
  IF TG_TABLE_NAME='workspace_usage_reservations' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.state<>'held' OR NEW.run_id IS NULL OR NEW.run_id<>NEW.operation_id OR NEW.feature<>'agent'
        OR NOT EXISTS(SELECT 1 FROM public.agent_runs r JOIN public.agent_threads t ON t.id=r.thread_id
          WHERE r.id=NEW.run_id AND t.workspace_id=NEW.workspace_id AND r.initiated_by_user_id=NEW.actor_user_id)
        OR NEW.uses_pool IS DISTINCT FROM (NEW.billing_mode='forge-managed') THEN
        RAISE EXCEPTION 'Invalid usage run binding.' USING ERRCODE='23514',CONSTRAINT='workspace_usage_run_binding';
      END IF;
    ELSE
      IF (to_jsonb(NEW)-ARRAY['run_id','actor_user_id','state','reserved_usd_micros','settled_usd_micros','updated_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['run_id','actor_user_id','state','reserved_usd_micros','settled_usd_micros','updated_at'])
        OR (NEW.run_id IS DISTINCT FROM OLD.run_id AND NEW.run_id IS NOT NULL)
        OR (NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id AND NEW.actor_user_id IS NOT NULL)
        OR (OLD.state NOT IN ('held','uncertain') AND
          (NEW.state<>OLD.state OR NEW.reserved_usd_micros<>OLD.reserved_usd_micros OR NEW.settled_usd_micros<>OLD.settled_usd_micros)) THEN
        RAISE EXCEPTION 'Usage payer, period, bound and terminal amounts are immutable.' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER workspace_usage_period_immutable BEFORE UPDATE OR DELETE ON public.workspace_usage_periods
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_usage_history();
--> statement-breakpoint
CREATE TRIGGER workspace_usage_carryover_guard BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_usage_carryovers
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_usage_history();
--> statement-breakpoint
CREATE TRIGGER workspace_usage_reservation_guard BEFORE INSERT OR UPDATE OR DELETE ON public.workspace_usage_reservations
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_usage_history();
--> statement-breakpoint
CREATE TRIGGER workspace_usage_receipt_immutable BEFORE UPDATE OR DELETE ON public.workspace_usage_receipts
FOR EACH ROW EXECUTE FUNCTION public.forge_guard_usage_history();
