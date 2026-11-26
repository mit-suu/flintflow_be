/**
 * Bản Track Changes của bản phát hành (FLF-466 phase 03; BF §3.2 C-6, §3.7, §4 "Nhận về"): so với **lần phát hành / bản gốc / baseline ổn định gần nhất**.
 * Tác giả từng chỗ sửa = CR sửa đoạn đó sau cùng (`CR-014 (Lan)`), chỗ không thuộc CR nào (thay đổi hệ thống, hoặc không tìm được) = tên người phát hành;
 * ngày = lúc phát hành. Gói có đổi mẫu kèm dịch ⇒ không dựng (`template_translated`); dựng lỗi ⇒ không chặn phát hành (`build_failed`).
 */

import { normalizeText } from "../docx-ooxml/index.js"
import { ChangeLocation } from "../change-request/change-location.model.js"
import { ChangeRequest } from "../change-request/change-request.model.js"
import { loadLayout, titleOfSection } from "../import/gap-report.service.js"
import type { Spine } from "../spine/spine.types.js"
import { docFileStore } from "./doc-file.store.js"
import type { IDocVersion } from "./doc-version.model.js"
import { trackedPolicySince } from "./migration-tracked-policy.js"
import { authorNameOf } from "./system-change.service.js"
import { buildTrackedDocx, pairParagraphs, paragraphTexts, type ParagraphChange, type TrackedComment } from "./tracked-version.js"
import { isStableDocVersion } from "./versioning.js"

export const TRACKED_UNAVAILABLE_REASONS = ["template_translated", "build_failed"] as const
export type TrackedUnavailableReason = (typeof TRACKED_UNAVAILABLE_REASONS)[number]

/** Version ổn định gần nhất (bản gốc 0.1 / baseline / release) trong danh sách mới -> cũ; `exclude` = version đang tạo. */
export const lastStableVersion = (versionsNewestFirst: readonly IDocVersion[], exclude?: string): IDocVersion | null =>
  versionsNewestFirst.find((v) => v.version !== exclude && isStableDocVersion(v)) ?? null

/**
 * Lý do gói hiện tại (hoặc lần phát hành sắp tạo) không có bản Track Changes: có đổi mẫu kèm dịch kể từ version ổn định gần nhất; không ⇒ `null`.
 */
export const trackedUnavailableReasonFor = async (projectId: string, versionsNewestFirst: readonly IDocVersion[]): Promise<TrackedUnavailableReason | null> => {
  const stable = lastStableVersion(versionsNewestFirst)
  if (!stable) return null
  return (await trackedPolicySince(projectId, stable.createdAt)) === "none" ? "template_translated" : null
}

/** Khoá so đoạn: chữ chuẩn hoá. */
const key = (text: string): string => normalizeText(text)

/**
 * Với mỗi cặp bản nháp liền nhau (cũ -> mới) ghi lại "đoạn chữ X do CR nào ghi ra" (modified / added: theo chữ mới; removed: theo chữ cũ).
 * Trả hàm tra tác giả cho từng chỗ sửa của diff cuối: lấy cặp **muộn nhất** làm đoạn đó đổi chữ.
 */
const crAuthorLookup = async (chain: readonly IDocVersion[], contentOnly: boolean): Promise<(change: ParagraphChange) => string | null> => {
  // chain[0] = bản ổn định trước; chain[i] (i >= 1) = bản nháp thứ i. Chỉ `cr_revision` có CR; thay đổi hệ thống không gán.
  const texts: string[][] = []
  for (const v of chain) texts.push(await paragraphTexts(await docFileStore().load(v.file_ref), contentOnly))
  const added: Map<string, string>[] = [] // chữ mới -> nhãn tác giả, theo từng cặp
  const removed: Map<string, string>[] = []
  for (let i = 1; i < chain.length; i++) {
    const addedMap = new Map<string, string>()
    const removedMap = new Map<string, string>()
    const crId = chain[i].kind === "cr_revision" ? chain[i].cr_ids[0] : undefined
    if (crId) {
      const label = `${crId} (${await authorNameOf(String(chain[i].created_by))})`
      for (const ch of pairParagraphs(texts[i - 1], texts[i])) {
        if (ch.kind === "removed") removedMap.set(key(ch.before), label)
        else addedMap.set(key(ch.after), label)
      }
    }
    added.push(addedMap)
    removed.push(removedMap)
  }
  return (change) => {
    const maps = change.kind === "removed" ? removed : added
    const k = key(change.kind === "removed" ? change.before : change.after)
    for (let i = maps.length - 1; i >= 0; i--) {
      const label = maps[i].get(k)
      if (label) return label
    }
    return null
  }
}

export interface ReleaseTrackedResult {
  tracked_file_ref: string | null
  tracked_unavailable_reason: TrackedUnavailableReason | null
}

const releaseComments = async (
  projectId: string,
  crIds: readonly string[],
  chain: readonly IDocVersion[],
  spine?: Spine
): Promise<TrackedComment[]> => {
  if (!crIds.length || !spine) return []
  const locations = await ChangeLocation.find({ projectId, cr_id: { $in: crIds }, conclusion: "comment" }).lean()
  const withText = locations.filter((l) => Boolean(l.proposal?.comment_text?.trim()))
  if (!withText.length) return []
  const layout = await loadLayout(projectId)
  // Tác giả comment = `<mã CR> (<người ghi>)` giống CR bản nháp (phase 03: "comment CR dùng tác giả của CR đó")
  const userByCr = new Map<string, string>()
  for (const v of chain) {
    if (v.kind === "cr_revision" && v.cr_ids[0]) userByCr.set(v.cr_ids[0], String(v.created_by))
  }
  const missingCrs = [...new Set(withText.map((l) => l.cr_id).filter((id) => !userByCr.has(id)))]
  if (missingCrs.length) {
    const crs = await ChangeRequest.find({ projectId, cr_id: { $in: missingCrs } }, { cr_id: 1, decided_by: 1, created_by: 1 }).lean()
    for (const c of crs) {
      const uid = c.decided_by ?? c.created_by
      if (uid) userByCr.set(c.cr_id, String(uid))
    }
  }
  const authorByCr = new Map<string, string>()
  for (const crId of [...new Set(withText.map((l) => l.cr_id))]) {
    const uid = userByCr.get(crId)
    authorByCr.set(crId, uid ? `${crId} (${await authorNameOf(uid)})` : crId)
  }
  return withText.map((l) => ({
    section_title: titleOfSection(spine, l.section_id, layout),
    text: l.proposal!.comment_text!,
    author: authorByCr.get(l.cr_id) ?? l.cr_id
  }))
}

/**
 * Dựng + lưu bản Track Changes của bản phát hành `version` (file vừa render là `buffer`). Không bao giờ ném lỗi.
 * `versionsNewestFirst` = mọi version đã có (chưa gồm bản phát hành đang tạo).
 */
export const buildReleaseTracked = async (input: {
  projectId: string
  userId: string
  version: string
  buffer: Buffer
  versionsNewestFirst: readonly IDocVersion[]
  crIds?: readonly string[]
  spine?: Spine
  now?: Date
}): Promise<ReleaseTrackedResult> => {
  const { projectId, userId, version, buffer, versionsNewestFirst } = input
  const stable = lastStableVersion(versionsNewestFirst)
  if (!stable) return { tracked_file_ref: null, tracked_unavailable_reason: null }
  try {
    const policy = await trackedPolicySince(projectId, stable.createdAt)
    if (policy === "none") return { tracked_file_ref: null, tracked_unavailable_reason: "template_translated" }
    const contentOnly = policy === "content_only"
    // Bản nháp từ lần ổn định trước (cũ -> mới) để tìm CR sửa đoạn sau cùng
    const chain = [stable, ...versionsNewestFirst.filter((v) => v.createdAt > stable.createdAt && !isStableDocVersion(v)).reverse()]
    let authorOf: ((change: ParagraphChange) => string | null) | undefined
    try {
      authorOf = await crAuthorLookup(chain, contentOnly)
    } catch (err) {
      console.warn(`[release] ${version}: không xác định được CR sửa từng đoạn - mọi chỗ sửa mang tên người phát hành`, err)
    }
    const comments = await releaseComments(projectId, input.crIds ?? [], chain, input.spine).catch(() => [])
    const out = await buildTrackedDocx(
      await docFileStore().load(stable.file_ref),
      buffer,
      { author: await authorNameOf(userId), date: input.now ?? new Date() },
      comments,
      { contentOnly, ...(authorOf ? { authorOf } : {}) }
    )
    const ref = await docFileStore().save(out.data, { projectId, kind: "version", name: `${version}_tracked` })
    return { tracked_file_ref: ref, tracked_unavailable_reason: null }
  } catch (err) {
    console.warn(`[release] ${version}: dựng bản có đánh dấu lỗi - chỉ còn bản sạch`, err)
    return { tracked_file_ref: null, tracked_unavailable_reason: "build_failed" }
  }
}
