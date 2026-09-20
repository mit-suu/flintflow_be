/**
 * Từ điển tên cột bảng ⇒ field Spine (I-3 khớp cột, G7 trích tất định). FLF-171, plan §6 2B.
 * `field_path` dạng `<mảng>[].<field>` (vd `use_cases[].id`). Bảng dọc (cột nhãn | giá trị, kiểu đặc tả UC)
 * không đi qua từ điển này — xem `extract` (2C).
 */

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
}

export const TABLE_ENTITIES: readonly TableEntityDef[] = [
  {
    entity: "actors",
    sections: ["fixed:2.1"],
    columns: [
      { field: "id", headers: ["actor id", "id", "mã tác nhân"] },
      { field: "name", headers: ["actor", "actor name", "name", "tác nhân", "tên tác nhân", "tên"] },
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
      { field: "description", headers: ["description", "mô tả", "use case description"] }
    ],
    required: ["id", "name"]
  },
  {
    entity: "screens",
    sections: ["fixed:3.1.2", "fixed:3.1.1"],
    columns: [
      { field: "id", headers: ["screen id", "id", "mã màn hình"] },
      { field: "name", headers: ["screen", "screen name", "name", "tên màn hình", "màn hình"] },
      { field: "description", headers: ["description", "mô tả"] }
    ],
    required: ["name"]
  },
  {
    entity: "entities",
    sections: ["fixed:3.1.5"],
    columns: [
      { field: "name", headers: ["entity", "entity name", "table", "object", "thực thể", "tên thực thể"] },
      { field: "description", headers: ["description", "mô tả"] }
    ],
    required: ["name"]
  },
  {
    entity: "business_rules",
    sections: ["fixed:5.1"],
    columns: [
      { field: "id", headers: ["br id", "rule id", "id", "mã", "mã quy tắc"] },
      { field: "statement", headers: ["business rule", "rule", "description", "statement", "nội dung", "mô tả", "quy tắc"] }
    ],
    required: ["id", "statement"]
  },
  {
    entity: "messages",
    sections: ["fixed:5.3"],
    columns: [
      { field: "code", headers: ["message code", "msg code", "code", "mã thông báo", "mã"] },
      { field: "text", headers: ["message", "message content", "content", "text", "nội dung", "thông báo"] }
    ],
    required: ["code", "text"]
  },
  {
    entity: "glossary",
    sections: ["fixed:5.5"],
    columns: [
      { field: "term", headers: ["term", "abbreviation", "acronym", "thuật ngữ", "từ viết tắt"] },
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
      { field: "threshold", headers: ["threshold", "target", "ngưỡng", "mục tiêu"] }
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
}

const matchColumn = (header: string, def: TableEntityDef): { field: string; confidence: number } | null => {
  const folded = foldText(header)
  if (!folded) return null
  let best: { field: string; confidence: number } | null = null
  for (const col of def.columns) {
    for (const h of col.headers) {
      const score = foldText(h) === folded ? 0.95 : titleSimilarity(h, header) >= 0.66 ? 0.75 : 0
      if (score && (!best || score > best.confidence)) best = { field: col.field, confidence: score }
    }
  }
  return best
}

/**
 * Khớp hàng tiêu đề của một bảng. Chọn thực thể theo section chứa bảng trước, rồi theo số cột khớp.
 * Không thực thể nào khớp đủ field bắt buộc ⇒ `entity = null`, mọi cột `field_path = null` (AI trích ở I-4).
 */
export const matchTableHeader = (headers: string[], sectionId: string | null): { entity: string | null; columns: ColumnMatch[] } => {
  let best: { def: TableEntityDef; matches: ({ field: string; confidence: number } | null)[]; score: number } | null = null
  for (const def of TABLE_ENTITIES) {
    const used = new Set<string>()
    const matches = headers.map((h) => {
      const m = matchColumn(h, def)
      if (!m || used.has(m.field)) return null
      used.add(m.field)
      return m
    })
    if (!def.required.every((f) => used.has(f))) continue
    const score = matches.filter(Boolean).length + (sectionId && def.sections.includes(sectionId) ? 10 : 0)
    if (!best || score > best.score) best = { def, matches, score }
  }
  if (!best) {
    return { entity: null, columns: headers.map((header, column_index) => ({ column_index, header, field_path: null, confidence: 0.9 })) }
  }
  const inSection = !!sectionId && best.def.sections.includes(sectionId)
  const { def, matches } = best
  return {
    entity: def.entity,
    columns: headers.map((header, column_index) => {
      const m = matches[column_index]
      if (!m) return { column_index, header, field_path: null, confidence: 0.9 }
      // Bảng nằm ngoài section quen thuộc của thực thể ⇒ giảm độ tin để người dùng xác nhận (1.7)
      return { column_index, header, field_path: `${def.entity}[].${m.field}`, confidence: inSection ? m.confidence : Math.min(m.confidence, 0.7) }
    })
  }
}
