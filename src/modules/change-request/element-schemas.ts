/**
 * FLF-469 (A.4): khuôn JSON rút gọn của phần tử Spine cho prompt C-4 (`{{element_schemas}}`). Sinh từ
 * `assets/schema/srs-spine.schema.json` (xuất từ Zod) nên không viết tay, không lệch với bước kiểm lúc ghi. Model hay
 * đoán field (`attributes[].type`, `flows_in` dạng object, thiếu `required`, động từ quan hệ tiếng Việt) - cho thấy khuôn
 * thật thì op `add` đúng ngay từ đầu.
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { getAssetsRoot } from "../../config/paths.js"
import type { IChangeLocation } from "./change-location.model.js"

type Json = Record<string, unknown>

let cached: Json | null = null
const schemaProperties = (): Json => {
  if (!cached) {
    const file = JSON.parse(readFileSync(path.join(getAssetsRoot(), "schema", "srs-spine.schema.json"), "utf8")) as { properties?: Json }
    cached = file.properties ?? {}
  }
  return cached
}

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v)

/** Kiểu rút gọn của một nhánh schema: `string`, `"a"|"b"`, `string[]`, `{ field*: type }`, `record<string, type>`, `X|null`. */
export const compactType = (node: unknown): string => {
  if (!isObject(node)) return "any"
  if (Array.isArray(node.anyOf)) return [...new Set((node.anyOf as unknown[]).map(compactType))].join("|")
  if (Array.isArray(node.enum)) return (node.enum as unknown[]).map((v) => JSON.stringify(v)).join("|")
  switch (node.type) {
    case "null":
      return "null"
    case "string":
      return typeof node.pattern === "string" ? `string(pattern ${node.pattern})` : "string"
    case "integer":
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "array":
      return `${compactType(node.items)}[]`
    case "object": {
      if (isObject(node.properties)) {
        const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
        const fields = Object.entries(node.properties).map(([k, v]) => `${k}${required.has(k) ? "*" : ""}: ${compactType(v)}`)
        return `{ ${fields.join(", ")} }`
      }
      return `record<string, ${compactType(node.additionalProperties)}>`
    }
    default:
      return "any"
  }
}

/** `functions[id=FN001].name` / `functions[]` ⇒ `functions`; `project` ⇒ `project`. */
const rootOfPath = (p: string): string | null => (p === "project" || p.startsWith("project.") ? "project" : (/^(\w+)\[/.exec(p)?.[1] ?? null))

/** Khuôn của một mảng: một dòng `name[]: { field*: type, ... }` (`*` = bắt buộc). Không có trong schema ⇒ null. */
export const elementSchemaLine = (array: string): string | null => {
  const node = schemaProperties()[array]
  if (!isObject(node)) return null
  if (node.type === "array") return `${array}[]: ${compactType(node.items)}`
  return `${array}: ${compactType(node)}`
}

const MAX_CHARS = 7000

/** Khuôn của mọi mảng mà các vị trí chạm tới (không lặp), cắt ở `MAX_CHARS`. Không có ⇒ "(none)". */
export const elementSchemasText = (locations: readonly Pick<IChangeLocation, "path">[]): string => {
  const roots = [...new Set(locations.map((l) => rootOfPath(l.path)).filter((r): r is string => !!r))]
  const lines = roots.flatMap((r) => {
    const line = elementSchemaLine(r)
    return line ? [line] : []
  })
  if (!lines.length) return "(none)"
  const text = ["`*` = required field. No other field is allowed; a value outside this shape fails the checks.", ...lines].join("\n")
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}...` : text
}
