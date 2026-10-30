import "@tanstack/react-start/server-only"
import sanitizeHtml from "sanitize-html"
import {
  FILE_PREVIEW_MAX_BYTES,
  FileDeliveryError,
} from "./file-delivery-contract"
import type { DeliveryFile } from "./file-delivery-service.server"

export const FILE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "content-security-policy":
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
}

function encodedName(name: string) {
  // Header-safe RFC 5987 encoding, including malformed legacy Unicode names.
  return encodeURIComponent(
    Buffer.from(name, "utf8")
      .toString("utf8")
      // eslint-disable-next-line no-control-regex -- Deliberately remove header control characters.
      .replace(/[\u0000-\u001f\u007f]/g, "_")
      .slice(0, 200)
  ).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}
export function downloadFileResponse(
  file: Pick<DeliveryFile, "name">,
  content: Uint8Array
) {
  let offset = 0
  // Streaming avoids the hosting buffered-response limit. Integrity was checked first.
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= content.byteLength) {
          controller.close()
          return
        }
        const end = Math.min(offset + 64 * 1024, content.byteLength)
        controller.enqueue(content.subarray(offset, end))
        offset = end
      },
      cancel() {
        offset = content.byteLength
      },
    }),
    {
      headers: {
        ...FILE_RESPONSE_HEADERS,
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodedName(file.name)}`,
        "content-type": "application/octet-stream",
      },
    }
  )
}

const escape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
const htmlTags = [
  "p",
  "br",
  "hr",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "blockquote",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
]

/** No document/office/PDF/archive extraction or arbitrary URL fetching occurs here. */
export function previewFileResponse(
  file: Pick<DeliveryFile, "name" | "contentType">,
  content: Uint8Array
) {
  if (content.byteLength > FILE_PREVIEW_MAX_BYTES)
    throw new FileDeliveryError("PREVIEW_UNAVAILABLE")
  let body: string
  if (
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
      file.contentType
    )
  ) {
    body = `<img alt="${escape(file.name)}" src="data:${file.contentType};base64,${Buffer.from(content).toString("base64")}">`
  } else {
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content)
    } catch {
      throw new FileDeliveryError("PREVIEW_UNAVAILABLE")
    }
    // eslint-disable-next-line no-control-regex -- Reject binary controls in otherwise valid UTF-8.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
      throw new FileDeliveryError("PREVIEW_UNAVAILABLE")
    if (file.contentType === "text/html" || /\.html?$/i.test(file.name)) {
      // No URL-bearing elements/attributes, styles, forms, meta refresh or embedded documents.
      body = sanitizeHtml(text, {
        allowedTags: htmlTags,
        allowedAttributes: {},
        nestingLimit: 32,
        disallowedTagsMode: "discard",
      })
    } else if (
      file.contentType === "image/svg+xml" ||
      /\.svg$/i.test(file.name)
    ) {
      const svg = sanitizeHtml(text, {
        allowedTags: [
          "svg",
          "g",
          "path",
          "rect",
          "circle",
          "ellipse",
          "line",
          "polyline",
          "polygon",
          "text",
          "tspan",
          "title",
          "desc",
        ],
        allowedAttributes: {
          "*": [
            "viewBox",
            "width",
            "height",
            "x",
            "y",
            "x1",
            "x2",
            "y1",
            "y2",
            "cx",
            "cy",
            "r",
            "rx",
            "ry",
            "d",
            "points",
            "transform",
            "fill",
            "stroke",
            "stroke-width",
            "opacity",
            "xmlns",
          ],
        },
        parser: { lowerCaseAttributeNames: false },
        nestingLimit: 32,
        // Color attributes cannot reference external documents or paint servers.
        transformTags: {
          "*": (tagName, attribs) => {
            for (const key of ["fill", "stroke"])
              if (
                attribs[key] &&
                !/^(?:none|currentColor|[a-zA-Z]+|#[0-9a-fA-F]{3,8}|rgba?\([\d\s,.%]+\))$/.test(
                  attribs[key]
                )
              )
                delete attribs[key]
            return { tagName, attribs }
          },
        },
      })
      // SVG is decoded in image mode as a second isolation boundary.
      body = `<img alt="${escape(file.name)}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">`
    } else if (
      file.contentType.startsWith("text/") ||
      file.contentType === "application/json"
    ) {
      body = `<pre>${escape(text)}</pre>`
    } else throw new FileDeliveryError("PREVIEW_UNAVAILABLE")
  }
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(file.name)}</title><style>body{margin:24px;font:14px/1.6 system-ui,sans-serif;color:#202020;background:#fff;overflow-wrap:anywhere}pre{white-space:pre-wrap}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}</style></head><body>${body}</body></html>`,
    {
      headers: {
        ...FILE_RESPONSE_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-disposition": "inline",
        "content-security-policy": `${FILE_RESPONSE_HEADERS["content-security-policy"]}; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; frame-src 'none'; connect-src 'none'`,
      },
    }
  )
}
