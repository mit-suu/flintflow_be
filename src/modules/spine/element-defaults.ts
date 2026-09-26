/**
 * element-defaults.ts
 * ─────────────────────────────────────────────────────────────────
 * Chuẩn hoá phần tử của op `add` TRƯỚC khi áp (FLF-177 fix-plan WP-1 — BUG-04).
 *
 * Model hay bỏ trống mảng tham chiếu (`includes`, `extends`, `function_ids`, `flow_to`,
 * `business_rule_ids`…). Trước đây phần tử thiếu mảng lọt vào cascade/bất biến và `for…of undefined` ném
 * `TypeError: values is not iterable` TRƯỚC khi schema kịp bắt ⇒ lỗi 501 thay vì lỗi validate để model
 * sửa. Mảng rỗng là giá trị mặc định đúng nghĩa của mọi mảng trong schema phần tử, nên điền `[]`.
 *
 * Chỉ điền mảng và vài field nullable mà `null` là "chưa có" không đổi nghĩa (`priority`,
 * `primary_function_id`, `confirmed_at`). KHÔNG điền `screen_id`, `feature_id`… — thiếu chúng là lỗi thật
 * (`screen_id = null` là function không thuộc màn nào), schema phải từ chối để model sửa.
 */

import { z } from "zod"
import {
  actorSchema,
  addendumSchema,
  assumptionSchema,
  businessRuleSchema,
  commonRequirementSchema,
  customSectionSchema,
  diagramSchema,
  entitySchema,
  featureSchema,
  functionSchema,
  glossaryTermSchema,
  messageSchema,
  nfrSchema,
  otherRequirementSchema,
  permissionSchema,
  roleSchema,
  screenSchema,
  useCaseSchema,
  validationSchema
} from "./spine.schema.js"

type ElementSchema = z.ZodObject<z.ZodRawShape>

const ELEMENT_SCHEMAS: Readonly<Record<string, ElementSchema>> = Object.freeze({
  features: featureSchema,
  actors: actorSchema,
  roles: roleSchema,
  use_cases: useCaseSchema,
  screens: screenSchema,
  permissions: permissionSchema,
  entities: entitySchema,
  functions: functionSchema,
  validations: validationSchema,
  nfrs: nfrSchema,
  business_rules: businessRuleSchema,
  common_requirements: commonRequirementSchema,
  messages: messageSchema,
  other_requirements: otherRequirementSchema,
  glossary: glossaryTermSchema,
  addendum: addendumSchema,
  custom_sections: customSectionSchema,
  diagrams: diagramSchema,
  assumptions: assumptionSchema
} as unknown as Record<string, ElementSchema>)

/** Field nullable mà thiếu thì `null` — không đổi nghĩa của phần tử. */
const NULL_WHEN_MISSING: ReadonlySet<string> = new Set(["priority", "primary_function_id", "confirmed_at"])

const isArraySchema = (schema: z.ZodType): boolean => {
  let current: z.ZodType = schema
  // bóc lớp default/optional/nullable để thấy kiểu thật
  for (let i = 0; i < 5; i++) {
    if (current instanceof z.ZodArray) return true
    if (current instanceof z.ZodDefault || current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodType
      continue
    }
    return false
  }
  return false
}

/** Có schema phần tử cho collection này không (collection có id, thêm bằng `add`). */
export const hasElementSchema = (collection: string): boolean => collection in ELEMENT_SCHEMAS

/**
 * Trả bản sao `value` đã điền mảng rỗng / null cho field bị bỏ trống. Giá trị không phải object, hoặc
 * collection lạ ⇒ trả nguyên. Không bao giờ ghi đè field đã có (kể cả khi sai kiểu — để schema báo).
 */
export const withElementDefaults = (collection: string, value: unknown): unknown => {
  const schema = ELEMENT_SCHEMAS[collection]
  if (!schema || typeof value !== "object" || value === null || Array.isArray(value)) return value
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const [key, field] of Object.entries(schema.shape)) {
    if (out[key] !== undefined) continue
    if (isArraySchema(field as z.ZodType)) out[key] = []
    else if (NULL_WHEN_MISSING.has(key)) out[key] = null
  }
  return out
}
