-- A question batch may be consumed only by one admitted conversation successor.
-- Keep the original run and events for replay; this receipt fences its workers
-- without relabelling the application's historical waiting row as completed.
ALTER TABLE forge_runtime.sessions ADD COLUMN continued_by_run_id uuid;
ALTER TABLE forge_runtime.sessions ADD CONSTRAINT runtime_input_continuation
    CHECK (continued_by_run_id IS NULL OR
        (conversation_id IS NOT NULL AND continued_by_run_id <> run_id));
