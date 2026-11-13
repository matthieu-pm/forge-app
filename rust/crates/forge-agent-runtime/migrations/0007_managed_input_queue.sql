-- Queue acceptance never changes active execution or its app delivery cursor.
ALTER TABLE forge_runtime.conversations
    ADD COLUMN managed boolean NOT NULL DEFAULT false,
    ADD COLUMN current_delivery_run_id uuid,
    ADD COLUMN intent_sequence bigint NOT NULL DEFAULT 0 CHECK (intent_sequence BETWEEN 0 AND 9007199254740991),
    ADD COLUMN drained_boundary jsonb;
UPDATE forge_runtime.conversations c SET current_delivery_run_id=CASE
    WHEN s.input_generation=c.generation THEN c.execution_run_id ELSE c.last_run_id END
FROM forge_runtime.sessions s WHERE s.run_id=c.execution_run_id;
ALTER TABLE forge_runtime.sessions ADD COLUMN authority jsonb;

CREATE TABLE forge_runtime.input_handoffs (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES forge_runtime.conversations(id) ON DELETE CASCADE,
    plan jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('prepared','activated','invalidated')),
    receipt jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX runtime_one_prepared_handoff ON forge_runtime.input_handoffs(conversation_id) WHERE state='prepared';
CREATE TABLE forge_runtime.input_intents (
    intent_id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES forge_runtime.conversations(id) ON DELETE CASCADE,
    sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    original_run_id uuid NOT NULL REFERENCES forge_runtime.sessions(run_id) DEFERRABLE INITIALLY DEFERRED,
    request_id uuid NOT NULL,
    approved boolean NOT NULL,
    authority jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('queued','prepared','activated','cancelled','expired')),
    handoff_id uuid REFERENCES forge_runtime.input_handoffs(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(conversation_id,sequence),
    UNIQUE(original_run_id,request_id)
);
