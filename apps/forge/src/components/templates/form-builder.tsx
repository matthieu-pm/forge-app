import * as React from "react"
import { Glyph, Picker } from "./template-controls"
import type { TemplateDraft } from "@/lib/template-contract"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"

type Field = TemplateDraft["fields"][number]
const types = [
  { value: "text", label: "Short text" },
  { value: "textarea", label: "Long text" },
  { value: "select", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "number", label: "Number" },
]
export function FormBuilder({
  fields,
  onChange,
}: {
  fields: Array<Field>
  onChange: (fields: Array<Field>) => void
}) {
  const [preview, setPreview] = React.useState(false)
  const patch = (id: string, change: Partial<Field>) =>
    onChange(fields.map((f) => (f.id === id ? { ...f, ...change } : f)))
  return (
    <section className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium">Form fields</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Edit fields" : "Preview form"}
        </Button>
      </div>
      <div className="space-y-3 rounded-xl border border-border/50 bg-muted/30 p-4">
        {!fields.length && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Add fields to collect the information your team needs.
          </p>
        )}
        {fields.map((field, index) =>
          preview ? (
            <div key={field.id} className="space-y-1.5">
              <label htmlFor={`preview-${field.id}`} className="text-xs">
                {field.label}
                {field.required && (
                  <span className="ml-1 text-muted-foreground">*</span>
                )}
              </label>
              {field.type === "textarea" ? (
                <textarea
                  id={`preview-${field.id}`}
                  placeholder="Enter text"
                  className="min-h-20 w-full rounded-lg border border-border bg-background/50 p-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
              ) : field.type === "select" ? (
                <select
                  id={`preview-${field.id}`}
                  className="h-8 w-full rounded-lg border border-border bg-background px-2 text-xs"
                >
                  <option value="">Select an option</option>
                  {field.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : field.type === "checkbox" ? (
                <div>
                  <Checkbox id={`preview-${field.id}`} />
                </div>
              ) : (
                <Input
                  id={`preview-${field.id}`}
                  type={field.type}
                  placeholder="Enter text"
                  className="h-8 rounded-lg"
                />
              )}
            </div>
          ) : (
            <div
              key={field.id}
              className="rounded-lg border border-border/60 bg-background/30 p-3"
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Field ${index + 1} label`}
                  value={field.label}
                  onChange={(e) => patch(field.id, { label: e.target.value })}
                  placeholder="Field label"
                  className="h-7 flex-1 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                />
                <Picker
                  label={`Field ${index + 1} type`}
                  value={field.type}
                  options={types}
                  onChange={(value) =>
                    patch(field.id, { type: value as Field["type"] })
                  }
                >
                  {types.find((t) => t.value === field.type)?.label}
                  <Glyph name="down" />
                </Picker>
                <button
                  type="button"
                  aria-label={`Move field ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => {
                    const reordered = [...fields]
                    ;[reordered[index - 1], reordered[index]] = [
                      reordered[index],
                      reordered[index - 1],
                    ]
                    onChange(reordered)
                  }}
                  className="size-6 rounded hover:bg-muted disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move field ${index + 1} down`}
                  disabled={index === fields.length - 1}
                  onClick={() => {
                    const reordered = [...fields]
                    ;[reordered[index + 1], reordered[index]] = [
                      reordered[index],
                      reordered[index + 1],
                    ]
                    onChange(reordered)
                  }}
                  className="size-6 rounded hover:bg-muted disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove field ${index + 1}`}
                  onClick={() =>
                    onChange(fields.filter((f) => f.id !== field.id))
                  }
                  className="grid size-6 place-items-center rounded hover:bg-muted"
                >
                  <Glyph name="close" />
                </button>
              </div>
              <label className="mt-3 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={field.required}
                  onCheckedChange={(required) => patch(field.id, { required })}
                  className="size-3.5"
                />
                Required
              </label>
              {field.type === "select" && (
                <div className="mt-3">
                  <label
                    htmlFor={`options-${field.id}`}
                    className="text-xs text-muted-foreground"
                  >
                    Options (one per line)
                  </label>
                  <textarea
                    id={`options-${field.id}`}
                    value={field.options.join("\n")}
                    onChange={(e) =>
                      patch(field.id, { options: e.target.value.split("\n") })
                    }
                    className="mt-1 min-h-16 w-full rounded-md border border-border bg-transparent p-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              )}
            </div>
          )
        )}
        {!preview && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 rounded-full text-xs"
            onClick={() =>
              onChange([
                ...fields,
                {
                  id: crypto.randomUUID(),
                  label: "",
                  type: "text",
                  required: false,
                  options: [],
                },
              ])
            }
          >
            <Glyph name="add" />
            Add field
          </Button>
        )}
      </div>
    </section>
  )
}
