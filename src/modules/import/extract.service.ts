/**
 * I-4 trích field Spine (nút 1.8) + xác nhận field (1.9, UC-22). FLF-171, plan §6 2C.
 * Theo từng section đã map, theo thứ tự tài liệu:
 *   1. Bảng khớp đủ cột (template profile) ⇒ trích tất định, không tốn credit (G7).
 *   2. Feature/function của §3.2+ ⇒ tên + quan hệ lấy từ heading (tất định).
 *   3. Phần chữ còn lại ⇒ `IMPORT_EXTRACT_FIELDS` (chỉ text block, G6) qua `withMeteredAi`.
 *   4. Lưu `ExtractionDraft`; field độ tin < 0.7 ⇒ `fields_review`.
 * Hết credit / AI lỗi sau retry ⇒ `paused`, giữ `extract_cursor`; chạy tiếp bỏ qua section đã `done`.
 * Chưa ghi Spine: finalize áp mọi field đã xác nhận trong một transaction.
 */

import type mongoose from "mongoose"
import { ActionType } from "../../shared/ai/ai-action.types.js"
import type { ImportExtractDiagramOutput, ImportExtractOutput } from "../../shared/ai/response-parser.js"
import { loadImportImage } from "../render/import-media.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { DocBlock, type IDocBlock } from "./doc-block.model.js"
import { DIAGRAM_SECTIONS, DIAGRAM_TARGETS, NFR_CATEGORY_BY_SECTION, isExtractableSection, schemaExcerptFor, targetsOf } from "./extract-targets.js"
import {
  IdAllocator,
  REF_LIST_FIELDS,
  aiItemId,
  compactKey,
  findKnownId,
  findKnownKey,
  flattenItem,
  mergeFieldValue,
  normalizeKey,
  parseFieldPath,
  resolveProvisional,
  type EntityItem,
  type ProvisionalEntity
} from "./extracted-entities.js"
import { ExtractionDraft, type ExtractedField, type IExtractionDraft } from "./extraction-draft.model.js"
import { VISION_CONFIDENCE_CAP, needsConfirm, type FieldOrigin, type MentionEntity } from "./import.constants.js"
import type { FieldsPatchRequest, GetImportResponse } from "./import.dto.js"
import { assertImportStatus, extractionSummary, requireImport, transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { withMeteredAi } from "./metered-ai.js"
import { Mode1Error } from "./mode1.errors.js"
import { capitalize, pathLabel, sectionLabel } from "../spine/human-labels.js"
import { PROVISIONAL_SECTION } from "./section-catalog.js"
import { TABLE_ENTITIES, hasRequiredFields } from "./table-header-dictionary.js"
import { tableRows, tableText } from "./table-rows.js"
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
    const items = deterministicTableItems(t, rows, profile)
    if (items) {
      // NFR của bảng nhận nhóm theo mục như NFR AI trích (bảng External Systems ở 4.1 ⇒ interface, không còn "other")
      for (const it of items) if (it.entity === "nfrs" && it.value.category === undefined && NFR_CATEGORY_BY_SECTION[sectionId]) it.value.category = NFR_CATEGORY_BY_SECTION[sectionId]
      out.handled.add(t.block_id)
      out.items.push(...items)
      continue
    }
    if (!targets.includes("use_cases")) continue
    const uc = useCaseSpecValue(readSpecLines([{ ...t, rows }], USE_CASE_LABELS).values)
    if (!uc) continue
    out.handled.add(t.block_id)
    out.verbatim.add(t.block_id)
    out.items.push({
      entity: "use_cases",
      id: uc.key ? normalizeKey(uc.key) : null,
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

/**
 * Ma trận phân quyền (FLF-252): mỗi cột vai trò ⇒ một vai trò (tên = tiêu đề cột), mỗi ô đánh dấu ⇒ một quyền
 * màn hình × vai trò × thao tác ("X"/"✓" ⇒ `access`, "view, create" ⇒ hai quyền). Tên màn / vai trò phân giải lúc dựng op.
 */
const matrixItems = (table: BlockLite, grid: string[][], shape: TableShape, cols: TableMapEntry[], confidence: number): EntityItem[] | null => {
  const screenCol = cols.find((c) => c.field_path === "permissions[].screen_id")?.column_index
  const roleCols = cols.filter((c) => c.field_path === "permissions[].role_id" && shape.headers[c.column_index]).map((c) => c.column_index)
  if (screenCol === undefined || !roleCols.length) return null
  const base = { id: null, confidence, field_confidence: {}, source_block_ids: [table.block_id], origin: "deterministic" as const }
  const roles = roleCols.map((c) => ({ ...base, entity: "roles", value: { name: shape.headers[c], actor_id: shape.headers[c] } }))
  const permissions = shape.body.flatMap((r) => {
    const screen = (grid[r][screenCol] ?? "").trim()
    if (!screen) return []
    return roleCols.flatMap((c) =>
      markActions(grid[r][c] ?? "").map((action) => ({ ...base, entity: "permissions", value: { screen_id: screen, role_id: shape.headers[c], action } }))
    )
  })
  return [...roles, ...permissions]
}

/**
 * Bảng có mapping đủ field bắt buộc ⇒ item theo từng hàng dữ liệu; không đủ ⇒ `null` (để AI trích). Đọc theo hình dạng
 * bảng (FLF-252): hàng tiêu đề thật (bỏ hàng tên bảng), hàng nhóm không thành phần tử (nhãn nhóm làm feature của màn).
 */
export const deterministicTableItems = (table: BlockLite, grid: string[][], profile: ITemplateProfile): EntityItem[] | null => {
  const cols = profile.table_map.filter((t) => t.block_id === table.block_id && t.field_path)
  const shape = tableShape(grid)
  if (!cols.length || !shape.body.length) return null
  const entity = cols[0].field_path!.split("[")[0]
  const confidence = Math.min(...cols.map((c) => (c.confirmed ? 1 : c.confidence)))
  if (entity === "permissions") return matrixItems(table, grid, shape, cols, confidence)
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
    const value: Record<string, unknown> = {}
    for (const [col, field] of fields) {
      let cell: string | undefined = grid[r][col]?.trim()
      if (!cell && FILL_DOWN_FIELDS.has(field)) cell = above.get(field)
      if (!cell) continue
      if (FILL_DOWN_FIELDS.has(field)) above.set(field, cell)
      value[field] = LIST_FIELDS.has(field) ? splitList(cell, field !== "goals") : cell
    }
    const label = labelCol === undefined ? "" : (grid[r][labelCol] ?? "").trim()
    if (label && typeof value.statement === "string" && !value.statement.toLowerCase().startsWith(label.toLowerCase())) value.statement = `${label}: ${value.statement}`
    if (!Object.keys(value).length) return []
    const group = groupOf(shape, r)
    if (entity === "screens" && value.feature_id === undefined && group) value.feature_id = group
    // Bảng yêu cầu "ID | Requirement" không có cột tên ⇒ tên chức năng là phần đầu câu yêu cầu (mô tả giữ đủ câu)
    if (entity === "functions" && value.name === undefined && typeof value.description === "string") value.name = shortName(value.description)
    const key = typeof value.id === "string" ? normalizeKey(value.id) : null
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

const knownKeysText = (items: EntityItem[]): string => {
  const byEntity = new Map<string, string[]>()
  for (const it of items) {
    if (!it.id) continue
    const name = typeof it.value.name === "string" ? ` (${it.value.name})` : ""
    byEntity.set(it.entity, [...(byEntity.get(it.entity) ?? []), `${it.id}${name}`])
  }
  return [...byEntity].map(([e, ids]) => `${e}: ${[...new Set(ids)].join(", ")}`).join("\n") || "(none yet)"
}

/**
 * Đổi output model sang item: id theo mã / tên phần tử đã biết (`aiItemId`), ép id function của section function.
 * `fromImage`: item đọc từ ảnh diagram — tên trùng phần tử đã biết thắng khoá model đặt.
 */
export const itemsFromAi = (
  out: ImportExtractOutput,
  ctx: { sectionId: string; alloc: IdAllocator; known: EntityItem[]; sectionFunction: ProvisionalEntity | null; validBlocks: Set<string>; fromImage?: boolean }
): EntityItem[] => {
  let functionUsed = false
  return out.items.map((raw) => {
    const value = { ...raw.value }
    delete value.id
    let id: string | null = null
    if (raw.entity !== "project") {
      if (raw.entity === "functions" && ctx.sectionFunction && !functionUsed) {
        id = ctx.sectionFunction.id
        functionUsed = true
      } else {
        id = aiItemId(ctx.known, raw.entity, raw.key, value.name ?? value.term, ctx.fromImage) ?? ctx.alloc.next(raw.entity)
        ctx.alloc.reserve(raw.entity, id)
      }
    }
    if (raw.entity === "nfrs" && NFR_CATEGORY_BY_SECTION[ctx.sectionId] && value.category === undefined) value.category = NFR_CATEGORY_BY_SECTION[ctx.sectionId]
    const sources = raw.source_block_ids.filter((b) => ctx.validBlocks.has(b))
    return {
      entity: raw.entity,
      id,
      value,
      confidence: raw.confidence,
      field_confidence: raw.field_confidence ?? {},
      source_block_ids: sources.length ? sources : [...ctx.validBlocks].slice(0, 1),
      origin: "ai" as const
    }
  })
}

// ─── ảnh diagram (mode 1 v3 phase 5) ─────────────────────────────

/** Mã lỗi cho biết môi trường không đọc được ảnh (không phải lỗi tạm thời) ⇒ bỏ qua ảnh thay vì dừng I-4. */
const VISION_UNAVAILABLE: ReadonlySet<string> = new Set(["GEMINI_KEY_MISSING", "AI_PROVIDER_NO_VISION"])

/** Chú thích của ảnh: block caption ngay sau (hoặc ngay trước) ảnh trong section. */
export const captionOf = (img: Pick<BlockLite, "block_id">, sectionBlocks: Pick<BlockLite, "block_id" | "kind" | "text">[]): string => {
  const i = sectionBlocks.findIndex((b) => b.block_id === img.block_id)
  const near = [sectionBlocks[i + 1], sectionBlocks[i - 1]].find((b) => b?.kind === "caption" && b.text.trim())
  return near?.text.trim() ?? "(none)"
}

/** Caption chỉ hình là sơ đồ đọc được (use case, ngữ cảnh, ERD / class, luồng màn). */
const DIAGRAM_CAPTION = /(use[\s-]?case|context|erd|entity[\s-]?relationship|class diagram|data model|screens?[\s-]?flow|navigation|sơ đồ|biểu đồ|diagram)/i
/** Caption chỉ hình không phải 4 loại sơ đồ đọc được (ảnh màn hình, wireframe, sequence / activity…) — đọc chỉ tốn credit. */
const NOT_DIAGRAM_CAPTION = /(layout|screenshot|screen shot|mock-?up|wireframe|prototype|giao diện|sequence|activity|state machine|deployment|component|workflow)/i

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

/**
 * Chạy (hoặc chạy tiếp) I-4 cho import đang ở `extracting`. Trả trạng thái mới nhất kể cả khi dừng vì credit/lỗi AI.
 */
export const runExtraction = async (projectId: string, userId: string, importId: string): Promise<ExtractionRun> => {
  const doc = await requireImport(projectId, importId)
  assertImportStatus(doc, ["extracting"], "extracting")
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa đọc xong bố cục tài liệu", { status: doc.status, to: "extracting", allowed: [] })
  const blocks = await DocBlock.find({ projectId, doc_version: IMPORTED_DOC_VERSION }).sort({ "anchor.ordinal": 1 }).lean<BlockLite[]>()
  const provisional = resolveProvisional(profile.heading_map)
  const plan = extractionPlan(blocks)

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

  const known: EntityItem[] = drafts.filter((d) => d.status === "done").flatMap(itemsOfDraft)
  for (const p of provisional.values()) known.push(...provisionalItems(p.section, provisional))
  const alloc = new IdAllocator()
  for (const k of known) if (k.id) alloc.reserve(k.entity, k.id)
  // FLF-252: giữ chỗ mọi mã tài liệu ghi (UC-01, BR-12…) trước khi cấp id mới — ảnh / chữ ở mục đứng trước không còn được
  // cấp trùng mã thật của bảng phía sau (rồi bị gộp nhầm thành một phần tử lúc finalize)
  for (const b of blocks) for (const m of b.mentions ?? []) if (MENTION_ARRAYS[m.entity]) alloc.reserve(MENTION_ARRAYS[m.entity]!, m.id)

  // FLF-252: phần đọc tất định (bảng, đặc tả "nhãn: giá trị") của mọi section chưa xong — chạy trước mọi lượt AI để ảnh /
  // chữ ở mục trước ghép được với phần tử của bảng phía sau (sơ đồ use case ở 2.2.1 ⇄ bảng use case ở 2.2.2)
  const settled = new Map<string, Settled>()
  for (const section_id of plan) {
    if (draftOf.get(section_id)!.status === "done") continue
    settled.set(section_id, settleSection(section_id, blocks, profile, provisional))
  }
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

  for (const section_id of plan) {
    const draft = draftOf.get(section_id)!
    if (draft.status === "done") continue
    doc.extract_cursor = section_id
    await doc.save()

    const sectionBlocks = blocks.filter((b) => b.section_id === section_id)
    const { items: settledItems, handled: handledTables, consumed, verbatim } = settled.get(section_id) ?? EMPTY_SETTLED
    const items: EntityItem[] = [...provisionalItems(section_id, provisional), ...settledItems]

    const tablePrefixes = sectionBlocks.filter((b) => b.kind === "table").map((b) => `${b.anchor.xml_path}/`)
    const aiBlocks = sectionBlocks
      .filter(
        (b) =>
          b.kind !== "heading" &&
          b.text.trim() &&
          !handledTables.has(b.block_id) &&
          !consumed.has(b.block_id) &&
          !(b.kind === "table_cell" && tablePrefixes.some((prefix) => b.anchor.xml_path.startsWith(prefix)))
      )
      // Bảng gửi AI theo ô thật (FLF-251) — tách `text` theo dòng làm ô nhiều dòng thành nhiều hàng
      .map((b) => (b.kind === "table" ? { ...b, text: tableText(tableRows(b, blocks)) } : b))
    const targets = targetsOf(section_id)
    let usageId: string | null = null
    // Bảng đặc tả use case đã đọc tất định nhưng Spine không chứa hết (luồng, tiền / hậu điều kiện) ⇒ giữ nguyên văn
    const unmapped: string[] = [...verbatim]
    const heading = profile.heading_map.find((h) => h.section_id === section_id)
    const sectionFunction = PROVISIONAL_SECTION.test(section_id) ? (provisional.get(section_id) ?? null) : null
    const pause = async (result: { reason: "credits" | "resume_later"; userMessage: string }): Promise<ExtractionRun> => {
      doc.paused = { reason: result.reason, at: new Date() }
      await doc.save()
      // Nói rõ mục nào — theo tiêu đề trong file, không in khoá section. Câu cho user (FLF-247); text thô của provider
      // đã log ở metered-ai
      draft.error = `Mục "${heading?.heading_text?.trim() || capitalize(sectionLabel(section_id))}": ${result.userMessage}`.slice(0, 500)
      if (result.reason === "resume_later") draft.status = "failed"
      await draft.save()
      return { doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections }
    }

    // Phase 5: ảnh diagram của section (sau bảng tất định, trước lô chữ) ⇒ Gemini đọc từng ảnh; thực thể đọc được vào
    // known_keys để lô chữ dùng lại khoá. EMF/WMF / file gốc không còn ⇒ `unsupported` (không gọi AI, giữ ảnh gốc).
    const diagramImages: IExtractionDraft["diagram_images"] = []
    for (const img of sectionBlocks.filter((b) => b.kind === "image" && b.image_ref && readsImage(section_id, captionOf(b, sectionBlocks)))) {
      const image = await loadImportImage(projectId, img.image_ref!)
      if (!image) {
        diagramImages.push({ block_id: img.block_id, kind: "unsupported" })
        continue
      }
      const result = await withMeteredAi<ImportExtractDiagramOutput>(
        { projectId, userId, stepId: `I-4:${section_id}` },
        ActionType.IMPORT_EXTRACT_DIAGRAM,
        {
          section_id,
          heading_text: heading?.heading_text ?? section_id,
          block_id: img.block_id,
          caption: captionOf(img, sectionBlocks),
          schema_excerpt: schemaExcerptFor(DIAGRAM_TARGETS),
          known_keys: knownKeysText([...known, ...items])
        },
        { images: [image] }
      )
      // Môi trường không có vision (thiếu GEMINI_API_KEY / provider không nhận ảnh) ⇒ không dừng import vì ảnh: giữ ảnh
      // gốc như EMF (cờ vàng lúc finalize) — lỗi cấu hình, chạy lại cũng không khá hơn
      if (!result.ok && result.code && VISION_UNAVAILABLE.has(result.code)) {
        diagramImages.push({ block_id: img.block_id, kind: "unsupported" })
        continue
      }
      // AI đọc ảnh vẫn lỗi sau khi đã thử lại + model dự phòng (Gemini "high demand"…) ⇒ không dừng cả I-4 vì một ảnh:
      // ảnh gốc luôn được giữ (§4.13), chỉ thiếu dữ liệu đọc từ ảnh — cờ vàng báo lúc finalize. Hết credit vẫn dừng.
      if (!result.ok && result.reason !== "credits") {
        console.warn(`[I-4] ${section_id}: đọc ảnh ${img.block_id} lỗi (${result.message}) — giữ ảnh gốc, đi tiếp`)
        diagramImages.push({ block_id: img.block_id, kind: "unavailable" })
        continue
      }
      if (!result.ok) return pause(result)
      usageId = result.usageId
      const read =
        result.data.diagram_kind === "other"
          ? []
          : visionItems(
              itemsFromAi(result.data, { sectionId: section_id, alloc, known: [...known, ...items], sectionFunction: null, validBlocks: new Set([img.block_id]), fromImage: true })
            )
      diagramImages.push({ block_id: img.block_id, kind: read.length ? result.data.diagram_kind : "other" })
      // Phần tử ảnh trùng phần tử đã có (chữ, bảng, ảnh trước) ⇒ chỉ giữ phần mới để bước 1.9 chỉ hỏi phần ảnh thêm vào (FLF-252)
      items.push(...onlyNewFromVision(read, [...known, ...items]))
    }

    for (const batch of targets.length ? chunkBlocks(aiBlocks) : []) {
      const result = await withMeteredAi<ImportExtractOutput>({ projectId, userId, stepId: `I-4:${section_id}` }, ActionType.IMPORT_EXTRACT_FIELDS, {
        section_id,
        heading_text: heading?.heading_text ?? section_id,
        target_entities: targets.join(", "),
        schema_excerpt: schemaExcerptFor(targets),
        known_keys: knownKeysText([...known, ...items]),
        blocks: blockLines(batch)
      })
      if (!result.ok) return pause(result)
      usageId = result.usageId
      // Văn xuôi không trích được ⇒ finalize giữ nguyên văn làm phần nối của section (mode 1 v2 — FLF-184)
      const inBatch = new Set(batch.map((b) => b.block_id))
      unmapped.push(...result.data.unmapped_block_ids.filter((id) => inBatch.has(id) && !unmapped.includes(id)))
      items.push(
        ...itemsFromAi(result.data, {
          sectionId: section_id,
          alloc,
          known: [...known, ...items],
          sectionFunction: sectionFunction?.entity === "functions" ? sectionFunction : null,
          validBlocks: new Set(batch.map((b) => b.block_id))
        })
      )
    }

    const merged = mergeItems(items)
    // Chức năng trích ngay dưới một tính năng (FLF-252 — danh sách yêu cầu của mẫu IEEE) thuộc tính năng đó khi tài liệu không ghi
    const sectionFeature = provisional.get(section_id)
    if (sectionFeature?.entity === "features") {
      for (const it of merged) if (it.entity === "functions" && it.value.feature_id === undefined) it.value.feature_id = sectionFeature.id
    }
    known.push(...merged)
    draft.fields = merged.flatMap(flattenItem) as ExtractedField[]
    draft.status = "done"
    draft.error = null
    draft.usage_id = usageId
    draft.unmapped_block_ids = unmapped
    draft.diagram_images = diagramImages
    draft.markModified("fields")
    await draft.save()
  }

  doc.extract_cursor = null
  await doc.save()
  const finalDrafts = await ExtractionDraft.find({ import_id: doc._id })
  await transitionImport(doc, needsReview(finalDrafts) ? "fields_review" : "baselining")
  return { doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections }
}




// ─── 1.9 xác nhận field ─────────────────────────────────────────

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
