CREATE TABLE "personal_preference_import_content" (
	"import_id" uuid PRIMARY KEY NOT NULL,
	"source" jsonb NOT NULL,
	"baseline" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_preference_import_content" ADD CONSTRAINT "personal_preference_import_content_import_id_personal_preference_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."personal_preference_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "personal_preference_import_content" ("import_id", "source", "baseline")
SELECT i.id, i.manifest #> '{plan,source}',
  COALESCE((SELECT jsonb_object_agg(v.key, v.value)
    FROM jsonb_each(i.manifest #> '{plan,snapshot,values}') v
    WHERE i.manifest #>> ARRAY['plan','choices',v.key] = 'import'), '{}'::jsonb)
FROM "personal_preference_imports" i
WHERE i.manifest #> '{plan,source,raw}' IS NOT NULL
ON CONFLICT ("import_id") DO NOTHING;
--> statement-breakpoint
UPDATE "personal_preference_imports" i SET "manifest" =
  jsonb_set(jsonb_set(i.manifest, '{plan,source}',
    jsonb_strip_nulls(jsonb_build_object(
      'location', i.manifest #> '{plan,source,location}',
      'key', i.manifest #> '{plan,source,key}',
      'recoveryKey', i.manifest #> '{plan,source,recovery,key}'))),
    '{plan,snapshot}', jsonb_set((i.manifest #> '{plan,snapshot}') - 'values', '{fieldVersions}',
      COALESCE((SELECT jsonb_object_agg(v.key, v.value)
        FROM jsonb_each(i.manifest #> '{plan,snapshot,fieldVersions}') v
        WHERE i.manifest #>> ARRAY['plan','choices',v.key] = 'import'), '{}'::jsonb)))
WHERE i.manifest #> '{plan,source,raw}' IS NOT NULL;
