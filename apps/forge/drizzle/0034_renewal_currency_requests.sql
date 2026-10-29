CREATE TABLE "workspace_currency_change_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"environment" text NOT NULL,
	"subscription_id" uuid NOT NULL,
	"billing_country" text NOT NULL,
	"from_currency" text NOT NULL,
	"target_currency" text NOT NULL,
	"current_plan" text NOT NULL,
	"renewal_plan" text NOT NULL,
	"renewal_members" integer NOT NULL,
	"renewal_price_minor" bigint NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"checkout_grace_ends_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_currency_change_environment_check" CHECK ("workspace_currency_change_requests"."environment" IN ('sandbox','production')),
	CONSTRAINT "workspace_currency_change_currency_check" CHECK ("workspace_currency_change_requests"."from_currency" IN ('eur','usd') AND "workspace_currency_change_requests"."target_currency" IN ('eur','usd')),
	CONSTRAINT "workspace_currency_change_country_check" CHECK ("workspace_currency_change_requests"."billing_country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "workspace_currency_change_plan_check" CHECK ("workspace_currency_change_requests"."current_plan" IN ('starter','plus') AND "workspace_currency_change_requests"."renewal_plan" IN ('starter','plus')),
	CONSTRAINT "workspace_currency_change_quantity_check" CHECK ("workspace_currency_change_requests"."renewal_members" > 0 AND "workspace_currency_change_requests"."renewal_price_minor" > 0 AND "workspace_currency_change_requests"."renewal_price_minor" <= 9007199254740991),
	CONSTRAINT "workspace_currency_change_deadline_check" CHECK (isfinite("workspace_currency_change_requests"."effective_at") AND isfinite("workspace_currency_change_requests"."checkout_grace_ends_at") AND "workspace_currency_change_requests"."checkout_grace_ends_at" = "workspace_currency_change_requests"."effective_at" + interval '168 hours' AND "workspace_currency_change_requests"."effective_at" > "workspace_currency_change_requests"."requested_at"),
	CONSTRAINT "workspace_currency_change_state_check" CHECK ("workspace_currency_change_requests"."state" IN ('requested','superseded','withdrawn','unchanged','completed','failed') AND ("workspace_currency_change_requests"."state" <> 'requested' OR "workspace_currency_change_requests"."from_currency" <> "workspace_currency_change_requests"."target_currency"))
);
--> statement-breakpoint
ALTER TABLE "workspace_currency_change_requests" ADD CONSTRAINT "workspace_currency_change_requests_workspace_id_organization_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_currency_change_requests" ADD CONSTRAINT "workspace_currency_change_requests_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_currency_change_one_pending" ON "workspace_currency_change_requests" USING btree ("workspace_id") WHERE "workspace_currency_change_requests"."state" = 'requested';--> statement-breakpoint
CREATE INDEX "workspace_currency_change_history_idx" ON "workspace_currency_change_requests" USING btree ("workspace_id","requested_at");