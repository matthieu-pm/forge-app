import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { readIssueRows } from "./issues.server"
import type { SQL } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type {
  IssueFacet,
  IssueQuery,
  IssueQueryPage,
  ParsedIssueQuery,
} from "@/lib/issue-query-contract"
import type { IssueDisplay, IssueFilter } from "@/lib/issue-view-contract"
import { issueQuerySchema } from "@/lib/issue-query-contract"
import { db, issues } from "@/db"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import {
  readableIssueCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"

const cursorSchema = z
  .object({
    version: z.literal(1),
    binding: z.string().length(64),
    snapshot: z.string().datetime(),
    expires: z.number().int(),
    values: z.tuple([
      z.string().max(40),
      z.string().max(40),
      z.string().max(10000),
      z.string().max(12),
      z.uuid(),
    ]),
  })
  .strict()
const column = (name: string) => sql.identifier(name)
const fieldColumns: Record<IssueFilter["field"], string> = {
  status: "status_id",
  assignee: "assignee",
  agent: "agent",
  agentSession: "agent_session",
  creator: "creator",
  priority: "priority",
  labels: "labels",
  parentId: "parent",
  suggestedLabel: "suggested_label",
  dueDate: "due_date",
  createdAt: "created_day",
  updatedAt: "updated_day",
  project: "project",
  milestone: "milestone",
  subscribers: "subscribers",
  autoClosed: "auto_closed",
  content: "content",
  description: "description",
  links: "links",
  templateName: "template_name",
}
function ruleCondition(rule: IssueFilter): SQL {
  const value = sql`lower(trim(${column(fieldColumns[rule.field])}))`
  const expected = rule.value.trim().toLowerCase()
  const equal = ["labels", "subscribers"].includes(rule.field)
    ? sql`${expected} = ANY(regexp_split_to_array(${value}, '\\s*,\\s*'))`
    : sql`${value} = ${expected}`
  switch (rule.operator) {
    case "is":
      return equal
    case "isNot":
      return sql`NOT (${equal})`
    case "contains":
      return sql`strpos(${value}, ${expected}) > 0`
    case "notContains":
      return sql`strpos(${value}, ${expected}) = 0`
    case "set":
      return sql`${value} <> ''`
    case "notSet":
      return sql`${value} = ''`
    case "before":
      return sql`${value} <> '' AND ${value} < ${expected}`
    case "after":
      return sql`${value} <> '' AND ${value} > ${expected}`
  }
}
function groupColumn(group: IssueDisplay["group"]): SQL {
  const fields = {
    Status: "status_name",
    Priority: "priority",
    Assignee: "assignee",
    Project: "project",
    Labels: "first_label",
    "No grouping": "all_group",
  }
  return sql`${column(fields[group])}`
}
function orderColumns(query: ParsedIssueQuery) {
  return [
    { key: "completion_key", descending: false },
    { key: "completion_time", descending: true },
    { key: "sort_key", descending: query.display.descending },
    { key: "number_key", descending: false },
    { key: "id", descending: false },
  ]
}
function afterCursor(query: ParsedIssueQuery, values?: Array<string>) {
  if (!values) return sql`true`
  const keys = orderColumns(query)
  return sql`(${sql.join(
    keys.map(
      (key, index) =>
        sql`(${sql.join(
          [
            ...keys
              .slice(0, index)
              .map(
                (prior, n) =>
                  sql`${column(prior.key)} ${prior.key === "id" ? sql`` : sql`COLLATE "C"`} = ${values[n]}`
              ),
            sql`${column(key.key)} ${key.key === "id" ? sql`` : sql`COLLATE "C"`} ${key.descending ? sql`<` : sql`>`} ${values[index]}${key.key === "id" ? sql`::uuid` : sql``}`,
          ],
          sql` AND `
        )})`
    ),
    sql` OR `
  )})`
}

/** All predicates, aggregates and cursors are built over the same live authorized relation. */
export async function queryCanonicalIssues(
  actor: Actor,
  raw: IssueQuery
): Promise<IssueQueryPage> {
  const query = issueQuerySchema.parse(raw)
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`)
      const current = await currentCommandActor(tx, actor)
      requireResourceScope(current, "issues:read")
      const { cursor: _cursor, ...parameters } = query
      const binding = createHash("sha256")
        .update(
          JSON.stringify({
            parameters,
            workspace: current.workspaceId,
            user: current.userId,
            authentication: current.authentication,
          })
        )
        .digest("hex")
      const cursor = query.cursor
        ? cursorSchema.parse(
            JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))
          )
        : null
      if (
        cursor &&
        (cursor.binding !== binding ||
          cursor.expires < Date.now() ||
          Date.parse(cursor.snapshot) > Date.now() + 5000)
      )
        throw new Error(
          "This issue cursor expired or belongs to another query. Refresh the list."
        )
      // created_at is assigned by PostgreSQL. Using an application clock here
      // can hide a just-committed issue when the database is slightly ahead.
      const snapshot =
        cursor?.snapshot ??
        (
          await tx.execute<{ snapshot: string }>(
            sql`SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS snapshot`
          )
        ).rows[0].snapshot
      const expires = cursor?.expires ?? Date.now() + 15 * 60_000
      const domain: Array<SQL> = [
        sql`${issues.workspaceId} = ${current.workspaceId}`,
        readableTeamCondition(current, issues.teamId),
        sql`${issues.archivedAt} IS NULL`,
        sql`${issues.deletedAt} IS NULL`,
        sql`${issues.createdAt} <= ${snapshot}::timestamptz`,
      ]
      if (query.teamIds)
        domain.push(
          query.teamIds.length
            ? sql`${issues.teamId} IN (${sql.join(
                query.teamIds.map((id) => sql`${id}::uuid`),
                sql`,`
              )})`
            : sql`false`
        )
      if (query.project !== undefined)
        domain.push(
          sql`coalesce(${issues.projectId}::text, '') = ${query.project}`
        )
      if (query.cycle !== undefined)
        domain.push(
          sql`EXISTS(SELECT 1 FROM issue_cycles c WHERE c.id = ${issues.cycleId} AND c.start_date = ${query.cycle})`
        )
      if (query.milestone)
        domain.push(
          sql`coalesce(${issues.properties}->>'milestone','') IN (${sql.join(query.milestone.length ? query.milestone.map((v) => sql`${v}`) : [sql`''`], sql`,`)})`
        )
      if (query.triage) {
        domain.push(sql`${issues.properties}->>'triage' = 'true'`)
        if (!query.showSnoozed)
          domain.push(
            sql`coalesce(${issues.properties}->>'snoozed','false') <> 'true'`
          )
      }
      if (query.personal === "assigned")
        domain.push(sql`${issues.assigneeId} = ${current.userId}`)
      if (query.personal === "created")
        domain.push(sql`${issues.creatorId} = ${current.userId}`)
      if (query.personal === "subscribed")
        domain.push(
          sql`${current.userId} = ANY(regexp_split_to_array(coalesce(${issues.properties}->>'subscribers',''), '\\s*,\\s*'))`
        )
      if (query.personal === "activity")
        domain.push(
          sql`(${issues.creatorId} = ${current.userId} OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(${issues.properties}->'activity','[]')) e WHERE e->>'author' = ${current.userId}) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(${issues.properties}->'comments','[]')) e WHERE e->>'author' = ${current.userId}))`
        )
      const match: Array<SQL> = []
      if (query.scope === "active")
        match.push(sql`status_group IN ('unstarted','started')`)
      if (query.scope === "backlog") match.push(sql`status_group = 'backlog'`)
      if (!query.display.showSubIssues) match.push(sql`parent = ''`)
      if (query.search)
        match.push(
          sql`strpos(lower(content || E'\n' || identifier), ${query.search.toLowerCase()}) > 0`
        )
      if (query.filters.rules.length)
        match.push(
          sql`(${sql.join(query.filters.rules.map(ruleCondition), query.filters.match === "all" ? sql` AND ` : sql` OR `)})`
        )
      const order = query.display.order
      const sortKey =
        order === "Priority"
          ? sql`priority_rank`
          : order === "Status"
            ? sql`lpad(status_position::text, 10, '0')`
            : order === "Title"
              ? sql`lower(title)`
              : order === "Due date"
                ? sql`coalesce(nullif(due_date,''), chr(65535))`
                : order === "Created"
                  ? sql`created_sort`
                  : sql`updated_sort`
      const cte = sql`WITH RECURSIVE authorized AS MATERIALIZED (
      SELECT issues.id, issues.revision, issues.number, issues.team_id, issues.title, CASE WHEN ${readableIssueCondition(current, sql`issues.parent_id`)} THEN coalesce(issues.parent_id::text,'') ELSE '' END parent,
      issues.properties, issues.status_id, coalesce(s.name,issues.status_id) status_name, coalesce(s.status_group,'backlog') status_group,
      coalesce(s.position,0) status_position, coalesce(issues.assignee_id,'') assignee,
      coalesce(issues.creator_id,'') creator, coalesce(issues.project_id::text,'') project,
      coalesce(issues.properties->>'priority','No priority') priority,
      CASE issues.properties->>'priority' WHEN 'Urgent' THEN '0' WHEN 'High' THEN '1' WHEN 'Medium' THEN '2' WHEN 'Low' THEN '3' ELSE '4' END priority_rank,
      coalesce(issues.properties->>'description','') description,
      issues.title || E'\n' || coalesce(issues.properties->>'description','') content,
      (SELECT t.identifier FROM teams t WHERE t.id=issues.team_id) || '-' || issues.number::text identifier,
      coalesce((SELECT string_agg(l.name, ',' ORDER BY l.name) FROM issue_labels il JOIN resource_labels l ON l.id=il.label_id WHERE il.issue_id=issues.id),'') labels,
      coalesce((SELECT l.name FROM issue_labels il JOIN resource_labels l ON l.id=il.label_id WHERE il.issue_id=issues.id ORDER BY l.name LIMIT 1),'') first_label,
      coalesce(issues.properties->>'agent','') agent, coalesce(issues.properties->>'agentSession','') agent_session,
      '' suggested_label, coalesce(issues.properties->>'dueDate','') due_date,
      coalesce(issues.properties->>'milestone','') milestone, coalesce(issues.properties->>'subscribers','') subscribers,
      CASE WHEN issues.properties->>'autoClosed'='true' THEN 'Yes' ELSE 'No' END auto_closed,
      CASE WHEN ${Boolean(query.triage)} THEN CASE WHEN (issues.title || E'\n' || coalesce(issues.properties->>'description','')) ~* 'https?://[^[:space:]]+' THEN 'link' ELSE '' END ELSE coalesce((SELECT string_agg((e->>'title') || ' ' || (e->>'url'),',') FROM jsonb_array_elements(coalesce(issues.properties->'links','[]')) e),'') END links,
      coalesce(issues.properties->>'templateName','') template_name,
      to_char(issues.created_at AT TIME ZONE 'UTC','YYYY-MM-DD') created_day,
      to_char(issues.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD') updated_day,
      to_char(issues.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') created_sort,
      to_char(issues.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') updated_sort,
      CASE WHEN ${query.display.completedByRecency} AND nullif(issues.properties->>'completedAt','') IS NOT NULL THEN '0' ELSE '1' END completion_key,
      CASE WHEN ${query.display.completedByRecency} THEN coalesce(issues.properties->>'completedAt','') ELSE '' END completion_time,
      'All issues' all_group
      FROM issues LEFT JOIN issue_statuses s ON s.workspace_id=issues.workspace_id AND s.team_id=issues.team_id AND s.id=issues.status_id
      WHERE ${sql.join(domain, sql` AND `)}
    ), matching AS (SELECT id FROM authorized WHERE ${match.length ? sql.join(match, sql` AND `) : sql`true`}),
    included(id) AS (
      SELECT id FROM matching
      ${query.display.showSubIssues && query.display.nested === "Show all" ? sql`UNION SELECT a.id FROM authorized a JOIN included p ON a.parent = p.id::text` : sql``}
    ), result AS (SELECT a.*, lpad(number::text,12,'0') number_key, ${sortKey} COLLATE "C" sort_key FROM authorized a JOIN included i USING(id))`
      const facetFields: Array<[IssueFacet, SQL]> = [
        ["assignee", sql`assignee`],
        ["priority", sql`priority`],
        ["project", sql`project`],
        ["team", sql`team_id::text`],
        ["status", sql`status_id`],
        [
          "labels",
          sql`unnest(CASE WHEN labels='' THEN ARRAY[''] ELSE string_to_array(labels,',') END)`,
        ],
      ]
      type PageRow = {
        id: string
        completion_key: string
        completion_time: string
        sort_key: string
        number_key: string
      }
      const aggregated = await tx.execute<{
        resultRevision: string
        page: Array<PageRow>
        total: number
        counts: Array<{ facet: IssueFacet; value: string; count: number }>
        projectTotals: IssueQueryPage["projectTotals"]
        groups: IssueQueryPage["groups"]
        rollups: IssueQueryPage["rollups"]
      }>(sql`${cte}, facets AS (${sql.join(
        facetFields.map(
          ([facet, expression]) =>
            sql`SELECT ${facet}::text facet, ${expression} value, count(*)::int count FROM result GROUP BY value`
        ),
        sql` UNION ALL `
      )}),
      ranked AS (SELECT *, row_number() OVER(PARTITION BY facet ORDER BY count DESC,value) rank FROM facets)
      SELECT (SELECT count(*)::int FROM result) total,
      (SELECT md5(coalesce(string_agg(jsonb_build_array(id,revision,status_name,status_position,labels)::text, ',' ORDER BY id),'')) FROM result) AS "resultRevision",
      coalesce((SELECT jsonb_agg(p) FROM (SELECT id,completion_key,completion_time,sort_key,number_key FROM result WHERE ${afterCursor(query, cursor?.values)} ORDER BY ${sql.join(
        orderColumns(query).map(
          (key) =>
            sql`${column(key.key)} ${key.key === "id" ? sql`` : sql`COLLATE "C"`} ${key.descending ? sql`DESC` : sql`ASC`}`
        ),
        sql`, `
      )} LIMIT ${query.limit + 1}) p),'[]') page,
      coalesce((SELECT jsonb_agg(f) FROM (SELECT facet,value,count FROM ranked WHERE rank<=101 ORDER BY facet,rank) f),'[]') counts,
      coalesce((SELECT jsonb_agg(g) FROM (SELECT ${groupColumn(query.display.group)} AS "group",${groupColumn(query.display.subgroup)} subgroup,count(*)::int count FROM result GROUP BY 1,2 ORDER BY count DESC,1,2 LIMIT 501) g),'[]') groups,
      coalesce((SELECT jsonb_agg(p) FROM (SELECT project,count(*)::int count,count(*) FILTER(WHERE status_group='completed')::int completed FROM result GROUP BY 1 ORDER BY 1 LIMIT 1001) p),'[]') AS "projectTotals",
      coalesce((SELECT jsonb_agg(r) FROM (SELECT project,milestone,count(*)::int count,count(*) FILTER(WHERE status_group='completed')::int completed FROM result GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001) r),'[]') rollups
    `)
      const response = aggregated.rows[0]
      const facets = Object.fromEntries(
        facetFields.map(([facet]) => [
          facet,
          response.counts
            .filter((r) => r.facet === facet)
            .slice(0, 100)
            .map(({ value, count }) => ({ value, count })),
        ])
      ) as IssueQueryPage["facets"]
      const rows = response.page.slice(0, query.limit)
      const records = rows.length
        ? await readIssueRows(
            tx,
            current,
            rows.map((r) => r.id)
          )
        : []
      const byId = new Map(records.map((r) => [r.issue.id, r]))
      const last = rows.at(-1)
      return {
        workspaceId: current.workspaceId,
        userId: current.userId,
        sessionId:
          current.authentication.kind === "session"
            ? current.authentication.sessionId
            : "",
        records: rows.flatMap((r) => (byId.has(r.id) ? [byId.get(r.id)!] : [])),
        resultRevision: response.resultRevision,
        total: response.total,
        facets,
        projectTotals: response.projectTotals.slice(0, 1000),
        rollups: response.rollups.slice(0, 1000),
        facetsTruncated:
          facetFields.some(
            ([f]) => response.counts.filter((r) => r.facet === f).length > 100
          ) ||
          response.groups.length > 500 ||
          response.rollups.length > 1000 ||
          response.projectTotals.length > 1000,
        groups: response.groups.slice(0, 500),
        nextCursor:
          response.page.length > query.limit && last
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  binding,
                  snapshot,
                  expires,
                  values: [
                    last.completion_key,
                    last.completion_time,
                    last.sort_key,
                    last.number_key,
                    last.id,
                  ],
                })
              ).toString("base64url")
            : null,
      }
    },
    { isolationLevel: "repeatable read" }
  )
}
