import { createServerFn } from "@tanstack/react-start"

export const loadPromotedDesktopRelease = createServerFn({
  method: "GET",
}).handler(async () => {
  const { getPromotedDesktopRelease } =
    await import(
      "@/application/desktop-releases/desktop-release-service.server"
    )
  return getPromotedDesktopRelease()
})
