import { randomUUID } from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { databaseClient as pool } from "./database"
import type { Actor } from "@/application/actor"
import {
  createCanonicalIssue,
  readCanonicalIssues,
} from "@/application/issues/issues.server"
import { commandIssueComment } from "@/application/issues/issue-comments.server"
import { commandIssueEngagement } from "@/application/issues/issue-engagement.server"
import { editCanonicalIssues } from "@/application/issues/edit-issues.server"
import {
  activateInbox,
  runInbox,
} from "@/application/inbox/inbox-delivery.server"
import { blankIssueDraft } from "@/lib/issue-record-contract"

const workspaceId = "for65-browser",
  aliceId = "for65-browser-alice",
  bobId = "for65-browser-bob"
const alice: Actor = {
  userId: aliceId,
  workspaceId,
  workspaceRole: "admin",
  authentication: { kind: "session", sessionId: "for65-browser-alice-session" },
  scopes: null,
}
const bob: Actor = {
  ...alice,
  userId: bobId,
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "for65-browser-bob-session" },
}
export async function runScenario(action: string) {
  if (action === "cleanup" || action === "seed") {
    await pool.query(
      "DELETE FROM background_job_steps WHERE job_id IN (SELECT id FROM background_jobs WHERE input->>'workspaceId'=$1)",
      [workspaceId]
    )
    await pool.query(
      "DELETE FROM background_jobs WHERE input->>'workspaceId'=$1",
      [workspaceId]
    )
    await pool.query("DELETE FROM organization WHERE id=$1", [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[aliceId, bobId]])
    if (action === "cleanup") return { cleaned: true }
    await pool.query(
      "INSERT INTO organization(id,name,slug) VALUES($1,'Inbox acceptance',$1)",
      [workspaceId]
    )
    const password = await hashPassword("for65-local-fixture-password")
    for (const actor of [alice, bob]) {
      const name = actor.userId === aliceId ? "Alice" : "Bob"
      await pool.query(
        'INSERT INTO "user"(id,name,email,email_verified) VALUES($1,$2,$3,true)',
        [actor.userId, name, `${name.toLowerCase()}-for65@example.test`]
      )
      await pool.query(
        "INSERT INTO account(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$2,$3)",
        [randomUUID(), actor.userId, password]
      )
      await pool.query(
        "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,$4)",
        [randomUUID(), workspaceId, actor.userId, actor.workspaceRole]
      )
      await pool.query(
        "INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,now()+interval '1 day')",
        [
          actor.authentication.kind === "session"
            ? actor.authentication.sessionId
            : "",
          actor.userId,
          workspaceId,
        ]
      )
    }
    const teamId = randomUUID()
    await pool.query(
      "INSERT INTO teams(id,workspace_id,name,slug,identifier,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,'Engineering','engineering','ENG','emoji','⚙️','#94a3b8','Europe/Paris',$3)",
      [teamId, workspaceId, aliceId]
    )
    await activateInbox(pool)
    const issueId = (
      await createCanonicalIssue(alice, {
        teamId,
        commandKey: randomUUID(),
        draft: {
          ...blankIssueDraft("todo"),
          title: "Review shared inbox delivery",
        },
      })
    ).issue.id
    await commandIssueEngagement(bob, {
      action: "subscription",
      commandKey: randomUUID(),
      teamId,
      issueId,
      subscribed: true,
    })
  }
  const record = (await readCanonicalIssues(alice)).records[0]
  if (action === "revoke") {
    await pool.query("UPDATE teams SET visibility='private' WHERE id=$1", [
      record.teamId,
    ])
    return { revoked: true }
  }
  if (action === "deliver" || action === "seed") {
    const { teamId, issue } = record
    await commandIssueComment(alice, {
      action: "create",
      commandKey: randomUUID(),
      teamId,
      issueId: issue.id,
      commentId: randomUUID(),
      expectedVersion: 0,
      parentId: "",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ready for your review, " },
              { type: "mention", attrs: { id: bobId, label: "Bob" } },
            ],
          },
        ],
      },
    })
    const latest = (await readCanonicalIssues(alice)).records[0].issue
    await editCanonicalIssues(alice, {
      teamId,
      commandKey: randomUUID(),
      edits: [
        {
          issueId: issue.id,
          expectedRevision: latest.revision!,
          changes: { title: "Shared inbox ready for review" },
        },
      ],
    })
    return runInbox(pool)
  }
  return { ready: true }
}
