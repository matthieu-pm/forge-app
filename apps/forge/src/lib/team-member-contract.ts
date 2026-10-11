import { z } from "zod"

export type TeamMemberSummary = {
  userId: string
  name: string
  email: string
  image: string | null
  username: string | null
  workspaceRole: string
  teamRole: string | null
}

export type TeamMemberDirectory = {
  members: Array<TeamMemberSummary>
  availableMembers: Array<TeamMemberSummary>
  canManage: boolean
}

export const teamMemberQuerySchema = z
  .object({ slug: z.string().trim().min(1) })
  .strict()
export const addTeamMembersSchema = teamMemberQuerySchema
  .extend({ userIds: z.array(z.string().min(1)).min(1).max(100) })
  .strict()

export function teamMemberRole(member: TeamMemberSummary) {
  if (
    member.workspaceRole
      .split(",")
      .some((role) => ["owner", "admin"].includes(role.trim()))
  )
    return "Workspace admin"
  return member.teamRole === "lead" ? "Team lead" : "Member"
}

export function teamMembersCsv(members: Array<TeamMemberSummary>) {
  const cell = (value: string) => {
    const safe = /^[\s]*[=+@-]/.test(value) ? `'${value}` : value
    return `"${safe.replaceAll('"', '""')}"`
  }
  return [
    ["Name", "Email", "Role"],
    ...members.map((member) => [
      member.name,
      member.email,
      teamMemberRole(member),
    ]),
  ]
    .map((row) => row.map(cell).join(","))
    .join("\r\n")
}
