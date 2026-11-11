-- Explicit upgrade of pre-budget snapshots. Walk the private conversation chain
-- once, carrying usage across cancelled/failed/completed turns. Never reset an
-- existing grant. Fence workers whose snapshots change before releasing locks.
LOCK TABLE forge_runtime.sessions IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE forge_budget_upgrade ON COMMIT DROP AS
WITH RECURSIVE chain AS (
    SELECT run_id, workspace_id, user_id, conversation_id,
        CASE WHEN engine_state ? 'budget' THEN (engine_state#>>'{budget,prior,input}')::numeric ELSE 0 END AS prior_input,
        CASE WHEN engine_state ? 'budget' THEN (engine_state#>>'{budget,prior,output}')::numeric ELSE 0 END AS prior_output,
        CASE WHEN engine_state ? 'budget' THEN (engine_state#>>'{budget,prior,input}')::numeric ELSE 0 END + (engine_state->>'input_tokens')::numeric AS total_input,
        CASE WHEN engine_state ? 'budget' THEN (engine_state#>>'{budget,prior,output}')::numeric ELSE 0 END + (engine_state->>'output_tokens')::numeric AS total_output,
        COALESCE(engine_state#>'{budget,granted}', 'null'::jsonb) AS granted
    FROM forge_runtime.sessions WHERE parent_run_id IS NULL OR engine_state ? 'budget'
    UNION ALL
    SELECT child.run_id, child.workspace_id, child.user_id, child.conversation_id,
        CASE WHEN child.engine_state ? 'budget' THEN (child.engine_state#>>'{budget,prior,input}')::numeric ELSE parent.total_input END,
        CASE WHEN child.engine_state ? 'budget' THEN (child.engine_state#>>'{budget,prior,output}')::numeric ELSE parent.total_output END,
        CASE WHEN child.engine_state ? 'budget' THEN (child.engine_state#>>'{budget,prior,input}')::numeric ELSE parent.total_input END + (child.engine_state->>'input_tokens')::numeric,
        CASE WHEN child.engine_state ? 'budget' THEN (child.engine_state#>>'{budget,prior,output}')::numeric ELSE parent.total_output END + (child.engine_state->>'output_tokens')::numeric,
        CASE WHEN child.engine_state ? 'budget' THEN child.engine_state#>'{budget,granted}' ELSE parent.granted END
    FROM forge_runtime.sessions child JOIN chain parent ON child.parent_run_id=parent.run_id
        AND child.workspace_id=parent.workspace_id AND child.user_id=parent.user_id
        AND child.conversation_id=parent.conversation_id
    WHERE NOT child.engine_state ? 'budget'
)
SELECT * FROM chain;
DO $$ BEGIN
    IF (SELECT count(*) FROM forge_budget_upgrade) <> (SELECT count(*) FROM forge_runtime.sessions)
        OR EXISTS (SELECT 1 FROM forge_budget_upgrade WHERE prior_input IS NULL OR prior_output IS NULL
            OR total_input IS NULL OR total_output IS NULL OR prior_input<0 OR prior_output<0
            OR total_input<prior_input OR total_output<prior_output
            OR total_input<>trunc(total_input) OR total_output<>trunc(total_output)
            OR prior_input<>trunc(prior_input) OR prior_output<>trunc(prior_output)
            OR total_input>9007199254740991 OR total_output>9007199254740991) THEN
        RAISE EXCEPTION 'Cannot reconstruct private conversation usage';
    END IF;
END $$;
UPDATE forge_runtime.sessions s SET
    engine_state=jsonb_set(jsonb_set(s.engine_state,'{budget}',jsonb_build_object(
        'prior',jsonb_build_object('input',u.prior_input,'output',u.prior_output),
        'granted',u.granted,'pending',NULL)), '{revision}',to_jsonb(s.revision+1)),
    revision=s.revision+1, epoch=s.epoch+1, lease_owner=NULL, lease_until=NULL,
    updated_at=clock_timestamp()
FROM forge_budget_upgrade u WHERE s.run_id=u.run_id AND NOT s.engine_state ? 'budget';
