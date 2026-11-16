/**
 * I-4 trích field Spine (nút 1.8) + xác nhận field (1.9, UC-22). FLF-171, plan §6 2C.
 * Theo từng section đã map:
 *   1. Bảng khớp đủ cột (template profile) ⇒ trích tất định, không tốn credit (G7).
 *   2. Feature/function của §3.2+ ⇒ tên + quan hệ lấy từ heading (tất định).
 *   3. Phần chữ còn lại ⇒ `IMPORT_EXTRACT_FIELDS` (chỉ text block, G6) qua `withMeteredAi`. FLF-392: tối đa
 *      `IMPORT_EXTRACT_CONCURRENCY` section gọi AI song song (chỉ lưu output thô); cấp mã / ghép tên / lọc chạy ở bước ghép,
 *      tuần tự theo thứ tự tài liệu ⇒ kết quả như chạy tuần tự.
 *   4. Lưu `ExtractionDraft` rồi sang `baselining` (FLF-343: không dừng ở `fields_review` — field độ tin < 0.7 / đọc từ ảnh vẫn vào
 *      baseline 0.1, finalize gắn cờ vàng "Cần xem"). Job nền nối tiếp finalize (`extract-jobs.ts`).
 * Hết credit / AI lỗi sau retry ⇒ `paused`, giữ `extract_cursor`; chạy tiếp bỏ qua section đã `done`.
 * Chưa ghi Spine: finalize áp mọi field trong một transaction.
 * Độ tin của item AI (FLF-343) = điểm AI kết hợp tín hiệu của code (`combineAiConfidence`) — điểm AI không bao giờ là tín hiệu duy nhất.
 */

import { createHash } from "node:crypto"
import type mongoose from "mongoose"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import { getActionCost, getOrCreateWallet, resolveWalletOrg } from "../../shared/ai/credit-reservation.service.js"
import type { DiagramImageKind, ImportExtractDiagramOutput, ImportExtractOutput } from "../../shared/ai/response-parser.js"
import { loadImportImage } from "../render/import-media.js"
// Caption ảnh màn hình dùng chung với mockup màn (FLF-410: dự phòng khi model không chỉ ra ảnh nào là ảnh màn hình)
import { SCREEN_CAPTION } from "../diagram/screen-originals.js"
import { IMPORTED_DOC_VERSIONS } from "../doc-version/versioning.js"
import { DocBlock, type IDocBlock } from "./doc-block.model.js"
import { applyDropToBlocks, planDrop, textRegions } from "./drop-text.js"
import { isPlaceholderRow, isPlaceholderText, templateMarks } from "./template-markers.js"
import { isTemplateContent, isTemplateFile } from "./structure-preview.js"
import { DIAGRAM_SECTIONS, DIAGRAM_TARGETS, NFR_CATEGORY_BY_SECTION, isExtractableSection, schemaExcerptFor, targetsOf } from "./extract-targets.js"
import {
  IdAllocator,
  type IdSource,
  REF_LIST_FIELDS,
  aiItemId,
  compactKey,
  findKnownCompact,
  findKnownId,
  findKnownKey,
  flattenItem,
  idKey,
  mergeFieldValue,
  keepKey,
  parseFieldPath,
  refTarget,
  resolveProvisional,
  type EntityItem,
  type ProvisionalEntity
} from "./extracted-entities.js"
import { ExtractionDraft, type ExtractedField, type ExtractionProgress, type IExtractionDraft, type RawAiStep } from "./extraction-draft.model.js"
import { FIELD_CONFIDENCE_THRESHOLD, VISION_CONFIDENCE_CAP, needsConfirm, type FieldOrigin, type MentionEntity } from "./import.constants.js"
import type { FieldsPatchRequest, GetImportResponse } from "./import.dto.js"
import { Project } from "../project/project.model.js"
import { assertImportStatus, extractionSummary, requireImport, transitionImport } from "./import.service.js"
import { ImportedDocument, type IImportedDocument } from "./imported-document.model.js"
import { knownKeysText, scopeKnownKeys } from "./known-keys.js"
import { VISION_UNAVAILABLE, withMeteredAi, type MeteredResult } from "./metered-ai.js"
import { notifyTopUpNeeded } from "./credit-flow.service.js"
import { runOrdered, type PoolRead, type PoolStop } from "./ordered-pool.js"
import { delay } from "../../shared/ai/retry.service.js"
import { env } from "../../config/env.js"
import { Mode1Error } from "./mode1.errors.js"
import { capitalize, pathLabel, sectionLabel } from "../spine/human-labels.js"
import { isRealText } from "../../shared/utils/instruction-text.js"
import { PROVISIONAL_SECTION } from "./section-catalog.js"
import { TABLE_ENTITIES, hasRequiredFields } from "./table-header-dictionary.js"
import { foldText } from "./text-similarity.js"
import { indentedCells, tableRows, tableText } from "./table-rows.js"
import { groupOf, markActions, tableShape, type TableShape } from "./table-shape.js"
import { FUNCTION_LABELS, USE_CASE_LABELS, functionSpecValue, readSpecLines, useCaseSpecValue } from "./spec-fields.js"
import { TemplateProfile, type ITemplateProfile, type TableMapEntry } from "./template-profile.model.js"

export interface ExtractionRun {
  doc: IImportedDocument
  sections: GetImportResponse["extraction"]["sections"]
}

type BlockLite = Pick<IDocBlock, "block_id" | "kind" | "text" | "section_id" | "anchor" | "image_ref" | "rows"> & Partial<Pick<IDocBlock, "mentions">>

/** Loại mã nhận được trong chữ (mention) ⇒ mảng Spine — giữ chỗ id trước khi cấp mã mới. */
const MENTION_ARRAYS: Readonly<Partial<Record<MentionEntity, string>>> = {
  use_case: "use_cases",
  function: "functions",
  nfr: "nfrs",
  business_rule: "business_rules",
  screen: "screens"
}

/** Section cần trích theo thứ tự xuất hiện trong tài liệu. */
export const extractionPlan = (blocks: BlockLite[]): string[] => {
  const out: string[] = []
  for (const b of blocks) if (b.section_id && isExtractableSection(b.section_id) && !out.includes(b.section_id)) out.push(b.section_id)
  return out
}

// ─── tất định: bảng ─────────────────────────────────────────────

/**
 * Ô danh sách ⇒ phần tử. Cột tham chiếu tách cả phần trong ngoặc (FLF-251): "Guest (Email Service, Identity Provider)"
 * là tác nhân chính + tác nhân phụ ⇒ ba tên, không cắt giữa ngoặc thành "Guest (Email Service".
 */
export const splitList = (s: string, refs = false): string[] =>
  (refs ? s.replace(/[()]/g, ",") : s)
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

const LIST_FIELDS = new Set(["actor_ids", "goals", "includes", "extends", "relations", "function_ids"])

/** Tách theo dấu phẩy / chấm phẩy / xuống dòng, không cắt trong ngoặc ("trạng thái (đang học, nghỉ)" là một mục). */
const splitOutsideParens = (s: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++
    else if ((ch === ")" || ch === "]") && depth > 0) depth--
    if (depth === 0 && /[,;\n]/.test(ch)) {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim().replace(/[.]+$/, "").trim()).filter(Boolean)
}

/** "Học sinh" ⇒ "hs" (viết tắt theo chữ đầu, như "mã HS"). */
const initialsOf = (folded: string): string => folded.split(" ").filter(Boolean).map((w) => w[0]).join("")

/** Thuộc tính đọc từ ô bảng — đúng dạng `EntityAttribute` của Spine. */
export interface CellAttribute {
  name: string
  kind: "key" | "reference" | "plain"
  required: boolean
}

/**
 * QLHS 11/11 bug #12c: ô "Thuộc tính chính" của bảng từ điển dữ liệu ⇒ thuộc tính dạng Spine (`{ name, kind, required }`).
 * Luật (tất định, đơn giản):
 *   - mã của chính thực thể ⇒ `key` (bắt buộc): "mã" / "id" / "code" đứng một mình, "mã <tên thực thể>" hoặc "mã <viết tắt>"
 *     ("mã HS" của Học sinh), "<tên thực thể> id";
 *   - mã khác ("mã TK phụ huynh", "mã lớp", "lop_id", "… id") ⇒ `reference` (khoá ngoại, không bắt buộc);
 *   - còn lại ⇒ `plain`, không bắt buộc (bảng không ghi bắt buộc thì không đoán).
 */
export const attributesFromCell = (cell: string, entityName: string): CellAttribute[] => {
  const entity = foldText(entityName)
  const own = new Set(["ma", "id", "code", "key", ...(entity ? [`ma ${entity}`, `ma ${initialsOf(entity)}`, `${entity} id`, `id ${entity}`, `${entity} code`] : [])])
  const seen = new Set<string>()
  return splitOutsideParens(cell).flatMap((name): CellAttribute[] => {
    const folded = foldText(name)
    if (!folded || seen.has(folded)) return []
    seen.add(folded)
    if (own.has(folded)) return [{ name, kind: "key", required: true }]
    const reference = /^(ma|id) \S/.test(folded) || /\S (id|code)$/.test(folded) || /^fk /.test(folded)
    return [{ name, kind: reference ? "reference" : "plain", required: false }]
  })
}

/** Field nhận giá trị hàng trên khi ô trống (ô gộp dọc — "Feature" gộp cho nhiều màn hình liền nhau). */
const FILL_DOWN_FIELDS = new Set(["feature_id"])

/** Phần đọc tất định của một section (FLF-252): item, bảng đã đọc hết, block đặc tả đã đọc, block phải giữ nguyên văn. */
export interface Settled {
  items: EntityItem[]
  handled: Set<string>
  consumed: Set<string>
  verbatim: Set<string>
}
const EMPTY_SETTLED: Settled = { items: [], handled: new Set(), consumed: new Set(), verbatim: new Set() }

/** Độ tin của phần đọc theo nhãn đặc tả quen (đúng nguyên văn, không đoán) — không cần xác nhận. */
const SPEC_CONFIDENCE = 0.9

/**
 * Đọc tất định một section (FLF-252), id cấp sau: bảng khớp đủ cột; bảng dọc đặc tả use case (mỗi bảng một use case —
 * bảng vẫn giữ nguyên văn vì Spine không chứa luồng / điều kiện); đặc tả chức năng dạng "nhãn: giá trị" của section chức năng.
 */
export const settleSection = (
  sectionId: string,
  blocks: BlockLite[],
  profile: ITemplateProfile,
  provisional: Map<string, ProvisionalEntity>
): Settled => {
  const out: Settled = { items: [], handled: new Set(), consumed: new Set(), verbatim: new Set() }
  const sectionBlocks = blocks.filter((b) => b.section_id === sectionId)
  const targets = targetsOf(sectionId)
  for (const t of sectionBlocks.filter((b) => b.kind === "table")) {
    const rows = tableRows(t, blocks)
    const items = deterministicTableItems(t, rows, profile, indentedCells(t, blocks))
    if (items) {
      // NFR của bảng nhận nhóm theo mục như NFR AI trích (bảng External Systems ở 4.1 ⇒ interface, không còn "other")
      for (const it of items) if (it.entity === "nfrs" && it.value.category === undefined && NFR_CATEGORY_BY_SECTION[sectionId]) it.value.category = NFR_CATEGORY_BY_SECTION[sectionId]
      out.handled.add(t.block_id)
      out.items.push(...items)
      // QLHS 11/11 (bug #10, #12c): bảng từ điển dữ liệu (có cột thuộc tính) luôn giữ nguyên văn tại chỗ — bản in theo file
      // upload; Spine vẫn nhận tên / quan hệ / thuộc tính đọc được từ bảng
      if (hasAttributeColumn(rows)) out.verbatim.add(t.block_id)
      // FLF-411: bảng toàn chỗ điền của mẫu (ma trận "Role-Name1 | <<Screen Name1>>") không cho phần tử nào ⇒ giữ nguyên văn;
      // bảng thông báo có cột ngoài Spine (5.3 "Message Type", "Context") ⇒ giữ nguyên văn, Spine vẫn nhận mã / nội dung
      if (!items.length || hasUnmappedMessageColumn(t, rows, profile)) out.verbatim.add(t.block_id)
      continue
    }
    if (!targets.includes("use_cases")) continue
    const uc = useCaseSpecValue(readSpecLines([{ ...t, rows }], USE_CASE_LABELS).values)
    if (!uc) continue
    out.handled.add(t.block_id)
    out.verbatim.add(t.block_id)
    out.items.push({
      entity: "use_cases",
      id: uc.key ? keepKey(uc.key) : null,
      value: uc.value,
      confidence: SPEC_CONFIDENCE,
      field_confidence: {},
      source_block_ids: [t.block_id],
      origin: "deterministic"
    })
  }
  const fn = provisional.get(sectionId)
  if (fn?.entity === "functions") {
    const sources = sectionBlocks
      .filter((b) => b.kind !== "heading" && b.kind !== "table_cell" && !out.handled.has(b.block_id))
      .map((b) => (b.kind === "table" ? { ...b, rows: tableRows(b, blocks) } : b))
    const spec = readSpecLines(sources, FUNCTION_LABELS)
    const value = functionSpecValue(spec.values)
    if (Object.keys(value).length) {
      for (const id of spec.consumed) out.consumed.add(id)
      out.items.push({ entity: "functions", id: fn.id, value, confidence: SPEC_CONFIDENCE, field_confidence: {}, source_block_ids: [...spec.consumed], origin: "deterministic" })
    }
  }
  return out
}

/** Tên ngắn từ một câu yêu cầu: bỏ "The system shall", cắt ở ranh giới từ trong 80 ký tự. */
export const shortName = (statement: string): string => {
  const s = statement
    .replace(/^\s*(the\s+)?(system|application|app|user)\s+(shall|must|should|will|can)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
  const first = s.split(/(?<=[.;:])\s/)[0].replace(/[.;:]$/, "")
  const name = first.length <= 80 ? first : `${first.slice(0, 80).replace(/\s+\S*$/, "")}…`
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** Dấu đầu dòng của dòng con trong cột tên ma trận ("- Adjust Stock", "↳ Adjust Stock"). */
const SUB_ROW_MARKER = /^[-–•+↳└]\s*/

/**
 * Ma trận phân quyền (FLF-252): mỗi cột vai trò ⇒ một vai trò (tên = tiêu đề cột), mỗi ô đánh dấu ⇒ một quyền
 * màn hình × vai trò × thao tác ("X"/"✓" ⇒ `access`, "view, create" ⇒ hai quyền). Tên màn / vai trò phân giải lúc dựng op.
 * Dòng thụt lề / có dấu đầu dòng dưới một màn là thao tác của màn đó (mẫu FPT: "Order Queue" rồi "    Confirm / Reject
 * Order") ⇒ ghi kèm `parent_screen`; lúc dựng op tên dòng không phải màn thì thành thao tác trên màn cha.
 */
const matrixItems = (
  table: BlockLite,
  grid: string[][],
  shape: TableShape,
  cols: TableMapEntry[],
  confidence: number,
  indented: ReadonlySet<string>
): EntityItem[] | null => {
  const screenCol = cols.find((c) => c.field_path === "permissions[].screen_id")?.column_index
  const allRoleCols = cols.filter((c) => c.field_path === "permissions[].role_id" && shape.headers[c.column_index]).map((c) => c.column_index)
  if (screenCol === undefined || !allRoleCols.length) return null
  // FLF-411: cột vai trò của mẫu ("Role-Name1", "…", "<<Role>>") không phải vai trò thật
  const roleCols = allRoleCols.filter((c) => !isPlaceholderRole(shape.headers[c]))
  const base = { id: null, confidence, field_confidence: {}, source_block_ids: [table.block_id], origin: "deterministic" as const }
  const roles = roleCols.map((c) => ({ ...base, entity: "roles", value: { name: shape.headers[c], actor_id: shape.headers[c] } }))
  let parent: string | null = null
  let parentIsPlaceholder = false
  const permissions = shape.body.flatMap((r) => {
    const raw = (grid[r][screenCol] ?? "").trim()
    if (!raw) return []
    const sub = parent !== null && (indented.has(`${r}:${screenCol}`) || SUB_ROW_MARKER.test(raw))
    const screen = sub ? raw.replace(SUB_ROW_MARKER, "") : raw
    if (!sub) {
      parent = screen
      parentIsPlaceholder = isPlaceholderText(screen)
    }
    // FLF-411: màn chỗ điền của mẫu (`<<Screen Name1>>`) và thao tác dưới nó không thành quyền
    if (isPlaceholderText(screen) || (sub && parentIsPlaceholder)) return []
    const extra = sub ? { parent_screen: parent } : {}
    return roleCols.flatMap((c) =>
      markActions(grid[r][c] ?? "").map((action) => ({ ...base, entity: "permissions", value: { screen_id: screen, role_id: shape.headers[c], action, ...extra } }))
    )
  })
  return [...roles, ...permissions]
}

/**
 * Bảng có mapping đủ field bắt buộc ⇒ item theo từng hàng dữ liệu; không đủ ⇒ `null` (để AI trích). Đọc theo hình dạng
 * bảng (FLF-252): hàng tiêu đề thật (bỏ hàng tên bảng), hàng nhóm không thành phần tử (nhãn nhóm làm feature của màn).
 */
export const deterministicTableItems = (
  table: BlockLite,
  grid: string[][],
  profile: ITemplateProfile,
  indented: ReadonlySet<string> = new Set()
): EntityItem[] | null => {
  const cols = profile.table_map.filter((t) => t.block_id === table.block_id && t.field_path)
  const shape = tableShape(grid)
  if (!cols.length || !shape.body.length) return null
  const entity = cols[0].field_path!.split("[")[0]
  // Cột người dùng xác nhận ⇒ chắc chắn; cột tự nhận (FLF-343) giữ độ tin của mapping ⇒ dữ liệu của nó vẫn "Cần xem"
  const confidence = Math.min(...cols.map((c) => (c.confirmed && !c.auto_confirmed ? 1 : c.confidence)))
  if (entity === "permissions") return matrixItems(table, grid, shape, cols, confidence, indented)
  const def = TABLE_ENTITIES.find((d) => d.entity === entity)
  const fields = new Map(cols.filter((c) => c.field_path!.startsWith(`${entity}[`)).map((c) => [c.column_index, c.field_path!.split("].")[1]]))
  if (!def || !hasRequiredFields(def, new Set(fields.values()))) return null
  const above = new Map<string, string>()
  // Bảng NFR có cột tên không map ("External System | Description") ⇒ tên đứng đầu câu yêu cầu: không còn câu
  // "Provides Pull Request events…" mất chữ "GitHub" (FLF-252)
  const statementCol = [...fields].find(([, field]) => field === "statement")?.[0]
  const labelCol =
    entity === "nfrs" && statementCol !== undefined ? shape.columns.find((c) => c.index < statementCol && c.role === "name" && !fields.has(c.index))?.index : undefined
  return shape.body.flatMap((r) => {
    // Hàng chỗ trống của mẫu (`[FR-xxx] | [The system shall ...]`) không phải dữ liệu — không thành phần tử Spine
    if (!grid[r].some((cell) => isRealText(cell))) return []
    // FLF-411: dòng mẫu (`3 | .. |`, `1 | <<Feature Name>> | <<Function Name1>>`) không phải dữ liệu; ô chỗ điền là trống
    if (isPlaceholderRow(grid[r])) return []
    const value: Record<string, unknown> = {}
    for (const [col, field] of fields) {
      let cell: string | undefined = grid[r][col]?.trim()
      if (cell && isPlaceholderText(cell)) cell = ""
      if (!cell && FILL_DOWN_FIELDS.has(field)) cell = above.get(field)
      if (!cell) continue
      if (FILL_DOWN_FIELDS.has(field)) above.set(field, cell)
      value[field] = LIST_FIELDS.has(field) ? splitList(cell, field !== "goals") : cell
    }
    // Bug #12c: thuộc tính cần tên thực thể (cột tên có thể đứng sau cột thuộc tính) ⇒ tách sau khi đọc hết hàng
    if (typeof value.attributes === "string") value.attributes = attributesFromCell(value.attributes, typeof value.name === "string" ? value.name : "")
    const label = labelCol === undefined ? "" : (grid[r][labelCol] ?? "").trim()
    if (label && typeof value.statement === "string" && !value.statement.toLowerCase().startsWith(label.toLowerCase())) value.statement = `${label}: ${value.statement}`
    if (!Object.keys(value).length) return []
    const group = groupOf(shape, r)
    if (entity === "screens" && value.feature_id === undefined && group) value.feature_id = group
    // Bảng yêu cầu "ID | Requirement" không có cột tên ⇒ tên chức năng là phần đầu câu yêu cầu (mô tả giữ đủ câu)
    if (entity === "functions" && value.name === undefined && typeof value.description === "string") value.name = shortName(value.description)
    const key = typeof value.id === "string" && value.id.trim() ? keepKey(value.id) : null
    delete value.id
    return [{ entity, id: key, value, confidence, field_confidence: {}, source_block_ids: [table.block_id], origin: "deterministic" as const }]
  })
}

// ─── AI ──────────────────────────────────────────────────────────

/** Ngân sách chữ mỗi lượt I-4 (~6k token, P0 báo cáo §4.8) và trần một block (bảng khổng lồ, ảnh nhúng dạng chữ…). */
export const AI_BATCH_CHARS = 24_000
export const AI_BLOCK_CHARS = 6_000

/** Chia block của section thành lô không vượt ngân sách; block quá dài bị cắt (ghi chú "…truncated"). */
export const chunkBlocks = <T extends { text: string }>(blocks: T[], budget = AI_BATCH_CHARS, maxBlock = AI_BLOCK_CHARS): T[][] => {
  const out: T[][] = []
  let cur: T[] = []
  let size = 0
  for (const raw of blocks) {
    const b = raw.text.length > maxBlock ? { ...raw, text: `${raw.text.slice(0, maxBlock)} …(truncated)` } : raw
    if (cur.length && size + b.text.length > budget) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(b)
    size += b.text.length
  }
  if (cur.length) out.push(cur)
  return out
}

/** Khối gửi AI; `text` của bảng đã là `tableText` (dựng trước khi chia lô để trần ký tự tính đúng phần gửi đi). */
const blockLines = (blocks: BlockLite[]): string => blocks.map((b) => `[${b.block_id}] ${b.kind === "table" ? `(table)\n${b.text}` : b.text}`).join("\n")

/**
 * QLHS 11/11 (bug #10): bảng "từ điển dữ liệu" có cột thuộc tính mà model chỉ lấy tên / quan hệ / mô tả (không field
 * `attributes` nào trích từ bảng đó) ⇒ nếu coi bảng là "đã trích" thì cột thuộc tính biến mất khỏi tài liệu. Bảng như vậy
 * giữ nguyên văn tại chỗ (unmapped) — Spine vẫn nhận phần model đọc được.
 */
const ATTRIBUTE_COLUMN = /thuộc tính|attribute/i
/** Hàng tiêu đề của bảng có cột thuộc tính (bảng từ điển dữ liệu). */
export const hasAttributeColumn = (rows: readonly (readonly string[])[] | null | undefined): boolean => ATTRIBUTE_COLUMN.test((rows?.[0] ?? []).join(" | "))
/** FLF-411: nhãn cột vai trò của mẫu ("Role-Name1", "Role Name 2", "…", "<<Role>>"). */
export const isPlaceholderRole = (header: string): boolean => isPlaceholderText(header) || /^role[\s_-]*name\s*\d*$/i.test(header.trim())

/** FLF-411: bảng thông báo có cột ngoài `Message` của Spine (không map, không phải cột số thứ tự) — vd "Message Type", "Context". */
const hasUnmappedMessageColumn = (table: BlockLite, rows: readonly (readonly string[])[], profile: ITemplateProfile): boolean => {
  const cols = profile.table_map.filter((t) => t.block_id === table.block_id)
  if (!cols.some((c) => c.field_path?.startsWith("messages["))) return false
  const mapped = new Set(cols.filter((c) => c.field_path).map((c) => c.column_index))
  return (rows[0] ?? []).some((h, i) => h.trim() && !mapped.has(i) && !/^(#|no\.?|stt|số tt)$/i.test(h.trim()))
}

export const tablesToKeepVerbatim = (batch: readonly Pick<BlockLite, "block_id" | "kind" | "rows">[], items: readonly EntityItem[]): string[] =>
  batch
    .filter((b) => b.kind === "table" && ATTRIBUTE_COLUMN.test((b.rows?.[0] ?? []).join(" | ")))
    .filter((b) => !items.some((it) => it.source_block_ids.includes(b.block_id) && Array.isArray(it.value.attributes) && (it.value.attributes as unknown[]).length > 0))
    .map((b) => b.block_id)

/** Trọng số của điểm AI trong độ tin cuối (FLF-343); phần còn lại là trung bình tín hiệu của code. */
export const AI_CONFIDENCE_WEIGHT = 0.6

/** Chuẩn hoá để so chữ: thường, bỏ dấu, gộp khoảng trắng. */
const plain = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()

/**
 * Tín hiệu code của một item AI (FLF-343, mỗi tín hiệu 0..1):
 * - `source`: model trỏ được ít nhất một block nguồn có thật của lô (không thì code tự gán block đầu ⇒ 0);
 * - `match`: khoá model đặt khớp mã được nhắc trong block nguồn / phần tử đã biết, hoặc một giá trị chữ của item có trong chữ
 *   của block nguồn (tên, câu yêu cầu… — 40 ký tự đầu) ⇒ 1; không khớp gì ⇒ 0;
 * - `section`: độ tin khớp mục (I-3) của section đang trích (không biết ⇒ không tính).
 */
export const codeSignals = (
  raw: { key?: string | null; value: Record<string, unknown>; source_block_ids: string[] },
  ctx: { validBlocks: Set<string>; blockText?: ReadonlyMap<string, string>; knownKey?: boolean; sectionConfidence?: number | null }
): number[] => {
  const sources = raw.source_block_ids.filter((b) => ctx.validBlocks.has(b))
  const signals = [sources.length ? 1 : 0]
  if (ctx.blockText && !sources.length) {
    // Block nguồn model bịa ⇒ không có chữ nguồn để khớp — không so với cả lô (dễ khớp nhầm)
    signals.push(0)
  } else if (ctx.blockText) {
    const text = plain(sources.map((b) => ctx.blockText!.get(b) ?? "").join(" "))
    const key = raw.key ? plain(raw.key) : ""
    const keyHit = !!key && (ctx.knownKey || text.includes(key))
    const valueHit = Object.values(raw.value).some((v) => {
      const str = typeof v === "string" ? plain(v) : ""
      return str.length >= 3 && text.includes(str.slice(0, 40))
    })
    signals.push(keyHit || valueHit ? 1 : 0)
  }
  if (typeof ctx.sectionConfidence === "number") signals.push(Math.min(1, Math.max(0, ctx.sectionConfidence)))
  return signals
}

/** Điểm AI dưới mức này ⇒ luôn "Cần xem", tín hiệu code khớp đến đâu cũng không kéo qua ngưỡng. */
export const AI_MIN_TRUSTED = 0.6

/**
 * Độ tin cuối = AI × 0.6 + trung bình tín hiệu code × 0.4, làm tròn 2 chữ số. Điểm AI < 0.6 ⇒ chặn dưới ngưỡng xác nhận
 * (`FIELD_CONFIDENCE_THRESHOLD`) để vẫn gắn cờ Cần xem.
 */
export const combineAiConfidence = (ai: number, signals: readonly number[]): number => {
  const code = signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : ai
  const combined = Math.round(Math.min(1, Math.max(0, AI_CONFIDENCE_WEIGHT * ai + (1 - AI_CONFIDENCE_WEIGHT) * code)) * 100) / 100
  return ai < AI_MIN_TRUSTED ? Math.min(combined, Math.round((FIELD_CONFIDENCE_THRESHOLD - 0.01) * 100) / 100) : combined
}

/**
 * Đổi output model sang item: id theo mã / tên phần tử đã biết (`aiItemId`), ép id function của section function.
 * `fromImage`: item đọc từ ảnh diagram — tên trùng phần tử đã biết thắng khoá model đặt.
 * Độ tin (cả từng field) = điểm AI kết hợp tín hiệu code (`codeSignals`, FLF-343).
 */
export const itemsFromAi = (
  out: ImportExtractOutput,
  ctx: {
    sectionId: string
    alloc: IdSource
    known: EntityItem[]
    sectionFunction: ProvisionalEntity | null
    validBlocks: Set<string>
    fromImage?: boolean
    /** Chữ của block trong lô (tín hiệu khớp khoá / giá trị). */
    blockText?: ReadonlyMap<string, string>
    /** Độ tin khớp mục I-3 của section. */
    sectionConfidence?: number | null
  }
): EntityItem[] => {
  let functionUsed = false
  return out.items.map((raw) => {
    const value = { ...raw.value }
    delete value.id
    let id: string | null = null
    let knownKey = false
    if (raw.entity !== "project") {
      if (raw.entity === "functions" && ctx.sectionFunction && !functionUsed) {
        id = ctx.sectionFunction.id
        functionUsed = true
        knownKey = true
      } else {
        const found = aiItemId(ctx.known, raw.entity, raw.key, value.name ?? value.term, ctx.fromImage)
        // Khoá trỏ đúng một phần tử đã biết (bảng, mục trước) — mã model tự đặt mới thì không tính
        knownKey = !!found && ctx.known.some((k) => k.entity === raw.entity && k.id === found)
        id = found ?? ctx.alloc.next(raw.entity)
        ctx.alloc.reserve(raw.entity, id)
      }
    }
    if (raw.entity === "nfrs" && NFR_CATEGORY_BY_SECTION[ctx.sectionId] && value.category === undefined) value.category = NFR_CATEGORY_BY_SECTION[ctx.sectionId]
    const sources = raw.source_block_ids.filter((b) => ctx.validBlocks.has(b))
    const signals = codeSignals(raw, { validBlocks: ctx.validBlocks, blockText: ctx.blockText, knownKey, sectionConfidence: ctx.sectionConfidence })
    return {
      entity: raw.entity,
      id,
      value,
      confidence: combineAiConfidence(raw.confidence, signals),
      field_confidence: Object.fromEntries(Object.entries(raw.field_confidence ?? {}).map(([k, v]) => [k, combineAiConfidence(v, signals)])),
      source_block_ids: sources.length ? sources : [...ctx.validBlocks].slice(0, 1),
      origin: "ai" as const
    }
  })
}

// ─── ảnh diagram (mode 1 v3 phase 5) ─────────────────────────────


/**
 * Mã business rule model gán cho chức năng phải có trong chữ của mục (FLF-252): mục không ghi mã nào mà model vẫn nối
 * "Logout" với BR-01 (đoán, độ tin 0.5) ⇒ bỏ; câu quy tắc model nhét vào chỗ mã cũng bỏ (không phải mã). Không còn mã ⇒ bỏ field.
 */
export const keepMentionedRules = (items: EntityItem[], mentioned: ReadonlySet<string>): EntityItem[] =>
  items.map((it) => {
    const refs = it.entity === "functions" && Array.isArray(it.value.business_rule_ids) ? (it.value.business_rule_ids as unknown[]) : null
    if (!refs) return it
    const kept = refs.filter((r) => typeof r === "string" && mentioned.has(idKey(r)))
    if (kept.length === refs.length) return it
    const value: Record<string, unknown> = { ...it.value, business_rule_ids: kept }
    if (!kept.length) delete value.business_rule_ids
    return { ...it, value }
  })

/** Đoạn văn thường nhưng là dòng chú thích hình: "H3 · sơ đồ hoạt động…", "Hình 2 …", "Figure 2 …", "Fig. 3 …". */
const FIGURE_LINE = /^(h\d+\b|hình\s*\d+|figure\s*\d+|fig\.?\s*\d+)/i
const isFigureLine = (b: Pick<BlockLite, "kind" | "text"> | undefined): boolean =>
  !!b && b.kind === "paragraph" && b.text.trim().length <= 200 && FIGURE_LINE.test(b.text.trim())

/**
 * Chú thích của ảnh: block caption ngay sau (hoặc ngay trước) ảnh trong section. File không dùng kiểu "Caption" của Word
 * (QLHS: "H3 · sơ đồ hoạt động UC-05" là đoạn thường ngay dưới ảnh) ⇒ nhận cả đoạn ngắn bắt đầu bằng "H3 / Hình 3 / Figure 3".
 */
export const captionOf = (img: Pick<BlockLite, "block_id">, sectionBlocks: Pick<BlockLite, "block_id" | "kind" | "text">[]): string => {
  const i = sectionBlocks.findIndex((b) => b.block_id === img.block_id)
  const near = [sectionBlocks[i + 1], sectionBlocks[i - 1]].find((b) => (b?.kind === "caption" && b.text.trim()) || isFigureLine(b))
  return near?.text.trim() ?? "(none)"
}

/** Caption chỉ hình là sơ đồ đọc được (use case, ngữ cảnh, ERD / class, luồng màn; FLF-390: sequence, activity). */
const DIAGRAM_CAPTION = /(use[\s-]?case|context|erd|entity[\s-]?relationship|class diagram|data model|screens?[\s-]?flow|navigation|sequence|tuần tự|activity|hoạt động|luồng xử lý|workflow|deployment|triển khai|sơ đồ|biểu đồ|diagram)/i
/** Caption chỉ hình không phải loại sơ đồ đọc được (ảnh màn hình, wireframe, state machine…) — đọc chỉ tốn credit. */
const NOT_DIAGRAM_CAPTION = new RegExp(`${SCREEN_CAPTION.source.slice(0, -1)}|state machine|component diagram)`, "i")

/**
 * Ảnh có gửi AI đọc không (FLF-252): caption nói là ảnh màn hình / sơ đồ khác loại ⇒ không; ảnh ở mục thường có sơ đồ
 * (ngữ cảnh, use case, luồng màn, ERD) hoặc caption nói là sơ đồ đọc được (mẫu IEEE đặt sơ đồ ở mục khác FPT) ⇒ có.
 */
export const readsImage = (sectionId: string, caption: string): boolean =>
  !NOT_DIAGRAM_CAPTION.test(caption) && (DIAGRAM_SECTIONS.has(sectionId) || DIAGRAM_CAPTION.test(caption))

const isBlank = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)

/** Loại phần tử mà field quan hệ trỏ tới. */
const REF_ENTITY: Readonly<Record<string, string>> = { actor_ids: "actors", includes: "use_cases", extends: "use_cases", relations: "entities", flow_to: "screens" }

/**
 * Khoá so tham chiếu: mã phần tử đã biết ⇒ tên của nó (ảnh ghi "A01", bảng ghi "Learner" là một), còn lại ⇒ tên so cả khác
 * quy ước đặt tên ("Repository" = "repositories").
 */
const refKey = (known: readonly EntityItem[], field: string, ref: unknown): string => {
  const entity = REF_ENTITY[field]
  ref = refTarget(ref)
  const id = entity ? findKnownKey(known, entity, String(ref)) : null
  const name = id ? known.find((k) => k.entity === entity && k.id === id && typeof k.value.name === "string")?.value.name : undefined
  return compactKey(typeof name === "string" ? name : String(ref))
}

/**
 * Phần tử đọc từ ảnh trùng phần tử đã có (cùng loại, cùng id) — từ chữ / bảng hay từ ảnh trước (sơ đồ ngữ cảnh rồi sơ
 * đồ use case cùng vẽ các tác nhân) ⇒ chỉ giữ phần ảnh thêm vào: quan hệ mới (actor nối thêm, include / extend…) và field
 * nguồn trước không có (loại tác nhân khi bảng không có cột loại). Bước 1.9 chỉ hỏi phần đó; không có gì mới ⇒ bỏ item (FLF-252).
 */
export const onlyNewFromVision = (items: EntityItem[], known: readonly EntityItem[]): EntityItem[] =>
  items.flatMap((it) => {
    const same = known.filter((k) => k.entity === it.entity && k.id === it.id)
    if (!same.length) return [it]
    const value: Record<string, unknown> = {}
    for (const [field, v] of Object.entries(it.value)) {
      if (isBlank(v)) continue
      const prev = same.map((k) => k.value[field]).filter((x) => !isBlank(x))
      if (!REF_LIST_FIELDS.has(field) || !Array.isArray(v)) {
        if (!prev.length) value[field] = v
        continue
      }
      const seen = new Set(prev.flat().map((x) => refKey(known, field, x)))
      const added = v.filter((x) => !seen.has(refKey(known, field, x)))
      if (added.length) value[field] = added
    }
    if (!Object.keys(value).length) return []
    return [{ ...it, value, field_confidence: Object.fromEntries(Object.entries(it.field_confidence).filter(([field]) => field in value)) }]
  })

/** Id use case của một tham chiếu (mã hoặc tên) trong `pool`; không phân giải được ⇒ `null`. */
const useCaseIdIn =
  (pool: readonly EntityItem[]) =>
  (ref: unknown): string | null =>
    typeof ref === "string" ? (findKnownKey(pool, "use_cases", ref) ?? findKnownId(pool, "use_cases", ref) ?? findKnownCompact(pool, "use_cases", ref)) : null

const hasActors = (it: EntityItem | undefined): boolean => Array.isArray(it?.value.actor_ids) && (it.value.actor_ids as unknown[]).length > 0

/**
 * Chiều include / extend đọc từ ảnh theo nét vẽ (FLF-252). Model (nhất là model dự phòng khi model chính quá tải) hay đọc
 * ngược đầu mũi tên — "Execute Analyzer include Trigger Analysis Workflow", "View List User extend View User Detail, Ban /
 * Unban User". Đảo chiều khi:
 * - đúng một đầu có tác nhân trên ảnh mà nằm sai phía: use case gốc nối với tác nhân, phần được include / phần mở rộng thì không;
 * - một use case extend từ hai use case trở lên: nhiều phần mở rộng trỏ về một gốc, không có phần mở rộng nào của nhiều gốc.
 * Còn lại (hai đầu cùng có / cùng không có tác nhân) ⇒ giữ như model đọc.
 */
export const orientRelations = (items: EntityItem[], known: readonly EntityItem[]): EntityItem[] => {
  const idOf = useCaseIdIn([...known, ...items])
  const read = new Map(items.filter((it) => it.entity === "use_cases" && it.id).map((it) => [it.id!, it]))
  const moves: { field: string; from: string; ref: unknown; to: string }[] = []
  for (const [id, it] of read) {
    for (const field of ["includes", "extends"]) {
      const refs = Array.isArray(it.value[field]) ? (it.value[field] as unknown[]) : []
      const fanOut = field === "extends" && refs.filter((r) => idOf(r) && idOf(r) !== id).length >= 2
      for (const ref of refs) {
        const other = idOf(ref)
        if (!other || other === id || !read.has(other)) continue
        const byActors = hasActors(it) !== hasActors(read.get(other))
        // include: gốc (có tác nhân) include phần chung; extend: phần mở rộng (không tác nhân) extend gốc
        const reversed = fanOut || (byActors && (field === "includes" ? !hasActors(it) : hasActors(it)))
        if (reversed) moves.push({ field, from: id, ref, to: other })
      }
    }
  }
  if (!moves.length) return items
  const value = new Map([...read].map(([id, it]) => [id, { ...it.value }]))
  for (const m of moves) {
    const from = value.get(m.from)!
    from[m.field] = (from[m.field] as unknown[]).filter((r) => r !== m.ref)
    const to = value.get(m.to)!
    const list = Array.isArray(to[m.field]) ? (to[m.field] as unknown[]) : []
    if (!list.some((r) => idOf(r) === m.from)) to[m.field] = [...list, m.from]
  }
  return items.map((it) => (it.entity === "use_cases" && it.id && value.has(it.id) ? { ...it, value: value.get(it.id)! } : it))
}

/**
 * Quan hệ ảnh tự mâu thuẫn — A extend B và B extend A (include cũng vậy), model đọc nhầm chiều mũi tên ⇒ bỏ cả cặp:
 * thiếu quan hệ còn hơn đưa ra duyệt một quan hệ sai, kết thành vòng (FLF-252, sơ đồ use case WDP301).
 */
export const dropMutualRelations = (items: EntityItem[], known: readonly EntityItem[]): EntityItem[] => {
  const idOf = useCaseIdIn([...known, ...items])
  const mutual = new Set<string>()
  for (const field of ["includes", "extends"]) {
    const edges = new Set<string>()
    for (const it of items) if (it.entity === "use_cases" && it.id && Array.isArray(it.value[field])) for (const r of it.value[field] as unknown[]) edges.add(`${it.id}>${idOf(r)}`)
    for (const e of edges) {
      const [from, to] = e.split(">")
      if (edges.has(`${to}>${from}`)) mutual.add(`${field}|${e}`)
    }
  }
  if (!mutual.size) return items
  return items.map((it) => {
    if (it.entity !== "use_cases" || !it.id) return it
    const value = { ...it.value }
    for (const field of ["includes", "extends"]) {
      if (Array.isArray(value[field])) value[field] = (value[field] as unknown[]).filter((r) => !mutual.has(`${field}|${it.id}>${idOf(r)}`))
    }
    return { ...it, value }
  })
}

/** Item đọc từ ảnh: `origin: vision`, độ tin (cả từng field) không vượt trần ⇒ luôn qua màn 1.9. */
export const visionItems = (items: EntityItem[]): EntityItem[] =>
  items.map((it) => ({
    ...it,
    origin: "vision" as const,
    confidence: Math.min(it.confidence, VISION_CONFIDENCE_CAP),
    field_confidence: Object.fromEntries(Object.entries(it.field_confidence).map(([k, v]) => [k, Math.min(v, VISION_CONFIDENCE_CAP)]))
  }))

// ─── chạy ────────────────────────────────────────────────────────

const itemsOfDraft = (d: Pick<IExtractionDraft, "fields">): EntityItem[] => {
  const map = new Map<string, EntityItem>()
  for (const f of d.fields) {
    const p = parseFieldPath(f.path)
    if (!p) continue
    const key = `${p.entity}|${p.id}`
    const it = map.get(key) ?? { entity: p.entity, id: p.id, value: {}, confidence: f.confidence, field_confidence: {}, source_block_ids: f.source_block_ids, origin: f.origin }
    it.value[p.field] = f.edited_value ?? f.value
    map.set(key, it)
  }
  return [...map.values()]
}

const fieldConfidence = (it: EntityItem, field: string): number => it.field_confidence[field] ?? it.confidence

/**
 * Gộp item cùng phần tử trong một section. Chữ / bảng nói cùng phần tử với ảnh ⇒ chữ thắng (tin hơn ảnh), ảnh chỉ bù field
 * chữ không có + quan hệ mới. Phần ảnh bù giữ nguồn `vision` + độ tin của ảnh (FLF-252) — trước đây nhận độ tin của chữ /
 * bảng nên vào Spine không qua bước 1.9 (vd quan hệ của ERD gộp vào bảng thực thể cùng mục).
 */
export const mergeItems = (items: EntityItem[]): EntityItem[] => {
  const out = new Map<string, EntityItem>()
  for (const it of items) {
    const key = `${it.entity}|${it.id ?? ""}`
    const cur = out.get(key)
    if (!cur) {
      out.set(key, { ...it, value: { ...it.value }, field_confidence: { ...it.field_confidence }, source_block_ids: [...it.source_block_ids] })
      continue
    }
    const [base, extra] = cur.origin === "vision" && it.origin !== "vision" ? [it, cur] : [cur, it]
    const origins: Record<string, FieldOrigin> = { ...extra.field_origin, ...base.field_origin }
    const merged: EntityItem = {
      ...base,
      value: { ...base.value },
      field_confidence: { ...extra.field_confidence, ...base.field_confidence },
      field_origin: origins,
      source_block_ids: [...new Set([...base.source_block_ids, ...extra.source_block_ids])]
    }
    for (const [k, v] of Object.entries(extra.value)) {
      const had = merged.value[k]
      const next = had === undefined ? v : REF_LIST_FIELDS.has(k) ? mergeFieldValue(k, had, v) : had
      if (JSON.stringify(next) === JSON.stringify(had)) continue
      merged.value[k] = next
      if (extra.origin !== "vision") continue
      merged.field_confidence[k] = Math.min(had === undefined ? 1 : fieldConfidence(base, k), fieldConfidence(extra, k))
      origins[k] = "vision"
    }
    out.set(key, merged)
  }
  return [...out.values()]
}

const provisionalItems = (sectionId: string, provisional: Map<string, ProvisionalEntity>): EntityItem[] => {
  const p = provisional.get(sectionId)
  if (!p) return []
  const value: Record<string, unknown> = { name: p.name }
  if (p.entity === "functions") value.feature_id = p.feature_id
  return [{ entity: p.entity, id: p.id, value, confidence: p.confidence, field_confidence: {}, source_block_ids: [p.block_id], origin: "deterministic" }]
}

const needsReview = (drafts: Pick<IExtractionDraft, "fields">[]): boolean =>
  drafts.some((d) => d.fields.some((f) => !f.confirmed && needsConfirm(f)))

// ─── kế hoạch lượt AI (chung cho lượt chạy và ước tính credit) ───

/** Một lượt AI của section theo thứ tự chạy: ảnh diagram trước (thực thể ảnh vào known_keys của lô chữ), rồi lô chữ. */
export type SectionAiStep = { kind: "image"; block: BlockLite } | { kind: "text"; batch: BlockLite[] }

/** Section chưa xong: phần đọc tất định + các lượt AI theo thứ tự. */
export interface PlannedSection {
  section_id: string
  settled: Settled
  steps: SectionAiStep[]
  /** Băm danh sách lượt — tiến độ từng lượt đã lưu chỉ dùng lại khi khớp. */
  plan_hash: string
}

/**
 * Lượt AI của một section. Tất định theo block + template profile: block của `IMPORTED_DOC_VERSION` chỉ ghi lúc tách file
 * và lúc finalize, mapping chỉ sửa ở `mapping_review` ⇒ trong lúc `extracting` chạy lại cho đúng các lô cũ.
 */
export const sectionAiSteps = (sectionId: string, blocks: BlockLite[], settled: Settled): SectionAiStep[] => {
  // FLF-411: chữ của mẫu (khoảng hướng dẫn nhiều đoạn, `<<Sample … >>` kèm hình, chỗ điền — BF §3.1.1) không gửi AI / vision
  const marks = templateMarks(blocks)
  const sectionBlocks = blocks.filter((b) => b.section_id === sectionId && !marks.has(b.block_id))
  const tablePrefixes = sectionBlocks.filter((b) => b.kind === "table").map((b) => `${b.anchor.xml_path}/`)
  const aiBlocks = sectionBlocks
    .filter(
      (b) =>
        b.kind !== "heading" &&
        b.text.trim() &&
        !settled.handled.has(b.block_id) &&
        !settled.consumed.has(b.block_id) &&
        !(b.kind === "table_cell" && tablePrefixes.some((prefix) => b.anchor.xml_path.startsWith(prefix)))
    )
    // Bảng gửi AI theo ô thật (FLF-251) — tách `text` theo dòng làm ô nhiều dòng thành nhiều hàng
    .map((b) => (b.kind === "table" ? { ...b, text: tableText(tableRows(b, blocks)) } : b))
  // Phase 5: ảnh diagram (EMF/WMF / file gốc không còn ⇒ lúc chạy ghi `unsupported`, không gọi AI)
  const images = sectionBlocks.filter((b) => b.kind === "image" && b.image_ref && readsImage(sectionId, captionOf(b, sectionBlocks)))
  const batches = targetsOf(sectionId).length ? chunkBlocks(aiBlocks) : []
  return [...images.map((block) => ({ kind: "image" as const, block })), ...batches.map((batch) => ({ kind: "text" as const, batch }))]
}

export const stepsHash = (steps: SectionAiStep[]): string =>
  createHash("sha1")
    .update(JSON.stringify(steps.map((s) => (s.kind === "image" ? ["image", s.block.block_id, s.block.image_ref] : ["text", s.batch.map((b) => [b.block_id, b.text])]))))
    .digest("hex")

/** Đọc tất định + lượt AI của mọi section chưa `done`, theo thứ tự tài liệu. */
export const planPendingSections = (
  plan: string[],
  blocks: BlockLite[],
  profile: ITemplateProfile,
  provisional: Map<string, ProvisionalEntity>,
  done: ReadonlySet<string>
): PlannedSection[] =>
  plan
    .filter((s) => !done.has(s))
    .map((section_id) => {
      const settled = settleSection(section_id, blocks, profile, provisional)
      const steps = sectionAiSteps(section_id, blocks, settled)
      return { section_id, settled, steps, plan_hash: stepsHash(steps) }
    })

/** Số lượt đã xong (đã trừ credit) theo tiến độ lưu trong bản nháp; kế hoạch đã khác ⇒ 0 (chạy lại cả section). */
const stepsDoneOf = (draft: Pick<IExtractionDraft, "partial"> | undefined, planned: PlannedSection): number =>
  draft?.partial && draft.partial.plan_hash === planned.plan_hash ? Math.min(draft.partial.steps_done, planned.steps.length) : 0

interface ExtractionInputs {
  profile: ITemplateProfile
  blocks: BlockLite[]
  provisional: Map<string, ProvisionalEntity>
  plan: string[]
}

/**
 * FLF-378 (luồng C, C2.1): file là **khung mẫu để điền** (giữ khung + màn đọc khung thấy phần lớn mục trống — `isTemplateFile`)
 * — chữ trong file là hướng dẫn / ví dụ, không phải dữ liệu ⇒ không trích nội dung vào Spine (không gọi AI, không đọc bảng tất
 * định). Chỉ giữ cấu trúc từ heading (tính năng / chức năng tạm của mapping) để mục của mẫu khớp được phần tử Spine; chữ của
 * mẫu thành `template_context` lúc finalize. Khung mẫu có tick bổ sung theo mẫu chuẩn cũng vậy (`isTemplateContent`, FLF-411).
 */
export const isTemplateOnlyProject = async (projectId: string): Promise<boolean> => {
  const [project, profile] = await Promise.all([
    Project.findById(projectId, { start_kind: 1, template_intent: 1 }).lean(),
    TemplateProfile.findOne({ projectId }, { structure_preview: 1 }).lean()
  ])
  // FLF-411: khung mẫu mà người dùng tick bổ sung theo mẫu chuẩn (ý định tự do) cũng không trích chữ / hình ví dụ của mẫu
  return isTemplateFile(project, profile) || isTemplateContent(profile)
}

export const loadExtractionInputs = async (projectId: string): Promise<ExtractionInputs | null> => {
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile) return null
  const stored = await DocBlock.find({ projectId, doc_version: { $in: IMPORTED_DOC_VERSIONS } }).sort({ "anchor.ordinal": 1 }).lean<BlockLite[]>()
  // FLF-412: lựa chọn Bỏ chữ chưa áp vào file (trước Bắt đầu) ⇒ ước tính như file đã bỏ chữ. Ý định chỉ quyết định có bỏ heading
  // mục riêng hay không — heading không tốn lượt đọc nên không cần biết
  const blocks = profile.drop_text?.length ? applyDropToBlocks(stored, planDrop(stored, textRegions(stored, profile.heading_map), new Set(profile.drop_text), "fixed")) : stored
  return { profile, blocks, provisional: resolveProvisional(profile.heading_map), plan: extractionPlan(blocks) }
}

/** Loại phần tử luôn có trong known_keys (danh sách nhỏ, chữ hay nhắc bằng tên): tác nhân, vai trò. */
const ALWAYS_KNOWN = ["actors", "roles"] as const

/** Feature/function tạm của section + feature cha của function — luôn đứng đầu known_keys. */
const provisionalScope = (sectionId: string, provisional: Map<string, ProvisionalEntity>): EntityItem[] => {
  const own = provisionalItems(sectionId, provisional)
  const p = provisional.get(sectionId)
  const parent = p?.feature_id ? [...provisional.values()].find((x) => x.entity === "features" && x.id === p.feature_id) : undefined
  return parent ? [...own, ...provisionalItems(parent.section, provisional)] : own
}

type MeteredFailure = Extract<MeteredResult<unknown>, { ok: false }>

/** Ngữ cảnh đọc một ảnh sơ đồ của section — dùng cho lượt đọc đầu và các lượt đọc lại (FLF-360). */
export interface DiagramReadContext {
  projectId: string
  userId: string
  section_id: string
  heading: { heading_text?: string; confidence?: number } | undefined
  sectionBlocks: BlockLite[]
  /** Phần tử đã biết (section khác + phần đọc tất định) và phần tử của chính section (đã đọc tới giờ). */
  known: readonly EntityItem[]
  items: readonly EntityItem[]
  alloc: IdSource
  ownProvisional: EntityItem[]
  targets: readonly string[]
  /** `false`: hết credit không tự báo nạp (I-4 song song báo một lần — FLF-392). */
  notifyTopUp?: boolean
  /**
   * I-4 song song: section khác vừa dừng (Dừng / hết credit / AI lỗi) trong lúc ảnh này đang tải ⇒ không bắt đầu lượt AI.
   * Kiểm ngay trước khi gọi model, sau bước tải ảnh.
   */
  stopped?: () => boolean
  /** FLF-390: function tạm của mục function — chủ của ảnh sequence / activity trong mục đó. */
  sectionFunction?: ProvisionalEntity | null
}

/**
 * Kết quả đọc một ảnh: `read` (loại + phần tử mới so với đã biết), `unsupported` (EMF/WMF / file mất / môi trường không có
 * vision — không đọc lại), `unavailable` (AI lỗi tạm thời sau mọi lượt thử — đọc lại được), `failed` (lỗi AI không tự khỏi —
 * không đọc lại), `credits` (hết credit — dừng).
 */
export type DiagramRead =
  | { status: "read"; kind: DiagramImageKind | "other"; items: EntityItem[]; usageId: string; owner_id?: string | null }
  | { status: "unsupported" | "unavailable" | "failed" }
  | { status: "credits"; failure: MeteredFailure }

/** FLF-390: sơ đồ của một phần tử — dữ liệu đọc được nằm trên chủ đó: sơ đồ tuần tự ↔ function, activity ↔ use case. */
const OWNER_ENTITY: Readonly<Record<string, "functions" | "use_cases">> = { sequence: "functions", activity: "use_cases" }

/** Kết quả gọi AI đọc một ảnh, chưa cấp mã / ghép tên (FLF-392: output thô lưu ở `partial.raw_steps`). */
export type DiagramCall =
  | { status: "read"; data: ImportExtractDiagramOutput; usageId: string }
  | { status: "unsupported" | "unavailable" | "failed" }
  | { status: "credits"; failure: MeteredFailure }
  /** `ctx.stopped()` bật trước khi gọi model ⇒ không gọi, không trừ credit, không lưu lượt. */
  | { status: "stopped" }

/** Gọi AI đọc một ảnh sơ đồ (known_keys theo phần tử đã biết + của section) — không cấp mã. */
export const callDiagramAi = async (img: BlockLite, ctx: Omit<DiagramReadContext, "alloc">): Promise<DiagramCall> => {
  const { projectId, userId, section_id, heading, sectionBlocks, known, items, ownProvisional, targets } = ctx
  const image = await loadImportImage(projectId, img.image_ref!)
  if (!image) return { status: "unsupported" }
  if (ctx.stopped?.()) return { status: "stopped" }
  const caption = captionOf(img, sectionBlocks)
  const result = await withMeteredAi<ImportExtractDiagramOutput>(
    { projectId, userId, stepId: `I-4:${section_id}` },
    ActionType.IMPORT_EXTRACT_DIAGRAM,
    {
      section_id,
      heading_text: heading?.heading_text ?? section_id,
      block_id: img.block_id,
      caption,
      schema_excerpt: schemaExcerptFor(DIAGRAM_TARGETS),
      // Ảnh không có chữ: phạm vi theo tiêu đề + chú thích + chữ của section; loại section trích luôn gửi (sơ đồ use case
      // ở 2.2.1 ⇒ các use case). Chỉ chữ prompt bị thu hẹp — ghép tên ở code vẫn dùng toàn bộ phần tử đã biết
      known_keys: knownKeysText(
        scopeKnownKeys([...known, ...items], {
          provisional: ownProvisional,
          section: [...items],
          text: [heading?.heading_text ?? "", caption, ...sectionBlocks.filter((b) => b.kind !== "image").map((b) => b.text)].join("\n"),
          mentions: sectionBlocks.flatMap((b) => b.mentions ?? []),
          // FLF-390: ảnh activity gắn vào use case đã có ⇒ model cần thấy mã use case kể cả ở mục chức năng
          always: [...ALWAYS_KNOWN, ...targets, "use_cases"]
        })
      )
    },
    { images: [image], notifyTopUp: ctx.notifyTopUp }
  )
  if (!result.ok) {
    // Môi trường không có vision (thiếu GEMINI_API_KEY / provider không nhận ảnh) ⇒ không dừng import vì ảnh: giữ ảnh
    // gốc như EMF (cờ vàng lúc finalize) — lỗi cấu hình, chạy lại cũng không khá hơn
    if (result.code && VISION_UNAVAILABLE.has(result.code)) return { status: "unsupported" }
    if (result.reason === "credits") return { status: "credits", failure: result }
    // AI đọc ảnh vẫn lỗi sau khi đã thử lại + model dự phòng (Gemini "high demand"…) ⇒ không dừng cả I-4 vì một ảnh: ảnh
    // gốc luôn được giữ (§4.13). FLF-360: lỗi tạm thời ⇒ `unavailable`, đọc lại sau khi chạy hết các mục; lỗi khác ⇒ thôi
    console.warn(`[I-4] ${section_id}: đọc ảnh ${img.block_id} lỗi (${result.message}) - giữ ảnh gốc, đi tiếp`)
    return { status: result.kind === "transient" ? "unavailable" : "failed" }
  }
  return { status: "read", data: result.data, usageId: result.usageId }
}

/**
 * Phần tử của một ảnh đã đọc: cấp mã / ghép tên với phần tử đã biết + của section, chiều quan hệ, chỉ phần mới; FLF-390:
 * chủ của sơ đồ tuần tự / activity (`owner_id`).
 */
export const diagramItems = (
  data: ImportExtractDiagramOutput,
  blockId: string,
  ctx: Pick<DiagramReadContext, "section_id" | "heading" | "known" | "items" | "alloc" | "sectionFunction">
): { kind: DiagramImageKind | "other"; items: EntityItem[]; owner_id?: string } => {
  const { section_id, heading, known, items, alloc } = ctx
  const sectionFunction = ctx.sectionFunction?.entity === "functions" ? ctx.sectionFunction : null
  const all = [...known, ...items]
  const knownIds = (entity: string) => new Set(all.filter((k) => k.entity === entity && k.id).map((k) => k.id as string))
  const knownFunctions = knownIds("functions")
  if (sectionFunction) knownFunctions.add(sectionFunction.id)
  const knownUseCases = knownIds("use_cases")
  const ownerEntity = OWNER_ENTITY[data.diagram_kind]
  const read =
    data.diagram_kind === "other"
      ? []
      : dropMutualRelations(
          orientRelations(
            visionItems(
              itemsFromAi(data, { sectionId: section_id, alloc, known: all, sectionFunction, validBlocks: new Set([blockId]), fromImage: true, sectionConfidence: heading?.confidence ?? null })
            ),
            all
          ),
          all
        )
          // FLF-390: hình không tạo chức năng mới; sơ đồ activity không tạo use case mới — chỉ thêm luồng cho phần tử đã có
          .filter((it) => it.entity !== "functions" || (it.id !== null && knownFunctions.has(it.id)))
          .filter((it) => data.diagram_kind !== "activity" || it.entity !== "use_cases" || (it.id !== null && knownUseCases.has(it.id)))
  // Sơ đồ gắn phần tử: chủ = phần tử nhận dữ liệu của hình; sơ đồ tuần tự trong mục function ⇒ function của mục (không có
  // chủ ⇒ không biết chủ, coi như hình khác)
  const owner = ownerEntity ? (read.find((it) => it.entity === ownerEntity)?.id ?? (ownerEntity === "functions" ? sectionFunction?.id : null) ?? null) : null
  const kind = !read.length || (ownerEntity && !owner) ? "other" : data.diagram_kind
  // Phần tử ảnh trùng phần tử đã có (chữ, bảng, ảnh trước) ⇒ chỉ giữ phần mới để bước 1.9 chỉ hỏi phần ảnh thêm vào (FLF-252)
  return { kind, items: onlyNewFromVision(read, all), ...(owner && kind !== "other" ? { owner_id: owner } : {}) }
}

export const readDiagramImage = async (img: BlockLite, ctx: DiagramReadContext): Promise<DiagramRead> => {
  const r = await callDiagramAi(img, ctx)
  // Không truyền `stopped` ở đây nên không có "stopped"; nếu có thì coi như ảnh chưa đọc được (đọc lại sau)
  if (r.status === "stopped") return { status: "unavailable" }
  if (r.status !== "read") return r
  return { status: "read", ...diagramItems(r.data, img.block_id, ctx), usageId: r.usageId }
}

/** FLF-360: chờ trước lượt đọc lại thứ `round` (0-based) — `IMPORT_AI_RETRY_BACKOFF_MS`, số phần tử = số lượt tối đa. */
export const importRetryBackoff = (): readonly number[] => env.IMPORT_AI_RETRY_BACKOFF_MS

/** FLF-392: số section gọi AI cùng lúc (`IMPORT_EXTRACT_CONCURRENCY`, 1 = mỗi lúc một section). */
export const extractConcurrency = (): number => env.IMPORT_EXTRACT_CONCURRENCY

/** Giãn cách đọc lại ±20% — N section lỗi cùng đợt quá tải không cùng thử lại một nhịp (FLF-392). */
const jitter = (ms: number): number => Math.round(ms * (0.8 + Math.random() * 0.4))

/** Nhịp kiểm tín hiệu dừng trong lúc chờ đọc lại — dừng không phải chờ hết giãn cách. */
const STOP_TICK_MS = 1_000

/**
 * Người dùng đã bấm Dừng (`paused: user`, đặt bởi request khác qua `requestStop`) — đọc lại từ DB vì `doc` trong bộ nhớ của
 * job không thấy. Có ⇒ chép `paused` vào `doc` để kết quả trả về đúng trạng thái dừng.
 */
export const userStopRequested = async (doc: IImportedDocument): Promise<boolean> => {
  const fresh = await ImportedDocument.findById(doc._id, { paused: 1 }).lean()
  if (fresh?.paused?.reason !== "user") return false
  doc.paused = fresh.paused
  return true
}

/** Nguồn id nháp cho known_keys lúc đọc: không cấp mã — phần tử AI mới không có id nên không vào prompt (FLF-392). */
const DRAFT_IDS: IdSource = { next: () => "", reserve: () => undefined }

/** Phần đã đọc của một section: phần tử chưa gộp, block giữ nguyên văn, ảnh, usage của lượt cuối đọc được. */
interface SectionState {
  items: EntityItem[]
  unmapped: string[]
  diagramImages: IExtractionDraft["diagram_images"]
  usageId: string | null
}

/** Ngữ cảnh tĩnh của một section — chung cho lúc đọc (gọi AI) và lúc ghép (replay). */
const sectionContext = (planned: PlannedSection, inputs: Pick<ExtractionInputs, "blocks" | "profile" | "provisional">) => {
  const { section_id } = planned
  const sectionBlocks = inputs.blocks.filter((b) => b.section_id === section_id)
  const sectionFunction = PROVISIONAL_SECTION.test(section_id) ? (inputs.provisional.get(section_id) ?? null) : null
  return {
    planned,
    section_id,
    sectionBlocks,
    heading: inputs.profile.heading_map.find((h) => h.section_id === section_id),
    targets: targetsOf(section_id),
    ownProvisional: provisionalScope(section_id, inputs.provisional),
    sectionFunction: sectionFunction?.entity === "functions" ? sectionFunction : null,
    mentionedRules: new Set(sectionBlocks.flatMap((b) => (b.mentions ?? []).filter((m) => m.entity === "business_rule").map((m) => idKey(m.id)))),
    /** Phần tử của chính section trước mọi lượt AI: feature / function tạm + phần đọc tất định. */
    own: [...provisionalItems(section_id, inputs.provisional), ...planned.settled.items]
  }
}
type SectionContext = ReturnType<typeof sectionContext>

/** Số lượt đầu đã xử lý sẵn vào `items` (bản ghi trước FLF-392) — các lượt sau nằm ở `raw_steps`. */
const preprocessedSteps = (progress: ExtractionProgress | null): number => (progress ? progress.steps_done - (progress.raw_steps?.length ?? 0) : 0)

/** Trạng thái đầu của section: phần tử của chính section + phần đã xử lý sẵn của bản ghi trước FLF-392. */
const initialState = (sc: SectionContext, progress: ExtractionProgress | null): SectionState => ({
  items: [...sc.own, ...(progress?.items ?? [])],
  // Bảng đặc tả use case đã đọc tất định nhưng Spine không chứa hết (luồng, tiền / hậu điều kiện) ⇒ giữ nguyên văn
  unmapped: progress?.unmapped_block_ids ? [...progress.unmapped_block_ids] : [...sc.planned.settled.verbatim],
  diagramImages: progress?.diagram_images ? [...progress.diagram_images] : [],
  usageId: progress?.usage_id ?? null
})

/**
 * Xử lý output một lượt AI vào phần đã đọc của section: cấp mã (`ids`), ghép tên với `known` + phần tử section đã có, lọc.
 * Cùng một hàm cho known_keys lúc đọc (`DRAFT_IDS`, known bản chụp) và lúc ghép (allocator thật, known theo thứ tự tài liệu)
 * ⇒ ghép replay đúng code xử lý của bản tuần tự.
 */
const applyRawStep = (state: SectionState, step: SectionAiStep, raw: RawAiStep, sc: SectionContext, ids: IdSource, known: readonly EntityItem[]): void => {
  if (raw.kind === "image") {
    if (raw.status !== "read") {
      state.diagramImages.push({ block_id: raw.block_id, kind: raw.status })
      return
    }
    const r = diagramItems(raw.data!, raw.block_id, { section_id: sc.section_id, heading: sc.heading, known, items: state.items, alloc: ids, sectionFunction: sc.sectionFunction })
    state.usageId = raw.usage_id ?? state.usageId
    state.diagramImages.push({ block_id: raw.block_id, kind: r.kind, ...(r.owner_id ? { owner_id: r.owner_id } : {}) })
    state.items.push(...r.items)
    return
  }
  const batch = step.kind === "text" ? step.batch : []
  state.usageId = raw.usage_id
  // Văn xuôi không trích được ⇒ finalize giữ nguyên văn làm phần nối của section (mode 1 v2 — FLF-184)
  const inBatch = new Set(batch.map((b) => b.block_id))
  state.unmapped.push(...raw.data.unmapped_block_ids.filter((id) => inBatch.has(id) && !state.unmapped.includes(id)))
  state.items.push(
    ...keepMentionedRules(
      itemsFromAi(raw.data, {
        sectionId: sc.section_id,
        alloc: ids,
        known: [...known, ...state.items],
        sectionFunction: sc.sectionFunction,
        validBlocks: inBatch,
        blockText: new Map(batch.map((b) => [b.block_id, b.text])),
        sectionConfidence: sc.heading?.confidence ?? null
      }),
      sc.mentionedRules
    )
  )
  state.unmapped.push(...tablesToKeepVerbatim(batch, state.items).filter((id) => !state.unmapped.includes(id)))
}

/** Số lần tự chạy tiếp trong một job khi ví được nạp trong lúc dừng vì hết credit (chặn vòng lặp). */
const TOPUP_RECHECKS = 3

/** Ví của org sở hữu dự án còn đủ cho ít nhất một lượt I-4 (lượt rẻ nhất) — cùng ví lượt gọi AI trừ. */
const walletCoversNextStep = async (projectId: string, userId: string): Promise<boolean> => {
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return false
  const [wallet, textCost, imageCost] = await Promise.all([
    getOrCreateWallet(userId, undefined, orgId),
    getActionCost(ActionType.IMPORT_EXTRACT_FIELDS),
    getActionCost(ActionType.IMPORT_EXTRACT_DIAGRAM)
  ])
  return wallet.balance - wallet.reserved >= Math.min(textCost, imageCost)
}

type ExtractionDraftDoc = IExtractionDraft & mongoose.Document

const isFailure = (r: RawAiStep | MeteredFailure): r is MeteredFailure => "ok" in r

/**
 * Chạy (hoặc chạy tiếp) I-4 cho import đang ở `extracting`. Trả trạng thái mới nhất kể cả khi dừng vì credit/lỗi AI.
 * FLF-392: tối đa `IMPORT_EXTRACT_CONCURRENCY` section gọi AI cùng lúc (lượt trong một section vẫn nối đuôi); output thô
 * của mỗi lượt lưu ở `ExtractionDraft.partial.raw_steps` ngay sau lượt đó. Section được **ghép** (replay cấp mã / ghép tên /
 * lọc, rồi `done`) nối tiếp theo thứ tự tài liệu khi mọi section đứng trước đã ghép ⇒ kết quả như chạy tuần tự. Dừng / hết
 * credit / AI lỗi ⇒ không lượt AI mới nào bắt đầu; chạy tiếp không gọi (và không trừ credit) lại lượt đã lưu.
 */
export const runExtraction = async (projectId: string, userId: string, importId: string): Promise<ExtractionRun> => {
  const started = Date.now()
  const stats = { calls: 0, notifiedTopUp: false }
  try {
    for (let rechecks = 0; ; rechecks++) {
      const run = await extractSections(projectId, userId, importId, stats)
      if (run.doc.paused?.reason !== "credits" || rechecks >= TOPUP_RECHECKS || !(await walletCoversNextStep(projectId, userId))) return run
      // `paused: credits` ghi ngay lúc lượt đầu hết credit, các section khác còn dừng dần — Lead nạp tiền trong lúc đó thì lượt
      // nạp gọi `startExtraction` khi job này còn chạy (bị bỏ qua) ⇒ ví đã đủ: tự chạy tiếp ngay, không chờ bấm Tiếp tục
      const cleared = await ImportedDocument.updateOne({ _id: run.doc._id, "paused.reason": "credits" }, { $set: { paused: null } })
      if (!cleared.modifiedCount) return run
    }
  } finally {
    // Đo thời gian I-4 riêng (FLF-392, docs/measurements.md)
    console.info(`[I-4] import ${importId}: ${stats.calls} lượt AI, ${Date.now() - started} ms, song song ${extractConcurrency()}`)
  }
}

const extractSections = async (projectId: string, userId: string, importId: string, stats: { calls: number; notifiedTopUp: boolean }): Promise<ExtractionRun> => {
  const doc = await requireImport(projectId, importId)
  assertImportStatus(doc, ["extracting"], "extracting")
  const inputs = await loadExtractionInputs(projectId)
  if (!inputs) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa đọc xong bố cục tài liệu", { status: doc.status, to: "extracting", allowed: [] })
  const { profile, blocks, provisional, plan } = inputs

  doc.paused = null
  await doc.save()
  for (const section_id of plan) {
    await ExtractionDraft.updateOne(
      { import_id: doc._id, section_id },
      { $setOnInsert: { projectId: doc.projectId, import_id: doc._id, section_id, status: "pending", fields: [], ops: [] } },
      { upsert: true }
    )
  }
  const drafts = await ExtractionDraft.find({ import_id: doc._id })
  const draftOf = new Map(drafts.map((d) => [d.section_id, d]))

  if (await isTemplateOnlyProject(projectId)) {
    for (const section_id of plan) {
      const draft = draftOf.get(section_id)!
      draft.fields = mergeItems(provisionalItems(section_id, provisional)).flatMap(flattenItem) as ExtractedField[]
      draft.status = "done"
      draft.error = null
      draft.unmapped_block_ids = []
      draft.diagram_images = []
      draft.partial = null
      draft.markModified("fields")
      await draft.save()
    }
    doc.extract_cursor = null
    await doc.save()
    await transitionImport(doc, "baselining")
    return { doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections }
  }

  const known: EntityItem[] = drafts.filter((d) => d.status === "done").flatMap(itemsOfDraft)
  for (const p of provisional.values()) known.push(...provisionalItems(p.section, provisional))
  const alloc = new IdAllocator()
  for (const k of known) if (k.id) alloc.reserve(k.entity, k.id)
  // FLF-252: giữ chỗ mọi mã tài liệu ghi (UC-01, BR-12…) trước khi cấp id mới — ảnh / chữ ở mục đứng trước không còn được
  // cấp trùng mã thật của bảng phía sau (rồi bị gộp nhầm thành một phần tử lúc finalize)
  for (const b of blocks) for (const m of b.mentions ?? []) if (MENTION_ARRAYS[m.entity]) alloc.reserve(MENTION_ARRAYS[m.entity]!, m.id)

  // FLF-252: phần đọc tất định (bảng, đặc tả "nhãn: giá trị") của mọi section chưa xong — chạy trước mọi lượt AI để ảnh /
  // chữ ở mục trước ghép được với phần tử của bảng phía sau (sơ đồ use case ở 2.2.1 ⇄ bảng use case ở 2.2.2)
  const pending = planPendingSections(plan, blocks, profile, provisional, new Set(drafts.filter((d) => d.status === "done").map((d) => d.section_id)))
  const settled = new Map(pending.map((p) => [p.section_id, p.settled]))
  // Mã bảng ghi giữ chỗ trước khi cấp mã cho phần tử không mã — không cấp "A01" rồi gặp "A-01" của bảng phía sau
  for (const found of settled.values()) for (const it of found.items) if (it.id) alloc.reserve(it.entity, it.id)
  for (const found of settled.values()) {
    for (const it of found.items) {
      // Không có mã: dùng lại id của phần tử cùng tên đã biết (vd chức năng 3.1.4 = function của heading 3.x.y)
      it.id ??= findKnownId([...known, ...found.items], it.entity, it.value.name ?? it.value.term) ?? alloc.next(it.entity)
      alloc.reserve(it.entity, it.id)
    }
    known.push(...found.items)
  }
  // Phần tử đã xử lý sẵn của bản ghi trước FLF-392 (section dừng giữa chừng) giữ chỗ id như khi chúng được cấp. Output thô
  // (`raw_steps`) không giữ chỗ trước: ghép replay cấp mã đúng thứ tự tài liệu
  for (const p of pending) {
    const d = draftOf.get(p.section_id)!
    if (stepsDoneOf(d, p) > 0) for (const it of d.partial!.items ?? []) if (it.id) alloc.reserve(it.entity, it.id)
  }

  // known_keys lúc đọc: bản chụp sau phần đọc tất định, chung cho mọi section đọc song song (không đổi trong lượt chạy)
  const view: readonly EntityItem[] = [...known]
  const stop: PoolStop = { aborted: false }
  const order = pending.map((p) => p.section_id)

  // `doc` (ImportedDocument) chỉ ghi qua một hàng đợi nối tiếp — nhiều section không `save()` cùng lúc (ParallelSaveError)
  let docQueue: Promise<void> = Promise.resolve()
  const writeDoc = (mutate: () => void): Promise<void> => {
    const write = docQueue.then(async () => {
      mutate()
      await doc.save()
    })
    docQueue = write.catch(() => undefined)
    return write
  }

  // FLF-360: section đang đọc lại lô chữ; FE thấy trạng thái của section đứng đầu theo thứ tự tài liệu
  const rereading = new Map<string, NonNullable<IImportedDocument["reread"]>>()
  const setRereadingOf = (section_id: string, state: IImportedDocument["reread"]): Promise<void> => {
    if (state) rereading.set(section_id, state)
    else if (!rereading.delete(section_id)) return Promise.resolve()
    const first = order.find((s) => rereading.has(s))
    return writeDoc(() => {
      doc.reread = first ? rereading.get(first)! : null
      doc.markModified("reread")
    })
  }

  /** Tín hiệu dừng chung: đã bật, hoặc người dùng vừa bấm Dừng (đọc DB). */
  const stopNow = async (): Promise<boolean> => {
    if (stop.aborted) return true
    if (await userStopRequested(doc)) stop.aborted = true
    return stop.aborted
  }
  /** Chờ đọc lại, bỏ ngang khi có tín hiệu dừng. `false` = đã dừng. */
  const waitOrStop = async (ms: number): Promise<boolean> => {
    for (let left = ms; left > 0; left -= STOP_TICK_MS) {
      await delay(Math.min(STOP_TICK_MS, left))
      if (await stopNow()) return false
    }
    return !(await stopNow())
  }

  // Hết credit / AI lỗi: ghi `paused` ngay (nạp tiền trong lúc các section khác dừng dần vẫn tự chạy tiếp) và có điều kiện —
  // `paused: user` đã có thì giữ; lỗi đầu tiên thắng. Hết credit ⇒ báo nạp đúng một lần
  let pauseWritten = false
  const pause = async (failure: MeteredFailure, sc: SectionContext, draft: ExtractionDraftDoc): Promise<void> => {
    stop.aborted = true
    if (!pauseWritten) {
      pauseWritten = true
      const res = await ImportedDocument.updateOne({ _id: doc._id, paused: null }, { $set: { paused: { reason: failure.reason, at: new Date() } } })
      if (res.modifiedCount && failure.reason === "credits" && !stats.notifiedTopUp) {
        stats.notifiedTopUp = true
        void notifyTopUpNeeded(projectId, `I-4:${sc.section_id}`)
      }
    }
    // Nói rõ mục nào — theo tiêu đề trong file, không in khoá section. Câu cho user (FLF-247); text thô của provider đã log
    // ở metered-ai
    draft.error = `Mục "${sc.heading?.heading_text?.trim() || capitalize(sectionLabel(sc.section_id))}": ${failure.userMessage}`.slice(0, 500)
    if (failure.reason === "resume_later") draft.status = "failed"
    await draft.save()
  }

  /**
   * Một lượt AI: ảnh diagram hoặc lô chữ. Trả output thô (đã parse schema, chưa cấp mã) hoặc lỗi credit / AI; `null` = có
   * tín hiệu dừng trong lúc tải ảnh, chưa gọi model.
   */
  const callStep = async (sc: SectionContext, step: SectionAiStep, state: SectionState): Promise<RawAiStep | MeteredFailure | null> => {
    const { section_id, heading, targets, ownProvisional } = sc
    if (step.kind === "image") {
      const r = await callDiagramAi(step.block, { projectId, userId, section_id, heading, sectionBlocks: sc.sectionBlocks, known: view, items: state.items, ownProvisional, targets, notifyTopUp: false, stopped: () => stop.aborted })
      if (r.status === "stopped") return null
      if (r.status !== "unsupported") stats.calls++
      if (r.status === "credits") return r.failure
      if (r.status === "read") return { kind: "image", block_id: step.block.block_id, status: "read", data: r.data, usage_id: r.usageId }
      return { kind: "image", block_id: step.block.block_id, status: r.status }
    }
    const text = blockLines(step.batch)
    stats.calls++
    const result = await withMeteredAi<ImportExtractOutput>(
      { projectId, userId, stepId: `I-4:${section_id}` },
      ActionType.IMPORT_EXTRACT_FIELDS,
      {
        section_id,
        heading_text: heading?.heading_text ?? section_id,
        target_entities: targets.join(", "),
        schema_excerpt: schemaExcerptFor(targets),
        // Chỉ phần tử lô này có thể nhắc tới (không còn cả tài liệu) — ghép mã / tên lúc ghép section vẫn dùng toàn bộ `known`
        known_keys: knownKeysText(
          scopeKnownKeys([...view, ...state.items], {
            provisional: ownProvisional,
            section: state.items,
            text: `${heading?.heading_text ?? ""}\n${text}`,
            mentions: step.batch.flatMap((b) => b.mentions ?? []),
            always: ALWAYS_KNOWN
          })
        ),
        blocks: text
      },
      { notifyTopUp: false }
    )
    return result.ok ? { kind: "text", data: result.data, usage_id: result.usageId } : result
  }

  /**
   * Đọc một section: các lượt còn lại nối đuôi (ảnh trước, rồi lô chữ), chỉ gọi AI và lưu output thô sau mỗi lượt. Trả tiến
   * độ đầy đủ để ghép; dừng / lỗi ⇒ `{ ok: false }` (tiến độ đã lưu, chạy tiếp bắt đầu đúng lượt chưa xong).
   */
  const readSection = async (planned: PlannedSection): Promise<PoolRead<ExtractionProgress | null>> => {
    const draft = draftOf.get(planned.section_id)!
    const sc = sectionContext(planned, inputs)
    let progress: ExtractionProgress | null = stepsDoneOf(draft, planned) > 0 ? (draft.partial as ExtractionProgress) : null
    const raw: RawAiStep[] = [...(progress?.raw_steps ?? [])]
    const base = preprocessedSteps(progress)
    // known_keys của lượt sau thấy phần tử section đã đọc tới giờ (chưa có mã: chỉ phần tử đã biết mới có id trong prompt)
    const state = initialState(sc, progress)
    for (const [j, r] of raw.entries()) applyRawStep(state, planned.steps[base + j], r, sc, DRAFT_IDS, view)

    // Người dùng bấm Dừng ⇒ không sang mục mới (mục đã xong giữ nguyên, chạy tiếp từ mục này)
    if (await stopNow()) return { ok: false }
    const first = base + raw.length
    for (let i = first; i < planned.steps.length; i++) {
      // Dừng giữa mục nhiều lượt: các lượt trước đã lưu ở `partial` ⇒ chạy tiếp bắt đầu đúng lượt này
      if (i > first && (await stopNow())) return { ok: false }
      const step = planned.steps[i]
      let res = await callStep(sc, step, state)
      if (res === null) return { ok: false }
      // FLF-360: lô chữ lỗi tạm thời (AI quá tải…) ⇒ đọc lại lô đó với giãn cách tăng dần, không dừng ngay; hết lượt mới
      // `resume_later`. Không bỏ qua lô chữ rồi đi tiếp. Có tín hiệu dừng ⇒ thôi đọc lại (lô này chạy tiếp lần sau)
      const backoff = importRetryBackoff()
      for (let round = 0; isFailure(res) && step.kind === "text" && res.kind === "transient" && round < backoff.length; round++) {
        await setRereadingOf(sc.section_id, { kind: "text", done: round + 1, total: backoff.length, section_id: sc.section_id })
        if (!(await waitOrStop(jitter(backoff[round])))) {
          await setRereadingOf(sc.section_id, null)
          return { ok: false }
        }
        // Chỉ lô chữ được đọc lại; `callStep` chỉ trả `null` cho lượt ảnh
        res = (await callStep(sc, step, state))!
      }
      await setRereadingOf(sc.section_id, null)
      if (isFailure(res)) {
        await pause(res, sc, draft)
        return { ok: false }
      }
      // Lưu như bản ghi DB (bỏ `undefined`) ⇒ ghép từ bộ nhớ hay từ DB (chạy tiếp) cho cùng kết quả
      const step_raw = JSON.parse(JSON.stringify(res)) as RawAiStep
      raw.push(step_raw)
      applyRawStep(state, step, step_raw, sc, DRAFT_IDS, view)
      // Lưu sau từng lượt đã trừ credit, kể cả lượt cuối (đọc xong mà chưa ghép): lần chạy tiếp không gọi lại lượt này
      progress = { ...(progress ?? {}), plan_hash: planned.plan_hash, steps_done: i + 1, raw_steps: raw }
      draft.partial = progress
      draft.markModified("partial")
      await draft.save()
    }
    return { ok: true, value: progress }
  }

  /** Ghép một section đã đọc xong (theo thứ tự tài liệu): replay output thô với allocator thật + phần tử đã biết ⇒ `done`. */
  const commitSection = async (planned: PlannedSection, progress: ExtractionProgress | null, index: number): Promise<void> => {
    const draft = draftOf.get(planned.section_id)!
    const sc = sectionContext(planned, inputs)
    const state = initialState(sc, progress)
    const base = preprocessedSteps(progress)
    for (const [j, r] of (progress?.raw_steps ?? []).entries()) applyRawStep(state, planned.steps[base + j], r, sc, alloc, known)

    const merged = mergeItems(state.items)
    // Chức năng trích ngay dưới một tính năng (FLF-252 — danh sách yêu cầu của mẫu IEEE) thuộc tính năng đó khi tài liệu không ghi
    const sectionFeature = provisional.get(planned.section_id)
    if (sectionFeature?.entity === "features") {
      for (const it of merged) if (it.entity === "functions" && it.value.feature_id === undefined) it.value.feature_id = sectionFeature.id
    }
    known.push(...merged)
    draft.fields = merged.flatMap(flattenItem) as ExtractedField[]
    draft.status = "done"
    draft.error = null
    draft.usage_id = state.usageId
    draft.unmapped_block_ids = state.unmapped
    draft.diagram_images = state.diagramImages
    draft.partial = null
    draft.markModified("fields")
    draft.markModified("partial")
    await draft.save()
    // Con trỏ = section đầu hàng chưa ghép (chạy tiếp / `markOrphanedExtraction` thấy đúng chỗ)
    if (pending[index + 1]) await writeDoc(() => (doc.extract_cursor = pending[index + 1].section_id))
  }

  const summary = async (): Promise<ExtractionRun> => ({ doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections })

  // Đặt con trỏ trước khi mở pool: FE / `markOrphanedExtraction` thấy "đã bắt đầu" ngay
  if (pending.length) await writeDoc(() => (doc.extract_cursor = pending[0].section_id))
  try {
    await runOrdered(pending, extractConcurrency(), { read: readSection, commit: (p, progress, i) => commitSection(p, progress, i), stop })
  } finally {
    await docQueue
  }
  if (stop.aborted) {
    // `paused` (user / credits / resume_later) đã ghi thẳng DB — chép vào `doc` để kết quả trả về đúng trạng thái dừng
    const fresh = await ImportedDocument.findById(doc._id, { paused: 1 }).lean()
    doc.paused = fresh?.paused ?? null
    return summary()
  }

  if (await userStopRequested(doc)) return summary()
  // FLF-360: ảnh AI chưa đọc được vì quá tải ⇒ đọc lại sau khi chạy hết các mục (đợt quá tải thường đã qua)
  const stopped = await rereadUnavailableImages({ projectId, userId, doc, blocks, profile, provisional, alloc, drafts: await ExtractionDraft.find({ import_id: doc._id }) })
  if (stopped) return stopped

  doc.extract_cursor = null
  await doc.save()
  // FLF-343: không dừng ở `fields_review` — field độ tin thấp vào baseline 0.1 kèm cờ "Cần xem" (finalize)
  await transitionImport(doc, "baselining")
  return summary()
}


// ─── FLF-360: đọc lại khi AI quá tải ─────────────────────────────

/** Trạng thái đọc lại cho FE (`GET /import` → `reread`) — nằm ở bản ghi import, không phải Spine. */
const setRereading = async (doc: IImportedDocument, state: IImportedDocument["reread"]): Promise<void> => {
  doc.reread = state
  doc.markModified("reread")
  await doc.save()
}

/** Ảnh AI chưa đọc được vì lỗi tạm thời, theo draft (section đã xong). */
export const unavailableImagesOf = (drafts: readonly Pick<IExtractionDraft, "section_id" | "status" | "diagram_images">[]): { section_id: string; block_id: string }[] =>
  drafts
    .filter((d) => d.status === "done")
    .flatMap((d) => (d.diagram_images ?? []).filter((i) => i.kind === "unavailable").map((i) => ({ section_id: d.section_id, block_id: i.block_id })))

/** Ngữ cảnh đọc lại ảnh của một section đã xong: phần tử đã biết = các section khác + feature / function tạm. */
export const rereadContextOf = (
  base: Pick<DiagramReadContext, "projectId" | "userId" | "alloc">,
  draft: Pick<IExtractionDraft, "section_id" | "fields">,
  drafts: readonly Pick<IExtractionDraft, "section_id" | "status" | "fields">[],
  inputs: { blocks: BlockLite[]; profile: Pick<ITemplateProfile, "heading_map">; provisional: Map<string, ProvisionalEntity> }
): DiagramReadContext => {
  const { section_id } = draft
  const known = drafts.filter((d) => d.section_id !== section_id && d.status === "done").flatMap(itemsOfDraft)
  for (const p of inputs.provisional.values()) known.push(...provisionalItems(p.section, inputs.provisional))
  return {
    ...base,
    section_id,
    heading: inputs.profile.heading_map.find((h) => h.section_id === section_id),
    sectionBlocks: inputs.blocks.filter((b) => b.section_id === section_id),
    known,
    items: itemsOfDraft(draft),
    ownProvisional: provisionalScope(section_id, inputs.provisional),
    targets: targetsOf(section_id),
    sectionFunction: PROVISIONAL_SECTION.test(section_id) ? (inputs.provisional.get(section_id) ?? null) : null
  }
}

/** Gộp kết quả đọc lại một ảnh vào draft: loại ảnh thật; đọc được ⇒ phần tử mới vào field như lần đọc đầu. */
export const applyRereadToDraft = (draft: IExtractionDraft & mongoose.Document, block_id: string, r: Exclude<DiagramRead, { status: "credits" }>, ctx: DiagramReadContext): void => {
  draft.diagram_images = (draft.diagram_images ?? []).map((i) =>
    i.block_id === block_id ? { block_id, kind: r.status === "read" ? r.kind : r.status, ...(r.status === "read" && r.owner_id ? { owner_id: r.owner_id } : {}) } : i
  )
  draft.markModified("diagram_images")
  if (r.status !== "read") return
  for (const it of r.items) if (it.id) ctx.alloc.reserve(it.entity, it.id)
  draft.fields = mergeItems([...ctx.items, ...r.items]).flatMap(flattenItem) as ExtractedField[]
  draft.usage_id ??= r.usageId
  draft.markModified("fields")
}

/**
 * Đọc lại các ảnh `unavailable` (FLF-360): tối đa `IMPORT_AI_RETRY_BACKOFF_MS.length` đợt, chờ tăng dần trước mỗi đợt.
 * Đọc được ⇒ gộp vào draft của section như lần đọc đầu (`known_keys`, ghép tên, quan hệ; chỉ phần mới so với đã biết) và
 * `diagram_images.kind` thành loại thật (finalize ẩn PlantUML cùng loại). Ảnh `unsupported` / lỗi không tự khỏi không đọc
 * lại. Hết credit ⇒ dừng `paused: credits` (chạy tiếp vào lại bước này). Trả `ExtractionRun` khi dừng, `null` khi đi tiếp.
 */
const rereadUnavailableImages = async (args: {
  projectId: string
  userId: string
  doc: IImportedDocument
  blocks: BlockLite[]
  profile: ITemplateProfile
  provisional: Map<string, ProvisionalEntity>
  alloc: IdAllocator
  drafts: (IExtractionDraft & mongoose.Document)[]
}): Promise<ExtractionRun | null> => {
  const { projectId, userId, doc, blocks, profile, provisional, alloc, drafts } = args
  const backoff = importRetryBackoff()
  const total = unavailableImagesOf(drafts).length
  if (!total || !backoff.length) return null
  let done = 0
  for (let round = 0; round < backoff.length; round++) {
    const pending = unavailableImagesOf(drafts)
    if (!pending.length) break
    await setRereading(doc, { kind: "images", done, total, section_id: pending[0].section_id })
    await delay(backoff[round])
    for (const { section_id, block_id } of pending) {
      const draft = drafts.find((d) => d.section_id === section_id)!
      const img = blocks.find((b) => b.block_id === block_id)
      if (!img?.image_ref) continue
      doc.extract_cursor = section_id
      await setRereading(doc, { kind: "images", done, total, section_id })
      const ctx = rereadContextOf({ projectId, userId, alloc }, draft, drafts, { blocks, profile, provisional })
      const r = await readDiagramImage(img, ctx)
      if (r.status === "credits") {
        doc.paused = { reason: "credits", at: new Date() }
        await setRereading(doc, null)
        return { doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections }
      }
      if (r.status === "unavailable") continue
      // Đọc được (hoặc lần này lỗi không tự khỏi ⇒ thôi đọc lại): cập nhật loại ảnh; dữ liệu mới vào draft như lần đọc đầu
      applyRereadToDraft(draft, block_id, r, ctx)
      await draft.save()
      done++
    }
  }
  await setRereading(doc, null)
  return null
}

// ─── ước tính credit trước khi trích ─────────────────────────────

/** Số lượt AI + credit I-4 còn phải chạy (`GET /import` → `credit_estimate`). */
export interface ExtractionEstimate {
  text_batches: number
  diagram_images: number
  ai_calls: number
  credits: number
}

/**
 * Ước tính từ CHÍNH kế hoạch của lượt chạy (`planPendingSections`): lô chữ sau phần đọc tất định + ảnh qua `readsImage`
 * mở được (PNG/JPEG), trừ section đã xong và các lượt đã xong của section dừng giữa chừng. Giá theo bảng giá hiện hành
 * (`getActionCost`). Là cận trên: retry trong một lượt không tính thêm (chỉ trừ một lần), môi trường không có vision thì ảnh
 * không gọi AI. Chưa có template profile ⇒ `null`.
 */
export const estimateExtraction = async (projectId: string, doc: Pick<IImportedDocument, "_id">): Promise<ExtractionEstimate | null> => {
  const inputs = await loadExtractionInputs(projectId)
  if (!inputs) return null
  // FLF-378: dự án mới theo mẫu bắt buộc không trích (không gọi AI)
  if (await isTemplateOnlyProject(projectId)) return { text_batches: 0, diagram_images: 0, ai_calls: 0, credits: 0 }
  const drafts = await ExtractionDraft.find({ import_id: doc._id }, { section_id: 1, status: 1, partial: 1, diagram_images: 1 }).lean<
    Pick<IExtractionDraft, "section_id" | "status" | "partial" | "diagram_images">[]
  >()
  const draftOf = new Map(drafts.map((d) => [d.section_id, d]))
  const done = new Set(drafts.filter((d) => d.status === "done").map((d) => d.section_id))
  let text = 0
  let images = 0
  for (const planned of planPendingSections(inputs.plan, inputs.blocks, inputs.profile, inputs.provisional, done)) {
    for (const step of planned.steps.slice(stepsDoneOf(draftOf.get(planned.section_id), planned))) {
      if (step.kind === "text") text++
      else if (await loadImportImage(projectId, step.block.image_ref!)) images++
    }
  }
  // FLF-360: ảnh của section đã xong mà AI chưa đọc được (quá tải) sẽ được đọc lại ⇒ tính vào. Lượt đọc lại lỗi được hoàn
  // credit (`executeAiAction`), nên mỗi ảnh / lô chữ trừ tối đa một lần dù đọc lại mấy lượt ⇒ đây vẫn là mức tối đa.
  images += unavailableImagesOf(drafts).length
  const [textCost, imageCost] = await Promise.all([getActionCost(ActionType.IMPORT_EXTRACT_FIELDS), getActionCost(ActionType.IMPORT_EXTRACT_DIAGRAM)])
  return { text_batches: text, diagram_images: images, ai_calls: text + images, credits: text * textCost + images * imageCost }
}

/**
 * `credit_estimate` của `GET /import` — FLF-343: màn báo credit **một lần** sau upload (`extracting` chưa chạy, hoặc đang dừng;
 * bản ghi cũ ở `mapping_review`; caller kiểm job nền). Gồm I-4 còn lại + bước kiểm tra AI (1.11) chạy nối tiếp sau baseline
 * 0.1 (`estimateCheckCalls`) ⇒ cả lượt một mạch tốn tối đa chừng này credit. `withBalance` (Lead / Analyst — cùng quyền xem
 * `/billing/balance`) ⇒ kèm số credit khả dụng của ví org sở hữu project (cùng ví lượt gọi AI trừ, `resolveWalletOrg`).
 */
export const creditEstimateFor = async (
  projectId: string,
  userId: string,
  doc: Pick<IImportedDocument, "_id" | "status">,
  opts: { withBalance: boolean }
): Promise<(ExtractionEstimate & { check_calls: number; available_credits: number | null }) | null> => {
  if (doc.status !== "mapping_review" && doc.status !== "extracting") return null
  const extraction = await estimateExtraction(projectId, doc)
  if (!extraction) return null
  // Import động: check.service dùng `chunkBlocks` của file này
  const { estimateCheckCalls } = await import("./check.service.js")
  const check = await estimateCheckCalls(projectId)
  const estimate = { ...extraction, check_calls: check.calls, ai_calls: extraction.ai_calls + check.calls, credits: extraction.credits + check.credits }
  if (!opts.withBalance) return { ...estimate, available_credits: null }
  const orgId = await resolveWalletOrg(projectId)
  if (!orgId) return { ...estimate, available_credits: null }
  const wallet = await getOrCreateWallet(userId, undefined, orgId)
  return { ...estimate, available_credits: wallet.balance - wallet.reserved }
}

// ─── 1.9 xác nhận field (chỉ bản ghi cũ đang `fields_review`, trước FLF-343) ─────────

export const patchFields = async (projectId: string, body: FieldsPatchRequest): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, body.import_id)
  assertImportStatus(doc, ["fields_review"], "baselining")
  const drafts = await ExtractionDraft.find({ import_id: doc._id })
  for (const f of body.fields) {
    const draft = drafts.find((d) => d.section_id === f.section_id)
    const idx = draft?.fields.findIndex((x) => x.path === f.path) ?? -1
    if (!draft || idx < 0) {
      throw new Mode1Error("IMPORT_INVALID_STATE", `Không có dữ liệu "${pathLabel(f.path)}" ở mục đã chọn`, { status: doc.status, to: "baselining", allowed: [] })
    }
    if (!f.confirmed) draft.fields.splice(idx, 1)
    else {
      draft.fields[idx].confirmed = true
      if (f.edited_value !== undefined) draft.fields[idx].edited_value = f.edited_value
    }
    draft.markModified("fields")
  }
  if (body.confirm_all) {
    for (const d of drafts) {
      for (const f of d.fields) f.confirmed = true
      d.markModified("fields")
    }
  }
  await Promise.all(drafts.map((d) => d.save()))
  if (!needsReview(drafts)) await transitionImport(doc, "baselining")
  return doc
}
