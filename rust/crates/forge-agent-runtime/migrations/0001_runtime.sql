-- Private runtime state, separate from the reference application's schema.
-- Installation is explicit. Regular connection/session operations never run DDL.
CREATE SCHEMA IF NOT EXISTS forge_runtime;
CREATE TABLE forge_runtime.sessions (
    run_id uuid PRIMARY KEY,
    workspace_id text NOT NULL,
    user_id text NOT NULL,
    initial_hash text NOT NULL CHECK (length(initial_hash)=64),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
    engine_state jsonb NOT NULL CHECK (jsonb_typeof(engine_state)='object' AND octet_length(engine_state::text)<=16777216),
    next_index bigint NOT NULL DEFAULT 0 CHECK (next_index>=0),
    journal_bytes bigint NOT NULL DEFAULT 0 CHECK (journal_bytes BETWEEN 0 AND 67108864),
    epoch bigint NOT NULL DEFAULT 0 CHECK (epoch>=0),
    lease_owner uuid,
    lease_until timestamptz,
    deadline timestamptz NOT NULL,
    cancelled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((lease_owner IS NULL)=(lease_until IS NULL)),
    CHECK (COALESCE(engine_state->>'revision'=revision::text,false)),
    CHECK (COALESCE(engine_state->'binding'->>'run'=run_id::text,false)),
    CHECK (COALESCE(engine_state->'binding'->>'workspace'=workspace_id,false)),
    CHECK (COALESCE(engine_state->'binding'->>'user'=user_id,false))
);
CREATE INDEX runtime_sessions_recovery ON forge_runtime.sessions (lease_until,updated_at)
    WHERE cancelled_at IS NULL AND engine_state->>'phase' IN ('ready','generating','tools');
CREATE TABLE forge_runtime.events (
    run_id uuid NOT NULL REFERENCES forge_runtime.sessions(run_id) ON DELETE CASCADE,
    stream_index bigint NOT NULL CHECK (stream_index>=0),
    event_id uuid NOT NULL UNIQUE,
    event jsonb NOT NULL CHECK (jsonb_typeof(event)='object' AND octet_length(event::text)<=16777216),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (run_id,stream_index)
);
