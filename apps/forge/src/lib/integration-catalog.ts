import {
  AiBrowserIcon,
  AiCloudIcon,
  AiSheetsIcon,
  ApiIcon,
  BrowserIcon,
  ChatGptIcon,
  ClaudeIcon,
  CloudIcon,
  CodeIcon,
  ComputerTerminal01Icon,
  CopilotIcon,
  Cursor02Icon,
  DatabaseIcon,
  FactoryIcon,
  FigmaIcon,
  GithubIcon,
  GitlabIcon,
  GoogleIcon,
  Message01Icon,
  NotionIcon,
  ReplitIcon,
  Robot01Icon,
  Search01Icon,
  SlackIcon,
  SourceCodeIcon,
  SparklesIcon,
  WindSurfIcon,
} from "@hugeicons/core-free-icons"
import type { HugeiconsIcon } from "@hugeicons/react"
import type { ComponentProps } from "react"

export type IntegrationIcon = ComponentProps<typeof HugeiconsIcon>["icon"]

export type Integration = {
  id: string
  name: string
  description: string
  icon: IntegrationIcon
  iconClassName: string
  iconSurfaceClassName: string
  enabled?: boolean
}

export type IntegrationCategory = {
  id: string
  label: string
  integrations: Array<Integration>
}

const integrationLogoFiles: Record<string, string> = {
  adk: "google.svg",
  aikido: "aikido.png",
  airbyte: "airbyte.svg",
  arc: "arc.svg",
  attio: "attio.png",
  "bird-eats-bug": "bird-eats-bug.png",
  canva: "canva.jpg",
  charlie: "charlie.png",
  chatgpt: "openai.svg",
  chatprd: "chatprd.png",
  claude: "claude.svg",
  "claude-code": "claude.svg",
  codegen: "codegen.png",
  codex: "openai.svg",
  cursor: "cursor.svg",
  "cursor-mcp": "cursor.svg",
  "cycle-report": "cycle-report.png",
  datadog: "datadog.svg",
  descript: "descript.svg",
  devin: "devin.svg",
  discord: "discord.svg",
  drata: "drata.png",
  dust: "dust.png",
  email: "forge-icon.svg",
  factory: "factory.png",
  figma: "figma.svg",
  fillout: "fillout.svg",
  fivetran: "fivetran.png",
  "forge-asks": "slack.svg",
  api: "forge-icon.svg",
  github: "github.svg",
  "github-copilot": "github-copilot.svg",
  "github-engineering": "github.svg",
  gitlab: "gitlab.svg",
  "gitlab-engineering": "gitlab.svg",
  glean: "glean.png",
  gong: "gong.png",
  "google-sheets": "google-sheets.svg",
  honeybadger: "honeybadger.svg",
  "incident-io": "incident-io.svg",
  intercom: "intercom.svg",
  jam: "jam.png",
  jellyfish: "jellyfish.png",
  jira: "jira.svg",
  loom: "loom.svg",
  miro: "miro.svg",
  notion: "notion.svg",
  orca: "orca.png",
  pagerduty: "pagerduty.svg",
  range: "range.png",
  raycast: "raycast.svg",
  replit: "replit.svg",
  retool: "retool.svg",
  salesforce: "salesforce.svg",
  sentry: "sentry.svg",
  "sentry-agent": "sentry.svg",
  slack: "slack.svg",
  v0: "v0.png",
  vanta: "vanta.png",
  vercel: "vercel.svg",
  "vs-code": "vs-code.svg",
  windsurf: "windsurf.svg",
  youtube: "youtube.svg",
  zapier: "zapier.svg",
  zendesk: "zendesk.svg",
}

export function getIntegrationLogoPath(integration: Integration) {
  const file = integrationLogoFiles[integration.id]

  if (!file) return undefined

  return file === "forge-icon.svg"
    ? "/img/forge-icon.svg"
    : `/img/integrations/${file}`
}

const neutralIcon = "text-foreground"
const neutralSurface = "bg-background"
const violetIcon = "text-violet-500"
const violetSurface = "bg-violet-500/12"
const orangeIcon = "text-orange-500"
const orangeSurface = "bg-orange-500/12"
const blueIcon = "text-blue-500"
const blueSurface = "bg-blue-500/12"
const emeraldIcon = "text-emerald-500"
const emeraldSurface = "bg-emerald-500/12"
const roseIcon = "text-rose-500"
const roseSurface = "bg-rose-500/12"

export const integrationCategories: Array<IntegrationCategory> = [
  {
    id: "essentials",
    label: "Essentials",
    integrations: [
      {
        id: "github",
        name: "GitHub",
        description:
          "Automate pull request workflows, sync issues, and connect code to product work.",
        icon: GithubIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
        enabled: true,
      },
      {
        id: "slack",
        name: "Slack",
        description: "Create issues from Slack messages and sync threads.",
        icon: SlackIcon,
        iconClassName: "text-fuchsia-500",
        iconSurfaceClassName: neutralSurface,
        enabled: true,
      },
      {
        id: "gitlab",
        name: "GitLab",
        description: "Automate your merge request workflow.",
        icon: GitlabIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "figma",
        name: "Figma",
        description: "Create and link issues directly from Figma.",
        icon: FigmaIcon,
        iconClassName: roseIcon,
        iconSurfaceClassName: neutralSurface,
        enabled: true,
      },
      {
        id: "intercom",
        name: "Intercom",
        description:
          "Keep a tight feedback loop with customers and streamline bug reports.",
        icon: Message01Icon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "google-sheets",
        name: "Google Sheets",
        description:
          "Build custom dashboards and analytics from issue and project data.",
        icon: AiSheetsIcon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    integrations: [
      {
        id: "codex",
        name: "Codex",
        description: "Delegate issues to Codex directly from Forge.",
        icon: ChatGptIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "cursor",
        name: "Cursor",
        description: "Turn issues into pull requests with Cursor cloud agents.",
        icon: Cursor02Icon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: "bg-stone-950 dark:bg-stone-100",
      },
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        description:
          "Turn Forge issues into code with GitHub Copilot coding agent.",
        icon: CopilotIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "factory",
        name: "Factory",
        description: "Assign issues from your backlog to Droids.",
        icon: FactoryIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "sentry-agent",
        name: "Sentry Agent",
        description: "Resolve Forge issues with Seer by Sentry.",
        icon: SparklesIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "devin",
        name: "Devin",
        description: "Automate work from issue to tested pull request.",
        icon: Robot01Icon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "chatprd",
        name: "ChatPRD",
        description:
          "Write requirements, manage issues, and review product work.",
        icon: Message01Icon,
        iconClassName: roseIcon,
        iconSurfaceClassName: roseSurface,
      },
      {
        id: "charlie",
        name: "Charlie",
        description: "Plan, implement, and review TypeScript pull requests.",
        icon: CodeIcon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
      {
        id: "codegen",
        name: "Codegen",
        description: "Turn scoped issues into reviewable code changes.",
        icon: SourceCodeIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
    ],
  },
  {
    id: "ai-clients",
    label: "AI clients",
    integrations: [
      {
        id: "cursor-mcp",
        name: "Cursor MCP",
        description: "Connect Cursor to the Forge MCP server.",
        icon: Cursor02Icon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: "bg-stone-950 dark:bg-stone-100",
      },
      {
        id: "chatgpt",
        name: "ChatGPT",
        description: "Connect ChatGPT research to Forge.",
        icon: ChatGptIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "claude",
        name: "Claude",
        description: "Connect Claude to the Forge MCP server.",
        icon: ClaudeIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "v0",
        name: "v0 by Vercel MCP connector",
        description: "Connect v0 and Forge through MCP.",
        icon: AiBrowserIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "windsurf",
        name: "Windsurf",
        description: "Connect Windsurf to the Forge MCP server.",
        icon: WindSurfIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "replit",
        name: "Replit",
        description: "Build apps and automations from Forge work.",
        icon: ReplitIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "dust",
        name: "Dust",
        description: "Build AI workflows with Forge issues.",
        icon: SparklesIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "adk",
        name: "ADK",
        description: "Connect your Google ADK agents to Forge.",
        icon: GoogleIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "claude-code",
        name: "Claude Code",
        description: "Give Claude Code issue context through MCP.",
        icon: ComputerTerminal01Icon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
    ],
  },
  {
    id: "engineering",
    label: "Engineering",
    integrations: [
      {
        id: "github-engineering",
        name: "GitHub",
        description:
          "Automate pull request workflows, sync issues, and connect your codebase.",
        icon: GithubIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
        enabled: true,
      },
      {
        id: "gitlab-engineering",
        name: "GitLab",
        description: "Automate your merge request workflow.",
        icon: GitlabIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "pagerduty",
        name: "PagerDuty Triage Responsibility",
        description: "Automate triage rotation with PagerDuty schedules.",
        icon: CloudIcon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
      {
        id: "sentry",
        name: "Sentry",
        description: "Create and link issues with Sentry.",
        icon: SparklesIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "vs-code",
        name: "VS Code",
        description: "Build VS Code extensions with Forge Connect.",
        icon: CodeIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "datadog",
        name: "Datadog",
        description: "Create Forge issues from Datadog cases and monitors.",
        icon: DatabaseIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "incident-io",
        name: "incident.io",
        description: "Manage incidents and triage responsibility in Forge.",
        icon: CloudIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "raycast",
        name: "Raycast",
        description: "Create, search, and modify issues from anywhere.",
        icon: ComputerTerminal01Icon,
        iconClassName: roseIcon,
        iconSurfaceClassName: roseSurface,
      },
      {
        id: "vercel",
        name: "Vercel",
        description: "Connect deployment feedback to Forge issues.",
        icon: AiCloudIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
      },
    ],
  },
  {
    id: "forge-crafted",
    label: "Forge crafted",
    integrations: [
      {
        id: "notion",
        name: "Notion",
        description: "Preview Forge issues, views, and projects in Notion.",
        icon: NotionIcon,
        iconClassName: neutralIcon,
        iconSurfaceClassName: neutralSurface,
        enabled: true,
      },
      {
        id: "forge-asks",
        name: "Forge Asks for Slack",
        description: "Turn requests from Slack into actionable issues.",
        icon: SlackIcon,
        iconClassName: "text-fuchsia-500",
        iconSurfaceClassName: neutralSurface,
      },
      {
        id: "email",
        name: "Create issues via email",
        description: "Create issues from dedicated team email addresses.",
        icon: Message01Icon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "api",
        name: "Forge API",
        description: "Build a custom integration with the Forge API.",
        icon: ApiIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
    ],
  },
  {
    id: "bug-reporting",
    label: "Bug reporting",
    integrations: [
      {
        id: "bird-eats-bug",
        name: "Bird Eats Bug",
        description: "Speed up bug reporting with rich reproduction context.",
        icon: BrowserIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "honeybadger",
        name: "Honeybadger",
        description: "Manage Honeybadger errors through Forge issues.",
        icon: SparklesIcon,
        iconClassName: roseIcon,
        iconSurfaceClassName: roseSurface,
      },
      {
        id: "jam",
        name: "Jam",
        description: "Create issues with the details developers need.",
        icon: BrowserIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "arc",
        name: "Arc",
        description: "Create issues from your browser command bar.",
        icon: AiBrowserIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
    ],
  },
  {
    id: "automations",
    label: "Automations",
    integrations: [
      {
        id: "zapier",
        name: "Zapier",
        description: "Build automations to create or update Forge issues.",
        icon: SparklesIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "jira",
        name: "Jira",
        description: "Transition issue data from Jira to Forge.",
        icon: SourceCodeIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "fivetran",
        name: "Fivetran",
        description: "Sync Forge data to your analytics stack.",
        icon: DatabaseIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "fillout",
        name: "Fillout",
        description: "Create issues from a customizable intake form.",
        icon: BrowserIcon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
    ],
  },
  {
    id: "customer-experience",
    label: "Customer experience",
    integrations: [
      {
        id: "zendesk",
        name: "Zendesk",
        description: "Keep a tight feedback loop with customers.",
        icon: Message01Icon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
      {
        id: "salesforce",
        name: "Salesforce",
        description: "Create Forge issues from Salesforce cases.",
        icon: CloudIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "attio",
        name: "Attio",
        description: "Link customer requests and issues to customer records.",
        icon: DatabaseIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "gong",
        name: "Gong",
        description: "Create customer requests from call insights.",
        icon: Message01Icon,
        iconClassName: roseIcon,
        iconSurfaceClassName: roseSurface,
      },
    ],
  },
  {
    id: "collaboration",
    label: "Collaboration",
    integrations: [
      {
        id: "discord",
        name: "Discord",
        description: "Create issues, share updates, and keep teams in sync.",
        icon: Message01Icon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "glean",
        name: "Glean",
        description: "Search Forge for instant workspace insights.",
        icon: Search01Icon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
      {
        id: "range",
        name: "Range",
        description: "Pull Forge issues into async check-ins.",
        icon: Message01Icon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "miro",
        name: "Miro",
        description:
          "Import, create, and manage issues from collaborative boards.",
        icon: BrowserIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
    ],
  },
  {
    id: "media-design",
    label: "Media & design",
    integrations: [
      {
        id: "descript",
        name: "Descript",
        description: "Embed Descript share links in issues and documents.",
        icon: Message01Icon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "loom",
        name: "Loom",
        description: "Embed Loom videos in issues and documents.",
        icon: BrowserIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "youtube",
        name: "YouTube",
        description: "Embed YouTube videos in Forge work.",
        icon: BrowserIcon,
        iconClassName: roseIcon,
        iconSurfaceClassName: roseSurface,
      },
      {
        id: "canva",
        name: "Canva AI Connector",
        description: "Create workflow content directly within Canva.",
        icon: SparklesIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    integrations: [
      {
        id: "airbyte",
        name: "Airbyte",
        description: "Consolidate Forge data in warehouses and lakes.",
        icon: DatabaseIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "retool",
        name: "Retool",
        description: "Analyze Forge issues in custom internal tools.",
        icon: AiSheetsIcon,
        iconClassName: orangeIcon,
        iconSurfaceClassName: orangeSurface,
      },
      {
        id: "jellyfish",
        name: "Jellyfish",
        description: "Understand developer productivity and AI impact.",
        icon: AiSheetsIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "cycle-report",
        name: "Cycle Report",
        description: "Create reviewable reports for Forge cycles.",
        icon: AiSheetsIcon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
    ],
  },
  {
    id: "security-compliance",
    label: "Security & compliance",
    integrations: [
      {
        id: "vanta",
        name: "Vanta",
        description: "Automate compliance and demonstrate trust.",
        icon: CloudIcon,
        iconClassName: violetIcon,
        iconSurfaceClassName: violetSurface,
      },
      {
        id: "drata",
        name: "Drata",
        description: "Simplify risk and compliance management.",
        icon: CloudIcon,
        iconClassName: blueIcon,
        iconSurfaceClassName: blueSurface,
      },
      {
        id: "orca",
        name: "Orca Security",
        description: "Route security fixes to the right team with context.",
        icon: CloudIcon,
        iconClassName: emeraldIcon,
        iconSurfaceClassName: emeraldSurface,
      },
      {
        id: "aikido",
        name: "Aikido Security",
        description: "Put application security workflows on autopilot.",
        icon: SparklesIcon,
        iconClassName: roseIcon,
        iconSurfaceClassName: roseSurface,
      },
    ],
  },
]

export const enabledIntegrations = [
  integrationCategories[0].integrations[0],
  integrationCategories[0].integrations[1],
  integrationCategories[0].integrations[3],
  integrationCategories[4].integrations[0],
]
