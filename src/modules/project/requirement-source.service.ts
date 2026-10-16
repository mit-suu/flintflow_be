/**
 * Nguồn tài liệu của yêu cầu (FLF-292). `draft-to-ops` trả `sources: [{ path, paras }]` cạnh `ops`; sau khi lô đã ghi
 * vào Spine, `captureSources` kiểm từng mục rồi lưu:
 *   - `path` chuẩn hoá về phần tử (`functions[id=FN12].normal` ⇒ `functions[id=FN12]`) và phần tử phải có trong Spine
 *     SAU lô — model không gắn nguồn cho phần tử nó không viết ra được;
 *   - mã đoạn phải tra được ra chữ trong tài liệu của project — mã bịa bị bỏ, không mục nào còn mã ⇒ bỏ cả mục.
 * Lỗi chỉ log: nguồn là phần phụ, không bao giờ làm hỏng lượt ghi Spine (giống `captureForTurn`).
 */

import mongoose from "mongoose"
import type { Spine } from "../spine/spine.types.js"
import type { SourceEntry } from "../../shared/ai/response-parser.js"
import { parseParagraphId, paragraphId, splitParagraphs } from "../../shared/ai/document-paragraphs.js"
import { ProjectDocument } from "./project-document.model.js"
import { RequirementSource } from "./requirement-source.model.js"

/** Mảng phần tử của Spine được gắn nguồn (khoá `id`). */
export const SOURCE_COLLECTIONS = [
  "actors",
  "roles",
  "features",
  "use_cases",
  "screens",
  "functions",
  "entities",
  "nfrs",
  "business_rules",
  "common_requirements",
  "messages",
  "other_requirements",
  "glossary",
  "addendum"
] as const

type SourceCollection = (typeof SOURCE_COLLECTIONS)[number]

const COLLECTION_SET: ReadonlySet<string> = new Set(SOURCE_COLLECTIONS)

/** Trần chữ trích mỗi đoạn — đoạn transcript rất dài vẫn đọc được trong popover. */
export const QUOTE_MAX_CHARS = 500

/** Trần số đoạn mỗi phần tử — model liệt kê cả tài liệu thì nguồn không còn nghĩa. */
export const MAX_REFS_PER_ENTITY = 5

/**
 * Path phần tử từ path model viết: `functions[id=FN12].normal` ⇒ `functions[id=FN12]`; `project.vision.x` ⇒
 * `project.vision`. Không trỏ được phần tử (`functions[]`, `permissions[screen_id=…]`, mảng lạ) ⇒ `null`.
 */
export const entityPathOf = (path: string): string | null => {
  const p = path.trim()
  const item = /^([a-z_]+)\[id=([^\],=]+)\]/.exec(p)
  if (item) return COLLECTION_SET.has(item[1]) ? `${item[1]}[id=${item[2].trim()}]` : null
  const field = /^project\.([a-z_]+)/.exec(p)
  return field ? `project.${field[1]}` : null
}

/** Phần tử còn trong Spine không (path đã chuẩn hoá bằng `entityPathOf`). */
export const entityExists = (spine: Spine, entityPath: string): boolean => {
  const item = /^([a-z_]+)\[id=(.+)\]$/.exec(entityPath)
  if (item) {
    const list = (spine as unknown as Record<SourceCollection, Array<{ id: string }> | undefined>)[item[1] as SourceCollection]
    return Array.isArray(list) && list.some((el) => el.id === item[2])
  }
  const field = /^project\.([a-z_]+)$/.exec(entityPath)
  return field !== null && field[1] in spine.project
}

interface ResolvedParagraph {
  document_id: mongoose.Types.ObjectId
  para_id: string
  quote: string
}

/** Tra mã đoạn ⇒ chữ trong tài liệu của project. Mã sai khuôn / không có ⇒ không có trong kết quả. */
export const resolveParagraphs = async (projectId: string, paraIds: readonly string[]): Promise<Map<string, ResolvedParagraph>> => {
  const wanted = new Map<string, { docCode: number; index: number }>()
  for (const raw of paraIds) {
    const parsed = parseParagraphId(raw)
    if (parsed) wanted.set(paragraphId(parsed.docCode, parsed.index), parsed)
  }
  const out = new Map<string, ResolvedParagraph>()
  if (wanted.size === 0) return out

  const codes = [...new Set([...wanted.values()].map((w) => w.docCode))]
  const docs = await ProjectDocument.find({ projectId, docCode: { $in: codes }, parseStatus: "success" })
    .select("_id docCode extractedText")
    .lean()
  const paragraphsByCode = new Map(docs.map((d) => [d.docCode as number, { id: d._id, paragraphs: splitParagraphs(d.extractedText ?? "") }]))

  for (const [id, { docCode, index }] of wanted) {
    const doc = paragraphsByCode.get(docCode)
    const text = doc?.paragraphs[index]
    if (doc && text) out.set(id, { document_id: doc.id, para_id: id, quote: text.slice(0, QUOTE_MAX_CHARS) })
  }
  return out
}

/** Lưu nguồn của một lô vừa ghi. `spine` là Spine SAU lô. */
export const captureSources = async (projectId: string, stepId: string, spine: Spine, entries: readonly SourceEntry[] | undefined): Promise<number> => {
  if (!entries?.length) return 0
  try {
    // Gộp mục cùng phần tử (model tách `name` và `description` thành hai mục)
    const byEntity = new Map<string, string[]>()
    for (const entry of entries) {
      const entityPath = entityPathOf(entry.path)
      if (!entityPath || !entityExists(spine, entityPath)) continue
      byEntity.set(entityPath, [...(byEntity.get(entityPath) ?? []), ...entry.paras])
    }
    if (byEntity.size === 0) return 0

    const resolved = await resolveParagraphs(projectId, [...byEntity.values()].flat())
    let saved = 0
    for (const [entityPath, paras] of byEntity) {
      const refs = [...new Set(paras.map((p) => p.trim().toUpperCase()))]
        .map((id) => resolved.get(id))
        .filter((r): r is ResolvedParagraph => r !== undefined)
        .slice(0, MAX_REFS_PER_ENTITY)
      if (refs.length === 0) continue
      await RequirementSource.updateOne(
        { projectId, entity_path: entityPath },
        { $set: { refs, step_id: stepId } },
        { upsert: true }
      )
      saved += 1
    }
    return saved
  } catch (err) {
    console.error(`[RequirementSource] capture failed for step ${stepId}:`, err)
    return 0
  }
}

export interface RequirementSourceView {
  path: string
  step_id: string
  updated_at: string
  refs: Array<{ para_id: string; document_id: string; document_name: string | null; quote: string }>
}

/** Nguồn của các phần tử còn trong Spine, kèm tên tài liệu (tài liệu đã xoá ⇒ `document_name: null`, chữ trích vẫn còn). */
export const listSources = async (projectId: string, spine: Spine): Promise<RequirementSourceView[]> => {
  const rows = await RequirementSource.find({ projectId }).sort({ entity_path: 1 }).lean()
  const live = rows.filter((r) => entityExists(spine, r.entity_path))
  const docIds = [...new Set(live.flatMap((r) => r.refs.map((ref) => String(ref.document_id))))]
  const docs = docIds.length > 0 ? await ProjectDocument.find({ _id: { $in: docIds } }).select("_id originalName").lean() : []
  const names = new Map(docs.map((d) => [String(d._id), d.originalName]))
  return live.map((r) => ({
    path: r.entity_path,
    step_id: r.step_id,
    updated_at: new Date(r.updatedAt).toISOString(),
    refs: r.refs.map((ref) => ({
      para_id: ref.para_id,
      document_id: String(ref.document_id),
      document_name: names.get(String(ref.document_id)) ?? null,
      quote: ref.quote
    }))
  }))
}
