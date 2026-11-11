-- Conversation IDs correspond to the application's private agent threads.
-- History is copied into each admitted run, so later parent retention need not
-- erase a child's context or its idempotent admission receipt.
CREATE TABLE forge_runtime.conversations (
    id uuid PRIMARY KEY,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    last_run_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE forge_runtime.sessions ADD COLUMN conversation_id uuid REFERENCES forge_runtime.conversations(id) ON DELETE CASCADE;
ALTER TABLE forge_runtime.sessions ADD COLUMN parent_run_id uuid;
CREATE INDEX runtime_conversation_runs ON forge_runtime.sessions(conversation_id,created_at) WHERE conversation_id IS NOT NULL;
