import { HugeiconsIcon } from "@hugeicons/react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { workspaceHighlights } from "@/lib/app-navigation"

export function PagePlaceholder({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string
  title: string
  description: string
}) {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6 md:p-8">
      <section className="flex max-w-3xl flex-col gap-3">
        <Badge variant="secondary" className="w-fit rounded-full px-3 py-1">
          {eyebrow}
        </Badge>
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
      </section>
      <section className="grid gap-4 lg:grid-cols-3">
        {workspaceHighlights.slice(0, 3).map((item) => (
          <Card key={item.title}>
            <CardHeader className="gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                <HugeiconsIcon icon={item.icon} strokeWidth={2} />
              </div>
              <div className="flex flex-col gap-1">
                <CardTitle>{item.title}</CardTitle>
                <CardDescription>{item.description}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              This placeholder gives the route a finished shell now, while
              leaving plenty of room for the real feature surface later.
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  )
}
