-- Every projection and aggregate shares this authorized relation. Parameters:
-- workspace, privilege, user, validated query, snapshot, normalized rules,
-- cursor sort values, page limit. No user text becomes an SQL identifier.
WITH RECURSIVE authorized AS MATERIALIZED (
  SELECT i.id,i.revision,i.number,i.team_id,i.title,
    CASE WHEN {{parent}} THEN coalesce(i.parent_id::text,'') ELSE '' END parent,
    i.status_id,coalesce(s.name,i.status_id) status_name,
    coalesce(s.status_group,'backlog') status_group,coalesce(s.position,0) status_position,
    coalesce(i.assignee_id,'') assignee,coalesce(i.creator_id,'') creator,
    CASE WHEN {{project}} THEN coalesce(i.project_id::text,'') ELSE '' END project,
    coalesce(i.properties->>'priority','No priority') priority,
    CASE i.properties->>'priority' WHEN 'Urgent' THEN '0' WHEN 'High' THEN '1'
      WHEN 'Medium' THEN '2' WHEN 'Low' THEN '3' ELSE '4' END priority_rank,
    coalesce(i.properties->>'description','') description,
    i.title || E'\n' || coalesce(i.properties->>'description','') content,
    (SELECT t.identifier FROM teams t WHERE t.id=i.team_id) || '-' || i.number::text identifier,
    coalesce((SELECT string_agg(l.name,',' ORDER BY l.name) FROM issue_labels il
      JOIN resource_labels l ON l.id=il.label_id WHERE il.issue_id=i.id),'') labels,
    coalesce((SELECT l.name FROM issue_labels il JOIN resource_labels l ON l.id=il.label_id
      WHERE il.issue_id=i.id ORDER BY l.name LIMIT 1),'') first_label,
    coalesce(i.properties->>'agent','') agent,coalesce(i.properties->>'agentSession','') agent_session,
    '' suggested_label,coalesce(i.properties->>'dueDate','') due_date,
    coalesce(i.properties->>'milestone','') milestone,coalesce(i.properties->>'subscribers','') subscribers,
    CASE WHEN i.properties->>'autoClosed'='true' THEN 'Yes' ELSE 'No' END auto_closed,
    CASE WHEN coalesce(($4::jsonb->>'triage')::boolean,false) THEN
      CASE WHEN jsonb_array_length(coalesce(i.properties->'links','[]'))>0 OR
        (i.title || E'\n' || coalesce(i.properties->>'description','')) ~* 'https?://[^[:space:]]+'
        THEN 'link' ELSE '' END
      ELSE coalesce((SELECT string_agg((e->>'title') || ' ' || (e->>'url'),',')
        FROM jsonb_array_elements(coalesce(i.properties->'links','[]')) e),'') END links,
    coalesce(i.properties->>'templateName','') template_name,
    to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') created_day,
    to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD') updated_day,
    to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') created_sort,
    to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') updated_sort,
    CASE WHEN ($4->'display'->>'completedByRecency')::boolean AND nullif(i.properties->>'completedAt','') IS NOT NULL THEN '0' ELSE '1' END completion_key,
    CASE WHEN ($4->'display'->>'completedByRecency')::boolean THEN coalesce(i.properties->>'completedAt','') ELSE '' END completion_time,
    'All issues' all_group
  FROM issues i LEFT JOIN issue_statuses s ON s.workspace_id=i.workspace_id AND s.team_id=i.team_id AND s.id=i.status_id
  WHERE i.workspace_id=$1 AND {{team}} AND i.archived_at IS NULL AND i.deleted_at IS NULL
    AND i.created_at <= $5::text::timestamptz
    AND (NOT ($4 ? 'teamIds') OR i.team_id IN (SELECT value::uuid FROM jsonb_array_elements_text($4->'teamIds')))
    AND (NOT ($4 ? 'project') OR coalesce(CASE WHEN {{project}} THEN i.project_id::text END,'')=$4->>'project')
    AND (NOT ($4 ? 'cycle') OR EXISTS(SELECT 1 FROM issue_cycles c WHERE c.id=i.cycle_id AND (c.id::text=$4->>'cycle' OR c.start_date=$4->>'cycle')))
    AND (NOT ($4 ? 'milestone') OR coalesce(i.properties->>'milestone','') IN
      (SELECT value FROM jsonb_array_elements_text(CASE WHEN $4->'milestone'='[]'::jsonb THEN '[""]'::jsonb ELSE $4->'milestone' END)))
    AND (NOT ($4 ? 'triage') OR CASE WHEN ($4->>'triage')::boolean
      THEN i.properties->>'triage'='true' AND (($4->>'showSnoozed')::boolean OR coalesce(i.properties->>'snoozed','false')<>'true')
      ELSE coalesce(i.properties->>'triage','false')<>'true' END)
    AND CASE $4->>'personal'
      WHEN 'assigned' THEN i.assignee_id=$3
      WHEN 'created' THEN i.creator_id=$3
      WHEN 'subscribed' THEN $3=ANY(regexp_split_to_array(coalesce(i.properties->>'subscribers',''), '\s*,\s*'))
      WHEN 'activity' THEN (i.creator_id=$3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(i.properties->'activity','[]')) e WHERE e->>'author'=$3)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(i.properties->'comments','[]')) e WHERE e->>'author'=$3))
      ELSE true END
), matching AS (
  SELECT id FROM authorized a
  WHERE CASE $4->>'scope' WHEN 'active' THEN status_group IN ('unstarted','started') WHEN 'backlog' THEN status_group='backlog' ELSE true END
    AND (($4->'display'->>'showSubIssues')::boolean OR parent='')
    AND ($4->>'search'='' OR strpos(lower(content || E'\n' || identifier),$6::jsonb->>'search')>0)
    AND coalesce((SELECT CASE WHEN $4->'filters'->>'match'='all' THEN bool_and(matched) ELSE bool_or(matched) END
      FROM jsonb_array_elements($6->'rules') AS rules(r)
      CROSS JOIN LATERAL (SELECT lower(trim(CASE r->>'field'
        WHEN 'status' THEN a.status_id WHEN 'assignee' THEN a.assignee WHEN 'agent' THEN a.agent
        WHEN 'agentSession' THEN a.agent_session WHEN 'creator' THEN a.creator WHEN 'priority' THEN a.priority
        WHEN 'labels' THEN a.labels WHEN 'parentId' THEN a.parent WHEN 'suggestedLabel' THEN a.suggested_label
        WHEN 'dueDate' THEN a.due_date WHEN 'createdAt' THEN a.created_day WHEN 'updatedAt' THEN a.updated_day
        WHEN 'project' THEN a.project WHEN 'milestone' THEN a.milestone WHEN 'subscribers' THEN a.subscribers
        WHEN 'autoClosed' THEN a.auto_closed WHEN 'content' THEN a.content WHEN 'description' THEN a.description
        WHEN 'links' THEN a.links WHEN 'templateName' THEN a.template_name END)) value,r->>'expected' expected) v
      CROSS JOIN LATERAL (SELECT CASE WHEN r->>'field' IN ('labels','subscribers') THEN expected=ANY(regexp_split_to_array(value,'\s*,\s*')) ELSE value=expected END equal) e
      CROSS JOIN LATERAL (SELECT CASE r->>'operator'
        WHEN 'is' THEN equal WHEN 'isNot' THEN NOT equal
        WHEN 'contains' THEN strpos(value,expected)>0 WHEN 'notContains' THEN strpos(value,expected)=0
        WHEN 'set' THEN value<>'' WHEN 'notSet' THEN value=''
        WHEN 'before' THEN value<>'' AND value<expected WHEN 'after' THEN value<>'' AND value>expected END matched) m
    ),true)
), included(id) AS (
  SELECT id FROM matching
  UNION SELECT a.id FROM authorized a JOIN included p ON a.parent=p.id::text
    WHERE ($4->'display'->>'showSubIssues')::boolean AND $4->'display'->>'nested'='Show all'
), result AS MATERIALIZED (
  SELECT a.*,lpad(number::text,12,'0') number_key,
    (CASE $4->'display'->>'order' WHEN 'Priority' THEN priority_rank WHEN 'Status' THEN lpad(status_position::text,10,'0')
      WHEN 'Title' THEN lower(title) WHEN 'Due date' THEN coalesce(nullif(due_date,''),chr(65535))
      WHEN 'Created' THEN created_sort ELSE updated_sort END) COLLATE "C" sort_key
  FROM authorized a JOIN included i USING(id)
), facets AS (
  SELECT 'assignee'::text facet,assignee value,count(*)::int count FROM result GROUP BY value
  UNION ALL SELECT 'priority',priority,count(*)::int FROM result GROUP BY priority
  UNION ALL SELECT 'project',project,count(*)::int FROM result GROUP BY project
  UNION ALL SELECT 'team',team_id::text,count(*)::int FROM result GROUP BY team_id
  UNION ALL SELECT 'status',status_id,count(*)::int FROM result GROUP BY status_id
  UNION ALL SELECT 'labels',unnest(CASE WHEN labels='' THEN ARRAY[''] ELSE string_to_array(labels,',') END) value,count(*)::int FROM result GROUP BY value
), ranked AS (
  SELECT *,row_number() OVER(PARTITION BY facet ORDER BY count DESC,value) rank FROM facets
)
SELECT (SELECT count(*)::int FROM result) total,
  (SELECT md5(coalesce(string_agg(jsonb_build_array(id,revision,status_name,status_position,labels)::text,',' ORDER BY id),'')) FROM result) result_revision,
  coalesce((SELECT jsonb_agg(p) FROM (
    SELECT id,completion_key,completion_time,sort_key,number_key FROM result
    WHERE $7::jsonb IS NULL OR
      completion_key COLLATE "C">$7->>0 OR
      (completion_key COLLATE "C"=$7->>0 AND completion_time COLLATE "C"<$7->>1) OR
      (completion_key COLLATE "C"=$7->>0 AND completion_time COLLATE "C"=$7->>1 AND
        CASE WHEN ($4->'display'->>'descending')::boolean THEN sort_key COLLATE "C"<$7->>2 ELSE sort_key COLLATE "C">$7->>2 END) OR
      (completion_key COLLATE "C"=$7->>0 AND completion_time COLLATE "C"=$7->>1 AND sort_key COLLATE "C"=$7->>2 AND number_key COLLATE "C">$7->>3) OR
      (completion_key COLLATE "C"=$7->>0 AND completion_time COLLATE "C"=$7->>1 AND sort_key COLLATE "C"=$7->>2 AND number_key COLLATE "C"=$7->>3 AND id>($7->>4)::uuid)
    ORDER BY completion_key COLLATE "C" ASC,completion_time COLLATE "C" DESC,
      CASE WHEN NOT ($4->'display'->>'descending')::boolean THEN sort_key END COLLATE "C" ASC,
      CASE WHEN ($4->'display'->>'descending')::boolean THEN sort_key END COLLATE "C" DESC,
      number_key COLLATE "C" ASC,id ASC LIMIT $8::bigint+1
  ) p),'[]') page,
  coalesce((SELECT jsonb_agg(f) FROM (SELECT facet,value,count FROM ranked WHERE rank<=101 ORDER BY facet,rank) f),'[]') counts,
  coalesce((SELECT jsonb_agg(g) FROM (
    SELECT CASE $4->'display'->>'group' WHEN 'Status' THEN status_name WHEN 'Priority' THEN priority WHEN 'Assignee' THEN assignee
      WHEN 'Project' THEN project WHEN 'Labels' THEN first_label ELSE all_group END "group",
    CASE $4->'display'->>'subgroup' WHEN 'Status' THEN status_name WHEN 'Priority' THEN priority WHEN 'Assignee' THEN assignee
      WHEN 'Project' THEN project WHEN 'Labels' THEN first_label ELSE all_group END subgroup,count(*)::int count
    FROM result GROUP BY 1,2 ORDER BY count DESC,1,2 LIMIT 501
  ) g),'[]') groups,
  coalesce((SELECT jsonb_agg(p) FROM (SELECT project,count(*)::int count,count(*) FILTER(WHERE status_group='completed')::int completed FROM result GROUP BY 1 ORDER BY 1 LIMIT 1001) p),'[]') project_totals,
  coalesce((SELECT jsonb_agg(r) FROM (SELECT project,milestone,count(*)::int count,count(*) FILTER(WHERE status_group='completed')::int completed FROM result GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001) r),'[]') rollups
