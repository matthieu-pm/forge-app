CREATE TABLE "operational_alert_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_job_health" (
	"key" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operational_metric_health" (
	"key" text PRIMARY KEY NOT NULL,
	"value" double precision NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"high_since" timestamp with time zone
);
