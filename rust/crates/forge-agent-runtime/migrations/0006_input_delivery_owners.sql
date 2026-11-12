-- A completed composer delivery can leave the session's required input pending
-- in an older execution. Keep delivery order separate from state ownership.
ALTER TABLE forge_runtime.conversations
    ADD COLUMN execution_run_id uuid,
    ADD COLUMN generation bigint NOT NULL DEFAULT 0
        CHECK (generation BETWEEN 0 AND 9007199254740991);
UPDATE forge_runtime.conversations SET execution_run_id=last_run_id;
ALTER TABLE forge_runtime.sessions ADD COLUMN delivery_only boolean NOT NULL DEFAULT false;
ALTER TABLE forge_runtime.sessions ADD COLUMN input_generation bigint NOT NULL DEFAULT 0
    CHECK (input_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE forge_runtime.sessions ADD CONSTRAINT runtime_completed_delivery
    CHECK (NOT delivery_only OR engine_state->>'phase'='complete');

-- Acknowledgement retries replay the same response boundary without applying
-- its input again or reclaiming an execution that a later delivery now owns.
CREATE TABLE forge_runtime.input_deliveries (
    run_id uuid NOT NULL REFERENCES forge_runtime.sessions(run_id) ON DELETE CASCADE,
    request_id uuid NOT NULL,
    decision text NOT NULL CHECK (decision IN ('approved','denied')),
    stream_start_index bigint NOT NULL CHECK (stream_start_index>=0),
    head_run_id uuid,
    generation bigint NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (run_id,request_id)
);
