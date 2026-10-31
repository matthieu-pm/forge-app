ALTER TABLE "issue_cycles" ADD COLUMN "number" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;
--> statement-breakpoint
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY team_id ORDER BY start_date, id)::integer AS n
  FROM issue_cycles
) UPDATE issue_cycles c SET number = n.n, timezone = t.timezone
FROM numbered n, teams t WHERE c.id = n.id AND c.team_id = t.id;
--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_team_number" UNIQUE("team_id","number");
--> statement-breakpoint
ALTER TABLE "issue_cycles" ADD CONSTRAINT "issue_cycles_number_positive" CHECK ("number" > 0);
--> statement-breakpoint
CREATE FUNCTION forge_guard_cycle_window() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.team_id::text,4055));
  IF TG_OP = 'UPDATE' AND (OLD.team_id,OLD.workspace_id,OLD.start_date,OLD.end_date,OLD.timezone,OLD.number)
    IS DISTINCT FROM (NEW.team_id,NEW.workspace_id,NEW.start_date,NEW.end_date,NEW.timezone,NEW.number) THEN
    RAISE EXCEPTION 'Existing cycle windows are immutable';
  END IF;
  IF NEW.number = 0 THEN
    SELECT coalesce(max(number),0)+1 INTO NEW.number FROM issue_cycles WHERE team_id = NEW.team_id;
  END IF;
  IF to_char(NEW.start_date::date,'YYYY-MM-DD') <> NEW.start_date OR
     to_char(NEW.end_date::date,'YYYY-MM-DD') <> NEW.end_date OR NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'Invalid cycle dates';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Invalid cycle timezone';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER issue_cycles_window_guard BEFORE INSERT OR UPDATE ON issue_cycles
FOR EACH ROW EXECUTE FUNCTION forge_guard_cycle_window();
