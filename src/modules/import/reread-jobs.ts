/**
 * FLF-360 — đọc lại ảnh sơ đồ **sau khi đã có bản 0.1**, chạy nền tự động (quyết định 2026-11-04): ảnh AI chưa đọc được vì
 * quá tải lúc import (`diagram_images.kind = unavailable`, cờ vàng `import_image_unread`) được job `import/reread-images`
 * đọc lại theo lịch giãn dần (`IMPORT_REREAD_JOB_DELAYS_MS`). Đọc được ⇒ một lô `by: import` có khoá lạc quan:
 * - dữ liệu đọc từ ảnh vào Spine (phần tử mới như import; phần tử đã có chỉ nhận phần ảnh thêm — quan hệ mới, field trống);
 * - khối ảnh của phần nối gắn `diagram` (loại + hash dữ liệu sau lô) ⇒ PlantUML cùng loại tiếp tục bị ẩn (§4.13);
 * - đóng cờ `import_image_unread` của ảnh đó;
 * rồi tính lại dấu đoạn của FLF-366 (`refreshSegmentHashes`) ⇒ đoạn chứa ảnh vẫn in nguyên văn, phần tử vừa ghi không bị in
 * thêm cuối mục. **Không tạo version mới.**
 *
 * Spine bị sửa giữa lúc đọc và lúc ghi (CR khác ghi trước) ⇒ đọc lại Spine, dựng lại op, ghi lại một lần; vẫn xung đột ⇒ bỏ
 * ảnh đó ở lượt này (giữ cờ, ghi log), lượt sau thử lại. Hết credit ⇒ dừng job, giữ cờ, không chặn người dùng. Lượt lỗi được
 * hoàn credit (`executeAiAction`). Hết lịch ⇒ dừng, giữ cờ vàng.
 *
 * Driver `inline` (không worker): hẹn giờ bằng `setTimeout` trong tiến trình API (máy chủ khởi động lại thì lịch mất — ảnh
 * giữ cờ vàng như trước FLF-360). Driver `bullmq`: job `delay` trong Redis.
 */

import { env } from "../../config/env.js"
import { defineJob, enqueueJob, usesQueue } from "../../shared/queue/job-runner.js"
import { applyTransaction, planTransaction } from "../spine/op-engine.js"
import type { Op } from "../spine/op.types.js"
import { OWNER_DIAGRAM_KINDS, isOriginalDiagramKind, originalDiagramValue } from "../spine/original-diagram.js"
import * as spineRepository from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"
import { assemble } from "../render/assemble.service.js"
import { Project } from "../project/project.model.js"
import { stripRecord } from "./check.service.js"
import { ExtractionDraft, type IExtractionDraft } from "./extraction-draft.model.js"
import { applyRereadToDraft, loadExtractionInputs, readDiagramImage, rereadContextOf, unavailableImagesOf, type DiagramRead } from "./extract.service.js"
import { IdAllocator, idKey, nameKey, type EntityItem } from "./extracted-entities.js"
import { refreshSegmentHashes } from "./finalize.service.js"
import { ImportedDocument } from "./imported-document.model.js"
import { IMPORT_IMAGE_RULE } from "./mode1-rule-profile.js"
import { buildImportOps } from "./spine-builder.js"

interface RereadJobData {
  projectId: string
  userId: string
  importId: string
  /** Lượt thứ mấy trong lịch (0-based) — chọn thời gian chờ của lượt kế tiếp. */
  round: number
}

/** Mảng Spine mà sơ đồ đọc được ghi vào (`DIAGRAM_TARGETS`). */
const DIAGRAM_ARRAYS = ["actors", "use_cases", "screens", "entities", "functions", "deployment_nodes"] as const
type DiagramArray = (typeof DIAGRAM_ARRAYS)[number]
const isDiagramArray = (entity: string): entity is DiagramArray => (DIAGRAM_ARRAYS as readonly string[]).includes(entity)

/** FLF-390: luồng đọc từ sơ đồ tuần tự (function) / activity (use case). */
const FUNCTION_FLOW_FIELDS = new Set(["interactions", "activity_nodes", "activity_flows"])

/** Field tham chiếu dạng mảng mã (ảnh nối thêm actor / include / quan hệ…) — nối thêm, không thay. */
const REF_FIELDS = new Set(["actor_ids", "includes", "extends", "relations", "function_ids", "feature_ids"])

type Element = Record<string, unknown> & { id: string }

const elementsOf = (spine: Spine, entity: DiagramArray): Element[] => spine[entity] as unknown as Element[]
const findElement = (spine: Spine, entity: DiagramArray, id: string): Element | undefined => elementsOf(spine, entity).find((e) => idKey(e.id) === idKey(id))

/** Giá trị "thô" của phần tử Spine (như field trích) — `buildImportOps` phân giải lại tham chiếu như lúc import. */
const rawOf = (el: Element): Record<string, unknown> => {
  const { id: _id, ...rest } = el
  return rest
}

/**
 * Hàm thuần: op ghi phần đọc từ ảnh vào Spine đã có bản 0.1.
 * - Phần tử chưa có ⇒ op `add` của `buildImportOps` (phân giải tên / mã, cấp id như import).
 * - Phần tử đã có ⇒ chỉ phần ảnh thêm (`onlyNewFromVision`): quan hệ mới nối thêm vào mảng mã (`set` cả mảng chuỗi), cạnh
 *   luồng màn mới `add` từng cạnh (mảng object không `set` được), field đang trống thì điền; field đã có chữ không ghi đè.
 * Tham chiếu phân giải bằng chính `buildImportOps` trên Spine bỏ phần tử đó ⇒ cùng luật với import (mã lỏng, tên, khác quy
 * ước đặt tên).
 */
export const rereadOps = (spine: Spine, items: readonly EntityItem[]): Op[] => {
  // FLF-390: ảnh sequence / activity không tạo function mới — chỉ thêm luồng cho function đã có
  const fresh = items.filter((it) => it.id && isDiagramArray(it.entity) && it.entity !== "functions" && !findElement(spine, it.entity, it.id))
  const ops: Op[] = fresh.length ? buildImportOps(spine, fresh.map((it) => ({ entity: it.entity, id: it.id, value: it.value }))) : []
  // Quan hệ của phần tử đã có phân giải trên Spine ĐÃ có phần tử mới (use case cũ nối thêm actor "Guest" vừa đọc được)
  const base = ops.length ? planTransaction(spine, { base_version: spine.spine_version, ops, by: "import" }, { startSeq: 1 }).spine : spine
  for (const it of items) {
    if (!it.id || !isDiagramArray(it.entity) || fresh.includes(it)) continue
    const current = findElement(base, it.entity, it.id)
    if (!current) continue
    // Dựng lại đúng phần tử này từ giá trị hiện tại + phần ảnh, trên Spine không có nó ⇒ tham chiếu đã phân giải
    const merged: Record<string, unknown> = { ...rawOf(current) }
    for (const [field, v] of Object.entries(it.value)) {
      if (REF_FIELDS.has(field) && Array.isArray(v)) merged[field] = [...((current[field] as unknown[]) ?? []), ...v]
      else if (field === "flow_to" && Array.isArray(v)) merged[field] = [...((current.flow_to as unknown[]) ?? []), ...v]
      else if (current[field] === undefined || current[field] === null || current[field] === "") merged[field] = v
    }
    const without = { ...base, [it.entity]: elementsOf(base, it.entity).filter((e) => e !== current) } as Spine
    const rebuilt = buildImportOps(without, [{ entity: it.entity, id: current.id, value: merged }]).find(
      (o) => o.op === "add" && o.path === `${it.entity}[]` && (o.value as Element | undefined)?.id === current.id
    )?.value as Element | undefined
    if (!rebuilt) continue
    const at = `${it.entity}[id=${current.id}]`
    // nút activity trước flow (flow tham chiếu id nút)
    for (const field of Object.keys(it.value).sort((a, b) => Number(a === "activity_flows") - Number(b === "activity_flows"))) {
      const before = current[field]
      const after = rebuilt[field]
      if (after === undefined || JSON.stringify(before) === JSON.stringify(after)) continue
      if (field === "flow_to" && Array.isArray(after)) {
        const had = new Set(((before as { to: string }[]) ?? []).map((e) => e.to))
        for (const edge of after as { to: string }[]) if (!had.has(edge.to)) ops.push({ op: "add", path: `${at}.flow_to[]`, value: edge, reason: "Đọc lại ảnh sơ đồ" })
        continue
      }
      // FLF-390: luồng của function / use case (mảng object) — chỉ ghi khi phần tử chưa có, cả mảng một op
      const empty = before === undefined || before === null || (Array.isArray(before) && before.length === 0)
      if (FUNCTION_FLOW_FIELDS.has(field) && Array.isArray(after) && after.length && empty) {
        ops.push({ op: "set", path: `${at}.${field}`, value: after, reason: "Đọc lại ảnh sơ đồ" })
        continue
      }
      if (Array.isArray(after) && after.some((x) => typeof x === "object" && x !== null)) continue
      ops.push({ op: "set", path: `${at}.${field}`, value: after, reason: "Đọc lại ảnh sơ đồ" })
    }
  }
  return ops.map((o) => ({ ...o, reason: o.reason ?? "Đọc lại ảnh sơ đồ" }))
}

/**
 * Hàm thuần: op cho một ảnh vừa đọc lại — dữ liệu + gắn `diagram` cho khối ảnh (hash tính trên Spine **sau** dữ liệu) +
 * đóng cờ `import_image_unread` của ảnh đó. Trả cả Spine dự kiến để kiểm trước khi ghi.
 */
export const imageRereadOps = (
  spine: Spine,
  read: Extract<DiagramRead, { status: "read" }>,
  image: { block_id: string; image_ref: string },
  now: string
): Op[] => {
  const data = rereadOps(spine, read.items)
  const planned = data.length ? planTransaction(spine, { base_version: spine.spine_version, ops: data, by: "import" }, { startSeq: 1 }).spine : spine
  const ops: Op[] = [...data]
  const owner = spine.custom_sections.find((c) => c.blocks.some((b) => b.kind === "image" && b.image_ref === image.image_ref))
  const fnOwner = read.owner_id ?? null
  if (owner && isOriginalDiagramKind(read.kind) && (!OWNER_DIAGRAM_KINDS.has(read.kind) || fnOwner)) {
    ops.push({
      op: "set",
      path: `custom_sections[id=${owner.id}].blocks[image_ref=${image.image_ref}].diagram`,
      value: originalDiagramValue(planned, read.kind, fnOwner),
      reason: "Đọc lại ảnh sơ đồ: giữ hình gốc, ẩn sơ đồ FlintFlow cùng loại"
    })
  }
  for (const f of spine.flags) {
    if (f.rule_id !== IMPORT_IMAGE_RULE || f.resolved_at !== null || f.target_id !== image.block_id) continue
    ops.push({ op: "set", path: `flags[id=${f.id}].resolved_at`, value: now, reason: `Đóng cờ ${IMPORT_IMAGE_RULE}: đã đọc lại được ảnh` })
  }
  return ops
}

/**
 * Path cho `refreshSegmentHashes`: op thêm phần tử (`actors[]`) ⇒ path theo id (`actors[id=A03]`) để phần tử mới vào `known`
 * của đoạn — không thì bị coi như CR thêm và in thêm ở cuối mục.
 */
export const touchedPath = (op: Op): string => {
  const id = op.op === "add" && /^[a-z_]+\[\]$/.test(op.path) ? (op.value as { id?: unknown } | undefined)?.id : undefined
  return typeof id === "string" ? `${op.path.slice(0, -2)}[id=${id}]` : op.path
}

const SPINE_CONFLICT = spineRepository.SPINE_VERSION_CONFLICT
const isConflict = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === SPINE_CONFLICT

/** Ghi một ảnh vừa đọc: xung đột khoá lạc quan ⇒ đọc lại Spine, dựng lại op, thử thêm một lần. Trả path đã ghi. */
const writeImage = async (projectId: string, read: Extract<DiagramRead, { status: "read" }>, image: { block_id: string; image_ref: string }): Promise<string[] | null> => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = await spineRepository.get(projectId)
    if (!record) return null
    const spine = stripRecord(record)
    const ops = imageRereadOps(spine, read, image, new Date().toISOString())
    if (!ops.length) return []
    try {
      await applyTransaction(projectId, { base_version: spine.spine_version, ops, by: "import", reason: `Import: đọc lại ảnh sơ đồ ${image.block_id}`, step_id: null })
      return ops.map(touchedPath)
    } catch (err) {
      if (!isConflict(err) || attempt === 1) {
        console.warn(`[reread] project ${projectId}: không ghi được ảnh ${image.block_id} (${err instanceof Error ? err.message : String(err)}) — giữ cờ, lượt sau thử lại`)
        return null
      }
    }
  }
  return null
}

export type RereadOutcome = "done" | "retry" | "stopped"

/**
 * Một lượt của job: đọc lại mọi ảnh còn `unavailable`. `done` = không còn ảnh nào; `retry` = còn ảnh lỗi tạm thời (hẹn lượt
 * sau); `stopped` = hết credit / import không còn (giữ cờ).
 */
export const runImageReread = async ({ projectId, userId, importId }: Omit<RereadJobData, "round">): Promise<RereadOutcome> => {
  const doc = await ImportedDocument.findById(importId)
  // Chỉ sau khi đã có bản 0.1 (import đang trích / đang tạo bản gốc tự đọc lại trong lượt)
  if (!doc || ["uploaded", "awaiting_latest_confirm", "mapping_review", "extracting", "baselining"].includes(doc.status)) return "stopped"
  const drafts = await ExtractionDraft.find({ import_id: doc._id })
  if (!unavailableImagesOf(drafts).length) return "done"
  const inputs = await loadExtractionInputs(projectId)
  const record = await spineRepository.get(projectId)
  if (!inputs || !record) return "stopped"
  // Giữ chỗ mọi id đang có (Spine + bản trích) ⇒ phần tử mới đọc từ ảnh không nhận trùng id
  const alloc = new IdAllocator()
  for (const a of DIAGRAM_ARRAYS) for (const e of elementsOf(stripRecord(record), a)) alloc.reserve(a, e.id)
  for (const d of drafts) for (const f of d.fields) {
    const m = /^([a-z_]+)\[id=([^\]]+)\]/.exec(f.path)
    if (m) alloc.reserve(m[1], m[2])
  }
  const touched: string[] = []
  let outcome: RereadOutcome = "done"
  for (const { section_id, block_id } of unavailableImagesOf(drafts)) {
    const img = inputs.blocks.find((b) => b.block_id === block_id)
    const draft = drafts.find((d) => d.section_id === section_id)!
    if (!img?.image_ref) continue
    const ctx = rereadContextOf({ projectId, userId, alloc }, draft, drafts, inputs)
    // Bản trích có thể ghi id khác Spine sau CR (đổi tên…) ⇒ thêm phần tử Spine hiện tại làm phần tử đã biết (ghép theo tên)
    const spineKnown = spineItems(stripRecord(record))
    const r = await readDiagramImage(img, { ...ctx, known: [...ctx.known, ...spineKnown.filter((k) => !ctx.known.some((x) => x.entity === k.entity && x.id === k.id))] })
    if (r.status === "credits") {
      console.warn(`[reread] project ${projectId}: hết credit — dừng đọc lại ảnh, giữ cờ vàng`)
      outcome = "stopped"
      break
    }
    if (r.status === "unavailable") {
      outcome = "retry"
      continue
    }
    if (r.status === "read") {
      const paths = await writeImage(projectId, r, { block_id, image_ref: img.image_ref })
      if (paths === null) {
        outcome = "retry"
        continue
      }
      touched.push(...paths)
    }
    // Đọc được / lỗi không tự khỏi ⇒ draft ghi loại thật (không đọc lại nữa); dữ liệu ảnh giữ trong draft như lần đọc đầu
    applyRereadToDraft(draft, block_id, r, ctx)
    await draft.save()
  }
  if (touched.length) {
    // FLF-366: đoạn chứa phần tử vừa ghi nhận dấu mới ⇒ vẫn in nguyên văn, không thành "CR đã sửa"
    await refreshSegmentHashes(projectId, touched)
    const after = await spineRepository.get(projectId)
    const project = await Project.findById(projectId, { name: 1 }).lean()
    if (after) await assemble(projectId, (project as { name?: string } | null)?.name ?? "", after.spine_version).catch((err: unknown) => console.warn(`[reread] ghép bản làm việc lỗi: ${String(err)}`))
  }
  return outcome
}

/** Phần tử Spine hiện tại dạng phần tử trích (id + tên) — ghép tên phần tử ảnh với dữ liệu sau CR. */
const spineItems = (spine: Spine): EntityItem[] =>
  DIAGRAM_ARRAYS.flatMap((entity) =>
    elementsOf(spine, entity).map((e) => ({ entity, id: e.id, value: { name: e.name }, confidence: 1, field_confidence: {}, source_block_ids: [], origin: "deterministic" as const }))
  )

const jobKey = (importId: string) => `reread-${importId}`

/** Lịch chờ trước từng lượt (`IMPORT_REREAD_JOB_DELAYS_MS`); rỗng ⇒ job tắt. */
export const rereadDelays = (): readonly number[] => env.IMPORT_REREAD_JOB_DELAYS_MS

const rereadJob = defineJob<RereadJobData>({
  queue: "import",
  name: "reread-images",
  // Lượt lỗi tạm thời do chính job hẹn lại theo lịch (không dùng retry của queue — lịch dài, giãn dần)
  options: { attempts: 1 },
  process: async (data) => {
    const outcome = await runImageReread(data)
    if (outcome === "retry") await scheduleImageReread(data.projectId, data.userId, data.importId, data.round + 1)
    if (outcome === "retry" && data.round + 1 >= rereadDelays().length) console.warn(`[reread] import ${data.importId}: hết lịch đọc lại — giữ ảnh gốc + cờ vàng`)
  },
  onFinalFailure: async ({ importId }, err) => {
    console.error(`[reread] job đọc lại ảnh của import ${importId} lỗi — giữ cờ vàng:`, err)
  }
})

/**
 * Hẹn lượt đọc lại thứ `round` (0-based). Hết lịch / job tắt ⇒ không làm gì. Driver inline: `setTimeout` (không giữ tiến
 * trình sống); bullmq: job `delay`.
 */
export const scheduleImageReread = async (projectId: string, userId: string, importId: string, round = 0): Promise<void> => {
  const delays = rereadDelays()
  if (round >= delays.length) return
  const data: RereadJobData = { projectId, userId, importId, round }
  if (usesQueue()) return enqueueJob(rereadJob, data, { key: `${jobKey(importId)}-${round}`, delayMs: delays[round] })
  const timer = setTimeout(() => void enqueueJob(rereadJob, data, { key: jobKey(importId) }), delays[round])
  timer.unref?.()
}

/** Finalize xong mà còn ảnh AI chưa đọc được vì quá tải ⇒ hẹn job đọc lại nền. Lỗi hẹn lịch không làm hỏng finalize. */
export const scheduleRereadAfterFinalize = async (
  projectId: string,
  userId: string,
  importId: string,
  drafts: readonly Pick<IExtractionDraft, "section_id" | "status" | "diagram_images">[]
): Promise<void> => {
  if (!unavailableImagesOf(drafts).length) return
  await scheduleImageReread(projectId, userId, importId).catch((err: unknown) => console.warn(`[reread] không hẹn được job đọc lại ảnh của import ${importId}: ${String(err)}`))
}
