/**
 * Đặc tả dạng "nhãn: giá trị" đọc tất định (FLF-252). Hàm thuần.
 * Mẫu FPT ghi chi tiết chức năng theo các nhãn cố định — "Function trigger:", "Normal case: …", "Abnormal case: …",
 * "Validation: …", "Business rules: …" — dạng đoạn / gạch đầu dòng; đặc tả use case hay là bảng dọc hai (bốn) cột
 * "nhãn | giá trị". Đọc các nhãn quen thành field Spine (không tốn credit, đúng nguyên văn); dòng có nhãn lạ hoặc không
 * nhãn vẫn để AI đọc / giữ nguyên văn.
 */

import { foldText } from "./text-similarity.js"

export interface SpecSource {
  block_id: string
  kind: string
  text: string
  rows?: string[][] | null
}

interface LabelDef {
  field: string
  labels: readonly string[]
}

/** Nhãn đặc tả chức năng (mẫu FPT "Function trigger / description / details", đặc tả use case kiểu IEEE). */
export const FUNCTION_LABELS: readonly LabelDef[] = [
  { field: "trigger", labels: ["function trigger", "trigger", "triggers", "navigation path", "timing frequency", "timing", "kích hoạt", "điều kiện kích hoạt"] },
  { field: "description", labels: ["purpose", "description", "function description", "brief description", "summary", "mục đích", "mô tả"] },
  { field: "screen_id", labels: ["interface", "screen", "màn hình", "giao diện"] },
  { field: "normal", labels: ["normal case", "normal cases", "normal flow", "main flow", "basic flow", "main success scenario", "luồng chính"] },
  {
    field: "abnormal",
    labels: ["abnormal case", "abnormal cases", "alternative flow", "alternative flows", "alternate flow", "alternate flows", "exception", "exceptions", "exception flow", "exception flows", "luồng ngoại lệ", "luồng thay thế"]
  },
  { field: "validations", labels: ["validation", "validations", "validation rules", "kiểm tra", "ràng buộc dữ liệu"] },
  { field: "business_rule_ids", labels: ["business rules", "business rule", "quy tắc nghiệp vụ"] },
  { field: "priority", labels: ["priority", "độ ưu tiên", "mức ưu tiên"] }
]

/** Nhãn đặc tả use case (bảng dọc "Use Case ID | UC-01", "Primary Actor | Guest"…). */
export const USE_CASE_LABELS: readonly LabelDef[] = [
  { field: "id", labels: ["use case id", "uc id", "id", "mã use case", "mã uc"] },
  { field: "name", labels: ["use case name", "uc name", "use case", "name", "tên use case"] },
  { field: "id_name", labels: ["use case id and name", "uc id and name", "id and name"] },
  { field: "actor_ids", labels: ["primary actor", "primary actors", "secondary actor", "secondary actors", "actor", "actors", "tác nhân", "tác nhân chính", "tác nhân phụ"] },
  { field: "description", labels: ["description", "brief description", "summary", "goal", "mô tả"] },
  { field: "includes", labels: ["includes", "include", "included use cases"] },
  { field: "extends", labels: ["extends", "extend", "extended use cases", "extension points"] }
]

/** `Nhãn: giá trị` — nhãn ngắn (≤ 40 ký tự, không có dấu câu kết thúc câu) đứng đầu dòng. */
const LABELED = /^\s*([^:.!?;]{2,40}?)\s*:\s*(.*)$/s

const labelOf = (raw: string, defs: readonly LabelDef[]): string | null => {
  const key = foldText(raw)
  return defs.find((d) => d.labels.some((l) => foldText(l) === key))?.field ?? null
}

export interface SpecResult {
  /** Field ⇒ các đoạn giá trị theo thứ tự tài liệu. */
  values: Map<string, string[]>
  /** Block đã đọc hết vào field (không cần gửi AI). */
  consumed: Set<string>
}

/**
 * Đọc các dòng "nhãn: giá trị" của một vùng đặc tả. Dòng nhãn rỗng ("Function trigger:", "Normal case:") mở nhóm: các dòng
 * không nhãn ngay sau thuộc field đó; nhãn lạ đóng nhóm (dòng đó và các dòng sau nó để AI đọc). Nhãn nhóm chung của mẫu FPT
 * ("Function description:", "Function details:") chỉ là tiêu đề, không phải field.
 */
export const readSpecLines = (sources: readonly SpecSource[], defs: readonly LabelDef[]): SpecResult => {
  const values = new Map<string, string[]>()
  const consumed = new Set<string>()
  let open: string | null = null
  const push = (field: string, value: string, block: string) => {
    if (value) values.set(field, [...(values.get(field) ?? []), value])
    consumed.add(block)
  }
  for (const s of sources) {
    for (const [label, value] of linesOf(s)) {
      if (label !== null) {
        if (GROUP_LABELS.has(foldText(label))) {
          open = labelOf(label, defs)
          consumed.add(s.block_id)
          continue
        }
        const field = labelOf(label, defs)
        if (field) {
          push(field, value, s.block_id)
          open = value ? null : field
          continue
        }
        open = null
        continue
      }
      if (open && value) push(open, value, s.block_id)
    }
  }
  return { values, consumed }
}

/** Nhãn nhóm của mẫu FPT — tiêu đề nhóm các nhãn con, tự nó không phải field (trừ khi trùng một nhãn field). */
const GROUP_LABELS = new Set(["function description", "function details", "function trigger", "details", "chi tiết chức năng"].map(foldText))

/** Dòng của một block: đoạn ⇒ một dòng; bảng dọc (2 hoặc 4 cột) ⇒ mỗi cặp ô "nhãn | giá trị" một dòng. */
const linesOf = (s: SpecSource): [string | null, string][] => {
  if (s.kind === "table") {
    const rows = s.rows ?? []
    if (!rows.length || rows.some((r) => r.length !== 2 && r.length !== 4)) return []
    return rows.flatMap((r) => {
      const pairs: [string | null, string][] = []
      for (let i = 0; i + 1 < r.length; i += 2) if (r[i].trim()) pairs.push([r[i].trim().replace(/:$/, ""), r[i + 1].trim()])
      return pairs
    })
  }
  const m = LABELED.exec(s.text)
  return m ? [[m[1].trim(), m[2].trim()]] : [[null, s.text.trim()]]
}

/** Bước luồng: tách theo "->" / "→", không thì giữ cả câu. */
export const flowSteps = (parts: readonly string[]): string[] =>
  parts.flatMap((p) => p.split(/\s*(?:->|→|=>)\s*/)).map((x) => x.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim()).filter(Boolean)

/** Viết tắt có dấu chấm — không phải chỗ hết câu ("e.g.", "i.e.", "etc."). */
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|approx|incl|ex|fig|no)\.$/i

/** Câu riêng: tách theo ". " / "; " — kể cả câu kết thúc bằng dấu ngoặc kép; không tách sau viết tắt. */
export const sentences = (parts: readonly string[]): string[] =>
  parts
    .flatMap((p) =>
      p.split(/(?<=[.;!?]["”']?)\s+(?=[A-Z0-9"“(])/).reduce<string[]>((acc, piece) => {
        if (acc.length && ABBREVIATION.test(acc[acc.length - 1])) acc[acc.length - 1] += ` ${piece}`
        else acc.push(piece)
        return acc
      }, [])
    )
    .map((x) => x.replace(/[.;]$/, "").trim())
    .filter(Boolean)

const BR_CODE = /\bBR[-_ ]?\d{1,4}\b/gi
/** Câu bắt đầu bằng mã quy tắc ("BR-11: …") — đã thành `business_rule_ids`, không lặp lại thành kiểm tra. */
const STARTS_WITH_BR = /^BR[-_ ]?\d{1,4}\b/i

/**
 * Đặc tả chức năng ⇒ value của item `functions` (FLF-252): trigger nối các ý, luồng chính theo bước, luồng ngoại lệ theo câu,
 * kiểm tra dữ liệu theo câu, quy tắc nghiệp vụ ⇒ mã BR + câu không mã thành kiểm tra nghiệp vụ, màn hình theo tên.
 */
export const functionSpecValue = (values: Map<string, string[]>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const get = (f: string) => values.get(f) ?? []
  if (get("trigger").length) out.trigger = get("trigger").join("; ")
  if (get("description").length) out.description = get("description").join("\n")
  if (get("screen_id").length) out.screen_id = get("screen_id")[0].replace(/:$/, "").trim()
  if (get("normal").length) out.normal = flowSteps(get("normal"))
  if (get("abnormal").length) out.abnormal = sentences(get("abnormal"))
  const rules = get("business_rule_ids")
  const codes = [...new Set(rules.flatMap((r) => [...r.matchAll(BR_CODE)].map((m) => m[0].toUpperCase().replace(/^BR[-_ ]?/, "BR-"))))]
  if (codes.length) out.business_rule_ids = codes
  const validations = [
    ...sentences(get("validations")).map((statement) => ({ kind: "format", statement })),
    ...sentences(rules)
      .filter((s) => !STARTS_WITH_BR.test(s))
      .map((statement) => ({ kind: "business", statement }))
  ]
  if (validations.length) out.validations = validations
  if (get("priority").length) out.priority = get("priority")[0]
  return out
}

/** Bảng dọc đặc tả use case ⇒ value (+ mã) của item `use_cases`; không đủ tên ⇒ `null`. */
export const useCaseSpecValue = (values: Map<string, string[]>): { key: string | null; value: Record<string, unknown> } | null => {
  const get = (f: string) => values.get(f) ?? []
  let key: string | null = get("id")[0] ?? null
  let name: string | null = get("name")[0] ?? null
  const idName = get("id_name")[0]
  if (idName) {
    const m = /^([A-Za-z]{1,5}[-_ ]?\d+(?:\.\d+)*)\s*[-–:.]?\s*(.*)$/.exec(idName)
    key ??= m?.[1] ?? null
    name ??= m?.[2] || null
  }
  if (!name) return null
  const value: Record<string, unknown> = { name }
  const actors = get("actor_ids").flatMap((a) => a.replace(/[()]/g, ",").split(/[,;\n]/)).map((a) => a.trim()).filter(Boolean)
  if (actors.length) value.actor_ids = [...new Set(actors)]
  if (get("description").length) value.description = get("description").join("\n")
  for (const f of ["includes", "extends"]) {
    const refs = get(f).flatMap((v) => v.split(/[,;\n]/)).map((v) => v.trim()).filter(Boolean)
    if (refs.length) value[f] = refs
  }
  return { key, value }
}
