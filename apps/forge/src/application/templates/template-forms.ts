import type { JSONContent } from "@tiptap/core"
import type { TemplateDraft } from "@/lib/template-contract"
import type { ApplyTemplate } from "@/lib/template-application-contract"

export class TemplateValidationError extends Error {}
export function formContent(
  template: TemplateDraft,
  answers: ApplyTemplate["answers"]
): JSONContent | null {
  if (template.issueType !== "form") {
    if (Object.keys(answers).length)
      throw new TemplateValidationError(
        "This template has no form fields. Reload templates and review your answers."
      )
    return template.content
  }
  const fields = template.fields
  if (
    new Set(fields.map((f) => f.id)).size !== fields.length ||
    fields.some((f) => !f.id)
  )
    throw new TemplateValidationError(
      "This form has duplicate or missing field identifiers. Ask a template administrator to repair it."
    )
  if (Object.keys(answers).some((id) => !fields.some((f) => f.id === id)))
    throw new TemplateValidationError(
      "The form fields changed. Reload templates and review your answers."
    )
  const content = [...(template.content?.content ?? [])]
  for (const field of fields) {
    const answer = answers[field.id]
    const empty =
      answer === undefined ||
      answer === "" ||
      (typeof answer === "string" && !answer.trim())
    if (
      field.required &&
      (empty || (field.type === "checkbox" && answer !== true))
    )
      throw new TemplateValidationError(
        `Complete “${field.label}” before creating the issue.`
      )
    if (empty) continue
    const valid =
      field.type === "checkbox"
        ? typeof answer === "boolean"
        : field.type === "number"
          ? typeof answer === "number" && Number.isFinite(answer)
          : field.type === "select"
            ? typeof answer === "string" && field.options.includes(answer)
            : field.type === "date"
              ? typeof answer === "string" &&
                /^\d{4}-\d{2}-\d{2}$/.test(answer) &&
                !Number.isNaN(Date.parse(answer)) &&
                new Date(answer).toISOString().slice(0, 10) === answer
              : typeof answer === "string"
    if (!valid)
      throw new TemplateValidationError(
        `Check the answer for “${field.label}”.`
      )
    content.push(
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: field.label }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text:
              typeof answer === "boolean"
                ? answer
                  ? "Yes"
                  : "No"
                : String(answer),
          },
        ],
      }
    )
  }
  return { type: "doc", content }
}
export function templateDocumentText(node: JSONContent | null): string {
  if (!node) return ""
  if (node.text) return node.text
  if (node.type === "hardBreak") return "\n"
  return (node.content ?? [])
    .map(templateDocumentText)
    .join(
      ["doc", "bulletList", "orderedList"].includes(node.type ?? "") ? "\n" : ""
    )
}
