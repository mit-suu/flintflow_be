/**
 * form-factor.ts
 * ─────────────────────────────────────────────────────────────────
 * `project.form_factor` là mảng nền tảng (phần tử đầu là nền tảng chính, `[]` = chưa chốt). Mọi đường ghi vào Spine —
 * op của model, `/changes` của user, import, revert — và mọi so sánh với change cũ đều đi qua đây, để chuỗi đơn của dữ
 * liệu / prompt cũ (`"web_app"`) và `null` được coi đúng là `["web_app"]` / `[]`.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Chuỗi ⇒ mảng một phần tử; mảng ⇒ bỏ trùng, giữ thứ tự; `null`/`undefined`/giá trị lạ ⇒ `[]`. */
export const normalizeFormFactor = (value: unknown): string[] => {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()]
  if (Array.isArray(value)) return [...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v !== ""))]
  return []
}

/**
 * Giá trị của một op/change tại `path` với `form_factor` đã chuẩn hoá: `project.form_factor` (mảng), `project` (object),
 * hoặc `$`/gốc (cả Spine). Path khác ⇒ trả nguyên `value`. Không đụng tới giá trị không phải object (vd sentinel "vắng").
 */
export const normalizeFormFactorAt = (path: string, value: unknown): unknown => {
  if (path === "project.form_factor") return normalizeFormFactor(value)
  if (path === "project" && isRecord(value) && "form_factor" in value) return { ...value, form_factor: normalizeFormFactor(value.form_factor) }
  if ((path === "$" || path === "") && isRecord(value) && isRecord(value.project) && "form_factor" in value.project) {
    return { ...value, project: { ...value.project, form_factor: normalizeFormFactor(value.project.form_factor) } }
  }
  return value
}
