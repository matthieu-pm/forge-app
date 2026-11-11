-- Compaction is an active, recoverable run phase. Keep the existing migration
-- immutable and expand its recovery index only during explicit installation.
DROP INDEX forge_runtime.runtime_sessions_recovery;
CREATE INDEX runtime_sessions_recovery ON forge_runtime.sessions (lease_until,updated_at)
    WHERE cancelled_at IS NULL AND engine_state->>'phase' IN ('ready','generating','compacting','tools');
