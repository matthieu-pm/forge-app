-- Auto routing already accepts a preferred connection without pinning a model.
-- Keep the existing foreign key and tenant checks; relax only this stale check.
ALTER TABLE "thread_model_preferences"
  DROP CONSTRAINT "thread_model_preferences_selection_check";
--> statement-breakpoint
ALTER TABLE "thread_model_preferences"
  ADD CONSTRAINT "thread_model_preferences_selection_check"
  CHECK (("mode" = 'auto' AND "selected_model_id" IS NULL)
    OR ("mode" = 'manual' AND "selected_connection_id" IS NOT NULL
      AND "selected_model_id" IS NOT NULL));
