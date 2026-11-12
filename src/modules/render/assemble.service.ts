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
 * FLF-265: ngôn ngữ tài liệu ≠ ngôn ngữ gốc của Spine (mode 2 `vi`) ⇒ `getDocumentWithMeta` dựng mỗi lần từ bản xem đã
 * dịch (`localized-spine.ts` + lớp bản dịch theo hash chữ gốc), KHÔNG qua cache. Cache chỉ giữ bản ngôn ngữ gốc, khoá
 * không đổi.
 *
 * KHÔNG ghi Spine ở đây — chỉ đọc (`spine.repository`, `Baseline`, `Change`, `User`, `TemplateProfile`) và ghi cache riêng
 * (`RenderedDocumentCache`, không phải collection `spines`).
 */

import mongoose from "mongoose"
import { z } from "zod"
import * as spineRepository from "../spine/spine.repository.js"
import { listSections } from "../spine/section-registry.js"
import { computeSectionStates, readiness, type SectionStateView } from "../spine/section-status.js"
import { spineSchema } from "../spine/spine.schema.js"
import type { Flag, Spine } from "../spine/spine.types.js"
import { systemName } from "../spine/system-name.js"
import { Baseline } from "../spine/baseline.model.js"
// T15 review T5: đọc Change model trực tiếp (chỉ đọc) — projection nhẹ cho §I, không qua
// spine.repository.listChanges (tải cả before/value, không cần cho Record of Changes).
import { createChangeLog } from "../spine/change-log.js"
// T15 review T7: tra tên người ghi thay cho userId thô trong §I (chỉ đọc).
import { User } from "../user/user.model.js"
import { ChangeRequest } from "../change-request/change-request.model.js"
import { loadDiagramFile } from "../diagram/diagram.service.js"
import { localizedDiagramPng, type DiagramSource } from "../diagram/localized-diagram.service.js"
import { capitalize, sectionLabel } from "../spine/human-labels.js"
import {
  defaultSectionTitle,
  renderSection,
  sectionHeadingOf,
  buildRecordOfChanges,
  type ChangeRecordRow,
  type SectionRenderContext
} from "./section-renderer.js"
import { missingImageFindings, omittedTemplateSectionFindings, runConsistencyPass, type ConsistencyFinding } from "./consistency-pass.js"
import { DIAGRAM_PLACEHOLDER_PNG, pendingImageCaption } from "./diagram-placeholder.js"
import { GROUP_HEADINGS, assembleTextFor, isVietnamese, type DocumentLanguage } from "./labels.js"
import { loadRenderContext } from "../diagram/render-context.js"
import { localizeSpine, localizedDiagramSources, renderView, type LocalizedSpine } from "./localized-spine.js"
import { translationUnits, type TranslationUnit } from "../translation/translation-units.js"
import { resolveTranslations, type ProjectLanguages, type ResolvedTranslations } from "../translation/translation.service.js"
import { translationRevision } from "../translation/translation.repository.js"
import type { UserLocale } from "../../shared/i18n/locale.js"
import { documentTranslationMetaSchema } from "../pipeline/pipeline.dto.js"
import { RenderedDocumentCache } from "./rendered-document.model.js"
import { cacheMemoKey, createMemo } from "./rendered-document-memo.js"
import { buildLayoutSections, type TemplateLayout } from "./layout-sections.js"
import { rearrangeOf } from "./source-fidelity.js"
// Mode 1 v2 (FLF-184): layout của file người dùng upload — chỉ đọc
import { TemplateProfile } from "../import/template-profile.model.js"
import { Project } from "../project/project.model.js"
import { MEDIA_PREFIX, isMediaId, loadImportMedia, mediaId } from "./import-media.js"
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
import { draftVersionLabel } from "./draft-version.js"
import { ApiError } from "../../shared/utils/api-error.js"

export const NO_WORKING_DRAFT = "NO_WORKING_DRAFT"

/**
 * 409 — `source=draft` khi project chưa có gì để dựng tài liệu (chưa có Spine: dự án vừa tạo, chưa chạy bước nào).
 * Từ FLF-264, Spine đã có thì `GET /document` tự dựng bản thiếu, nên lỗi này không còn nghĩa "chưa chạy S-8.2".
 */
export class NoWorkingDraftError extends ApiError {
  constructor() {
    super(409, "Dự án chưa có nội dung nào để dựng tài liệu.", NO_WORKING_DRAFT)
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
 * cứng trước đây (chỉ phủ 4 chương, thiếu 3 nhóm con — review C4). Bảng theo ngôn ngữ ở `labels.ts` (FLF-265).
 */
const groupHeadings = (language?: string): Readonly<Record<string, string>> => GROUP_HEADINGS[isVietnamese(language) ? "vi" : "en"]

/** `"4.2.1"` cha `"4.2"` → chuỗi tổ tiên `["4", "4.2"]`. `feature:<id>` (cha của function) không có nhóm số. */
const parentChain = (parent: string | undefined): string[] => {
  if (!parent || parent.startsWith("feature:")) return []
  const parts = parent.split(".")
  return parts.map((_, i) => parts.slice(0, i + 1).join("."))
}

const chapterSection = (number: string, language?: string): RenderedSection => ({
  id: `group:${number}`,
  number,
  heading: groupHeadings(language)[number] ?? number,
  level: number.split(".").length,
  blocks: []
})

/** T15 review Th1: heading "Unassigned Functions" — chỉ chèn khi thật sự có function feature_id chết. */
const unassignedFunctionsSection = (number: string, language?: string): RenderedSection => ({
  id: "group:unassigned-functions",
  number,
  heading: assembleTextFor(language).unassignedFunctions,
  level: 2,
  blocks: []
})

// ─── ảnh diagram ─────────────────────────────────────────────────

/**
 * `warm` (tuỳ chọn): nạp sẵn thứ loader cần cho cả lượt (metadata PNG, `file_ref`) — caller chạy song song với lượt đọc
 * cache để khỏi nối tiếp round-trip (FLF-383). Loader không có `warm` ⇒ bỏ qua.
 */
export type DiagramPngLoader = ((projectId: string, diagramId: string) => Promise<string | null>) & {
  warm?: (projectId: string) => Promise<void>
}

/** Nạp sẵn của loader, lỗi nuốt — loader tự hỏi lại lúc phân giải từng ảnh. */
const warmLoader = (load: DiagramPngLoader, projectId: string): Promise<void> =>
  load.warm ? load.warm(projectId).catch(() => undefined) : Promise.resolve()

const defaultDiagramPngLoader: DiagramPngLoader = async (projectId, diagramId) => {
  // Phase 5 (T3): ảnh gốc của mục riêng — lấy từ file upload, không phải file diagram
  if (isMediaId(diagramId)) return loadImportMedia(projectId, diagramId.slice(MEDIA_PREFIX.length)).catch(() => null)
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
      // File rỗng cũng là thiếu: writer không nhúng được và người đọc cần thấy placeholder có lý do.
      // Ảnh gốc không nhúng được (EMF/WMF…) không phải "diagram chưa render" — không đưa vào `missing` (khỏi kiểm lại mãi)
      if (png === null || png.length === 0) {
        if (!isMediaId(id)) missing.push(id)
      }
      else loaded.set(id, png)
    }
  }
  return { loaded, missing }
}

/** Id mọi ảnh của tài liệu: sơ đồ đã vẽ + ảnh gốc trong mục riêng (Phase 5 T3). */
const documentImageIds = (spine: Spine): string[] => [
  ...spine.diagrams.filter((d) => d.render_status === "ok").map((d) => d.id),
  ...new Set(spine.custom_sections.flatMap((c) => c.blocks.filter((b) => b.kind === "image" && b.image_ref).map((b) => mediaId(b.image_ref!))))
]

const preloadDiagramPngs = (projectId: string, spine: Spine, load: DiagramPngLoader): Promise<ImageLoadResult> =>
  loadDiagramPngs(projectId, documentImageIds(spine), load)

/** FLF-265 N1 — PNG (base64) của nguồn sơ đồ đã dịch; `null` ⇒ dùng ảnh gốc. Mặc định đọc / vẽ qua PlantUML, không gọi model. */
export type LocalizedDiagramPngLoader = (projectId: string, diagramId: string, locale: string, diagram: DiagramSource) => Promise<string | null>

/**
 * N1 — trần thời gian một lượt dựng chờ vẽ PNG theo ngôn ngữ. Lần đọc đầu sau khi dịch phải vẽ mọi sơ đồ (vài giây với
 * PlantUML local); quá trần ⇒ sơ đồ chưa xong dùng ảnh gốc, lượt vẽ vẫn chạy tiếp và lưu file cho lần đọc sau.
 */
export const LOCALIZED_IMAGE_BUDGET_MS = 8_000

/**
 * Nạp PNG theo ngôn ngữ cho các sơ đồ có nguồn đã dịch — `IMAGE_LOAD_BATCH_SIZE` lượt cùng lúc, mỗi lượt xong là nhận
 * ngay (một sơ đồ chậm chỉ giữ một chỗ, không chặn cả lô) — trong trần `budgetMs`.
 */
const loadLocalizedPngs = async (
  projectId: string,
  locale: string,
  sources: ReadonlyMap<string, DiagramSource>,
  load: LocalizedDiagramPngLoader,
  budgetMs: number
): Promise<{ loaded: Map<string, string>; complete: boolean }> => {
  const loaded = new Map<string, string>()
  if (sources.size === 0) return { loaded, complete: true }
  const entries = [...sources]
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const [id, diagram] = entries[next++]
      const png = await load(projectId, id, locale, diagram).catch(() => null)
      if (png) loaded.set(id, png)
    }
  }
  let complete = false
  const work = Promise.all(Array.from({ length: Math.min(IMAGE_LOAD_BATCH_SIZE, entries.length) }, worker)).then(() => {
    complete = true
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs)
  })
  await Promise.race([work, budget])
  clearTimeout(timer)
  // Bản chụp lúc hết chờ — lượt vẽ còn chạy tiếp không đổi tài liệu đã trả. `complete = false` ⇒ còn sơ đồ đang vẽ:
  // bản dựng này không được nhớ (sẽ kẹt ảnh gốc), lượt sau lấy PNG theo ngôn ngữ đã vẽ xong
  return { loaded: new Map(loaded), complete }
}

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
const materializeImages = (doc: RenderedDocument, resolve: (diagramId: string) => string | null, language?: string): RenderedDocument => {
  const materialize = (b: Block): Block => {
    const id = refDiagramId(b)
    if (id === null || !isImageBlock(b)) return b
    const png = resolve(id)
    if (png) return { ...b, png }
    // Ảnh gốc không nhúng được (EMF/WMF, file gốc không còn) ⇒ chỗ giữ ảnh trống, giữ chú thích gốc nếu có — FLF-411 U1-7:
    // không in câu kỹ thuật ("không nhúng được ảnh gốc…") vào tài liệu của người dùng; lý do đã có ở cờ `import_image_unread`
    if (isMediaId(id)) return { ...b, png: DIAGRAM_PLACEHOLDER_PNG }
    return { ...b, png: DIAGRAM_PLACEHOLDER_PNG, caption: pendingImageCaption(b.caption, id, language) }
  }
  return { ...doc, sections: doc.sections.map((s) => ({ ...s, blocks: s.blocks.map(materialize) })) }
}

const resolveLoaded =
  (images: ImageLoadResult) =>
  (diagramId: string): string | null =>
    images.loaded.get(diagramId) ?? null

const warnMissingImages = (images: ImageLoadResult, target: string): void => {
  if (images.missing.length > 0) {
    console.warn(`[assemble] ${images.missing.length} diagram PNG chưa tải được cho ${target} (${images.missing.join(", ")}) - tài liệu dùng placeholder tới khi có ảnh`)
  }
}

/**
 * Sau khi đọc cache: tải lại PNG (theo lô) cho mọi tham chiếu rồi phân giải — PNG có sau lúc cache vẫn hiện ảnh thật.
 * `language` (FLF-265): ngôn ngữ chú thích placeholder — phải trùng ngôn ngữ đã dựng `doc`. Cache chỉ giữ bản ngôn ngữ
 * gốc (§3.5) nên đường đọc cache không truyền (chú thích như trước); bản theo ngôn ngữ khác không qua cache, chú thích
 * theo ngôn ngữ ở `materializeImages`.
 */
/** Id sơ đồ / media mà tài liệu dạng tham chiếu đang trỏ tới. */
const docImageIds = (doc: RenderedDocument): string[] => {
  const refs = new Set<string>()
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      const id = refDiagramId(block)
      if (id !== null) refs.add(id)
    }
  }
  return [...refs]
}

const rehydrateImages = async (doc: RenderedDocument, projectId: string, load: DiagramPngLoader, language?: string): Promise<RenderedDocument> => {
  const refs = docImageIds(doc)
  if (refs.length === 0) return doc

  const images = await loadDiagramPngs(projectId, refs, load)
  warnMissingImages(images, `project ${projectId} (đọc cache)`)
  return materializeImages(doc, resolveLoaded(images), language)
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
 * cho Record of Changes, có thể lớn với change phức tạp). FLF-381: đọc tăng dần (`spine/change-log.ts`) — lượt sau chỉ
 * tải change mới.
 */
const recordChangeLog = createChangeLog<ChangeRecordRow>(RECORD_CHANGE_PROJECTION, (d: ChangeRecordDoc) => ({
  txn: d.txn,
  at: d.at instanceof Date ? d.at.toISOString() : d.at,
  by: d.by,
  reason: d.reason,
  op: d.op,
  path: d.path,
  step_id: d.step_id
}))

export const listChangesForRecord = (projectId: string): Promise<ChangeRecordRow[]> => recordChangeLog.list(projectId)

const SYSTEM_ACTOR = "system"
const IMPORT_ACTOR = "import"
const shortenId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id)

/**
 * T15 review T7: `changes[].by` là userId thô — tra `User.name`/email theo lô (một query cho mọi
 * txn của §I) để hiển thị thay vì id. `"system"` luôn hiển thị "System"; user không còn (đã xoá)
 * giữ id rút gọn thay vì id đầy đủ.
 */
const buildInChargeResolver = async (changes: ChangeRecordRow[], projectId?: string): Promise<(by: string) => string> => {
  // FLF-411 (U2-6): lô ghi của change request mang `by = mã CR` ⇒ "In charge" là người tạo CR (tên), không phải "CR-001"
  const crIds = projectId ? [...new Set(changes.map((c) => c.by))].filter((id) => CR_ACTOR.test(id)) : []
  const crs = crIds.length === 0
    ? []
    : ((await ChangeRequest.find({ projectId, cr_id: { $in: crIds } }, { cr_id: 1, requester: 1, created_by: 1 }).lean()) as { cr_id: string; requester?: string; created_by?: unknown }[])
  const ids = [...new Set([...changes.map((c) => c.by), ...crs.map((c) => String(c.created_by ?? ""))])].filter((id) => id !== SYSTEM_ACTOR && mongoose.isValidObjectId(id))
  const users = ids.length === 0
    ? []
    : ((await User.find({ _id: { $in: ids } }, { name: 1, email: 1 }, { lean: true })) as { _id: unknown; name?: string; email: string }[])
  const nameById = new Map(users.map((u) => [String(u._id), (u.name && u.name.trim()) || u.email]))
  for (const cr of crs) {
    const name = nameById.get(String(cr.created_by ?? "")) ?? cr.requester?.trim()
    if (name) nameById.set(cr.cr_id, name)
  }
  return (by: string): string => {
    if (by === SYSTEM_ACTOR) return "System"
    // Mode 1: lô ghi lúc nhập tài liệu (finalize/check) mang `by: "import"` — không phải người, không in mã thô
    if (by === IMPORT_ACTOR) return "FlintFlow (import)"
    return nameById.get(by) ?? shortenId(by)
  }
}

/** Lô ghi của một change request (`change-request/write.service`: `by` = mã CR). */
const CR_ACTOR = /^CR-\d{3,}$/

/**
 * FLF-265: tài liệu tiếng Việt in `"system"` thành "Hệ thống" — resolver do caller dựng (tra `User`) giữ nguyên cho
 * mọi người ghi khác. Không có ngôn ngữ ⇒ đúng resolver cũ.
 */
/** Lô import (`by = import`: nạp dữ liệu file + ký bản gốc 0.1) không thành dòng lịch sử khi file đã có bảng lịch sử riêng. */
export const withoutImportRows = (rows: readonly ChangeRecordRow[], legacyRows: number): ChangeRecordRow[] =>
  legacyRows > 0 ? rows.filter((r) => r.by !== "import") : [...rows]

const inChargeFor = (resolve: ((by: string) => string) | undefined, language?: string): ((by: string) => string) | undefined =>
  isVietnamese(language) ? (by) => (by === SYSTEM_ACTOR ? assembleTextFor(language).systemInCharge : resolve ? resolve(by) : by) : resolve

// ─── phụ lục cờ ──────────────────────────────────────────────────

const buildFlagRow = (spine: Spine, flag: Flag, numbers: Map<string, string>, titles?: Map<string, string>, language?: string): FlagRow => {
  // Layout người dùng (có `titles`): số hiệu mẫu FPT không còn đúng ⇒ không suy từ khoá logic
  const fallbackNumber = titles ? "" : flag.section_id.startsWith("fixed:") ? flag.section_id.slice("fixed:".length) : ""
  const number = numbers.get(flag.section_id) ?? fallbackNumber
  let heading = titles?.get(flag.section_id) ?? ""
  if (!titles?.has(flag.section_id)) {
    try {
      // FLF-265: mẫu FPT tiếng Việt ⇒ tiêu đề mục cố định theo bảng vi (feature/function: tên Spine)
      heading = language ? defaultSectionTitle(spine, flag.section_id, language) : sectionHeadingOf(spine, flag.section_id)
    } catch {
      // section_id không phân giải được (dữ liệu cũ, mục riêng đã xoá) — nhãn chung thay vì khoá logic thô hay ném lỗi cả
      // tài liệu. Mode 1 (có `titles`) nói tiếng Việt như thông điệp cờ; mode 2 theo ngôn ngữ tài liệu (mặc định tiếng Anh).
      heading = titles ? capitalize(sectionLabel(flag.section_id, spine)) : assembleTextFor(language).removedSection
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
  titles?: Map<string, string>,
  language?: string,
  /** FLF-265: bản xem đã dịch — tên mục feature / function của dòng cờ in theo bản này; cờ, số hiệu, độ cũ vẫn theo `spine`. */
  localized?: LocalizedSpine
): FlagsAppendix => {
  const headings = localized ? renderView(localized) : spine
  const waived = spine.flags.filter((f) => f.waived_by_user).map((f) => buildFlagRow(headings, f, numbers, titles, language))
  if (source === "baseline") {
    // srs-spine.md §6: bản baseline chỉ cần in danh sách waive — không có cờ đỏ mở (điều kiện ký baseline).
    return { redOpen: [], staleCount: 0, waived }
  }
  // FLF-329: cờ đỏ giữ nguyên / waive cũ vẫn là cờ đỏ mở — vẫn in vào phụ lục và vẫn chặn
  const redOpen = spine.flags.filter((f) => f.level === "red" && f.resolved_at === null)
  // T15 review T4: dùng lại `states` đã tính một lần ở buildDocument thay vì computeSectionStates lần nữa.
  return { redOpen: redOpen.map((f) => buildFlagRow(headings, f, numbers, titles, language)), staleCount: readiness(spine, changes, states).stale, waived }
}

// ─── dựng sections[] ────────────────────────────────────────────

interface BuildSectionsOptions {
  /** Chỉ dùng nội bộ (dev) — bỏ section rỗng. KHÔNG lộ qua `assembleRequestSchema` (đóng băng). */
  partial?: boolean
  unassignedNumber: string
  hasUnassigned: boolean
  /**
   * FLF-265 — ngôn ngữ nhãn của mẫu FPT (nội bộ, không phải tham số request). Không đặt ⇒ tiếng Anh, y như trước.
   */
  language?: DocumentLanguage
  /**
   * FLF-265 D11 — bản xem đã dịch: nội dung section dựng từ bản này; danh sách mục, số hiệu, trạng thái và logic dựa chữ
   * Anh vẫn theo `spine` gốc (truyền vào ctx `canonical`). Không đặt ⇒ dựng thẳng từ `spine` như trước.
   */
  localized?: LocalizedSpine
}

const buildSections = (spine: Spine, numbers: Map<string, string>, states: SectionStateView[], opts: BuildSectionsOptions): RenderedSection[] => {
  const stateById = new Map(states.map((s) => [s.id, s]))
  const numberOfCtx = (id: string): string | undefined => numbers.get(id)
  // Mọi sơ đồ render_status=ok đều vào section dưới dạng tham chiếu; PNG thật/placeholder gắn lúc trả về
  const diagramPng = (id: string): string | undefined => imageRef(id)
  const content = opts.localized ? renderView(opts.localized) : spine

  const out: RenderedSection[] = []
  const seenGroups = new Set<string>()
  let unassignedHeadingInserted = false

  for (const def of listSections(spine)) {
    if (def.id === "fixed:I") continue

    for (const group of parentChain(def.parent)) {
      if (seenGroups.has(group)) continue
      seenGroups.add(group)
      out.push(chapterSection(group, opts.language))
    }

    if (
      opts.hasUnassigned &&
      !unassignedHeadingInserted &&
      def.id.startsWith("function:") &&
      (numbers.get(def.id) ?? "").startsWith(`${opts.unassignedNumber}.`)
    ) {
      out.push(unassignedFunctionsSection(opts.unassignedNumber, opts.language))
      unassignedHeadingInserted = true
    }

    const state = stateById.get(def.id)
    const ctx: SectionRenderContext = {
      number: numbers.get(def.id) ?? "",
      diagramPng,
      numberOf: numberOfCtx,
      // Tài liệu theo mẫu FPT: §3.x.y dùng khung mục FPT (mode 1 đi `layout-sections.ts`, giữ khung cũ)
      functionLayout: "fpt",
      ...(opts.language !== undefined ? { language: opts.language } : {}),
      ...(opts.localized ? { canonical: spine } : {}),
      ...(state?.status !== undefined ? { status: state.status } : {}),
      ...(state?.awaiting_reaccept !== undefined ? { awaiting_reaccept: state.awaiting_reaccept } : {})
    }
    const section = renderSection(content, def.id, ctx)
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
  /**
   * FLF-265 — tra lớp bản dịch cho bản xem đã dịch; mặc định `translation.service#resolveTranslations` (một truy vấn `$in`
   * theo hash chữ gốc, không gọi model). Chỉ gọi khi ngôn ngữ tài liệu ≠ ngôn ngữ gốc; test tiêm bản giả, khỏi cần Mongo.
   */
  resolveTranslations?: TranslationResolver
  /**
   * FLF-265 N1 — PNG của sơ đồ có nguồn đã dịch; mặc định `localized-diagram.service#localizedDiagramPng` (đọc file theo
   * hash, chưa có thì vẽ trên PlantUML rồi lưu). Chỉ gọi trên đường bản dịch; `null` ⇒ ảnh gốc.
   */
  loadLocalizedDiagramPng?: LocalizedDiagramPngLoader
  /** N1 — trần chờ vẽ PNG theo ngôn ngữ của một lượt dựng; mặc định `LOCALIZED_IMAGE_BUDGET_MS`. */
  localizedImageBudgetMs?: number
  /**
   * FLF-381 — revision lớp bản dịch của (dự án, ngôn ngữ) cho khoá bản xem đã dịch nhớ trong tiến trình; mặc định
   * `translation.repository#translationRevision` (`updatedAt` lớn nhất — mọi lần ghi bản dịch đều đổi nó).
   */
  translationRevision?: (projectId: string, locale: DocumentLanguage) => Promise<string | null>
}

export type TemplateLoader = (projectId: string) => Promise<TemplateLayout | null>

/** FLF-265 — key đơn vị dịch ⇒ chữ dịch (chỉ đơn vị đã dịch) + số đơn vị còn thiếu, cùng luật `resolveTranslations`. */
export type TranslationResolver = (
  projectId: string,
  locale: UserLocale,
  units: TranslationUnit[]
) => Promise<Pick<ResolvedTranslations, "map" | "missing">>

/** `meta.translation` của GET /document — đúng khuôn `pipeline.dto#documentTranslationMetaSchema` (đóng băng). */
export type DocumentTranslationMeta = z.infer<typeof documentTranslationMetaSchema>

/** Layout người dùng của project mode 1 (sau finalize import). Project mode 2 / import cũ chưa có layout ⇒ `null`. */
export const loadTemplateLayout: TemplateLoader = async (projectId) => {
  const profile = (await TemplateProfile.findOne(
    { projectId },
    { layout: 1, language: 1, template_family: 1, legacy_record_of_changes: 1, non_screen_table: 1, function_originals: 1, section_slices: 1, section_segments: 1, target_structure: 1, flow2_entry_at: 1 },
    { lean: true }
  )) as
    | {
        layout?: TemplateLayout["layout"]
        language?: string
        template_family?: string
        legacy_record_of_changes?: TemplateLayout["legacyRecord"]
        non_screen_table?: string[]
        function_originals?: TemplateLayout["functionOriginals"]
        section_slices?: TemplateLayout["sectionSlices"]
        section_segments?: TemplateLayout["sectionSegments"]
        target_structure?: { sections?: { section_id: string; status: string }[] } | null
        flow2_entry_at?: Date | null
      }
    | null
  if (!profile?.layout?.length) return null
  // Chế độ 3 (mẫu bắt buộc, FLF-335): in đúng các mục của mẫu, không chèn mục FlintFlow ngoài mẫu (business-flow 2.10)
  const project = (await Project.findById(projectId, { template_intent: 1 }, { lean: true })) as { template_intent?: string | null } | null
  // FLF-416 chế độ 4 đã vào Luồng 2: mục Ngoài phạm vi của file xuống cuối tài liệu (bố cục sắp lại theo mẫu chuẩn)
  const rearrange = project?.template_intent === "free" ? rearrangeOf(project, profile) : null
  return {
    ...(rearrange?.moveToEnd.length ? { moveToEnd: rearrange.moveToEnd } : {}),
    ...(project?.template_intent === "fixed" ? { fixedTemplate: true } : {}),
    layout: profile.layout,
    language: profile.language ?? "en",
    ...(profile.template_family ? { family: profile.template_family } : {}),
    legacyRecord: profile.legacy_record_of_changes ?? [],
    // FLF-252: import trước khi có các field này ⇒ không truyền, bản in giữ cách cũ
    ...(profile.non_screen_table?.length ? { nonScreenTable: profile.non_screen_table } : {}),
    ...(profile.function_originals?.length ? { functionOriginals: profile.function_originals } : {}),
    ...(profile.section_slices?.length ? { sectionSlices: profile.section_slices } : {}),
    // FLF-366: import trước khi có đoạn nguyên văn ⇒ không truyền, bản in như cũ
    ...(profile.section_segments?.length ? { sectionSegments: profile.section_segments } : {})
  }
}

const defaultDeps = (): AssembleDeps => ({
  loadDiagramPng: defaultDiagramPngLoader,
  now: () => new Date(),
  loadTemplate: loadTemplateLayout,
  resolveTranslations,
  loadLocalizedDiagramPng: (projectId, diagramId, locale, diagram) => localizedDiagramPng(projectId, diagramId, locale, diagram)
})

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
  /**
   * FLF-265 — ngôn ngữ nhãn cố định của tài liệu mẫu FPT (mode 2). Tham số nội bộ (đường bản dịch của
   * `getDocumentWithMeta` đặt), không phải query param. Không đặt ⇒ tiếng Anh như trước. Có `template` (mode 1) ⇒ bỏ
   * qua — nhãn mode 1 theo file người dùng.
   */
  language?: DocumentLanguage
  /**
   * FLF-265 D11 — ngôn ngữ chữ trong Spine (mode 2 `en`). Khác `language` (mẫu FPT) ⇒ nội dung lấy qua bản xem đã dịch
   * (`deps.resolveTranslations`); đơn vị chưa dịch giữ chữ gốc. Không đặt ⇒ không dịch.
   */
  sourceLanguage?: DocumentLanguage
}

interface BuiltDocument {
  /** Tài liệu với ảnh ở dạng tham chiếu — đúng dạng ghi cache. */
  refDoc: RenderedDocument
  images: ImageLoadResult
  /** FLF-265: chỉ có khi nội dung dựng từ bản xem đã dịch. */
  translation?: DocumentTranslationMeta
  /** Bản đã dịch: PNG theo ngôn ngữ đã lấy được + mọi lượt vẽ đã xong trong trần chờ (điều kiện được nhớ — FLF-381). */
  localized?: { loaded: Map<string, string>; complete: boolean }
}

/**
 * FLF-265 D11 — bản xem đã dịch của `spine` + số đơn vị còn in chữ gốc. Một truy vấn lớp bản dịch theo hash
 * (`deps.resolveTranslations`), không gọi model: GET /document Viewer gọi được, không tiêu credit (D9).
 */
const translateSpine = async (
  projectId: string,
  spine: Spine,
  locale: DocumentLanguage,
  sourceLocale: DocumentLanguage,
  deps: AssembleDeps
): Promise<{ localized: LocalizedSpine; translation: DocumentTranslationMeta }> => {
  const units = translationUnits(spine)
  const resolved = await (deps.resolveTranslations ?? resolveTranslations)(projectId, locale, units)
  return {
    // N1: nguồn sơ đồ của bản xem cũng theo `locale` (nhãn máy + chữ đã dịch)
    localized: localizeSpine(spine, units, resolved.map, locale, await loadRenderContext(projectId)),
    translation: { locale, source_locale: sourceLocale, missing: resolved.missing }
  }
}

/**
 * Ảnh của tài liệu. Bản đã dịch (N1): sơ đồ có nguồn đã dịch lấy PNG theo ngôn ngữ trước (vẽ được trong trần chờ thì
 * dùng); chỉ ảnh còn lại — kể cả sơ đồ vẽ không kịp / không được — mới tải PNG gốc, khỏi đọc hai lần mỗi sơ đồ.
 * `missing` chỉ nói về PNG gốc đã tải.
 */
const loadDocumentImages = async (
  projectId: string,
  spine: Spine,
  deps: AssembleDeps,
  translated: { localized: LocalizedSpine; translation: DocumentTranslationMeta } | undefined
): Promise<{ images: ImageLoadResult; localized?: { loaded: Map<string, string>; complete: boolean } }> => {
  if (!translated || !deps.loadLocalizedDiagramPng) return { images: await preloadDiagramPngs(projectId, spine, deps.loadDiagramPng) }
  const localized = await loadLocalizedPngs(
    projectId,
    translated.translation.locale,
    localizedDiagramSources(spine, translated.localized),
    deps.loadLocalizedDiagramPng,
    deps.localizedImageBudgetMs ?? LOCALIZED_IMAGE_BUDGET_MS
  )
  const images = await withLocalizedImages(projectId, documentImageIds(spine), localized.loaded, deps.loadDiagramPng)
  return { images, localized }
}

/** Ảnh gốc cho mọi id chưa có PNG theo ngôn ngữ, rồi gộp PNG theo ngôn ngữ vào — dùng lúc dựng và lúc đọc bản đã nhớ. */
const withLocalizedImages = async (
  projectId: string,
  ids: readonly string[],
  localized: ReadonlyMap<string, string>,
  load: DiagramPngLoader
): Promise<ImageLoadResult> => {
  const images = await loadDiagramPngs(projectId, ids.filter((id) => !localized.has(id)), load)
  for (const [id, png] of localized) images.loaded.set(id, png)
  return images
}

/** Dựng tài liệu dạng tham chiếu + kết quả tải ảnh — hàm thuần theo nghĩa I/O (chỉ tải ảnh), dùng chung cho draft/baseline. */
async function buildDocumentParts(input: BuildDocumentInput, deps: AssembleDeps): Promise<BuiltDocument> {
  const { projectId, projectName, spine, source, version } = input
  const states = computeSectionStates(spine, input.statusChanges)
  // Chỉ mẫu FPT nhận ngôn ngữ — đường layout mode 1 giữ nguyên byte
  const language = input.template ? undefined : input.language
  // FLF-265 D11: ngôn ngữ tài liệu ≠ ngôn ngữ gốc ⇒ nội dung từ bản xem đã dịch; số hiệu, thứ tự, trạng thái, cờ vẫn
  // tính trên `spine` gốc. Ảnh: PNG theo ngôn ngữ của sơ đồ đã dịch (N1), còn lại ảnh gốc
  const translated =
    language !== undefined && input.sourceLanguage !== undefined && language !== input.sourceLanguage
      ? await translateSpine(projectId, spine, language, input.sourceLanguage, deps)
      : undefined
  const { images, localized } = await loadDocumentImages(projectId, spine, deps, translated)
  deps.onImagesLoaded?.(images)
  let sections: RenderedSection[]
  let numbers: Map<string, string>
  let titles: Map<string, string> | undefined
  let omittedSectionIds: string[] | undefined
  // Section chữ gốc cho S-8.4 — `null` ⇒ bỏ qua pass (xem dưới)
  let checked: RenderedSection[] | null
  if (input.template) {
    // Mode 1 v2: thứ tự + tiêu đề + số hiệu theo file người dùng (layout-sections.ts)
    ;({ sections, numbers, titles, omittedSectionIds } = buildLayoutSections(spine, input.template, states, {
      partial: input.partial ?? false,
      diagramPng: imageRef
    }))
    checked = sections
  } else {
    const map = buildNumberMap(spine)
    numbers = map.numbers
    const options: BuildSectionsOptions = {
      partial: input.partial ?? false,
      unassignedNumber: map.unassignedNumber,
      hasUnassigned: map.hasUnassigned,
      ...(language !== undefined ? { language } : {})
    }
    sections = buildSections(spine, numbers, states, translated ? { ...options, localized: translated.localized } : options)
    // S-8.4 không bao giờ chạy trên chữ dịch: luật `undefined_term` dò chữ IN HOA tiếng Anh. Bản xem đã dịch chỉ đi
    // GET /document + export — không ai đọc findings ở đó (POST /assemble dựng bản gốc, trả qua `meta.consistency`) ⇒
    // chỉ dựng thêm các section chữ gốc cho pass khi caller đăng ký `onConsistencyFindings`; không ai nghe ⇒ bỏ qua.
    if (!translated) checked = sections
    else if (deps.onConsistencyFindings) checked = buildSections(spine, numbers, states, { ...options, language: input.sourceLanguage })
    else checked = null
  }

  if (checked) {
    const findings = [...await runConsistencyPass(spine, checked), ...omittedTemplateSectionFindings(spine, omittedSectionIds ?? [])]
    deps.onConsistencyFindings?.(findings)
  }

  const refDoc: RenderedDocument = {
    projectId,
    // FLF-177: bìa, tiêu đề và tên file in tên hệ thống; chưa đặt ⇒ tên project như trước
    projectName: systemName(spine.project, projectName),
    version,
    source,
    generatedAt: deps.now().toISOString(),
    sections,
    // T15 (mode 1 v3): lịch sử sửa đổi của khách (file gốc) đứng trước, lịch sử FlintFlow nối tiếp. File đã có bảng lịch sử
    // của riêng nó ⇒ không thêm dòng chỉ vì import / ký bản gốc 0.1 (lô `by = import`): bản 0.1 giữ đúng bảng của file, mỗi
    // change request mới thành một dòng
    recordOfChanges: [...(input.template?.legacyRecord ?? []), ...buildRecordOfChanges(withoutImportRows(input.recordChanges, input.template?.legacyRecord?.length ?? 0), inChargeFor(deps.resolveInCharge, language), language, spine)],
    flagsAppendix: buildFlagsAppendix(spine, input.statusChanges, numbers, source, states, titles, language, translated?.localized)
  }
  if (source === "draft") refDoc.watermark = "DRAFT"
  // Không có layout file người dùng ⇒ mẫu FPT (FLF-214: style heading con của §3.x.y)
  if (!input.template) refDoc.format = "fpt"
  return { refDoc, images, ...(translated ? { translation: translated.translation } : {}), ...(localized ? { localized } : {}) }
}

/** Dựng `RenderedDocument` sẵn ảnh (PNG thật hoặc placeholder) — cho writer/test gọi trực tiếp, không qua cache. */
async function buildDocument(input: BuildDocumentInput, deps: AssembleDeps): Promise<RenderedDocument> {
  const { refDoc, images } = await buildDocumentParts(input, deps)
  return materializeImages(refDoc, resolveLoaded(images), input.template ? undefined : input.language)
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
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  if (record.spine_version !== baseVersion) {
    throw new ApiError(409, "Tài liệu vừa được thay đổi ở phiên khác. Vui lòng tải lại rồi thử lại.", spineRepository.SPINE_VERSION_CONFLICT)
  }

  const cached = await RenderedDocumentCache.findOne({ projectId, spine_version: record.spine_version }, null, { lean: true })
  // T15 review T2: cache hỏng (dữ liệu cũ, lỗi ghi thủ công…) không được làm 500 lộ chi tiết ra ngoài. FLF-264: cũng
  // không còn là lỗi 422 trả cho người dùng — dựng lại đè lên là việc của code, không phải việc họ phải xử lý.
  const parsedCache = cached ? renderedDocumentSchema.safeParse(cached.doc) : null
  if (cached && parsedCache?.success) {
    // Trúng cache vẫn báo ảnh thiếu — client gọi lại cùng version không bị mất lý do; ảnh đã có lại thì hết báo
    const stillMissing = await recheckMissingImages(projectId, cached._id, cached.missing_diagram_ids ?? [], merged.loadDiagramPng)
    const template = await (merged.loadTemplate ?? loadTemplateLayout)(projectId)
    const omitted = template?.fixedTemplate
      ? buildLayoutSections(record, template, [], { diagramPng: imageRef }).omittedSectionIds ?? []
      : []
    return {
      spine_version: record.spine_version,
      sections: countRealSections(parsedCache.data.sections),
      generated_at: parsedCache.data.generatedAt,
      findings: [...missingImageFindings(stillMissing), ...omittedTemplateSectionFindings(record, omitted)]
    }
  }
  if (cached) console.warn(`[render] cache tài liệu v${record.spine_version} của project ${projectId} không hợp khuôn - dựng lại`)

  const { projectId: _projectId, ...spine } = record
  const changes = await spineRepository.listChanges(projectId)
  const recordChanges = await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges, projectId)
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
      version: draftVersionLabel(spine, changes),
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
  // FLF-265 §3.5: cache chỉ giữ bản ngôn ngữ gốc — `assemble` (POST /assemble, và GET /document khi ngôn ngữ tài liệu
  // = gốc) không nhận ngôn ngữ nên khoá `(projectId, spine_version)` giữ nguyên. Ngôn ngữ tài liệu ≠ gốc đi
  // `getDocumentWithMeta` ⇒ dựng mỗi lần, không đọc / ghi cache (bản dịch mới không tăng `spine_version`).
  await upsertCache(
    { projectId, spine_version: record.spine_version },
    {
      assembled_at_version: record.spine_version,
      generated_at: new Date(refDoc.generatedAt),
      doc: refDoc,
      missing_diagram_ids: images.missing
    }
  )
  await rememberWrittenCache({ projectId, spine_version: record.spine_version }, refDoc)
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
  /** Fixed-template exports must not reuse documents assembled with legacy collapsed headings. */
  freshTemplate?: boolean
  recordChanges?: ChangeRecordRow[]
  source: RenderSource
  baseline_id?: string
  /**
   * FLF-265 — ngôn ngữ tài liệu + ngôn ngữ gốc của dự án (`translation.service#projectLanguages`). Controller đặt từ
   * project; riêng tải file (FLF-334 B) đặt `locale` = `?lang=` khi có. Không truyền hoặc `locale == source` ⇒ đúng
   * đường cache như trước.
   */
  languages?: ProjectLanguages
  /**
   * FLF-334 B — chạy trên ĐÚNG Spine sắp dựng (draft: bản vừa đọc; baseline: snapshot), trước khi dựng; ném lỗi ⇒ không
   * dựng. Chỉ đường bản dịch (`languages.locale ≠ source`) gọi — tải file dùng để kiểm đủ bản dịch (409
   * `TRANSLATION_INCOMPLETE`) mà không đọc Spine lần hai giữa lúc kiểm và lúc dựng.
   */
  beforeRender?: (spine: Spine) => Promise<void>
  /**
   * Bản xem đã dịch: được dùng lại bản đã dựng (ảnh dạng tham chiếu `image-ref:`). CHỈ `GET /document` bật — export /
   * comment cần ảnh nhúng + dựng mới (`freshTemplate` luôn dựng mới), nên không bao giờ đọc / ghi bản dùng lại.
   */
  reuseTranslated?: boolean
  /**
   * FLF-383 — đầu Spine (+ revision lớp bản dịch khi ngôn ngữ tài liệu ≠ gốc) controller vừa đọc (`documentVersion`) cho
   * bản draft: tra cache / bản dịch đã lưu theo đó, khỏi hỏi lại và khỏi tải cả Spine khi trúng. `null` ⇒ dự án chưa có
   * Spine. Không truyền ⇒ tự đọc.
   */
  draftHead?: DraftHead | null
}

/** Đầu Spine của bản draft mà caller đã đọc (FLF-383). */
export interface DraftHead {
  spine_version: number
  /** `<_id>:<spine_version>` — cùng dạng `spineRepository.getWithIdentity`. */
  identity: string
  /** `translationRevision(projectId, locale)`; chỉ có nghĩa khi đã đọc cho ngôn ngữ tài liệu ≠ gốc. */
  translation_revision: string | null
}

/**
 * Bản dựng trong cache: đúng `spineVersion` khi truyền số, bản mới nhất khi truyền `null`.
 * `null` trả về ⇒ chưa có bản nào dùng được — kể cả khi cache tồn tại nhưng nội dung không còn hợp khuôn
 * (dữ liệu cũ, ghi tay): lượt đọc kế dựng lại đè lên, không bắt người dùng xử lý một lỗi của cache.
 */
const loadDraftCache = async (
  projectId: string,
  spineVersion: number | null,
  load: DiagramPngLoader
): Promise<{ doc: RenderedDocument; assembledAtVersion: number | undefined } | null> => {
  // Metadata ảnh nạp cùng lúc với lượt đọc cache (FLF-383) — `rehydrateImages` dùng bản đã nạp
  const [cached] = await Promise.all([
    readCachedDocument(
      spineVersion === null ? { projectId, spine_version: { $exists: true } } : { projectId, spine_version: spineVersion },
      { spine_version: -1 }
    ),
    warmLoader(load, projectId)
  ])
  if (cached === null) return null
  if (cached === "invalid") {
    console.warn(`[render] cache tài liệu của project ${projectId} không hợp khuôn - dựng lại`)
    return null
  }
  return { doc: await rehydrateImages(cached.doc, projectId, load), assembledAtVersion: cached.assembledAtVersion }
}

/** Thân document cache đã đọc, theo `cacheMemoKey` (FLF-381, `rendered-document-memo.ts`). */
const documentMemo = createMemo<RenderedDocument>()

/** Bản xem đã dịch đã dựng (FLF-381) — dạng tham chiếu + PNG theo ngôn ngữ đã có lúc dựng. */
interface TranslatedEntry {
  doc: RenderedDocument
  translation: DocumentTranslationMeta
  localized: [string, string][]
  /** Ngôn ngữ chú thích placeholder lúc phân giải ảnh (mode 1 có layout ⇒ không đặt, như `withImages`). */
  imageLanguage?: DocumentLanguage
}
const translatedMemo = createMemo<TranslatedEntry>()

/**
 * Đọc một document cache (FLF-381): hỏi `_id` + `updatedAt` trước (vài chục byte), thân (~100 KB, ~1,5 s qua Atlas) chỉ
 * tải khi bản đó chưa nhớ trong tiến trình (`rendered-document-memo.ts`). `null` ⇒ không có; `"invalid"` ⇒ có mà không
 * hợp khuôn (caller dựng lại đè lên). Bản trả về ở dạng tham chiếu ảnh, chưa phân giải.
 */
const readCachedDocument = async (
  filter: Record<string, unknown>,
  sort?: Record<string, 1 | -1>
): Promise<{ doc: RenderedDocument; assembledAtVersion: number | undefined } | "invalid" | null> => {
  const head = (await RenderedDocumentCache.findOne(filter, { _id: 1, updatedAt: 1, assembled_at_version: 1 }, { lean: true, ...(sort ? { sort } : {}) })) as {
    _id: unknown
    updatedAt?: unknown
    assembled_at_version?: number
  } | null
  if (!head) return null
  const key = cacheMemoKey(head)
  const assembledAtVersion = typeof head.assembled_at_version === "number" ? head.assembled_at_version : undefined
  const memoized = documentMemo.get(key)
  if (memoized) return { doc: memoized, assembledAtVersion }
  const full = (await RenderedDocumentCache.findOne({ _id: head._id }, { doc: 1 }, { lean: true })) as { doc?: unknown } | null
  if (!full) return null
  const parsed = renderedDocumentSchema.safeParse(full.doc)
  if (!parsed.success) return "invalid"
  documentMemo.set(key, parsed.data)
  return { doc: parsed.data, assembledAtVersion }
}

/** Vừa ghi document cache: nhớ luôn bản vừa dựng (khỏi tải lại ~100 KB ngay sau khi chính mình ghi). */
const rememberWrittenCache = async (filter: Record<string, unknown>, refDoc: RenderedDocument): Promise<void> => {
  const parsed = renderedDocumentSchema.safeParse(refDoc)
  if (!parsed.success) return
  const head = (await RenderedDocumentCache.findOne(filter, { _id: 1, updatedAt: 1 }, { lean: true })) as { _id: unknown; updatedAt?: unknown } | null
  if (head) documentMemo.set(cacheMemoKey(head), parsed.data)
}

/**
 * Lượt dựng đang chạy, khoá theo `(project, spine_version)`: nhiều tab cùng mở một project chưa có bản dựng ở
 * version hiện tại thì dùng chung một lượt. Dựng trùng vốn vô hại (tất định, `upsertCache` chịu được đua ghi),
 * gom lại chỉ để khỏi phí.
 */
const assemblingNow = new Map<string, Promise<AssembleResult>>()

const assembleShared = (projectId: string, projectName: string, spineVersion: number, deps: AssembleDeps): Promise<AssembleResult> => {
  const key = `${projectId}:${spineVersion}`
  const running = assemblingNow.get(key)
  if (running) return running
  const task = assemble(projectId, projectName, spineVersion, deps).finally(() => assemblingNow.delete(key))
  assemblingNow.set(key, task)
  return task
}

const isSpineVersionConflict = (err: unknown): boolean => err instanceof ApiError && err.code === spineRepository.SPINE_VERSION_CONFLICT

/**
 * Tài liệu bản nháp ở `spine_version` hiện tại. Chưa có bản dựng ở version đó — lần đọc đầu, hoặc Spine vừa đi
 * tiếp sau một step / lệnh sửa — thì dựng ngay tại đây thay vì trả bản cũ và chờ ai đó bấm một nút: dựng là thao
 * tác tất định, idempotent theo version, không gọi model và đo được ~20ms cho một SRS 19 màn, nên nó là chi tiết
 * nội bộ chứ không phải một quyết định của người dùng.
 */
const getDraftDocument = async (
  projectId: string,
  projectName: string,
  deps: AssembleDeps,
  knownSpineVersion?: number | null
): Promise<{ doc: RenderedDocument; draftMeta?: DraftMeta }> => {
  // FLF-383: chỉ cần `spine_version` để tra cache — cả Spine (~250 KB, vài giây qua Atlas) chỉ tải khi phải dựng
  // (`assemble` tự đọc). Version đọc trước body cache: Spine đi tiếp giữa chừng ⇒ `stale` theo version đã đọc (FLF-369).
  const spineVersion = knownSpineVersion !== undefined ? knownSpineVersion : ((await spineRepository.versionHead(projectId))?.spine_version ?? null)
  // Dự án chưa có Spine (vừa tạo, chưa chạy bước nào): không có gì để dựng — caller trả trạng thái "chưa có"
  if (spineVersion === null) throw new NoWorkingDraftError()
  const record = { spine_version: spineVersion }
  // Độ mới của chính bản trả về — cùng nghĩa `getDraftMeta` mà khỏi hỏi lại cache + Spine
  const withMeta = (built: { doc: RenderedDocument; assembledAtVersion: number | undefined }) => ({
    doc: built.doc,
    ...(built.assembledAtVersion !== undefined
      ? {
          draftMeta: {
            assembled_at_version: built.assembledAtVersion,
            spine_version: record.spine_version,
            stale: built.assembledAtVersion !== record.spine_version
          }
        }
      : {})
  })

  const current = await loadDraftCache(projectId, record.spine_version, deps.loadDiagramPng)
  if (current) return withMeta(current)

  // `SPINE_VERSION_CONFLICT`: Spine đi tiếp ngay giữa lúc đọc version và dựng (một step khác đang chạy). Bản vừa
  // dựng ở version cũ vẫn đọc được và lượt đọc kế sẽ bắt kịp — không chặn lượt xem hiện tại vì một cuộc đua.
  await assembleShared(projectId, projectName, record.spine_version, deps).catch((err: unknown) => {
    if (!isSpineVersionConflict(err)) throw err
  })

  const built = await loadDraftCache(projectId, null, deps.loadDiagramPng)
  if (!built) throw new NoWorkingDraftError()
  return withMeta(built)
}

/** Mã baseline hiển thị `BLnnn` — `Spine.baselines[].id` do `baseline.service.nextBaselineId` sinh. */
const BASELINE_DISPLAY_ID = /^BL\d+$/

const baselineNotFound = (): ApiError => new ApiError(404, "Không tìm thấy bản baseline này.", "BASELINE_NOT_FOUND")

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

/** Baseline theo `baseline_id` (`_id` hoặc `BLnnn`); không truyền ⇒ bản mới nhất; không có ⇒ 404. */
/** `_id` của baseline cần đọc (không tải snapshot); `undefined` ⇒ baseline mới nhất. Không có ⇒ 404. */
const baselineObjectId = async (projectId: string, baselineId: string | undefined): Promise<string> => {
  const objectId = await resolveBaselineObjectId(projectId, baselineId)
  if (objectId) return objectId
  const latest = (await Baseline.findOne({ projectId }, { _id: 1 }, { lean: true, sort: { at: -1 } })) as { _id: unknown } | null
  if (!latest) throw baselineNotFound()
  return String(latest._id)
}

const findBaseline = async (projectId: string, baselineId: string | undefined) => {
  const objectId = await resolveBaselineObjectId(projectId, baselineId)
  const filter = objectId ? { projectId, _id: objectId } : { projectId }
  const baseline = await Baseline.findOne(filter, null, { lean: true, sort: { at: -1 } })
  if (!baseline) throw baselineNotFound()
  return baseline
}

/** T15 review T2: snapshot hỏng (dữ liệu cũ, migrate lỗi…) không được làm 500 lộ chi tiết ra ngoài. */
const baselineSpine = (snapshot: unknown): Spine => {
  const parsedSpine = spineSchema.safeParse(snapshot)
  if (!parsedSpine.success) throw new ApiError(422, "Dữ liệu của bản baseline này bị lỗi nên chưa xuất được.", "BASELINE_SNAPSHOT_INVALID")
  return parsedSpine.data
}

const getBaselineDocument = async (
  projectId: string,
  projectName: string,
  baselineId: string | undefined,
  deps: AssembleDeps
): Promise<RenderedDocument> => {
  // FLF-381: chỉ lấy `_id` để tra cache — snapshot (~200 KB, ~2 s qua Atlas) chỉ tải khi phải dựng
  const baselineIdStr = await baselineObjectId(projectId, baselineId)

  // T15 review T5: baseline bất biến — cache theo baseline._id, không dựng lại mỗi lần xem.
  const cacheFilter = { projectId, baseline_id: baselineIdStr }
  const cached = await readCachedDocument(cacheFilter)
  if (cached !== null && cached !== "invalid") return rehydrateImages(cached.doc, projectId, deps.loadDiagramPng)
  // Cache hỏng: snapshot của baseline là bất biến nên dựng lại từ nó luôn đúng — không trả lỗi cho người dùng
  if (cached === "invalid") console.warn(`[render] cache baseline ${baselineIdStr} của project ${projectId} không hợp khuôn - dựng lại`)

  const baseline = await findBaseline(projectId, baselineIdStr)
  const spine = baselineSpine(baseline.snapshot)

  // §I hiển thị lịch sử đầy đủ hiện có (chưa có mốc "seq tại lúc ký" trong Baseline — T19 chưa chốt);
  // status/stale của section thì tính với changes rỗng vì không có gì để so — tránh stale giả cho bản đã ký.
  const recordChanges = await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges, projectId)

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
  // FLF-265 §3.5: như bản draft — cache baseline chỉ giữ bản ngôn ngữ gốc, khoá `(projectId, baseline_id)` giữ nguyên
  // (chú thích placeholder theo mặc định, trùng lúc `rehydrateImages` đọc lại). Bản theo ngôn ngữ khác dựng mỗi lần từ
  // snapshot + lớp bản dịch theo hash (Q4) ở `getTranslatedBaselineDocument`, không qua cache.
  await upsertCache(cacheFilter, { generated_at: new Date(refDoc.generatedAt), doc: refDoc, missing_diagram_ids: images.missing })
  await rememberWrittenCache(cacheFilter, refDoc)

  return materializeImages(refDoc, resolveLoaded(images))
}

// ─── FLF-265 §3.5 + FLF-383: ngôn ngữ tài liệu ≠ ngôn ngữ gốc ──
//
// Bản dịch mới (lượt AI trả kèm — D16, dịch theo lô) không tăng `spine_version` ⇒ không dùng hàng draft / baseline (khoá
// theo version / baseline). Bản xem đã dịch có hàng riêng trong `RenderedDocumentCache` (`locale` có mặt, một hàng mỗi
// `(project, view, locale)` — xem `rendered-document.model.ts`), khoá bằng danh tính nội dung + revision lớp bản dịch, nên
// bản dịch mới / Spine đổi vẫn hiện ở lượt đọc kế và bản dựng sống qua restart (FLF-383). `translatedMemo` (FLF-381) là
// lớp RAM phía trên. Đường export (`beforeRender` / `recordChanges`) và caller nghe findings S-8.4 luôn dựng mới, không
// đọc / ghi.

/** Tài liệu sẵn ảnh, chú thích placeholder theo `language` (mode 1 có layout ⇒ mặc định, như `buildDocument`). */
const withImages = (built: BuiltDocument, language: DocumentLanguage | undefined): DocumentWithMeta => ({
  doc: materializeImages(built.refDoc, resolveLoaded(built.images), language),
  ...(built.translation ? { translation: built.translation } : {})
})

/** Khoá một bản xem đã dịch: hàng `(view, locale)` dùng được khi `contentKey` + `revision` khớp. */
interface TranslatedKey {
  /** `draft` | `baseline:<Baseline._id>` */
  view: string
  /** Draft: danh tính Spine; baseline: `spine_version` (§I theo lịch sử hiện có, mọi change đều tăng nó). */
  contentKey: string
  locale: DocumentLanguage
  /** `translationRevision` lúc đọc; chưa có bản dịch nào ⇒ `-`. */
  revision: string
}

const revisionOf = async (projectId: string, locale: DocumentLanguage, deps: AssembleDeps): Promise<string> =>
  (await (deps.translationRevision ?? translationRevision)(projectId, locale)) ?? "-"

const translatedMemoKey = (projectId: string, key: TranslatedKey): string =>
  `${projectId}:${key.view}:${key.contentKey}:${key.locale}:${key.revision}`

/** Hàng bản dịch đã lưu — sai khuôn (dữ liệu cũ, ghi tay) ⇒ coi như chưa có, dựng lại ghi đè. */
const storedTranslatedSchema = z.object({
  doc: renderedDocumentSchema,
  translation: documentTranslationMetaSchema,
  localized_refs: z.array(z.tuple([z.string(), z.string()])),
  image_language: z.enum(["vi", "en"]).nullish()
})

/** Một truy vấn theo đủ khoá: hàng khác khoá (bản cũ) ⇒ `null`. */
const loadStoredTranslated = async (projectId: string, key: TranslatedKey): Promise<TranslatedEntry | null> => {
  const row = await RenderedDocumentCache.findOne(
    { projectId, view: key.view, locale: key.locale, content_key: key.contentKey, translation_revision: key.revision },
    { doc: 1, translation: 1, localized_refs: 1, image_language: 1 },
    { lean: true }
  )
  if (!row) return null
  const parsed = storedTranslatedSchema.safeParse(row)
  if (!parsed.success) {
    console.warn(`[render] bản dịch ${key.locale} (${key.view}) đã lưu của project ${projectId} không hợp khuôn - dựng lại`)
    return null
  }
  const { doc, translation, localized_refs, image_language } = parsed.data
  return { doc, translation, localized: localized_refs, ...(image_language ? { imageLanguage: image_language } : {}) }
}

/** Phân giải ảnh như lúc dựng: PNG theo ngôn ngữ đã có, còn lại ảnh gốc tải lại. */
const materializeTranslated = async (entry: TranslatedEntry, projectId: string, deps: AssembleDeps): Promise<DocumentWithMeta> => {
  const images = await withLocalizedImages(projectId, docImageIds(entry.doc), new Map(entry.localized), deps.loadDiagramPng)
  return { doc: materializeImages(entry.doc, resolveLoaded(images), entry.imageLanguage), translation: entry.translation }
}

/**
 * RAM ⇒ hàng đã lưu (nạp lại vào RAM). Chưa có ⇒ `null`. Metadata ảnh chỉ nạp sẵn (song song) khi phải hỏi DB — trúng RAM
 * mà mọi sơ đồ đã có PNG theo ngôn ngữ thì loader ảnh gốc không cần hỏi gì.
 */
const readTranslated = async (projectId: string, key: TranslatedKey, deps: AssembleDeps): Promise<DocumentWithMeta | null> => {
  const memoKey = translatedMemoKey(projectId, key)
  const memoized = translatedMemo.get(memoKey)
  if (memoized) return materializeTranslated(memoized, projectId, deps)
  const [stored] = await Promise.all([loadStoredTranslated(projectId, key), warmLoader(deps.loadDiagramPng, projectId)])
  if (!stored) return null
  translatedMemo.set(memoKey, stored)
  return materializeTranslated(stored, projectId, deps)
}

/** Lượt ghi bản dịch đang chạy — response không chờ; test chờ qua `_internal.flushTranslatedWrites`. */
const pendingTranslatedWrites = new Set<Promise<void>>()

/**
 * Nhớ (RAM) + lưu (DB, không chờ) bản vừa dựng. Chỉ khi mọi PNG theo ngôn ngữ đã vẽ xong trong trần chờ — không thì sẽ
 * kẹt ảnh gốc cho tới khi khoá đổi. Lưu lỗi chỉ log: lượt sau dựng lại.
 */
const rememberTranslatedBuild = (projectId: string, key: TranslatedKey, built: BuiltDocument, imageLanguage: DocumentLanguage | undefined): void => {
  if (!built.translation || built.localized?.complete === false) return
  const entry: TranslatedEntry = {
    doc: built.refDoc,
    translation: built.translation,
    localized: [...(built.localized?.loaded ?? [])],
    ...(imageLanguage ? { imageLanguage } : {})
  }
  translatedMemo.set(translatedMemoKey(projectId, key), entry)
  const write: Promise<void> = upsertCache(
    { projectId, view: key.view, locale: key.locale },
    {
      content_key: key.contentKey,
      translation_revision: key.revision,
      generated_at: new Date(built.refDoc.generatedAt),
      doc: entry.doc,
      translation: entry.translation,
      localized_refs: entry.localized,
      image_language: imageLanguage ?? null,
      missing_diagram_ids: built.images.missing
    }
  )
    .then(
      () => undefined,
      (err: unknown) => console.warn(`[render] không lưu được bản dịch ${key.locale} (${key.view}) của project ${projectId}: ${err instanceof Error ? err.message : String(err)}`)
    )
    .finally(() => pendingTranslatedWrites.delete(write))
  pendingTranslatedWrites.add(write)
}

const flushTranslatedWrites = async (): Promise<void> => {
  await Promise.all([...pendingTranslatedWrites])
}

const translatedDraftMeta = (version: number): DraftMeta => ({ assembled_at_version: version, spine_version: version, stale: false })

/** Bản nháp ở `spine_version` hiện tại, dựng từ Spine + lớp bản dịch — không qua hàng draft / `assembleShared`. */
const getTranslatedDraftDocument = async (
  projectId: string,
  projectName: string,
  languages: ProjectLanguages,
  deps: AssembleDeps,
  beforeRender: ((spine: Spine) => Promise<void>) | undefined,
  reuse: boolean,
  knownHead: DraftHead | null | undefined
): Promise<DocumentWithMeta> => {
  // Chỉ GET /document (`reuse`) dùng lại; caller nghe findings S-8.4 cần một lượt dựng thật; export luôn dựng mới
  const reusable = reuse && !beforeRender && !deps.onConsistencyFindings
  let revision: string | null = null
  if (reusable) {
    // FLF-383: khoá chỉ cần danh tính Spine (projection) + revision — controller đã đọc thì dùng luôn, cả Spine chỉ tải
    // khi phải dựng
    if (knownHead === null) throw new NoWorkingDraftError()
    const [head, rev] = knownHead
      ? [knownHead, knownHead.translation_revision ?? "-"]
      : await Promise.all([spineRepository.versionHead(projectId), revisionOf(projectId, languages.locale, deps)])
    if (!head) throw new NoWorkingDraftError()
    revision = rev
    const hit = await readTranslated(projectId, { view: "draft", contentKey: head.identity, locale: languages.locale, revision }, deps)
    if (hit) return { ...hit, draftMeta: translatedDraftMeta(head.spine_version) }
  }

  const loaded = await spineRepository.getWithIdentity(projectId)
  if (!loaded) throw new NoWorkingDraftError()
  const { record, identity } = loaded
  // Độ mới của chính bản trả về — `getDraftMeta` đọc hàng draft, mà đường này không ghi hàng đó
  const draftMeta = translatedDraftMeta(record.spine_version)

  const { projectId: _projectId, ...spine } = record
  if (beforeRender) await beforeRender(spine)
  const changes = await spineRepository.listChanges(projectId)
  const recordChanges = await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges, projectId)
  const template = await (deps.loadTemplate ?? loadTemplateLayout)(projectId)

  const built = await buildDocumentParts(
    {
      projectId,
      projectName,
      spine,
      statusChanges: changes,
      recordChanges,
      source: "draft",
      version: draftVersionLabel(spine, changes),
      template,
      language: languages.locale,
      sourceLanguage: languages.source
    },
    { ...deps, resolveInCharge }
  )
  warnMissingImages(built.images, `project ${projectId}`)
  const imageLanguage = template ? undefined : languages.locale
  // Khoá theo chính bản Spine vừa dựng (version có thể đã tăng sau lượt tra head)
  if (revision !== null) rememberTranslatedBuild(projectId, { view: "draft", contentKey: identity, locale: languages.locale, revision }, built, imageLanguage)
  return { ...withImages(built, imageLanguage), draftMeta }
}

/** Baseline đã ký dựng lại từ `Baseline.snapshot` + lớp bản dịch theo hash chữ gốc (Q4) — không qua hàng baseline gốc. */
const getTranslatedBaselineDocument = async (
  projectId: string,
  projectName: string,
  baselineId: string | undefined,
  languages: ProjectLanguages,
  deps: AssembleDeps,
  beforeRender: ((spine: Spine) => Promise<void>) | undefined,
  savedRecords: ChangeRecordRow[] | undefined,
  reuse: boolean
): Promise<DocumentWithMeta> => {
  const reusable = reuse && !beforeRender && !savedRecords && !deps.onConsistencyFindings
  // Snapshot bất biến theo `_id`; §I lấy lịch sử hiện có ⇒ khoá thêm `spine_version` (mọi change đều tăng nó)
  const [baselineIdStr, head, revision] = await Promise.all([
    baselineObjectId(projectId, baselineId),
    reusable ? spineRepository.versionHead(projectId) : Promise.resolve(null),
    reusable ? revisionOf(projectId, languages.locale, deps) : Promise.resolve(null)
  ])
  const key: TranslatedKey | null =
    head && revision !== null ? { view: `baseline:${baselineIdStr}`, contentKey: String(head.spine_version), locale: languages.locale, revision } : null
  const hit = key ? await readTranslated(projectId, key, deps) : null
  if (hit) return hit

  const baseline = await findBaseline(projectId, baselineIdStr)
  const spine = baselineSpine(baseline.snapshot)
  if (beforeRender) await beforeRender(spine)
  // §I + status rỗng như bản baseline gốc (`getBaselineDocument`)
  const recordChanges = savedRecords ?? await listChangesForRecord(projectId)
  const resolveInCharge = await buildInChargeResolver(recordChanges, projectId)
  const template = await (deps.loadTemplate ?? loadTemplateLayout)(projectId)

  const built = await buildDocumentParts(
    {
      projectId,
      projectName,
      spine,
      statusChanges: [],
      recordChanges,
      source: "baseline",
      version: String(baseline.version),
      template,
      language: languages.locale,
      sourceLanguage: languages.source
    },
    { ...deps, resolveInCharge }
  )
  warnMissingImages(built.images, `baseline ${String(baseline._id)}`)
  const imageLanguage = template ? undefined : languages.locale
  if (key) rememberTranslatedBuild(projectId, key, built, imageLanguage)
  return withImages(built, imageLanguage)
}

/** Kết quả của `getDocumentWithMeta` — tài liệu + phần caller đính vào `meta` / header. */
export interface DocumentWithMeta {
  doc: RenderedDocument
  /** Chỉ khi nội dung dựng từ bản xem đã dịch: `meta.translation` (`missing` = đơn vị đang in chữ gốc). */
  translation?: DocumentTranslationMeta
  /**
   * Chỉ cho bản draft: độ mới của chính bản trả về (bản dịch: `stale: false`; bản gốc: theo document cache vừa đọc —
   * FLF-381, khỏi hỏi lại cache + Spine). Không có ⇒ caller gọi `getDraftMeta` như trước.
   */
  draftMeta?: DraftMeta
}

/**
 * GET /document, GET /export/word. `query.languages` (FLF-265) với `locale ≠ source` ⇒ dựng mỗi lần từ bản xem đã dịch
 * (draft: Spine hiện tại; baseline: snapshot + lớp bản dịch theo hash — Q4), không đọc / ghi `RenderedDocumentCache`,
 * kèm `translation` (+ `draftMeta` cho draft). Không truyền hoặc `locale == source` ⇒ đúng đường cache như trước, chỉ có
 * `doc`. Không nhánh nào gọi model (D9).
 */
export async function getDocumentWithMeta(
  projectId: string,
  projectName: string,
  query: DocumentQuery,
  deps: Partial<AssembleDeps> = {}
): Promise<DocumentWithMeta> {
  const merged: AssembleDeps = { ...defaultDeps(), ...deps }
  const { languages } = query
  if (languages && (languages.locale !== languages.source || query.freshTemplate)) {
    const reuse = query.reuseTranslated === true && !query.freshTemplate
    return query.source === "baseline"
      ? getTranslatedBaselineDocument(projectId, projectName, query.baseline_id, languages, merged, query.beforeRender, query.recordChanges, reuse)
      : getTranslatedDraftDocument(projectId, projectName, languages, merged, query.beforeRender, reuse, query.draftHead)
  }
  if (query.source === "baseline") return { doc: await getBaselineDocument(projectId, projectName, query.baseline_id, merged) }
  return getDraftDocument(projectId, projectName, merged, query.draftHead === undefined ? undefined : (query.draftHead?.spine_version ?? null))
}

/** FLF-334 B — snapshot Spine của một baseline (`_id` hoặc `BLnnn`; không truyền ⇒ mới nhất). */
export async function loadBaselineSpine(projectId: string, baselineId: string | undefined): Promise<Spine> {
  return baselineSpine((await findBaseline(projectId, baselineId)).snapshot)
}

export async function getDocument(
  projectId: string,
  projectName: string,
  query: DocumentQuery,
  deps: Partial<AssembleDeps> = {}
): Promise<RenderedDocument> {
  return (await getDocumentWithMeta(projectId, projectName, query, deps)).doc
}

// ─── mode 1 v2: file version tài liệu dựng từ snapshot Spine (FLF-184) ──

/**
 * `RenderedDocument` sẵn ảnh của một snapshot Spine (không qua cache) — `doc-version` ghi thành file `.docx` cho
 * version mode 1 (bản gốc `0.1` sau import; V4: bản ghi CR, release). Theo layout của project nếu có.
 */
export async function renderSpineDocument(
  projectId: string,
  projectName: string,
  spine: Spine,
  opts: {
    /** Immutable version history; an explicit empty array means no generated history rows. */
    recordChanges?: ChangeRecordRow[]
    version: string
    source: RenderSource
    /** Change chưa ghi DB nhưng thuộc snapshot (C-7 render trước khi ghi Spine — FLF-186) — nối vào §I. */
    pendingRecord?: ChangeRecordRow[]
    /**
     * FLF-318: dự án chuyển từ mode 2 — mẫu FPT theo ngôn ngữ tài liệu, nội dung qua lớp bản dịch (như bản Lead đã ký).
     * Không truyền ⇒ như trước (mode 1 theo layout file, không dịch).
     */
    languages?: ProjectLanguages
  },
  deps: Partial<AssembleDeps> = {}
): Promise<RenderedDocument> {
  const merged: AssembleDeps = { ...defaultDeps(), ...deps }
  const recordChanges = [...(opts.recordChanges ?? await listChangesForRecord(projectId)), ...(opts.pendingRecord ?? [])]
  const resolveInCharge = await buildInChargeResolver(recordChanges, projectId)
  return buildDocument(
    {
      projectId,
      projectName,
      spine,
      statusChanges: [],
      recordChanges,
      source: opts.source,
      version: opts.version,
      template: await (merged.loadTemplate ?? loadTemplateLayout)(projectId),
      ...(opts.languages ? { language: opts.languages.locale, sourceLanguage: opts.languages.source } : {})
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
export const _internal = { buildDocument, buildNumberMap, buildSections, rehydrateImages, flushTranslatedWrites }
