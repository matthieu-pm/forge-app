-- Recovery uses elapsed hours, including across session time zones and DST.
CREATE OR REPLACE FUNCTION public.forge_issue_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND
  (OLD.purge_started_at IS NOT NULL OR OLD.deleted_at + interval '720 hours' <= clock_timestamp()) THEN
  RAISE EXCEPTION 'The issue recovery period has ended.' USING ERRCODE='23514',CONSTRAINT='issue_recovery_expired';
 END IF;
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS DISTINCT FROM NEW.deleted_at THEN
  RAISE EXCEPTION 'The deletion deadline cannot be renewed.';
 END IF;
 IF OLD.purged_at IS NOT NULL AND (NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.purged_at IS DISTINCT FROM OLD.purged_at OR NEW.title<>'' OR NEW.properties<>'{}'::jsonb) THEN
  RAISE EXCEPTION 'Purged issues cannot be recreated.';
 END IF;
 IF NEW.purge_started_at IS NOT NULL AND (NEW.deleted_at IS NULL OR NEW.deleted_at + interval '720 hours' > clock_timestamp()) THEN
  RAISE EXCEPTION 'Issue purge is not due.';
 END IF;
 IF OLD.purge_started_at IS NOT NULL AND NEW.purge_started_at IS NULL THEN
  RAISE EXCEPTION 'An issue purge cannot be cancelled.';
 END IF;
 RETURN NEW;
END $$;
