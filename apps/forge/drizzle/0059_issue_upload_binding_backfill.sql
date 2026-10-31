-- Existing direct issue uploads were finalized before attachment commands existed.
-- Internal resource imports keep their established access contract (NULL state).
UPDATE resource_files f SET attachment_state = 'unbound'
WHERE f.issue_id IS NOT NULL AND f.attachment_state IS NULL
AND EXISTS (SELECT 1 FROM file_upload_intents u WHERE u.id=f.id AND u.workspace_id=f.workspace_id);
