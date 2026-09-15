/**
 * assemble.service.ts
 * ─────────────────────────────────────────────────────────────────
 * S-8.2 Document Assembly + S-8.3 Record of Changes: ghép `RenderedSection[]` (section-renderer.ts)
 * theo đúng thứ tự template FPT, sinh số hiệu section (Product-Brief-to-SRS-Phases.md §6.3), chèn ảnh,
 * dựng §I từ `changes[]`, gắn phụ lục cờ — thành một `RenderedDocument` hoàn chỉnh.
 *
 * `source = draft`  : dựng từ Spine sống, cache theo `spine_version` (collection `rendered_documents`).
 * `source = baseline`: dựng từ `Baseline.snapshot` (T19) — không đọc Spine hiện tại (srs-spine.md §2.1),
 *                       không cache (rẻ, bất biến).
 *
 * KHÔNG ghi Spine ở đây — chỉ đọc (`spine.repository`, `Baseline`) và ghi cache riêng
 * (`RenderedDocumentCache`, không phải collection `spines`).
 */

import mongoose from "mongoose"
import * as spineRepository from "../spine/spine.repository.js"
import { listSections } from "../spine/section-registry.js"
import { computeSectionStates, readiness } from "../spine/section-status.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Change, Flag, Spine } from "../spine/spine.types.js"
import { Baseline } from "../spine/baseline.model.js"
import { loadDiagramFile } from "../diagram/diagram.service.js"
import { renderSection, sectionHeadingOf, buildRecordOfChanges, type SectionRenderContext } from "./section-renderer.js"
import { runConsistencyPass } from "./consistency-pass.js"
import { RenderedDocumentCache } from "./rendered-document.model.js"
import type { FlagRow, FlagsAppendix, RenderedDocument, RenderedSection, RenderSource } from "./rendered-document.types.js"
import { renderedDocumentSchema } from "./rendered-document.schema.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const NO_WORKING_DRAFT = "NO_WORKING_DRAFT"

/** 409 — `GET /document` hoặc `GET /export/word` với `source=draft` trước khi `POST /assemble` chạy lần nào. */
export class NoWorkingDraftError extends ApiError {
  constructor() {
    super(409, "Document has not been assembled yet. Run POST /assemble first (S-8.2).", NO_WORKING_DRAFT)
  }
}

// ─── số hiệu section (§6.3) ─────────────────────────────────────

/** `§3.(2 + features[].order)` — feature thứ `order` (từ 0), `order` bất biến 5 giữ duy nhất/liên tục. */
const featureNumber = (spine: Spine, featureId: string): string => {
  const feature = spine.features.find((f) => f.id === featureId)
  return `3.${2 + (feature?.order ?? 0)}`
}

/**
 * `§3.(2 + order).(functions[].order + 1)` — CHÚ Ý: `functions[].order` được đánh RIÊNG cho
 * `screen_id ≠ null` và `screen_id = null` (Phases §6.3), nên cùng một feature có thể có hai
 * function với `order` trùng nhau (một screen-bound, một non-screen). Đọc `fn.order` trực tiếp
 * làm `.y` sẽ sinh số trùng. Số `.y` đúng là VỊ TRÍ (1-based) của function trong danh sách đã gộp
 * của chính feature đó — đúng thứ tự `section-registry.listSections` đã tính (screen-bound trước,
 * theo `order`, rồi non-screen theo `order`) — nên duyệt `listSections` một lần và đếm theo feature.
 */
const buildNumberMap = (spine: Spine): Map<string, string> => {
  const numbers = new Map<string, string>()
  const functionOrdinalByFeature = new Map<string, number>()

  for (const def of listSections(spine)) {
    if (def.id === "fixed:I") continue

    if (def.id.startsWith("fixed:")) {
      numbers.set(def.id, def.id.slice("fixed:".length))
      continue
    }
    if (def.id.startsWith("feature:")) {
      numbers.set(def.id, featureNumber(spine, def.id.slice("feature:".length)))
      continue
    }
    // function:<id> — def.parent = "feature:<id>" (section-registry.listSections)
    const featureId = def.parent ?? ""
    const ordinal = (functionOrdinalByFeature.get(featureId) ?? 0) + 1
    functionOrdinalByFeature.set(featureId, ordinal)
    numbers.set(def.id, `${numbers.get(featureId) ?? featureNumber(spine, featureId.slice("feature:".length))}.${ordinal}`)
  }
  return numbers
}

// ─── 5 chương FPT (tiêu đề chương 2–5; chương 1 = chính `fixed:1`) ─

const CHAPTER_HEADINGS: Readonly<Record<string, string>> = {
  "2": "User Requirements",
  "3": "Functional Requirements",
  "4": "Non-Functional Requirements",
  "5": "Requirement Appendix"
}

/** Section đầu tiên của mỗi chương 2–5 — chèn heading chương ngay trước. */
const CHAPTER_BEFORE: Readonly<Record<string, string>> = {
  "fixed:2.1": "2",
  "fixed:3.1.1": "3",
  "fixed:4.1": "4",
  "fixed:5.1": "5"
}

const chapterSection = (number: string): RenderedSection => ({
  id: `group:${number}`,
  number,
  heading: CHAPTER_HEADINGS[number],
  level: 1,
  blocks: []
})

// ─── ảnh diagram ─────────────────────────────────────────────────

export type DiagramPngLoader = (projectId: string, diagramId: string) => Promise<string | null>

const defaultDiagramPngLoader: DiagramPngLoader = async (projectId, diagramId) => {
  try {
    const file = await loadDiagramFile(projectId, diagramId, "png")
    return file.data.toString("base64")
  } catch {
    // Ảnh thiếu/lỗi không chặn cả tài liệu — section chỉ thiếu ảnh đó (writer vẫn nhận doc hợp lệ).
    return null
  }
}

const preloadDiagramPngs = async (projectId: string, spine: Spine, load: DiagramPngLoader): Promise<Map<string, string>> => {
  const ok = spine.diagrams.filter((d) => d.render_status === "ok")
  const loaded = await Promise.all(
    ok.map(async (d): Promise<readonly [string, string] | null> => {
      const png = await load(projectId, d.id)
      return png === null ? null : ([d.id, png] as const)
    })
  )
  return new Map(loaded.filter((entry): entry is readonly [string, string] => entry !== null))
}

// ─── phụ lục cờ ──────────────────────────────────────────────────

const buildFlagRow = (spine: Spine, flag: Flag, numbers: Map<string, string>): FlagRow => {
  const number = numbers.get(flag.section_id) ?? (flag.section_id.startsWith("fixed:") ? flag.section_id.slice("fixed:".length) : flag.section_id)
  let heading = flag.section_id
  try {
    heading = sectionHeadingOf(spine, flag.section_id)
  } catch {
    // section_id không phân giải được (dữ liệu cũ) — giữ khoá logic thô thay vì ném lỗi cả tài liệu
  }
  const row: FlagRow = { id: flag.id, rule_id: flag.rule_id, section: `${number} ${heading}`.trim(), message: flag.message }
  if (flag.waived_by_user) row.waive_reason = flag.waive_reason
  return row
}

const buildFlagsAppendix = (spine: Spine, changes: Change[], numbers: Map<string, string>, source: RenderSource): FlagsAppendix => {
  const waived = spine.flags.filter((f) => f.waived_by_user).map((f) => buildFlagRow(spine, f, numbers))
  if (source === "baseline") {
    // srs-spine.md §6: bản baseline chỉ cần in danh sách waive — không có cờ đỏ mở (điều kiện ký baseline).
    return { redOpen: [], staleCount: 0, waived }
  }
  const redOpen = spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && !f.waived_by_user)
  return { redOpen: redOpen.map((f) => buildFlagRow(spine, f, numbers)), staleCount: readiness(spine, changes).stale, waived }
}

// ─── dựng sections[] ────────────────────────────────────────────

interface BuildSectionsOptions {
  /** Chỉ dùng nội bộ (dev) — bỏ section rỗng. KHÔNG lộ qua `assembleRequestSchema` (đóng băng). */
  partial?: boolean
}

const buildSections = (
  spine: Spine,
  changes: Change[],
  diagramPngs: Map<string, string>,
  numbers: Map<string, string>,
  opts: BuildSectionsOptions
): RenderedSection[] => {
  const states = new Map(computeSectionStates(spine, changes).map((s) => [s.id, s]))
  const numberOfCtx = (id: string): string | undefined => numbers.get(id)
  const diagramPng = (id: string): string | undefined => diagramPngs.get(id)

  const out: RenderedSection[] = []
  for (const def of listSections(spine)) {
    if (def.id === "fixed:I") continue
    const chapter = CHAPTER_BEFORE[def.id]
    if (chapter) out.push(chapterSection(chapter))

    const state = states.get(def.id)
    const ctx: SectionRenderContext = {
      number: numbers.get(def.id) ?? "",
      diagramPng,
      numberOf: numberOfCtx,
      ...(state?.status !== undefined ? { status: state.status } : {}),
      ...(state?.awaiting_reaccept !== undefined ? { awaiting_reaccept: state.awaiting_reaccept } : {})
    }
    const section = renderSection(spine, def.id, ctx)
    if (opts.partial && section.blocks.length === 0) continue
    out.push(section)
  }
  return out
}

// ─── dựng RenderedDocument hoàn chỉnh ───────────────────────────

export interface AssembleDeps {
  loadDiagramPng: DiagramPngLoader
  now: () => Date
}

const defaultDeps = (): AssembleDeps => ({ loadDiagramPng: defaultDiagramPngLoader, now: () => new Date() })

interface BuildDocumentInput {
  projectId: string
  projectName: string
  spine: Spine
  /** Changes dùng để tính status/stale (rỗng cho baseline — không có mốc so sánh đáng tin). */
  statusChanges: Change[]
  /** Changes dùng để dựng §I (cả lịch sử hiện có, kể cả bản baseline — xem ghi chú ở `getBaselineDocument`). */
  recordChanges: Change[]
  source: RenderSource
  version: string
  partial?: boolean
}

/** Dựng `RenderedDocument` — hàm thuần theo nghĩa I/O (chỉ tải ảnh), dùng chung cho draft/baseline. */
async function buildDocument(input: BuildDocumentInput, deps: AssembleDeps): Promise<RenderedDocument> {
  const { projectId, projectName, spine, source, version } = input
  const diagramPngs = await preloadDiagramPngs(projectId, spine, deps.loadDiagramPng)
  const numbers = buildNumberMap(spine)
  const sections = buildSections(spine, input.statusChanges, diagramPngs, numbers, { partial: input.partial ?? false })

  const findings = await runConsistencyPass(spine, sections)
  if (findings.length > 0) {
    console.warn(`[assemble] S-8.4 consistency findings for project ${projectId} (${findings.length}):`, findings.slice(0, 10))
  }

  const doc: RenderedDocument = {
    projectId,
    projectName,
    version,
    source,
    generatedAt: deps.now().toISOString(),
    sections,
    recordOfChanges: buildRecordOfChanges(input.recordChanges),
    flagsAppendix: buildFlagsAppendix(spine, input.statusChanges, numbers, source)
  }
  if (source === "draft") doc.watermark = "DRAFT"
  return doc
}

// ─── POST /projects/:id/assemble ────────────────────────────────

export interface AssembleResult {
  spine_version: number
  sections: number
  generated_at: string
}

/**
 * S-8.2: ghép bản draft ở `spine_version` hiện tại và lưu cache. Idempotent theo `spine_version` —
 * gọi lại cùng version trả cache có sẵn, không dựng lại. `base_version` lệch ⇒ 409 SPINE_VERSION_CONFLICT.
 */
export async function assemble(
  projectId: string,
  projectName: string,
  baseVersion: number,
  deps: Partial<AssembleDeps> = {}
): Promise<AssembleResult> {
  const merged: AssembleDeps = { ...defaultDeps(), ...deps }
  const record = await spineRepository.getOrCreate(projectId, { name: projectName })
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }

  const cached = await RenderedDocumentCache.findOne({ projectId, spine_version: record.spine_version }, null, { lean: true })
  if (cached) {
    const doc = renderedDocumentSchema.parse(cached.doc)
    return { spine_version: record.spine_version, sections: doc.sections.length, generated_at: doc.generatedAt }
  }

  const { projectId: _projectId, ...spine } = record
  const changes = await spineRepository.listChanges(projectId)
  const doc = await buildDocument(
    {
      projectId,
      projectName,
      spine,
      statusChanges: changes,
      recordChanges: changes,
      source: "draft",
      version: `v0.${record.spine_version}`
    },
    merged
  )

  await RenderedDocumentCache.findOneAndUpdate(
    { projectId, spine_version: record.spine_version },
    { $set: { assembled_at_version: record.spine_version, generated_at: new Date(doc.generatedAt), doc } },
    { upsert: true }
  )

  return { spine_version: record.spine_version, sections: doc.sections.length, generated_at: doc.generatedAt }
}

// ─── GET /projects/:id/document, GET /projects/:id/export/word ──

export interface DocumentQuery {
  source: RenderSource
  baseline_id?: string
}

const getDraftDocument = async (projectId: string): Promise<RenderedDocument> => {
  const cached = await RenderedDocumentCache.findOne({ projectId }, null, { lean: true, sort: { spine_version: -1 } })
  if (!cached) throw new NoWorkingDraftError()
  return renderedDocumentSchema.parse(cached.doc)
}

const getBaselineDocument = async (
  projectId: string,
  projectName: string,
  baselineId: string | undefined,
  deps: AssembleDeps
): Promise<RenderedDocument> => {
  if (baselineId !== undefined && !mongoose.isValidObjectId(baselineId)) {
    throw new ApiError(404, "Baseline không tồn tại", "BASELINE_NOT_FOUND")
  }
  const filter = baselineId ? { projectId, _id: baselineId } : { projectId }
  const baseline = await Baseline.findOne(filter, null, { lean: true, sort: { at: -1 } })
  if (!baseline) throw new ApiError(404, "Baseline không tồn tại", "BASELINE_NOT_FOUND")

  const spine = spineSchema.parse(baseline.snapshot)
  // §I hiển thị lịch sử đầy đủ hiện có (chưa có mốc "seq tại lúc ký" trong Baseline — T19 chưa chốt);
  // status/stale của section thì tính với changes rỗng vì không có gì để so — tránh stale giả cho bản đã ký.
  const recordChanges = await spineRepository.listChanges(projectId)
  return buildDocument(
    {
      projectId,
      projectName,
      spine,
      statusChanges: [],
      recordChanges,
      source: "baseline",
      version: String(baseline.version)
    },
    deps
  )
}

export async function getDocument(
  projectId: string,
  projectName: string,
  query: DocumentQuery,
  deps: Partial<AssembleDeps> = {}
): Promise<RenderedDocument> {
  const merged: AssembleDeps = { ...defaultDeps(), ...deps }
  if (query.source === "baseline") return getBaselineDocument(projectId, projectName, query.baseline_id, merged)
  return getDraftDocument(projectId)
}

// exported for tests that need to build a document without the cache/HTTP layer (dev `partial`)
export const _internal = { buildDocument, buildNumberMap, buildSections }
