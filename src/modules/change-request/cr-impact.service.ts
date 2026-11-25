/**
 * C-3 tìm vị trí ảnh hưởng (nút 3.4, UC-50) — tất định, không tốn credit — rồi khoá (3.5).
 * Mode 1 v2 (FLF-186): vị trí là **phần tử Spine** (`spine-location.ts` — đích C-2 + phần tử tham chiếu tới nó,
 * phần tử nhắc mã/tên của đích, phần tử chứa từ khoá), khoá theo path (`lock.service.ts`).
 * Hybrid retrieval: index embedding dùng được (`embedding/vector-search.ts`) ⇒ phần tử gần nghĩa với CR (top-K, trên
 * ngưỡng điểm) thay nguồn từ khoá; không có ⇒ từ khoá như cũ. Embed query không trừ credit.
 */

import { stripRecord } from "../import/check.service.js"
import * as spineRepository from "../spine/spine.repository.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type { IChangeRequest } from "./change-request.model.js"
import { assertCrStatus } from "./change-request.service.js"
import { ChangeLocation } from "./change-location.model.js"
import { unlockPaths } from "./lock.service.js"
import { countMentionLocations, elementValue, emptySectionTargets, findSpineLocations, mergeFoundLocations, removeElementLocations, removeElementTarget, systemRenameLocations, systemRenameTarget, withOriginalDiagrams, withOriginalPassages, type FoundLocation, type ImpactIntent } from "./spine-location.js"
import { TemplateProfile } from "../import/template-profile.model.js"
import type { SectionSegments } from "../spine/segment-hash.js"
import { systemName } from "../spine/system-name.js"
import { crLiteralText, literalValues } from "./literal-values.js"
import { approvedBatch, approvedBatchLocations, crUseCaseIntent } from "./add-use-case.service.js"
import { Mode1Error } from "../import/mode1.errors.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import { ownerStepOf } from "../spine/section-registry.js"
import { crQueryText } from "./embedding/element-text.js"
import { vectorCandidates } from "./embedding/vector-search.js"
import { TransactionRejectedError, planTransaction } from "../spine/op-engine.js"
import { userOpSchema, type Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"

export { elementPathOf } from "./spine-location.js"

export const formatLocationId = (n: number): string => `L${String(n).padStart(3, "0")}`

/**
 * FLF-473: Spine sau khi áp thử `rawOps` (ops xem trước đính kèm CR) — op lỗi / không hợp lệ ⇒ `null` (bỏ qua câu đếm,
 * không đoán). Không có ops nào ⇒ `null` (CR không có gì để làm đổi số phần tử qua đường này).
 */
const plannedAfterSeed = (spine: Spine, rawOps: readonly unknown[]): Spine | null => {
  if (!rawOps.length) return null
  const ops: Op[] = []
  for (const raw of rawOps) {
    const parsed = userOpSchema.safeParse(raw)
    if (!parsed.success) return null
    ops.push(parsed.data)
  }
  try {
    return planTransaction(spine, { base_version: spine.spine_version, ops, by: "cr-impact:count" }, { startSeq: 1 }).spine
  } catch (err) {
    if (err instanceof TransactionRejectedError) return null
    throw err
  }
}

const REMOVE_VERB = "xoá|xóa|bỏ|gỡ|loại bỏ|remove|delete|drop"
const RENAME_PHRASE = /(?<![\p{L}\p{N}])(?:đổi tên|thay tên|gọi là|rename)(?![\p{L}\p{N}])/iu
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * FLF-483 (M4-b): ý định của CR cho C-3 - `remove` (xoá phần tử: mọi tham chiếu và mọi chỗ nhắc tên đều phải sửa), `rename`
 * (đổi tên: mọi chỗ nhắc tên cũ phải sửa), còn lại `other`. Hàm thuần, chỉ đọc chữ người yêu cầu + op xem trước.
 * `remove`: op `remove` trong `seedOps`, CR xoá use case (`crUseCaseIntent`), hoặc động từ xoá đứng ngay trước tên / mã của
 * một đích (cần `spine` để biết tên đích; không có ⇒ chỉ so mã).
 */
export const crImpactIntent = (cr: Pick<IChangeRequest, "title" | "description" | "amendments" | "targets" | "seed">, seedOps: readonly unknown[] = [], spine?: Spine): ImpactIntent => {
  const text = [cr.title, cr.description, ...(cr.amendments ?? []).map((a) => a.text)].filter(Boolean).join("\n")
  if (seedOps.some((o) => (o as { op?: unknown } | null)?.op === "remove")) return "remove"
  if (crUseCaseIntent(cr as never) === "remove") return "remove"
  const names = (cr.targets?.entity_paths ?? []).flatMap((t) => {
    const code = /^\w+\[id=([^\]]+)\]/.exec(t)?.[1]
    const value = spine ? (elementValue(spine, t.replace(/^(\w+\[id=[^\]]+\]).*$/, "$1")) as { name?: unknown } | undefined) : undefined
    return [code, typeof value?.name === "string" ? value.name : undefined].filter((n): n is string => !!n && n.trim().length >= 2)
  })
  if (names.length) {
    const edge = "(?<![\\p{L}\\p{N}])"
    const verb = new RegExp(`${edge}(?:${REMOVE_VERB})(?![\\p{L}\\p{N}])[^.;\\n]{0,40}?${edge}(?:${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "iu")
    if (verb.test(text)) return "remove"
  }
  if (systemRenameTarget(text) !== null || RENAME_PHRASE.test(text)) return "rename"
  return "other"
}

/** POST …/impact: tìm lại toàn bộ vị trí (thay lần trước) rồi khoá. */
export const runImpact = async (cr: IChangeRequest): Promise<void> => {
  assertCrStatus(cr, ["impact_review"], "impact_review")
  const record = await spineRepository.get(String(cr.projectId))
  if (!record) throw new ApiError(404, "Không tìm thấy dữ liệu tài liệu của dự án.", spineRepository.SPINE_NOT_FOUND)
  const spine = stripRecord(record)

  const seedTargets = new Set(cr.seed?.targets ?? [])
  // FLF-318: lô thêm / xoá / sửa use case đã duyệt trong chat ⇒ vị trí là đúng phần tử lô chạm tới, như trước baseline
  const approved = approvedBatch(spine, cr)
  // P08 (upload U2-7): CR chỉ đổi tên hệ thống ⇒ chỉ phần tử tên hệ thống + nơi nhắc tên, không dò từ khoá / nghĩa
  const renamesSystem = !approved && !cr.amendments?.length && systemRenameTarget(`${cr.title}
${cr.description}`) !== null
  // FLF-480 (P09 #5): CR chỉ xoá một phần tử theo mã (BR-03, UC-09…) ⇒ phần tử + nơi tham chiếu / nhắc mã, không dò BM25 rộng
  const removedCode = !approved && !renamesSystem && !cr.amendments?.length ? removeElementTarget(`${cr.title}
${cr.description}`) : null
  const removal = removedCode ? removeElementLocations(spine, removedCode) : []
  let located: FoundLocation[] = approved
    ? withOriginalDiagrams(spine, cr.targets.entity_paths, approvedBatchLocations(spine, approved))
    : removal.length
    ? withOriginalDiagrams(spine, removal.map((r) => r.path), removal)
    : renamesSystem
    ? // sơ đồ ngữ cảnh / use case gốc của file in tên hệ thống (ô trung tâm, khung hệ thống) ⇒ vẽ lại theo tên mới
      withOriginalDiagrams(spine, ["fixed:1", "fixed:2.2.1"], systemRenameLocations(spine, systemName(spine.project)))
    : findSpineLocations(spine, cr.targets.entity_paths, cr.targets.keywords, await vectorCandidates(String(cr.projectId), crQueryText(cr)), {
        // FLF-483: giá trị cụ thể CR đổi ("5 triệu") phải có ở mọi chỗ đang ghi nó, không phụ thuộc xếp hạng từ khoá / tìm theo nghĩa
        literals: literalValues(crLiteralText(cr)),
        // FLF-483: xoá / đổi tên thì giữ tên chung và tham chiếu của actor / vai trò; việc khác thì lọc nguồn nhiễu
        intent: crImpactIntent(cr, cr.seed?.ops ?? [], spine)
      }).map((f) =>
        seedTargets.has(f.path) && !f.found_by.includes("preview") ? { ...f, found_by: [...f.found_by, "preview" as const] } : f
      )
  // FLF-473 (EduCampus B14): CR làm đổi số phần tử (lô use case đã duyệt, hoặc ops xem trước đính kèm CR) ⇒ câu đếm
  // trong văn xuôi khớp đúng loại đó cũng là vị trí cần sửa, dù không nhắc tên/mã gì.
  const countAfter = approved ? approved.after : plannedAfterSeed(spine, cr.seed?.ops ?? [])
  if (countAfter) located = mergeFoundLocations(located, countMentionLocations(spine, countAfter))
  // BF §3.2 C-3: đoạn văn giữ nguyên của file gốc nhắc phần tử bị đụng tới ⇒ vị trí "sửa chữ" (không cắt trần số vị trí)
  const segments = ((await TemplateProfile.findOne({ projectId: cr.projectId }).select("section_segments").lean()) as { section_segments?: SectionSegments[] } | null)?.section_segments ?? []
  const found = segments.length ? withOriginalPassages(spine, segments, located) : located
  // C-2 đã cảnh báo yêu cầu không hợp lý và người yêu cầu chọn làm tiếp ⇒ mọi vị trí "giữ theo ý mình", C-4 không cảnh báo lại
  const keptIntent = cr.proceed_after_warning ? { kept_intent: true } : {}
  // Phase 8: CR gộp thêm lệnh sau khi đã có đề xuất ⇒ vị trí đã có (đề xuất / kết luận / khoá) giữ nguyên, chỉ thêm
  // phần tử mới. Chưa có đề xuất nào ⇒ tìm lại như cũ (thay toàn bộ vị trí, trả khoá phần tử bị bỏ).
  const existing = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).select("path location_id conclusion").lean()
  if (existing.some((l) => l.conclusion !== null)) {
    const have = new Set(existing.map((l) => l.path))
    const fresh = found.filter((f) => !have.has(f.path))
    if (!fresh.length) return
    const next = existing.reduce((n, l) => Math.max(n, Number(l.location_id.slice(1)) || 0), 0)
    await ChangeLocation.insertMany(
      fresh.map((f, i) => ({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: formatLocationId(next + i + 1), ...f, ...keptIntent }))
    )
    return
  }
  if (!found.length) {
    // Đứng im ở impact_review với 0 vị trí làm nút "Tìm vị trí" trông như hỏng. Nói rõ: đích nào là mục còn trống
    // mà cũng không thêm mới được và CR đã nhắm vào gì. Mode 1 v3 không còn step ⇒ lối ra duy nhất là sửa mô tả CR.
    const layout = await loadLayout(String(cr.projectId))
    const empty = emptySectionTargets(spine, cr.targets.entity_paths).map((section_id) => ({
      section_id,
      title: titleOfSection(spine, section_id, layout),
      step_id: section_id.startsWith("custom:") ? null : ownerStepOf(section_id, spine)
    }))
    const emptyTitles = empty.map((e) => `"${e.title}"`).join(", ")
    throw new Mode1Error(
      "CR_NO_LOCATIONS",
      empty.length
        ? `Không có phần tử nào để sửa: ${emptyTitles} đang trống - sửa mô tả CR cho trỏ vào phần tử cụ thể rồi làm rõ lại`
        : "Không tìm được phần nào trong tài liệu khớp với change request - sửa mô tả (nêu mã hoặc tên phần tử) rồi làm rõ lại",
      { targets: { entity_paths: [...cr.targets.entity_paths], keywords: [...cr.targets.keywords] }, empty_sections: empty }
    )
  }
  const previous: string[] = await ChangeLocation.find({ projectId: cr.projectId, cr_id: cr.cr_id }).distinct("path")
  await ChangeLocation.deleteMany({ projectId: cr.projectId, cr_id: cr.cr_id })
  const docs = await ChangeLocation.insertMany(
    found.map((f, i) => ({ projectId: cr.projectId, cr_id: cr.cr_id, location_id: formatLocationId(i + 1), ...f, ...keptIntent }))
  )
  // FLF-375 (business-flow §3.2): không khoá chỗ đang sửa — hai CR cùng chạm một phần tử được, C-6 kiểm lại lúc
  // xác nhận (`concurrent-edit.ts`). Chỉ dọn dòng khoá cũ (trước FLF-375) của phần tử không còn là vị trí.
  const kept = new Set(docs.map((d) => d.path))
  const dropped = previous.filter((p) => !kept.has(p))
  if (dropped.length) await unlockPaths(cr.projectId, cr.cr_id, dropped)
}
