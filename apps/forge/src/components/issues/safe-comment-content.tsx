import { Fragment } from "react"
import type { ReactNode } from "react"
import type { CommentNode } from "@/lib/comment-rich-text"
import { validateCommentDocument } from "@/lib/comment-rich-text"

/** Stored/legacy JSON is untrusted too. React text and a fixed tag map only. */
export function SafeCommentContent({
  document,
  fallback,
}: {
  document?: unknown
  fallback: string
}) {
  let doc: CommentNode
  try {
    doc = validateCommentDocument(document)
  } catch {
    return <p className="whitespace-pre-wrap">{fallback}</p>
  }
  function render(n: CommentNode, key: number): ReactNode {
    if (n.type === "text") {
      let text: ReactNode = n.text
      for (const [i, m] of (n.marks ?? []).entries()) {
        if (m.type === "link")
          text = (
            <a
              key={i}
              href={String(m.attrs!.href)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline"
            >
              {text}
            </a>
          )
        else if (m.type === "bold") text = <strong key={i}>{text}</strong>
        else if (m.type === "italic") text = <em key={i}>{text}</em>
        else if (m.type === "strike") text = <s key={i}>{text}</s>
        else text = <code key={i}>{text}</code>
      }
      return <Fragment key={key}>{text}</Fragment>
    }
    if (n.type === "mention")
      return (
        <span key={key} className="rounded bg-primary/10 px-1 text-primary">
          @{String(n.attrs!.label)}
        </span>
      )
    if (n.type === "hardBreak") return <br key={key} />
    const children = n.content?.map(render)
    switch (n.type) {
      case "paragraph":
        return (
          <p key={key} className="min-h-5 whitespace-pre-wrap">
            {children}
          </p>
        )
      case "blockquote":
        return (
          <blockquote key={key} className="border-l-2 pl-3">
            {children}
          </blockquote>
        )
      case "bulletList":
        return (
          <ul key={key} className="list-disc pl-5">
            {children}
          </ul>
        )
      case "orderedList":
        return (
          <ol
            key={key}
            start={Number(n.attrs?.start ?? 1)}
            className="list-decimal pl-5"
          >
            {children}
          </ol>
        )
      case "listItem":
        return <li key={key}>{children}</li>
      case "codeBlock":
        return (
          <pre key={key} className="overflow-x-auto rounded bg-muted p-2">
            <code>{children}</code>
          </pre>
        )
      default:
        return <Fragment key={key}>{children}</Fragment>
    }
  }
  return <div className="text-sm">{render(doc, 0)}</div>
}
