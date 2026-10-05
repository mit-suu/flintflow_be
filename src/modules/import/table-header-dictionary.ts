/**
 * Từ điển tên cột bảng ⇒ field Spine (I-3 khớp cột, G7 trích tất định). FLF-171, plan §6 2B.
 * `field_path` dạng `<mảng>[].<field>` (vd `use_cases[].id`). Bảng dọc (cột nhãn | giá trị, kiểu đặc tả UC)
 * không đi qua từ điển này — xem `extract` (2C).
 * FLF-251: có đủ các cột chính FlintFlow xuất ra (Kind, Includes/Extends, Relations, Priority, Native, Functions, Feature)
 * để file xuất ra import lại không mất dữ liệu; gán cột theo điểm cao nhất trên cả bảng.
 */

import { isMarkMatrix, tableShape, type ColumnRole, type TableShape } from "./table-shape.js"
import { foldText, titleSimilarity } from "./text-similarity.js"

export interface ColumnDef {
  field: string
  headers: readonly string[]
}

export interface TableEntityDef {
  /** Mảng Spine. */
  entity: string
  /** Section mà bảng của thực thể này thường nằm trong. */
  sections: readonly string[]
  columns: readonly ColumnDef[]
  /** Field bắt buộc phải có cột mới coi là bảng của thực thể (trích tất định được). */
  required: readonly string[]
  /** Có ít nhất một trong các field này (thay cho `required` khi bảng có nhiều dạng — FLF-252). */
  requiredAny?: readonly string[]
}

/** Section có thuộc danh sách section của thực thể không — `feature:*` khớp mọi section tính năng. */
export const inSections = (def: Pick<TableEntityDef, "sections">, sectionId: string): boolean =>
  def.sections.some((s) => s === sectionId || (s.endsWith(":*") && sectionId.startsWith(s.slice(0, -1))))

/** Bảng có đủ field bắt buộc của thực thể. */
export const hasRequiredFields = (def: Pick<TableEntityDef, "required" | "requiredAny">, fields: ReadonlySet<string>): boolean =>
  def.required.every((f) => fields.has(f)) && (!def.requiredAny || def.requiredAny.some((f) => fields.has(f)))

export const TABLE_ENTITIES: readonly TableEntityDef[] = [
  {
    entity: "actors",
    sections: ["fixed:2.1"],
    columns: [
      { field: "id", headers: ["actor id", "id", "mã tác nhân"] },
      { field: "name", headers: ["actor", "actor name", "name", "tác nhân", "tên tác nhân", "tên"] },
      { field: "kind", headers: ["kind", "actor kind", "actor type", "type", "loại", "loại tác nhân"] },
      { field: "description", headers: ["description", "mô tả", "role description", "vai trò"] }
    ],
    required: ["name"]
  },
  {
    entity: "use_cases",
    sections: ["fixed:2.2.1", "fixed:2.2.2", "group:2.2"],
    columns: [
      { field: "id", headers: ["use case id", "uc id", "id", "mã uc", "mã use case"] },
      { field: "name", headers: ["use case", "use case name", "name", "tên use case", "tên chức năng"] },
      { field: "actor_ids", headers: ["actor", "actors", "primary actor", "tác nhân"] },
      { field: "description", headers: ["description", "mô tả", "use case description"] },
      { field: "includes", headers: ["includes", "include", "included use cases", "bao gồm"] },
      { field: "extends", headers: ["extends", "extend", "extended use cases", "mở rộng"] }
    ],
    required: ["id", "name"]
  },
  {
    entity: "screens",
    sections: ["fixed:3.1.2", "fixed:3.1.1"],
    columns: [
      { field: "id", headers: ["screen id", "id", "mã màn hình"] },
      { field: "name", headers: ["screen", "screen name", "name", "tên màn hình", "màn hình"] },
      { field: "feature_id", headers: ["feature", "feature name", "tính năng", "nhóm chức năng"] },
      { field: "description", headers: ["description", "mô tả"] }
    ],
    required: ["name"]
  },
  {
    // Bảng chức năng không có màn hình (3.1.4 Non-Screen Functions); bảng yêu cầu chức năng dưới một tính năng
    // (mẫu IEEE: "ID | Requirement | Priority" — FLF-252)
    entity: "functions",
    sections: ["fixed:3.1.4", "feature:*"],
    columns: [
      { field: "id", headers: ["function id", "requirement id", "req id", "id", "mã chức năng", "mã yêu cầu"] },
      { field: "name", headers: ["system function", "function", "function name", "name", "title", "tên chức năng", "chức năng"] },
      { field: "feature_id", headers: ["feature", "feature name", "tính năng"] },
      { field: "trigger", headers: ["trigger", "kích hoạt", "sự kiện kích hoạt", "điều kiện kích hoạt"] },
      { field: "description", headers: ["description", "requirement", "requirement description", "statement", "mô tả", "yêu cầu"] },
      { field: "priority", headers: ["priority", "ưu tiên", "mức ưu tiên", "độ ưu tiên"] }
    ],
    required: [],
    requiredAny: ["name", "description"]
  },
  {
    // Ma trận phân quyền màn hình × vai trò (3.1.3): cột đầu là màn hình, mỗi cột sau là một vai trò — nhận theo dữ liệu
    // (`isMarkMatrix`), không theo tiêu đề cột vai trò (tên vai trò của từng dự án)
    entity: "permissions",
    sections: ["fixed:3.1.3"],
    columns: [
      { field: "screen_id", headers: ["screen", "screen name", "màn hình", "tên màn hình"] },
      { field: "role_id", headers: ["role", "vai trò"] }
    ],
    required: ["screen_id", "role_id"]
  },
  {
    entity: "entities",
    sections: ["fixed:3.1.5"],
    columns: [
      { field: "name", headers: ["entity", "entity name", "table", "object", "thực thể", "tên thực thể"] },
      { field: "description", headers: ["description", "mô tả"] },
      { field: "relations", headers: ["relations", "relationships", "related entities", "quan hệ", "liên kết"] }
    ],
    required: ["name"]
  },
  {
    entity: "business_rules",
    sections: ["fixed:5.1"],
    columns: [
      { field: "id", headers: ["br id", "rule id", "id", "mã", "mã quy tắc"] },
      { field: "statement", headers: ["business rule", "rule", "rule definition", "description", "statement", "nội dung", "mô tả", "quy tắc"] }
    ],
    required: ["id", "statement"]
  },
  {
    entity: "messages",
    sections: ["fixed:5.3"],
    columns: [
      { field: "code", headers: ["message code", "msg code", "code", "mã thông báo", "mã"] },
      { field: "text", headers: ["message", "message content", "content", "text", "nội dung", "thông báo"] },
      { field: "function_ids", headers: ["functions", "function", "used in", "chức năng", "dùng ở"] }
    ],
    required: ["code", "text"]
  },
  {
    entity: "glossary",
    sections: ["fixed:5.5"],
    columns: [
      { field: "term", headers: ["term", "abbreviation", "acronym", "thuật ngữ", "từ viết tắt"] },
      { field: "term_native", headers: ["native", "native term", "vietnamese", "tiếng việt", "thuật ngữ tiếng việt"] },
      { field: "definition", headers: ["definition", "description", "meaning", "định nghĩa", "giải thích", "ý nghĩa"] }
    ],
    required: ["term", "definition"]
  },
  {
    entity: "nfrs",
    sections: ["fixed:4.1", "fixed:4.2.1", "fixed:4.2.2", "fixed:4.2.3", "fixed:4.2.4", "group:4", "group:4.2"],
    columns: [
      { field: "id", headers: ["nfr id", "id", "mã"] },
      { field: "category", headers: ["category", "type", "loại", "nhóm"] },
      { field: "statement", headers: ["requirement", "description", "statement", "yêu cầu", "mô tả"] },
      { field: "metric", headers: ["metric", "measure", "chỉ số", "đo lường"] },
      { field: "threshold", headers: ["threshold", "target", "ngưỡng", "mục tiêu"] },
      { field: "priority", headers: ["priority", "ưu tiên", "mức ưu tiên", "độ ưu tiên"] }
    ],
    required: ["statement"]
  },
  {
    entity: "common_requirements",
    sections: ["fixed:5.2"],
    columns: [
      { field: "category", headers: ["category", "type", "loại", "nhóm"] },
      { field: "statement", headers: ["requirement", "description", "statement", "yêu cầu", "mô tả", "nội dung"] }
    ],
    required: ["statement"]
  },
  {
    entity: "other_requirements",
    sections: ["fixed:5.4"],
    columns: [
      { field: "kind", headers: ["type", "kind", "loại"] },
      { field: "statement", headers: ["requirement", "description", "statement", "yêu cầu", "mô tả", "nội dung"] }
    ],
    required: ["statement"]
  }
]

export interface ColumnMatch {
  column_index: number
  header: string
  field_path: string | null
  confidence: number
  /** Vai trò cột theo dữ liệu (FLF-252) — `undefined` khi chỉ khớp tiêu đề. */
  role?: ColumnRole
  /** Tối đa 3 giá trị đầu của cột — cho người dùng nhìn dữ liệu khi xác nhận mapping. */
  samples?: string[]
}

/** Tiền tố mã ⇒ thực thể (cột mã có tiêu đề "#" / trống vẫn nhận ra là mã của đúng loại phần tử). */
const PREFIX_ENTITY: Readonly<Record<string, string>> = {
  UC: "use_cases",
  BR: "business_rules",
  MSG: "messages",
  NFR: "nfrs",
  SCR: "screens",
  FR: "functions",
  A: "actors",
  E: "entities",
  COM: "common_requirements",
  OR: "other_requirements"
}

type FieldMatch = { field: string; confidence: number }

/** Điểm khớp tiêu đề cột với một field: đúng tên 0.95, gần đúng 0.75, không khớp 0. Tiêu đề rỗng / chỉ ký hiệu (`#`) ⇒ 0. */
const columnScore = (header: string, col: ColumnDef): number => {
  const folded = foldText(header)
  if (!folded) return 0
  let best = 0
  for (const h of col.headers) best = Math.max(best, foldText(h) === folded ? 0.95 : titleSimilarity(h, header) >= 0.66 ? 0.75 : 0)
  return best
}

/**
 * Ứng viên field của một cột: theo tiêu đề; tiêu đề không khớp (ký hiệu "#", trống, tên lạ) mà dữ liệu là mã ⇒ cột mã
 * của thực thể (FLF-252). Cột số thứ tự (1, 2, 3) không bao giờ là mã / tên, kể cả khi tiêu đề ghi "ID".
 */
const candidatesOf = (header: string, column: number, def: TableEntityDef, shape: TableShape): (FieldMatch & { column: number })[] => {
  const profile = shape.columns[column]
  if (profile?.role === "row_no") return []
  const byHeader = def.columns.map((col) => ({ column, field: col.field, confidence: columnScore(header, col) })).filter((c) => c.confidence > 0)
  if (byHeader.length || profile?.role !== "code") return byHeader
  const idField = def.columns.find((c) => c.field === "id" || c.field === "code")
  if (!idField) return []
  return [{ column, field: idField.field, confidence: profile.prefix && PREFIX_ENTITY[profile.prefix] === def.entity ? 0.9 : 0.75 }]
}

/**
 * Gán cột ⇒ field theo điểm cao nhất trên cả bảng (FLF-251), mỗi cột và mỗi field dùng một lần. Trước đây gán lần lượt
 * trái → phải nên cột khớp gần đứng trước giành mất field ("Message Type" lấy `text`, cột "Content" thật bị bỏ).
 */
const assignColumns = (headers: string[], def: TableEntityDef, shape: TableShape): (FieldMatch | null)[] => {
  const candidates = headers
    .flatMap((header, column) => candidatesOf(header, column, def, shape))
    .sort((a, b) => b.confidence - a.confidence || a.column - b.column)
  const out: (FieldMatch | null)[] = headers.map(() => null)
  const used = new Set<string>()
  for (const c of candidates) {
    if (out[c.column] || used.has(c.field)) continue
    out[c.column] = { field: c.field, confidence: c.confidence }
    used.add(c.field)
  }
  return out
}

/** Ma trận phân quyền: cột đầu ⇒ màn hình, mỗi cột vai trò có tiêu đề ⇒ `role_id` (tên vai trò = tiêu đề cột). */
const permissionMatrix = (shape: TableShape): (FieldMatch | null)[] =>
  shape.headers.map((header, column) =>
    column === 0 ? { field: "screen_id", confidence: 0.9 } : header ? { field: "role_id", confidence: 0.9 } : null
  )

export interface TableMatch {
  entity: string | null
  columns: ColumnMatch[]
  shape: TableShape
}

/**
 * Khớp một bảng theo tiêu đề + dữ liệu (FLF-252). Chọn thực thể theo section chứa bảng trước, rồi theo số cột khớp.
 * Không thực thể nào khớp đủ field bắt buộc ⇒ `entity = null`, mọi cột `field_path = null` (AI trích ở I-4).
 * Bảng nằm ở section đã biết nhưng không phải section của thực thể (bảng lịch sử thay đổi trông như NFR, bảng field
 * trong mục chức năng trông như tác nhân…) ⇒ không đoán, để AI đọc theo đích của section (FLF-251). Không rõ section
 * (`null`) ⇒ vẫn đoán, độ tin bị giảm. Ma trận màn hình × vai trò ở mục phân quyền ⇒ `permissions` theo dữ liệu.
 */
export const matchTable = (rows: readonly string[][], sectionId: string | null): TableMatch => {
  const shape = tableShape(rows)
  const { headers } = shape
  const withData = (column_index: number, match: Omit<ColumnMatch, "column_index" | "header" | "role" | "samples">): ColumnMatch => {
    const profile = shape.columns[column_index]
    return { column_index, header: headers[column_index], ...match, ...(profile && profile.role !== "empty" ? { role: profile.role, samples: profile.samples } : {}) }
  }
  let best: { def: TableEntityDef; matches: (FieldMatch | null)[]; score: number } | null = null
  for (const def of TABLE_ENTITIES) {
    if (sectionId !== null && !inSections(def, sectionId)) continue
    const matches = def.entity === "permissions" ? (isMarkMatrix(shape) ? permissionMatrix(shape) : []) : assignColumns(headers, def, shape)
    const fields = new Set(matches.filter((m): m is FieldMatch => !!m).map((m) => m.field))
    if (!hasRequiredFields(def, fields)) continue
    const score = fields.size + (sectionId && inSections(def, sectionId) ? 10 : 0)
    if (!best || score > best.score) best = { def, matches, score }
  }
  if (!best) return { entity: null, shape, columns: headers.map((_, i) => withData(i, { field_path: null, confidence: 0.9 })) }
  const inSection = !!sectionId && inSections(best.def, sectionId)
  const { def, matches } = best
  return {
    entity: def.entity,
    shape,
    columns: headers.map((_, i) => {
      const m = matches[i]
      if (!m) return withData(i, { field_path: null, confidence: 0.9 })
      // Bảng nằm ngoài section quen thuộc của thực thể ⇒ giảm độ tin để người dùng xác nhận (1.7)
      return withData(i, { field_path: `${def.entity}[].${m.field}`, confidence: inSection ? m.confidence : Math.min(m.confidence, 0.7) })
    })
  }
}

/** Khớp chỉ theo hàng tiêu đề (không có dữ liệu) — giữ cho chỗ gọi cũ / test. */
export const matchTableHeader = (headers: string[], sectionId: string | null): { entity: string | null; columns: ColumnMatch[] } => {
  const { entity, columns } = matchTable([headers], sectionId)
  return { entity, columns }
}
