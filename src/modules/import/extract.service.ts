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
import type { ImportExtractOutput } from "../../shared/ai/response-parser.js"
import { IMPORTED_DOC_VERSION } from "../doc-version/versioning.js"
import { DocBlock, type IDocBlock } from "./doc-block.model.js"
import { NFR_CATEGORY_BY_SECTION, isExtractableSection, schemaExcerptFor, targetsOf } from "./extract-targets.js"
import {
  IdAllocator,
  flattenItem,
  normalizeKey,
  parseFieldPath,
  resolveProvisional,
  type EntityItem,
  type ProvisionalEntity
} from "./extracted-entities.js"
import { ExtractionDraft, type ExtractedField, type IExtractionDraft } from "./extraction-draft.model.js"
import { FIELD_CONFIDENCE_THRESHOLD } from "./import.constants.js"
import type { FieldsPatchRequest, GetImportResponse } from "./import.dto.js"
import { assertImportStatus, extractionSummary, requireImport, transitionImport } from "./import.service.js"
import type { IImportedDocument } from "./imported-document.model.js"
import { withMeteredAi } from "./metered-ai.js"
import { Mode1Error } from "./mode1.errors.js"
import { PROVISIONAL_SECTION } from "./section-catalog.js"
import { TABLE_ENTITIES } from "./table-header-dictionary.js"
import { TemplateProfile, type ITemplateProfile } from "./template-profile.model.js"

export interface ExtractionRun {
  doc: IImportedDocument
  sections: GetImportResponse["extraction"]["sections"]
}

type BlockLite = Pick<IDocBlock, "block_id" | "kind" | "text" | "section_id" | "anchor">

/** Section cần trích theo thứ tự xuất hiện trong tài liệu. */
export const extractionPlan = (blocks: BlockLite[]): string[] => {
  const out: string[] = []
  for (const b of blocks) if (b.section_id && isExtractableSection(b.section_id) && !out.includes(b.section_id)) out.push(b.section_id)
  return out
}

// ─── tất định: bảng ─────────────────────────────────────────────

const CELL_PATH = /\/tr\[(\d+)\]\/tc\[(\d+)\]\/p\[\d+\]$/

/** Dựng lưới ô của bảng từ block `table_cell` (đoạn cùng ô nối bằng xuống dòng). */
export const tableGrid = (table: BlockLite, blocks: BlockLite[]): string[][] => {
  const grid: string[][] = []
  const prefix = `${table.anchor.xml_path}/tr[`
  for (const b of blocks) {
    if (b.kind !== "table_cell" || !b.anchor.xml_path.startsWith(prefix)) continue
    const m = CELL_PATH.exec(b.anchor.xml_path)
    if (!m) continue
    const [r, c] = [Number(m[1]), Number(m[2])]
    grid[r] ??= []
    grid[r][c] = grid[r][c] ? `${grid[r][c]}\n${b.text}` : b.text
  }
  return grid.map((row) => Array.from(row ?? [], (cell) => (cell ?? "").trim()))
}

const splitList = (s: string): string[] =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean)

const LIST_FIELDS = new Set(["actor_ids", "goals"])

/** Bảng có mapping đủ field bắt buộc ⇒ item theo từng hàng dữ liệu; không đủ ⇒ `null` (để AI trích). */
export const deterministicTableItems = (table: BlockLite, grid: string[][], profile: ITemplateProfile): EntityItem[] | null => {
  const cols = profile.table_map.filter((t) => t.block_id === table.block_id && t.field_path)
  if (!cols.length || grid.length < 2) return null
  const entity = cols[0].field_path!.split("[")[0]
  const def = TABLE_ENTITIES.find((d) => d.entity === entity)
  const fields = new Map(cols.filter((c) => c.field_path!.startsWith(`${entity}[`)).map((c) => [c.column_index, c.field_path!.split("].")[1]]))
  if (!def || !def.required.every((f) => [...fields.values()].includes(f))) return null
  const confidence = Math.min(...cols.map((c) => (c.confirmed ? 1 : c.confidence)))
  return grid.slice(1).flatMap((row) => {
    const value: Record<string, unknown> = {}
    for (const [col, field] of fields) {
      const cell = row[col]?.trim()
      if (cell) value[field] = LIST_FIELDS.has(field) ? splitList(cell) : cell
    }
    if (!Object.keys(value).length) return []
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

const blockLines = (blocks: BlockLite[]): string => blocks.map((b) => `[${b.block_id}] ${b.kind === "table" ? `(table)\n${b.text.split("\n").map((r) => `| ${r} |`).join("\n")}` : b.text}`).join("\n")

const knownKeysText = (items: EntityItem[]): string => {
  const byEntity = new Map<string, string[]>()
  for (const it of items) {
    if (!it.id) continue
    const name = typeof it.value.name === "string" ? ` (${it.value.name})` : ""
    byEntity.set(it.entity, [...(byEntity.get(it.entity) ?? []), `${it.id}${name}`])
  }
  return [...byEntity].map(([e, ids]) => `${e}: ${[...new Set(ids)].join(", ")}`).join("\n") || "(none yet)"
}

/** Đổi output model sang item: chuẩn hoá khoá, dùng lại id theo tên, ép id function của section function. */
export const itemsFromAi = (
  out: ImportExtractOutput,
  ctx: { sectionId: string; alloc: IdAllocator; known: EntityItem[]; sectionFunction: ProvisionalEntity | null; validBlocks: Set<string> }
): EntityItem[] => {
  const byName = (entity: string, name: unknown): string | null => {
    if (typeof name !== "string") return null
    const hit = ctx.known.find((k) => k.entity === entity && typeof k.value.name === "string" && k.value.name.toLowerCase() === name.toLowerCase())
    return hit?.id ?? null
  }
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
        id = raw.key ? normalizeKey(raw.key) : byName(raw.entity, value.name ?? value.term)
        id ??= ctx.alloc.next(raw.entity)
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

const mergeItems = (items: EntityItem[]): EntityItem[] => {
  const out = new Map<string, EntityItem>()
  for (const it of items) {
    const key = `${it.entity}|${it.id ?? ""}`
    const cur = out.get(key)
    if (!cur) {
      out.set(key, { ...it, value: { ...it.value }, source_block_ids: [...it.source_block_ids] })
      continue
    }
    for (const [k, v] of Object.entries(it.value)) if (cur.value[k] === undefined) cur.value[k] = v
    cur.field_confidence = { ...it.field_confidence, ...cur.field_confidence }
    cur.source_block_ids = [...new Set([...cur.source_block_ids, ...it.source_block_ids])]
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
  drafts.some((d) => d.fields.some((f) => !f.confirmed && f.confidence < FIELD_CONFIDENCE_THRESHOLD))

/**
 * Chạy (hoặc chạy tiếp) I-4 cho import đang ở `extracting`. Trả trạng thái mới nhất kể cả khi dừng vì credit/lỗi AI.
 */
export const runExtraction = async (projectId: string, userId: string, importId: string): Promise<ExtractionRun> => {
  const doc = await requireImport(projectId, importId)
  assertImportStatus(doc, ["extracting"], "extracting")
  const profile = await TemplateProfile.findOne({ projectId })
  if (!profile) throw new Mode1Error("IMPORT_INVALID_STATE", "Chưa có template profile", { status: doc.status, to: "extracting", allowed: [] })
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

  for (const section_id of plan) {
    const draft = draftOf.get(section_id)!
    if (draft.status === "done") continue
    doc.extract_cursor = section_id
    await doc.save()

    const sectionBlocks = blocks.filter((b) => b.section_id === section_id)
    const items: EntityItem[] = [...provisionalItems(section_id, provisional)]
    const handledTables = new Set<string>()
    for (const t of sectionBlocks.filter((b) => b.kind === "table")) {
      const rows = deterministicTableItems(t, tableGrid(t, blocks), profile)
      if (!rows) continue
      handledTables.add(t.block_id)
      for (const it of rows) {
        it.id ??= alloc.next(it.entity)
        alloc.reserve(it.entity, it.id)
        items.push(it)
      }
    }

    const tablePrefixes = sectionBlocks.filter((b) => b.kind === "table").map((b) => `${b.anchor.xml_path}/`)
    const aiBlocks = sectionBlocks.filter(
      (b) =>
        b.kind !== "heading" &&
        b.text.trim() &&
        !handledTables.has(b.block_id) &&
        !(b.kind === "table_cell" && tablePrefixes.some((prefix) => b.anchor.xml_path.startsWith(prefix)))
    )
    const targets = targetsOf(section_id)
    let usageId: string | null = null
    const heading = profile.heading_map.find((h) => h.section_id === section_id)
    const sectionFunction = PROVISIONAL_SECTION.test(section_id) ? (provisional.get(section_id) ?? null) : null
    for (const batch of targets.length ? chunkBlocks(aiBlocks) : []) {
      const result = await withMeteredAi<ImportExtractOutput>({ projectId, userId, stepId: `I-4:${section_id}` }, ActionType.IMPORT_EXTRACT_FIELDS, {
        section_id,
        heading_text: heading?.heading_text ?? section_id,
        target_entities: targets.join(", "),
        schema_excerpt: schemaExcerptFor(targets),
        known_keys: knownKeysText([...known, ...items]),
        blocks: blockLines(batch)
      })
      if (!result.ok) {
        doc.paused = { reason: result.reason, at: new Date() }
        await doc.save()
        draft.error = result.message.slice(0, 500)
        if (result.reason === "resume_later") draft.status = "failed"
        await draft.save()
        return { doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections }
      }
      usageId = result.usageId
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
    known.push(...merged)
    draft.fields = merged.flatMap(flattenItem) as ExtractedField[]
    draft.status = "done"
    draft.error = null
    draft.usage_id = usageId
    draft.markModified("fields")
    await draft.save()
  }

  doc.extract_cursor = null
  await doc.save()
  const finalDrafts = await ExtractionDraft.find({ import_id: doc._id })
  await transitionImport(doc, needsReview(finalDrafts) ? "fields_review" : "baselining")
  return { doc, sections: (await extractionSummary(doc._id as mongoose.Types.ObjectId)).sections }
}

/** UC-61/UC-75: bỏ `paused` rồi chạy tiếp từ `extract_cursor` (section `done` giữ nguyên). */
export const resumeExtraction = runExtraction

// ─── 1.9 xác nhận field ─────────────────────────────────────────

export const patchFields = async (projectId: string, body: FieldsPatchRequest): Promise<IImportedDocument> => {
  const doc = await requireImport(projectId, body.import_id)
  assertImportStatus(doc, ["fields_review"], "baselining")
  const drafts = await ExtractionDraft.find({ import_id: doc._id })
  for (const f of body.fields) {
    const draft = drafts.find((d) => d.section_id === f.section_id)
    const idx = draft?.fields.findIndex((x) => x.path === f.path) ?? -1
    if (!draft || idx < 0) {
      throw new Mode1Error("IMPORT_INVALID_STATE", `Không có field ${f.path} ở section ${f.section_id}`, { status: doc.status, to: "baselining", allowed: [] })
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
