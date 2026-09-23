/**
 * assemble.service.ts
 * ─────────────────────────────────────────────────────────────────
 * S-8.2 Document Assembly + S-8.3 Record of Changes: ghép `RenderedSection[]` (section-renderer.ts)
 * theo đúng thứ tự template FPT, sinh số hiệu section (Product-Brief-to-SRS-Phases.md §6.3), chèn ảnh,
 * dựng §I từ `changes[]`, gắn phụ lục cờ — thành một `RenderedDocument` hoàn chỉnh.
 *
 * `source = draft`  : dựng từ Spine sống, cache theo `spine_version` (collection `rendered_documents`).
 * `source = baseline`: dựng từ `Baseline.snapshot` (T19) — không đọc Spine hiện tại (srs-spine.md §2.1),
 *                       cache theo `Baseline._id` (bất biến — T15 review T5). `baseline_id` nhận cả `_id` Mongo
 *                       lẫn mã `BLnnn` của `Spine.baselines[]`; Spine chỉ được đọc để đổi mã thành `_id`
 *                       (`resolveBaselineObjectId`), không để lấy nội dung.
 *
 * Ảnh sơ đồ: section luôn sinh **tham chiếu** `diagram-ref:<id>` (không base64 — tránh phình cache tới trần
 * 16MB), cache giữ nguyên dạng đó; lúc trả về mới phân giải (`materializeImages`): PNG tải được ⇒ ảnh thật,
 * không ⇒ ảnh placeholder + caption nêu rõ sơ đồ chưa render. Nhờ vậy thiếu PNG **không chặn cache** (trước đây
 * `POST /assemble` 200 nhưng không ghi cache ⇒ `GET /document` 409 mà client không biết vì sao — spec-gaps
 * FLF-166, thay quyết định T15 review C3/Th4), và PNG xuất hiện sau thì lần đọc kế có ảnh thật mà không cần
 * `spine_version` mới hay dựng lại baseline.
 *
 * Mode 1 v2 (FLF-184): project có layout file upload (`TemplateProfile.layout`) ⇒ thứ tự + tiêu đề + số hiệu theo file
 * đó (`layout-sections.ts`) thay cho mẫu FPT; nội dung section vẫn từ Spine.
 *
 * KHÔNG ghi Spine ở đây — chỉ đọc (`spine.repository`, `Baseline`, `Change`, `User`, `TemplateProfile`) và ghi cache riêng
 * (`RenderedDocumentCache`, không phải collection `spines`).
 */

import mongoose from "mongoose"
import * as spineRepository from "../spine/spine.repository.js"
import { listSections } from "../spine/section-registry.js"
import { computeSectionStates, readiness, type SectionStateView } from "../spine/section-status.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { systemName } from "../spine/system-name.js"
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
import { missingImageFindings, runConsistencyPass, type ConsistencyFinding } from "./consistency-pass.js"
import { DIAGRAM_PLACEHOLDER_PNG, pendingImageCaption } from "./diagram-placeholder.js"
import { RenderedDocumentCache } from "./rendered-document.model.js"
import { buildLayoutSections, type TemplateLayout } from "./layout-sections.js"
// Mode 1 v2 (FLF-184): layout của file người dùng upload — chỉ đọc
import { TemplateProfile } from "../import/template-profile.model.js"
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
  /**
   * Id diagram `render_status="ok"` nhưng tải PNG lỗi/null. Không chặn cache: tài liệu trả về dùng placeholder,
   * `POST /assemble` báo qua finding `diagram_png_missing`, danh sách này lưu kèm cache (`missing_diagram_ids`).
   */
  missing: string[]
}

/** T15 review Th4: giới hạn 4 tải song song một lô — tránh fan-out không giới hạn khi có nhiều ảnh. */
const IMAGE_LOAD_BATCH_SIZE = 4

/** Tải PNG theo lô cho một danh sách diagram id — dùng chung cho lúc build, lúc đọc cache và lúc kiểm lại ảnh thiếu. */
const loadDiagramPngs = async (projectId: string, diagramIds: readonly string[], load: DiagramPngLoader): Promise<ImageLoadResult> => {
  const loaded = new Map<string, string>()
  const missing: string[] = []
  for (let i = 0; i < diagramIds.length; i += IMAGE_LOAD_BATCH_SIZE) {
    const batch = diagramIds.slice(i, i + IMAGE_LOAD_BATCH_SIZE)
    const results = await Promise.all(batch.map(async (id) => [id, await load(projectId, id)] as const))
    for (const [id, png] of results) {
      // File rỗng cũng là thiếu: writer không nhúng được và người đọc cần thấy placeholder có lý do
      if (png === null || png.length === 0) missing.push(id)
      else loaded.set(id, png)
    }
  }
  return { loaded, missing }
}

const preloadDiagramPngs = (projectId: string, spine: Spine, load: DiagramPngLoader): Promise<ImageLoadResult> =>
  loadDiagramPngs(
    projectId,
    spine.diagrams.filter((d) => d.render_status === "ok").map((d) => d.id),
    load
  )

// ─── ảnh dạng tham chiếu trong section/cache; phân giải lúc trả về (review T6, FLF-166) ──────

/** Ô `png` là tham chiếu diagram id (`diagram-ref:<id>`), chưa phải PNG thật. */
const IMAGE_REF_PREFIX = "diagram-ref:"

const isImageBlock = (b: Block): b is ImageBlock => b.type === "image"

const imageRef = (diagramId: string): string => `${IMAGE_REF_PREFIX}${diagramId}`

const refDiagramId = (b: Block): string | null =>
  isImageBlock(b) && typeof b.png === "string" && b.png.startsWith(IMAGE_REF_PREFIX) ? b.png.slice(IMAGE_REF_PREFIX.length) : null

/**
 * Thay mọi tham chiếu ảnh bằng PNG thật (`resolve` trả base64) — không có ⇒ ảnh placeholder + caption nêu rõ
 * sơ đồ chưa render. Trước đây ảnh không tải lại được bị bỏ khỏi section; giữ block để người đọc thấy lý do
 * thay vì thiếu hình lặng lẽ (kể cả bản draft đã `stale` hay sơ đồ bị xoá sau khi cache).
 */
const materializeImages = (doc: RenderedDocument, resolve: (diagramId: string) => string | null): RenderedDocument => {
  const materialize = (b: Block): Block => {
    const id = refDiagramId(b)
    if (id === null || !isImageBlock(b)) return b
    const png = resolve(id)
    return png ? { ...b, png } : { ...b, png: DIAGRAM_PLACEHOLDER_PNG, caption: pendingImageCaption(b.caption, id) }
  }
  return { ...doc, sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map(materialize) })) }
}

const resolveLoaded =
  (images: ImageLoadResult) =>
  (diagramId: string): string | null =>
    images.loaded.get(diagramId) ?? null

const warnMissingImages = (images: ImageLoadResult, target: string): void => {
  if (images.missing.length > 0) {
    console.warn(`[assemble] ${images.missing.length} diagram PNG chưa tải được cho ${target} (${images.missing.join(", ")}) — tài liệu dùng placeholder tới khi có ảnh`)
  }
}

/** Sau khi đọc cache: tải lại PNG (theo lô) cho mọi tham chiếu rồi phân giải — PNG có sau lúc cache vẫn hiện ảnh thật. */
const rehydrateImages = async (doc: RenderedDocument, projectId: string, load: DiagramPngLoader): Promise<RenderedDocument> => {
  const refs = new Set<string>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      const id = refDiagramId(block)
      if (id !== null) refs.add(id)
    }
  }
  if (refs.size === 0) return doc

  const images = await loadDiagramPngs(projectId, [...refs], load)
  warnMissingImages(images, `project ${projectId} (đọc cache)`)
  return materializeImages(doc, resolveLoaded(images))
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
  path: string
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
    path: d.path,
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

const buildFlagRow = (spine: Spine, flag: Flag, numbers: Map<string, string>, titles?: Map<string, string>): FlagRow => {
  // Layout người dùng (có `titles`): số hiệu mẫu FPT không còn đúng ⇒ không suy từ khoá logic
  const fallbackNumber = titles ? "" : flag.section_id.startsWith("fixed:") ? flag.section_id.slice("fixed:".length) : flag.section_id
  const number = numbers.get(flag.section_id) ?? fallbackNumber
  let heading = titles?.get(flag.section_id) ?? flag.section_id
  if (!titles?.has(flag.section_id)) {
    try {
      heading = sectionHeadingOf(spine, flag.section_id)
    } catch {
      // section_id không phân giải được (dữ liệu cũ, mục riêng đã xoá) — giữ khoá logic thô thay vì ném lỗi cả tài liệu
    }
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
  states: SectionStateView[],
  titles?: Map<string, string>
): FlagsAppendix => {
  const waived = spine.flags.filter((f) => f.waived_by_user).map((f) => buildFlagRow(spine, f, numbers, titles))
  if (source === "baseline") {
    // srs-spine.md §6: bản baseline chỉ cần in danh sách waive — không có cờ đỏ mở (điều kiện ký baseline).
    return { redOpen: [], staleCount: 0, waived }
  }
  const redOpen = spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && !f.waived_by_user)
  // T15 review T4: dùng lại `states` đã tính một lần ở buildDocument thay vì computeSectionStates lần nữa.
  return { redOpen: redOpen.map((f) => buildFlagRow(spine, f, numbers, titles)), staleCount: readiness(spine, changes, states).stale, waived }
}

// ─── dựng sections[] ────────────────────────────────────────────

interface BuildSectionsOptions {
  /** Chỉ dùng nội bộ (dev) — bỏ section rỗng. KHÔNG lộ qua `assembleRequestSchema` (đóng băng). */
  partial?: boolean
  unassignedNumber: string
  hasUnassigned: boolean
}

const buildSections = (spine: Spine, numbers: Map<string, string>, states: SectionStateView[], opts: BuildSectionsOptions): RenderedSection[] => {
  const stateById = new Map(states.map((s) => [s.id, s]))
  const numberOfCtx = (id: string): string | undefined => numbers.get(id)
  // Mọi sơ đồ render_status=ok đều vào section dưới dạng tham chiếu; PNG thật/placeholder gắn lúc trả về
  const diagramPng = (id: string): string | undefined => imageRef(id)

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
  /** Gọi khi tải xong ảnh (quan sát/log). `missing` không còn chặn cache — xem chú thích đầu file. */
  onImagesLoaded?: (result: ImageLoadResult) => void
  /** T15 review Th2: gọi khi S-8.4 chạy xong — caller quyết log/trả `meta`, không tự `console.warn` ở đây. */
  onConsistencyFindings?: (findings: ConsistencyFinding[]) => void
  /** Mode 1 v2 (FLF-184): layout của file upload — `null` ⇒ thứ tự + số hiệu mẫu FPT (mode 2). */
  loadTemplate?: TemplateLoader
}

export type TemplateLoader = (projectId: string) => Promise<TemplateLayout | null>

/** Layout người dùng của project mode 1 (sau finalize import). Project mode 2 / import cũ chưa có layout ⇒ `null`. */
export const loadTemplateLayout: TemplateLoader = async (projectId) => {
  const profile = (await TemplateProfile.findOne({ projectId }, { layout: 1, language: 1, legacy_record_of_changes: 1 }, { lean: true })) as
    | { layout?: TemplateLayout["layout"]; language?: string; legacy_record_of_changes?: TemplateLayout["legacyRecord"] }
    | null
  if (!profile?.layout?.length) return null
  return { layout: profile.layout, language: profile.language ?? "en", legacyRecord: profile.legacy_record_of_changes ?? [] }
}

const defaultDeps = (): AssembleDeps => ({ loadDiagramPng: defaultDiagramPngLoader, now: () => new Date(), loadTemplate: loadTemplateLayout })

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
  /** Layout của file người dùng (mode 1 v2) — không có ⇒ mẫu FPT. */
  template?: TemplateLayout | null
}

interface BuiltDocument {
  /** Tài liệu với ảnh ở dạng tham chiếu — đúng dạng ghi cache. */
  refDoc: RenderedDocument
  images: ImageLoadResult
}

/** Dựng tài liệu dạng tham chiếu + kết quả tải ảnh — hàm thuần theo nghĩa I/O (chỉ tải ảnh), dùng chung cho draft/baseline. */
async function buildDocumentParts(input: BuildDocumentInput, deps: AssembleDeps): Promise<BuiltDocument> {
  const { projectId, projectName, spine, source, version } = input
  const images = await preloadDiagramPngs(projectId, spine, deps.loadDiagramPng)
  deps.onImagesLoaded?.(images)

  const states = computeSectionStates(spine, input.statusChanges)
  let sections: RenderedSection[]
  let numbers: Map<string, string>
  let titles: Map<string, string> | undefined
  if (input.template) {
    // Mode 1 v2: thứ tự + tiêu đề + số hiệu theo file người dùng (layout-sections.ts)
    ;({ sections, numbers, titles } = buildLayoutSections(spine, input.template, states, {
      partial: input.partial ?? false,
      diagramPng: imageRef
    }))
  } else {
    const map = buildNumberMap(spine)
    numbers = map.numbers
    sections = buildSections(spine, numbers, states, {
      partial: input.partial ?? false,
      unassignedNumber: map.unassignedNumber,
      hasUnassigned: map.hasUnassigned
    })
  }

  const findings = await runConsistencyPass(spine, sections)
  deps.onConsistencyFindings?.(findings)

  const refDoc: RenderedDocument = {
    projectId,
    // FLF-177: bìa, tiêu đề và tên file in tên hệ thống; chưa đặt ⇒ tên project như trước
    projectName: systemName(spine.project, projectName),
    version,
    source,
    generatedAt: deps.now().toISOString(),
    sections,
    // T15 (mode 1 v3): lịch sử sửa đổi của khách (file gốc) đứng trước, lịch sử FlintFlow nối tiếp
    recordOfChanges: [...(input.template?.legacyRecord ?? []), ...buildRecordOfChanges(input.recordChanges, deps.resolveInCharge)],
    flagsAppendix: buildFlagsAppendix(spine, input.statusChanges, numbers, source, states, titles)
  }
  if (source === "draft") refDoc.watermark = "DRAFT"
  return { refDoc, images }
}

/** Dựng `RenderedDocument` sẵn ảnh (PNG thật hoặc placeholder) — cho writer/test gọi trực tiếp, không qua cache. */
async function buildDocument(input: BuildDocumentInput, deps: AssembleDeps): Promise<RenderedDocument> {
  const { refDoc, images } = await buildDocumentParts(input, deps)
  return materializeImages(refDoc, resolveLoaded(images))
}

/**
 * Trúng cache: kiểm lại **chỉ** các id đã ghi là thiếu (danh sách nhỏ) — PNG được khôi phục sau đó (không đổi
 * `spine_version`) thì finding tự hết thay vì báo thiếu mãi; danh sách thu hẹp được ghi lại vào cache.
 */
const recheckMissingImages = async (
  projectId: string,
  cacheId: unknown,
  recorded: readonly string[],
  load: DiagramPngLoader
): Promise<string[]> => {
  if (recorded.length === 0) return []
  const { missing } = await loadDiagramPngs(projectId, recorded, load)
  if (missing.length !== recorded.length) {
    await RenderedDocumentCache.updateOne({ _id: cacheId }, { $set: { missing_diagram_ids: missing } })
  }
  return missing
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
    // Trúng cache vẫn báo ảnh thiếu — client gọi lại cùng version không bị mất lý do; ảnh đã có lại thì hết báo
    const stillMissing = await recheckMissingImages(projectId, cached._id, cached.missing_diagram_ids ?? [], merged.loadDiagramPng)
    return {
      spine_version: record.spine_version,
      sections: countRealSections(parsed.data.sections),
      generated_at: parsed.data.generatedAt,
      findings: missingImageFindings(stillMissing)
    }
  }

  const { projectId: _projectId, ...spine } = record
  const changes = await spineRepository.listChanges(projectId)
  const recordChanges = await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges)
  const template = await (merged.loadTemplate ?? loadTemplateLayout)(projectId)

  let findings: ConsistencyFinding[] = []
  const { refDoc, images } = await buildDocumentParts(
    {
      projectId,
      projectName,
      spine,
      statusChanges: changes,
      recordChanges,
      source: "draft",
      version: `v0.${record.spine_version}`,
      template
    },
    {
      ...merged,
      resolveInCharge,
      onConsistencyFindings: (f) => {
        findings = f
      }
    }
  )

  warnMissingImages(images, `project ${projectId}`)
  await upsertCache(
    { projectId, spine_version: record.spine_version },
    {
      assembled_at_version: record.spine_version,
      generated_at: new Date(refDoc.generatedAt),
      doc: refDoc,
      missing_diagram_ids: images.missing
    }
  )
  await pruneOldDraftCache(projectId)

  return {
    spine_version: record.spine_version,
    sections: countRealSections(refDoc.sections),
    generated_at: refDoc.generatedAt,
    findings: [...findings, ...missingImageFindings(images.missing)]
  }
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

/** Mã baseline hiển thị `BLnnn` — `Spine.baselines[].id` do `baseline.service.nextBaselineId` sinh. */
const BASELINE_DISPLAY_ID = /^BL\d+$/

const baselineNotFound = (): ApiError => new ApiError(404, "Baseline không tồn tại", "BASELINE_NOT_FOUND")

/**
 * `baseline_id` của `GET /document` và `GET /export/word` nhận cả `_id` Mongo (= `snapshot_ref`) lẫn mã `BLnnn`
 * mà `POST /baseline` / `GET /baselines` trả — cùng một hợp đồng, không cần client biết `snapshot_ref`.
 * Mã `BLnnn` đổi sang `_id` qua `Spine.baselines[].snapshot_ref`; mọi trường hợp không phân giải được đều 404
 * (kể cả `snapshot_ref` không phải ObjectId — schema chỉ ràng buộc chuỗi — để Mongoose không ném `CastError` thành 500).
 * `undefined` ⇒ baseline mới nhất.
 */
const resolveBaselineObjectId = async (projectId: string, baselineId: string | undefined): Promise<string | undefined> => {
  if (baselineId === undefined) return undefined
  if (mongoose.isValidObjectId(baselineId)) return baselineId
  if (!BASELINE_DISPLAY_ID.test(baselineId)) throw baselineNotFound()
  // Đọc projection nhỏ, không nạp/validate cả Spine cho một lượt xem baseline
  const ref = (await spineRepository.listBaselineRefs(projectId)).find((b) => b.id === baselineId)?.snapshot_ref
  if (ref === undefined || !mongoose.isValidObjectId(ref)) throw baselineNotFound()
  return ref
}

const getBaselineDocument = async (
  projectId: string,
  projectName: string,
  baselineId: string | undefined,
  deps: AssembleDeps
): Promise<RenderedDocument> => {
  const objectId = await resolveBaselineObjectId(projectId, baselineId)
  const filter = objectId ? { projectId, _id: objectId } : { projectId }
  const baseline = await Baseline.findOne(filter, null, { lean: true, sort: { at: -1 } })
  if (!baseline) throw baselineNotFound()
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

  const { refDoc, images } = await buildDocumentParts(
    {
      projectId,
      projectName,
      spine,
      statusChanges: [],
      recordChanges,
      source: "baseline",
      version: String(baseline.version),
      template: await (deps.loadTemplate ?? loadTemplateLayout)(projectId)
    },
    { ...deps, resolveInCharge }
  )

  // Cache dạng tham chiếu kể cả khi thiếu PNG: baseline đã ký không bị "placeholder vĩnh viễn" vì mỗi lần đọc
  // đều thử tải lại ảnh (rehydrateImages) — PNG có sau ⇒ ảnh thật mà không cần dựng lại.
  warnMissingImages(images, `baseline ${baselineIdStr}`)
  await upsertCache(cacheFilter, { generated_at: new Date(refDoc.generatedAt), doc: refDoc, missing_diagram_ids: images.missing })

  return materializeImages(refDoc, resolveLoaded(images))
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

// ─── mode 1 v2: file version tài liệu dựng từ snapshot Spine (FLF-184) ──

/**
 * `RenderedDocument` sẵn ảnh của một snapshot Spine (không qua cache) — `doc-version` ghi thành file `.docx` cho
 * version mode 1 (bản `0.0` sau import; V4: bản ghi CR, release). Theo layout của project nếu có.
 */
export async function renderSpineDocument(
  projectId: string,
  projectName: string,
  spine: Spine,
  opts: {
    version: string
    source: RenderSource
    /** Change chưa ghi DB nhưng thuộc snapshot (C-7 render trước khi ghi Spine — FLF-186) — nối vào §I. */
    pendingRecord?: ChangeRecordRow[]
  },
  deps: Partial<AssembleDeps> = {}
): Promise<RenderedDocument> {
  const merged: AssembleDeps = { ...defaultDeps(), ...deps }
  const recordChanges = [...(await listChangesForRecord(projectId)), ...(opts.pendingRecord ?? [])]
  const resolveInCharge = await buildInChargeResolver(recordChanges)
  return buildDocument(
    {
      projectId,
      projectName,
      spine,
      statusChanges: [],
      recordChanges,
      source: opts.source,
      version: opts.version,
      template: await (merged.loadTemplate ?? loadTemplateLayout)(projectId)
    },
    { ...merged, resolveInCharge }
  )
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
