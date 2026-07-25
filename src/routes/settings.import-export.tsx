import { createFileRoute } from "@tanstack/react-router"

import { ImportExportSettings } from "@/components/import-export-settings"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"

export const Route = createFileRoute("/settings/import-export")({
  beforeLoad: protectedRouteBeforeLoad,
  component: ImportExportSettings,
})
