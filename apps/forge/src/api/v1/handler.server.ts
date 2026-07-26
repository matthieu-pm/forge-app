import "@tanstack/react-start/server-only"

import { OpenAPIHandler } from "@orpc/openapi/fetch"
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins"
import {
  ZodToJsonSchemaConverter,
  experimental_ZodSmartCoercionPlugin,
} from "@orpc/zod/zod4"

import { publicApiRouter } from "@/api/v1/router.server"

const handler = new OpenAPIHandler(publicApiRouter, {
  plugins: [
    new experimental_ZodSmartCoercionPlugin(),
    new OpenAPIReferencePlugin({
      docsPath: "/docs",
      specPath: "/openapi.json",
      docsTitle: "Forge API Reference",
      docsProvider: "scalar",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Forge API",
          version: "1.0.0",
          description:
            "Programmatic access to Forge workspaces and their resources.",
        },
        servers: [{ url: "/api/v1" }],
        security: [{ bearerAuth: [] }],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "Forge API key",
            },
          },
        },
      },
    }),
  ],
})

export function isPublicApiEnabled() {
  const configured = process.env.PUBLIC_API_ENABLED
  return (
    configured === "true" ||
    (configured !== "false" && process.env.NODE_ENV !== "production")
  )
}

export async function handlePublicApiRequest(request: Request) {
  if (!isPublicApiEnabled()) {
    return new Response("Not Found", { status: 404 })
  }

  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID()
  const { response } = await handler.handle(request, {
    prefix: "/api/v1",
    context: { headers: request.headers, requestId },
  })

  if (!response) return new Response("Not Found", { status: 404 })

  response.headers.set("x-request-id", requestId)
  response.headers.set("cache-control", "no-store")
  return response
}

export function rewritePublicApiRequest(request: Request, pathname: string) {
  const url = new URL(request.url)
  url.pathname = pathname
  return new Request(url, request)
}
