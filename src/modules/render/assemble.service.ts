/**
 * assemble.service.ts
 * ─────────────────────────────────────────────────────────────────
 * S-8.2 Document Assembly + S-8.3 Record of Changes: ghép `RenderedSection[]` (section-renderer.ts)
 * theo đúng thứ tự template FPT, sinh số hiệu section (Product-Brief-to-SRS-Phases.md §6.3), chèn ảnh,
 * dựng §I từ `changes[]`, gắn phụ lục cờ — thành một `RenderedDocument` hoàn chỉnh.
 *
 * `source = draft`  : dựng từ Spine sống, cache theo `spine_version` (collection `rendered_documents`).
 * `source = baseline`: dựng từ `Baseline.snapshot` (T19) — không đọc Spine hiện tại (srs-spine.md §2.1),
 *                       cache theo `Baseline._id` (bất biến — T15 review T5).
 *
 * KHÔNG ghi Spine ở đây — chỉ đọc (`spine.repository`, `Baseline`, `Change`, `User`) và ghi cache riêng
 * (`RenderedDocumentCache`, không phải collection `spines`).
 */

import mongoose from "mongoose"
import * as spineRepository from "../spine/spine.repository.js"
import { listSections } from "../spine/section-registry.js"
import { computeSectionStates, readiness, type SectionStateView } from "../spine/section-status.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { Baseline } from "../spine/baseline.model.js"
// T15 review T5: đọc Change model trực tiếp (chỉ đọc) — projection nhẹ cho §I, không qua
// spine.repository.listChanges (tải cả before/value, không cần cho Record of Changes).
import { Change as ChangeModel } from "../spine/change.model.js"
// T15 review T7: tra tên người ghi thay cho userId thô trong §I (chỉ đọc).
import { User } from "../user/user.model.js"
import { loadDiagramFile } from "../diagram/diagram.service.js"
import {
  renderSection,
  sectionHeadingOf,
  buildRecordOfChanges,
  type ChangeRecordRow,
  type SectionRenderContext
} from "./section-renderer.js"
import { runConsistencyPass, type ConsistencyFinding } from "./consistency-pass.js"
import { RenderedDocumentCache } from "./rendered-document.model.js"
import type {
  Block,
  FlagRow,
  FlagsAppendix,
  ImageBlock,
  RenderedDocument,
  RenderedSection,
  RenderSource
} from "./rendered-document.types.js"
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

export interface NumberMap {
  numbers: Map<string, string>
  /** T15 review Th1: số của mục "Unassigned Functions" — `3.(2 + features.length + 1)`, sau feature cuối. */
  unassignedNumber: string
  /** `true` khi có ít nhất một function `feature_id` chết (không khớp feature nào còn sống). */
  hasUnassigned: boolean
}

/**
 * `§3.(2 + order).(vị trí trong feature)` — CHÚ Ý: `functions[].order` được đánh RIÊNG cho
 * `screen_id ≠ null` và `screen_id = null` (Phases §6.3), nên cùng một feature có thể có hai
 * function với `order` trùng nhau (một screen-bound, một non-screen). Đọc `fn.order` trực tiếp
 * làm `.y` sẽ sinh số trùng. Số `.y` đúng là VỊ TRÍ (1-based) của function trong danh sách đã gộp
 * của chính feature đó — đúng thứ tự `section-registry.listSections` đã tính (screen-bound trước,
 * theo `order`, rồi non-screen theo `order`) — nên duyệt `listSections` một lần và đếm theo feature.
 *
 * T15 review Th1: function có `feature_id` chết (feature đã bị xoá, dữ liệu lỗi từ trước) không có
 * feature thật để tính `featureNumber` — trước đây rơi về mặc định `order=0` ⇒ luôn ra "3.2", trùng
 * với feature thật đầu tiên. Gom mọi function mồ côi vào một mục riêng `unassignedNumber` ở cuối
 * chương 3 (`section-status`/`buildSections` chèn heading "Unassigned Functions" trước function đầu
 * tiên của mục này — xem `buildSections`).
 */
const buildNumberMap = (spine: Spine): NumberMap => {
  const numbers = new Map<string, string>()
  const functionOrdinalByFeatureNumber = new Map<string, number>()
  const unassignedNumber = `3.${2 + spine.features.length + 1}`
  let hasUnassigned = false

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
    const parentFeatureId = def.parent?.startsWith("feature:") ? def.parent.slice("feature:".length) : ""
    const featureExists = spine.features.some((f) => f.id === parentFeatureId)
    let featureNum: string
    if (featureExists) {
      featureNum = featureNumber(spine, parentFeatureId)
    } else {
      hasUnassigned = true
      featureNum = unassignedNumber
    }
    const ordinal = (functionOrdinalByFeatureNumber.get(featureNum) ?? 0) + 1
    functionOrdinalByFeatureNumber.set(featureNum, ordinal)
    numbers.set(def.id, `${featureNum}.${ordinal}`)
  }
  return { numbers, unassignedNumber, hasUnassigned }
}

// ─── heading nhóm chèn trước section con đầu tiên (§6.3, review C4) ─

/**
 * Nhãn hiển thị của mọi nhóm heading tổng hợp: 4 chương (`"2".."5"`, level 1) + 3 nhóm con
 * (`"2.2"`, `"3.1"`, `"4.2"`, level 2) — suy trực tiếp từ `def.parent` của
 * `section-registry.listSections` (`parentChain`) thay vì bảng "section đầu tiên của mỗi chương"
 * cứng trước đây (chỉ phủ 4 chương, thiếu 3 nhóm con — review C4).
 */
const GROUP_HEADINGS: Readonly<Record<string, string>> = {
  "2": "User Requirements",
  "2.2": "Use Cases",
  "3": "Functional Requirements",
  "3.1": "System Functional Overview",
  "4": "Non-Functional Requirements",
  "4.2": "Quality Attributes",
  "5": "Requirement Appendix"
}

/** `"4.2.1"` cha `"4.2"` → chuỗi tổ tiên `["4", "4.2"]`. `feature:<id>` (cha của function) không có nhóm số. */
const parentChain = (parent: string | undefined): string[] => {
  if (!parent || parent.startsWith("feature:")) return []
  const parts = parent.split(".")
  return parts.map((_, i) => parts.slice(0, i + 1).join("."))
}

const chapterSection = (number: string): RenderedSection => ({
  id: `group:${number}`,
  number,
  heading: GROUP_HEADINGS[number] ?? number,
  level: number.split(".").length,
  blocks: []
})

/** T15 review Th1: heading "Unassigned Functions" — chỉ chèn khi thật sự có function feature_id chết. */
const unassignedFunctionsSection = (number: string): RenderedSection => ({
  id: "group:unassigned-functions",
  number,
  heading: "Unassigned Functions",
  level: 2,
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

export interface ImageLoadResult {
  loaded: Map<string, string>
  /** Id diagram `render_status="ok"` nhưng tải PNG lỗi/null (review C3) — khác rỗng ⇒ caller không ghi cache. */
  missing: string[]
}

/** T15 review Th4: giới hạn 4 tải song song một lô — tránh fan-out không giới hạn khi có nhiều ảnh. */
const IMAGE_LOAD_BATCH_SIZE = 4

const preloadDiagramPngs = async (projectId: string, spine: Spine, load: DiagramPngLoader): Promise<ImageLoadResult> => {
  const ok = spine.diagrams.filter((d) => d.render_status === "ok")
  const loaded = new Map<string, string>()
  const missing: string[] = []
  for (let i = 0; i < ok.length; i += IMAGE_LOAD_BATCH_SIZE) {
    const batch = ok.slice(i, i + IMAGE_LOAD_BATCH_SIZE)
    const results = await Promise.all(batch.map(async (d) => [d.id, await load(projectId, d.id)] as const))
    for (const [id, png] of results) {
      if (png === null) missing.push(id)
      else loaded.set(id, png)
    }
  }
  return { loaded, missing }
}

// ─── cache: gọn ảnh, không lưu base64 (review T6) ──────────────────

/** Đánh dấu ô `png` trong cache là tham chiếu diagram id, chưa phải PNG thật. */
const IMAGE_REF_PREFIX = "diagram-ref:"

const isImageBlock = (b: Block): b is ImageBlock => b.type === "image"

/**
 * Trước khi ghi cache: thay `ImageBlock.png` (base64, có thể vài trăm KB/ảnh) bằng tham chiếu
 * `diagram-ref:<id>` — tránh phình collection `rendered_documents` và trần 16MB/document của Mongo.
 * `diagramPngs` (id → base64 vừa tải lúc build) cho biết base64 nào ứng với diagram nào.
 */
const stripImagesForCache = (doc: RenderedDocument, diagramPngs: Map<string, string>): RenderedDocument => {
  const pngToId = new Map(Array.from(diagramPngs, ([id, png]) => [png, id]))
  const stripBlock = (b: Block): Block => {
    if (!isImageBlock(b)) return b
    const png = typeof b.png === "string" ? b.png : b.png.toString("base64")
    const id = pngToId.get(png)
    return id ? { ...b, png: `${IMAGE_REF_PREFIX}${id}` } : b
  }
  return { ...doc, sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map(stripBlock) })) }
}

/**
 * Sau khi đọc cache: tải lại PNG thật cho mọi ảnh còn ở dạng tham chiếu. Ảnh không tải lại được
 * (diagram bị xoá sau lúc cache) bị bỏ khỏi section thay vì làm hỏng cả tài liệu.
 */
const rehydrateImages = async (doc: RenderedDocument, projectId: string, load: DiagramPngLoader): Promise<RenderedDocument> => {
  const refs = new Set<string>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (isImageBlock(block) && typeof block.png === "string" && block.png.startsWith(IMAGE_REF_PREFIX)) {
        refs.add(block.png.slice(IMAGE_REF_PREFIX.length))
      }
    }
  }
  if (refs.size === 0) return doc

  const resolved = new Map<string, string>()
  for (const id of refs) {
    const png = await load(projectId, id)
    if (png !== null) resolved.set(id, png)
    else console.warn(`[assemble] Không tải lại được PNG diagram ${id} từ cache — bỏ ảnh này khỏi tài liệu`)
  }

  const hydrateBlock = (b: Block): Block | null => {
    if (!isImageBlock(b) || typeof b.png !== "string" || !b.png.startsWith(IMAGE_REF_PREFIX)) return b
    const png = resolved.get(b.png.slice(IMAGE_REF_PREFIX.length))
    return png ? { ...b, png } : null
  }
  return {
    ...doc,
    sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map(hydrateBlock).filter((b): b is Block => b !== null) }))
  }
}

// ─── cache: ghi an toàn (review T10) + dọn bản cũ (review T6) ─────

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === 11000

/**
 * T15 review T10: upsert lạc quan có thể đụng race hai request cùng ghi lần đầu (`E11000` của unique
 * index) — bắt lỗi đó, đọc lại bản đã thắng thay vì để lộ 500 cho request thua.
 */
const upsertCache = async (filter: Record<string, unknown>, setDoc: Record<string, unknown>) => {
  try {
    return await RenderedDocumentCache.findOneAndUpdate(filter, { $set: setDoc }, { upsert: true, lean: true })
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err
    const existing = await RenderedDocumentCache.findOne(filter, null, { lean: true })
    if (existing) return existing
    throw err
  }
}

/** T15 review T6: chỉ giữ 3 bản draft gần nhất mỗi project — bản baseline (bất biến) không bị dọn. */
const DRAFT_CACHE_RETENTION = 3

const pruneOldDraftCache = async (projectId: string): Promise<void> => {
  const stale = await RenderedDocumentCache.find(
    { projectId, spine_version: { $exists: true } },
    { _id: 1 },
    { lean: true, sort: { spine_version: -1 }, skip: DRAFT_CACHE_RETENTION }
  )
  if (stale.length === 0) return
  await RenderedDocumentCache.deleteMany({ _id: { $in: stale.map((row: { _id: unknown }) => row._id) } })
}

// ─── §I: changes nhẹ (review T5) + tên người ghi (review T7) ──────

const RECORD_CHANGE_PROJECTION = { txn: 1, at: 1, by: 1, reason: 1, op: 1, step_id: 1, path: 1, seq: 1 } as const

interface ChangeRecordDoc {
  txn: string
  at: Date | string
  by: string
  reason: string | null
  op: string
  step_id: string | null
}

/**
 * T15 review T5: §I chỉ cần `{txn, at, by, reason, op, step_id}` — đọc thẳng `Change` model (chỉ đọc)
 * với projection nhẹ này thay vì `spine.repository.listChanges` (tải cả `before`/`value`, không cần
 * cho Record of Changes, có thể lớn với change phức tạp).
 */
const listChangesForRecord = async (projectId: string): Promise<ChangeRecordRow[]> => {
  const docs = (await ChangeModel.find({ projectId }, RECORD_CHANGE_PROJECTION, { sort: { seq: 1 }, lean: true })) as ChangeRecordDoc[]
  return docs.map((d) => ({
    txn: d.txn,
    at: d.at instanceof Date ? d.at.toISOString() : d.at,
    by: d.by,
    reason: d.reason,
    op: d.op,
    step_id: d.step_id
  }))
}

const SYSTEM_ACTOR = "system"
const shortenId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id)

/**
 * T15 review T7: `changes[].by` là userId thô — tra `User.name`/email theo lô (một query cho mọi
 * txn của §I) để hiển thị thay vì id. `"system"` luôn hiển thị "System"; user không còn (đã xoá)
 * giữ id rút gọn thay vì id đầy đủ.
 */
const buildInChargeResolver = async (changes: ChangeRecordRow[]): Promise<(by: string) => string> => {
  const ids = [...new Set(changes.map((c) => c.by))].filter((id) => id !== SYSTEM_ACTOR && mongoose.isValidObjectId(id))
  const users = ids.length === 0
    ? []
    : ((await User.find({ _id: { $in: ids } }, { name: 1, email: 1 }, { lean: true })) as { _id: unknown; name?: string; email: string }[])
  const nameById = new Map(users.map((u) => [String(u._id), (u.name && u.name.trim()) || u.email]))
  return (by: string): string => {
    if (by === SYSTEM_ACTOR) return "System"
    return nameById.get(by) ?? shortenId(by)
  }
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

type StatusChanges = Parameters<typeof computeSectionStates>[1]

const buildFlagsAppendix = (
  spine: Spine,
  changes: StatusChanges,
  numbers: Map<string, string>,
  source: RenderSource,
  states: SectionStateView[]
): FlagsAppendix => {
  const waived = spine.flags.filter((f) => f.waived_by_user).map((f) => buildFlagRow(spine, f, numbers))
  if (source === "baseline") {
    // srs-spine.md §6: bản baseline chỉ cần in danh sách waive — không có cờ đỏ mở (điều kiện ký baseline).
    return { redOpen: [], staleCount: 0, waived }
  }
  const redOpen = spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && !f.waived_by_user)
  // T15 review T4: dùng lại `states` đã tính một lần ở buildDocument thay vì computeSectionStates lần nữa.
  return { redOpen: redOpen.map((f) => buildFlagRow(spine, f, numbers)), staleCount: readiness(spine, changes, states).stale, waived }
}

// ─── dựng sections[] ────────────────────────────────────────────

interface BuildSectionsOptions {
  /** Chỉ dùng nội bộ (dev) — bỏ section rỗng. KHÔNG lộ qua `assembleRequestSchema` (đóng băng). */
  partial?: boolean
  unassignedNumber: string
  hasUnassigned: boolean
}

const buildSections = (
  spine: Spine,
  diagramPngs: Map<string, string>,
  numbers: Map<string, string>,
  states: SectionStateView[],
  opts: BuildSectionsOptions
): RenderedSection[] => {
  const stateById = new Map(states.map((s) => [s.id, s]))
  const numberOfCtx = (id: string): string | undefined => numbers.get(id)
  const diagramPng = (id: string): string | undefined => diagramPngs.get(id)

  const out: RenderedSection[] = []
  const seenGroups = new Set<string>()
  let unassignedHeadingInserted = false

  for (const def of listSections(spine)) {
    if (def.id === "fixed:I") continue

    for (const group of parentChain(def.parent)) {
      if (seenGroups.has(group)) continue
      seenGroups.add(group)
      out.push(chapterSection(group))
    }

    if (
      opts.hasUnassigned &&
      !unassignedHeadingInserted &&
      def.id.startsWith("function:") &&
      (numbers.get(def.id) ?? "").startsWith(`${opts.unassignedNumber}.`)
    ) {
      out.push(unassignedFunctionsSection(opts.unassignedNumber))
      unassignedHeadingInserted = true
    }

    const state = stateById.get(def.id)
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

/** T15 review T8: `group:*` là heading chèn lúc assemble (review C4/Th1), không phải section logic
 * của contract — không tính vào `sections` của `assembleResponseSchema`. */
const countRealSections = (sections: RenderedSection[]): number => sections.filter((s) => !s.id.startsWith("group:")).length

// ─── dựng RenderedDocument hoàn chỉnh ───────────────────────────

export interface AssembleDeps {
  loadDiagramPng: DiagramPngLoader
  now: () => Date
  /** T15 review T7: tra tên hiển thị cho `changes[].by` trong §I — mặc định giữ nguyên id (đủ cho test thuần, không cần DB). */
  resolveInCharge?: (by: string) => string
  /** T15 review C3/Th4: gọi khi tải xong ảnh — `missing` khác rỗng ⇒ caller không ghi cache. */
  onImagesLoaded?: (result: ImageLoadResult) => void
  /** T15 review Th2: gọi khi S-8.4 chạy xong — caller quyết log/trả `meta`, không tự `console.warn` ở đây. */
  onConsistencyFindings?: (findings: ConsistencyFinding[]) => void
}

const defaultDeps = (): AssembleDeps => ({ loadDiagramPng: defaultDiagramPngLoader, now: () => new Date() })

interface BuildDocumentInput {
  projectId: string
  projectName: string
  spine: Spine
  /** Changes dùng để tính status/stale (rỗng cho baseline — không có mốc so sánh đáng tin). */
  statusChanges: StatusChanges
  /** Changes dùng để dựng §I (cả lịch sử hiện có, kể cả bản baseline — xem ghi chú ở `getBaselineDocument`). */
  recordChanges: ChangeRecordRow[]
  source: RenderSource
  version: string
  partial?: boolean
}

/** Dựng `RenderedDocument` — hàm thuần theo nghĩa I/O (chỉ tải ảnh), dùng chung cho draft/baseline. */
async function buildDocument(input: BuildDocumentInput, deps: AssembleDeps): Promise<RenderedDocument> {
  const { projectId, projectName, spine, source, version } = input
  const imageResult = await preloadDiagramPngs(projectId, spine, deps.loadDiagramPng)
  deps.onImagesLoaded?.(imageResult)

  const { numbers, unassignedNumber, hasUnassigned } = buildNumberMap(spine)
  const states = computeSectionStates(spine, input.statusChanges)
  const sections = buildSections(spine, imageResult.loaded, numbers, states, {
    partial: input.partial ?? false,
    unassignedNumber,
    hasUnassigned
  })

  const findings = await runConsistencyPass(spine, sections)
  deps.onConsistencyFindings?.(findings)

  const doc: RenderedDocument = {
    projectId,
    projectName,
    version,
    source,
    generatedAt: deps.now().toISOString(),
    sections,
    recordOfChanges: buildRecordOfChanges(input.recordChanges, deps.resolveInCharge),
    flagsAppendix: buildFlagsAppendix(spine, input.statusChanges, numbers, source, states)
  }
  if (source === "draft") doc.watermark = "DRAFT"
  return doc
}

// ─── POST /projects/:id/assemble ────────────────────────────────

export interface AssembleResult {
  spine_version: number
  sections: number
  generated_at: string
  /** T15 review Th2: findings S-8.4 — controller trả qua `meta.consistency`, không còn `console.warn` toàn bộ. */
  findings: ConsistencyFinding[]
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

  // T15 review T3: assemble chỉ ĐỌC Spine — tạo Spine rỗng là việc của spine.repository/op-engine,
  // không phải của bước assemble (trước đây dùng getOrCreate, âm thầm ghi Spine rỗng nếu chưa có).
  const record = await spineRepository.get(projectId)
  if (!record) throw new ApiError(404, "Không tìm thấy Spine của dự án", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }

  const cached = await RenderedDocumentCache.findOne({ projectId, spine_version: record.spine_version }, null, { lean: true })
  if (cached) {
    // T15 review T2: cache hỏng (dữ liệu cũ, lỗi ghi thủ công…) không được làm 500 lộ chi tiết ra ngoài.
    const parsed = renderedDocumentSchema.safeParse(cached.doc)
    if (!parsed.success) throw new ApiError(422, "Bản ghi cache RenderedDocument không hợp lệ", "RENDERED_DOCUMENT_INVALID")
    return { spine_version: record.spine_version, sections: countRealSections(parsed.data.sections), generated_at: parsed.data.generatedAt, findings: [] }
  }

  const { projectId: _projectId, ...spine } = record
  const changes = await spineRepository.listChanges(projectId)
  const recordChanges = await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges)

  let imageResult: ImageLoadResult | undefined
  let findings: ConsistencyFinding[] = []
  const doc = await buildDocument(
    {
      projectId,
      projectName,
      spine,
      statusChanges: changes,
      recordChanges,
      source: "draft",
      version: `v0.${record.spine_version}`
    },
    {
      ...merged,
      resolveInCharge,
      onImagesLoaded: (r) => {
        imageResult = r
      },
      onConsistencyFindings: (f) => {
        findings = f
      }
    }
  )

  if (imageResult && imageResult.missing.length > 0) {
    // T15 review C3: ảnh thiếu không chặn assemble, nhưng KHÔNG cache bản thiếu ảnh — lần sau thử lại.
    console.warn(`[assemble] ${imageResult.missing.length} diagram PNG chưa tải được cho project ${projectId} — không ghi cache`)
  } else {
    await upsertCache(
      { projectId, spine_version: record.spine_version },
      {
        assembled_at_version: record.spine_version,
        generated_at: new Date(doc.generatedAt),
        doc: stripImagesForCache(doc, imageResult?.loaded ?? new Map())
      }
    )
    await pruneOldDraftCache(projectId)
  }

  return { spine_version: record.spine_version, sections: countRealSections(doc.sections), generated_at: doc.generatedAt, findings }
}

// ─── GET /projects/:id/document, GET /projects/:id/export/word ──

export interface DocumentQuery {
  source: RenderSource
  baseline_id?: string
}

const getDraftDocument = async (projectId: string, loadDiagramPng: DiagramPngLoader): Promise<RenderedDocument> => {
  const cached = await RenderedDocumentCache.findOne(
    { projectId, spine_version: { $exists: true } },
    null,
    { lean: true, sort: { spine_version: -1 } }
  )
  if (!cached) throw new NoWorkingDraftError()
  const parsed = renderedDocumentSchema.safeParse(cached.doc)
  if (!parsed.success) throw new ApiError(422, "Bản ghi cache RenderedDocument không hợp lệ", "RENDERED_DOCUMENT_INVALID")
  return rehydrateImages(parsed.data, projectId, loadDiagramPng)
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
  const baselineIdStr = String(baseline._id)

  // T15 review T5: baseline bất biến — cache theo baseline._id, không dựng lại mỗi lần xem.
  const cacheFilter = { projectId, baseline_id: baselineIdStr }
  const cached = await RenderedDocumentCache.findOne(cacheFilter, null, { lean: true })
  if (cached) {
    const parsed = renderedDocumentSchema.safeParse(cached.doc)
    if (!parsed.success) throw new ApiError(422, "Bản ghi cache RenderedDocument không hợp lệ", "RENDERED_DOCUMENT_INVALID")
    return rehydrateImages(parsed.data, projectId, deps.loadDiagramPng)
  }

  // T15 review T2: snapshot hỏng (dữ liệu cũ, migrate lỗi…) không được làm 500 lộ chi tiết ra ngoài.
  const parsedSpine = spineSchema.safeParse(baseline.snapshot)
  if (!parsedSpine.success) throw new ApiError(422, "Baseline snapshot không hợp lệ", "BASELINE_SNAPSHOT_INVALID")
  const spine = parsedSpine.data

  // §I hiển thị lịch sử đầy đủ hiện có (chưa có mốc "seq tại lúc ký" trong Baseline — T19 chưa chốt);
  // status/stale của section thì tính với changes rỗng vì không có gì để so — tránh stale giả cho bản đã ký.
  const recordChanges = await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges)

  let imageResult: ImageLoadResult | undefined
  const doc = await buildDocument(
    {
      projectId,
      projectName,
      spine,
      statusChanges: [],
      recordChanges,
      source: "baseline",
      version: String(baseline.version)
    },
    {
      ...deps,
      resolveInCharge,
      onImagesLoaded: (r) => {
        imageResult = r
      }
    }
  )

  if (imageResult && imageResult.missing.length > 0) {
    console.warn(`[assemble] ${imageResult.missing.length} diagram PNG chưa tải được cho baseline ${baselineIdStr} — không ghi cache`)
  } else {
    await upsertCache(cacheFilter, {
      generated_at: new Date(doc.generatedAt),
      doc: stripImagesForCache(doc, imageResult?.loaded ?? new Map())
    })
  }

  return doc
}

export async function getDocument(
  projectId: string,
  projectName: string,
  query: DocumentQuery,
  deps: Partial<AssembleDeps> = {}
): Promise<RenderedDocument> {
  const merged: AssembleDeps = { ...defaultDeps(), ...deps }
  if (query.source === "baseline") return getBaselineDocument(projectId, projectName, query.baseline_id, merged)
  return getDraftDocument(projectId, merged.loadDiagramPng)
}

// ─── review C2: meta độ mới của bản draft ────────────────────────

export interface DraftMeta {
  assembled_at_version: number
  spine_version: number
  stale: boolean
}

/**
 * T15 review C2: `GET /document?source=draft` trước đây âm thầm trả bản cache mới nhất dù Spine đã
 * đổi tiếp sau lần assemble cuối. Controller (render.controller.ts, export.controller.ts) gọi hàm
 * này để đính kèm độ mới — `null` khi chưa từng assemble (cùng điều kiện với `NoWorkingDraftError`).
 */
export async function getDraftMeta(projectId: string): Promise<DraftMeta | null> {
  const cached = await RenderedDocumentCache.findOne(
    { projectId, spine_version: { $exists: true } },
    { assembled_at_version: 1 },
    { lean: true, sort: { spine_version: -1 } }
  )
  if (!cached || typeof cached.assembled_at_version !== "number") return null
  const record = await spineRepository.get(projectId)
  const spine_version = record?.spine_version ?? cached.assembled_at_version
  return { assembled_at_version: cached.assembled_at_version, spine_version, stale: cached.assembled_at_version !== spine_version }
}

// exported for tests that need to build a document without the cache/HTTP layer (dev `partial`)
export const _internal = { buildDocument, buildNumberMap, buildSections }
