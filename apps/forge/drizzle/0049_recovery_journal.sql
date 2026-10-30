CREATE TABLE "recovery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"operation_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_key" jsonb NOT NULL,
	"action" text NOT NULL,
	"patch" jsonb,
	"storage_reference" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_events_sequence_unique" UNIQUE("sequence")
);
--> statement-breakpoint
CREATE TABLE "recovery_journal_state" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "recovery_events" ADD CONSTRAINT "recovery_events_operation_id_recovery_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."recovery_operations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_events_operation_idx" ON "recovery_events" USING btree ("operation_id","sequence");
--> statement-breakpoint
CREATE INDEX "recovery_operations_published_idx" ON "recovery_operations" USING btree ("published_at");
--> statement-breakpoint
INSERT INTO public.recovery_journal_state(id,enabled) VALUES('singleton',false);
--> statement-breakpoint
CREATE FUNCTION public.forge_capture_recovery_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_row jsonb; new_row jsonb; row_identity jsonb; changes jsonb := '{}'::jsonb;
  field text; operation uuid; event_action text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.recovery_journal_state WHERE id='singleton' AND enabled) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  old_row:=to_jsonb(OLD);
  IF TG_OP='DELETE' THEN event_action:='delete';
  ELSE
    new_row:=to_jsonb(NEW); event_action:='patch';
    FOREACH field IN ARRAY ARRAY['deleted_at','expires_at','enabled','revoked_at','role','visibility','status','archived_at','permissions','scopes','active_organization_id','email_verified'] LOOP
      IF old_row ? field AND old_row->field IS DISTINCT FROM new_row->field THEN changes:=changes||jsonb_build_object(field,new_row->field); END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['secret','secret_reference','access_token','refresh_token','password','oauth_verifier','oauth_state_hash'] LOOP
      IF old_row ? field AND old_row->field IS DISTINCT FROM new_row->field THEN changes:=changes||jsonb_build_object(field,NULL); END IF;
    END LOOP;
    IF old_row ? 'transcript' AND old_row->'transcript' IS DISTINCT FROM new_row->'transcript' AND new_row->'transcript'='[]'::jsonb THEN changes:=changes||jsonb_build_object('transcript','[]'::jsonb); END IF;
    IF old_row ? 'state' AND old_row->'state' IS DISTINCT FROM new_row->'state' AND new_row->>'state' IN ('rejected','expired','cancelled','deleted','revoked','deleting') THEN changes:=changes||jsonb_build_object('state',new_row->'state'); END IF;
    IF TG_TABLE_NAME='workspace_security_settings' THEN changes:=new_row-'workspace_id'-'updated_by_user_id'-'created_at'-'updated_at'; END IF;
    IF changes='{}'::jsonb THEN RETURN NEW; END IF;
  END IF;
  operation:=NULLIF(current_setting('forge.recovery_operation',true),'')::uuid;
  IF operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.recovery_operations WHERE id=operation) THEN
    RAISE EXCEPTION 'RECOVERY_JOURNAL_REQUIRED: destructive changes require an independently prepared operation';
  END IF;
  SELECT jsonb_object_agg(a.attname,old_row->a.attname ORDER BY a.attname) INTO row_identity
    FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid=TG_RELID AND i.indisprimary;
  IF row_identity IS NULL THEN RAISE EXCEPTION 'RECOVERY_PRIMARY_KEY_REQUIRED'; END IF;
  INSERT INTO public.recovery_events(operation_id,table_name,row_key,action,patch,storage_reference,occurred_at)
    VALUES(operation,TG_TABLE_NAME,row_identity,event_action,CASE WHEN TG_OP='DELETE' THEN NULL ELSE changes END,
      CASE WHEN TG_TABLE_NAME IN ('resource_files','agent_artifacts','agent_attachments') AND (TG_OP='DELETE' OR changes->>'deleted_at' IS NOT NULL) THEN old_row->>'storage_reference' ELSE NULL END,clock_timestamp());
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_capture_recovery_event() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.forge_install_recovery_triggers() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE tab record;
BEGIN
  FOR tab IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE 'recovery\_%' ESCAPE '\' LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS forge_recovery_capture ON public.%I',tab.tablename);
    EXECUTE format('CREATE TRIGGER forge_recovery_capture AFTER DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.forge_capture_recovery_event()',tab.tablename);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forge_install_recovery_triggers() FROM PUBLIC;
--> statement-breakpoint
SELECT public.forge_install_recovery_triggers();
