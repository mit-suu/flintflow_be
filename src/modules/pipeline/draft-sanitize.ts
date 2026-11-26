/**
 * FLF-477: làm sạch HÌNH THỨC của lô model soạn trước khi kiểm, thay vì từ chối cả lượt.
 *
 * Model hay viết `message` / `event` của sơ đồ có dấu phẩy hoặc ngoặc vuông ("Select slot, pay deposit") — ràng buộc
 * PlantUML / selector path cấm các ký tự này (`spine.schema.ts`). Lỗi chỉ ở dấu câu nên server tự sửa; model sửa lỗi này
 * thì lộ lỗi khác đã làm hỏng cả 3 lượt thử (gặp thật ở S-5.2).
 *
 * Chỉ đổi dấu câu / khoảng trắng / chữ hoa của nhãn; không đổi nghĩa, không thêm bớt op (op_index giữ nguyên).
 * Luật nội dung (ERD, actor…) không đụng tới — vẫn từ chối như cũ.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** "Select slot, pay deposit" ⇒ "Select slot - pay deposit"; bỏ `[` `]`; gọn khoảng trắng. */
export const cleanDiagramLabel = (text: string): string =>
  text
    .replace(/\s*,\s*/g, " - ")
    .replace(/[[\]]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .trim()

/** Động từ trong hình thoi ERD: tiếng Anh viết thường, cách nhau bằng dấu cách (`spine.schema.ts` `relation_verbs`). */
const VERB_OK = /^[a-z]+( [a-z]+)*$/
export const cleanRelationVerb = (text: string): string => {
  const fixed = text.replace(/[-_]+/g, " ").replace(/\s{2,}/g, " ").trim().toLowerCase()
  return VERB_OK.test(fixed) ? fixed : text
}

const fixField = (obj: Record<string, unknown>, key: string, fix: (s: string) => string, hits: string[], label: string): Record<string, unknown> => {
  const cur = obj[key]
  if (typeof cur !== "string") return obj
  const next = fix(cur)
  if (next === cur || next.length === 0) return obj
  hits.push(`${label}: "${cur}" ⇒ "${next}"`)
  return { ...obj, [key]: next }
}

const fixList = (value: unknown, key: string, hits: string[], label: string): unknown =>
  Array.isArray(value) ? value.map((item) => (isRecord(item) ? fixField(item, key, cleanDiagramLabel, hits, label) : item)) : value

/** Sửa nhãn trong một giá trị (phần tử đơn hoặc cả function / entity) tuỳ path đích của op. */
const sanitizeValue = (path: string, value: unknown, hits: string[]): unknown => {
  // Cả mảng: set functions[id=X].interactions / entities[id=X].transitions
  if (Array.isArray(value)) {
    if (/\.interactions$/.test(path)) return fixList(value, "message", hits, "message")
    if (/\.transitions$/.test(path)) return fixList(value, "event", hits, "event")
    return value
  }
  if (!isRecord(value)) return value
  // Phần tử đơn: add functions[id=X].interactions[] / entities[id=X].transitions[]
  if (/\.interactions\[\]$/.test(path)) return fixField(value, "message", cleanDiagramLabel, hits, "message")
  if (/\.transitions\[\]$/.test(path)) return fixField(value, "event", cleanDiagramLabel, hits, "event")
  let out: Record<string, unknown> = value
  // Cả phần tử cha: add/set functions[] | functions[id=X], entities[] | entities[id=X]
  if (/(^|\.)functions(\[[^\]]*\])?$/.test(path) && "interactions" in out) out = { ...out, interactions: fixList(out.interactions, "message", hits, "message") }
  if (/(^|\.)entities(\[[^\]]*\])?$/.test(path)) {
    if ("transitions" in out) out = { ...out, transitions: fixList(out.transitions, "event", hits, "event") }
    if (isRecord(out.relation_verbs)) {
      const verbs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(out.relation_verbs)) verbs[k] = typeof v === "string" ? cleanRelationVerb(v) : v
      out = { ...out, relation_verbs: verbs }
    }
  }
  return out
}

const sanitizeEntries = <T>(entries: readonly T[], hits: string[]): T[] =>
  entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || !("value" in entry)) return entry
    const value = sanitizeValue(entry.path, entry.value, hits)
    return value === entry.value ? entry : ({ ...entry, value } as T)
  })

export interface SanitizedDraft<O, L> {
  ops: O[]
  localized: L[] | undefined
  /** Mỗi mục là một chỗ đã sửa (chỉ để log / test). */
  fixes: string[]
}

/** Làm sạch `ops` (và `localized` cùng hình dạng) của lô model trả. Không đổi số op, thứ tự op. */
export const sanitizeDraftForm = <O, L>(ops: readonly O[] | undefined, localized: readonly L[] | undefined): SanitizedDraft<O, L> => {
  const fixes: string[] = []
  return { ops: sanitizeEntries(ops ?? [], fixes), localized: localized ? sanitizeEntries(localized, fixes) : undefined, fixes }
}
