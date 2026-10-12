import type { StatusGroup } from "@/lib/team-statuses"

export function IssueStatusIcon({
  group,
  color,
  review = false,
}: {
  group: StatusGroup
  color: string
  review?: boolean
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4 shrink-0"
      style={{ color }}
      fill="none"
    >
      <circle
        cx="10"
        cy="10"
        r="7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeDasharray={group === "backlog" ? "1.4 2.1" : undefined}
        fill={
          ["completed", "canceled", "duplicate"].includes(group)
            ? "currentColor"
            : "none"
        }
      />
      {group === "started" && (
        <path
          d={review ? "M10 5a5 5 0 1 1-5 5h5Z" : "M10 5a5 5 0 0 1 0 10Z"}
          fill="currentColor"
        />
      )}
      {group === "completed" && (
        <path
          d="m6.5 10 2.2 2.2 4.8-4.5"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {group === "canceled" && (
        <path
          d="m7.5 7.5 5 5m0-5-5 5"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
      {group === "duplicate" && (
        <path
          d="m6.5 10 3.5-3.5m0 7 3.5-3.5"
          stroke="var(--background)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}
