/**
 * Hàng việc chờ người quyết (FLF-443, endpoint 51). Hàm thuần đọc một Spine, trả danh sách đã xếp: loại việc → bước soạn
 * sở hữu → section → phần tử. Chỉ thứ tự và danh tính, không chữ UI, không gọi model.
 *
 * Phạm vi loại (vị từ pha khớp FE): Brief = `current_phase` bắt đầu `B-` hoặc bằng `S-1`.
 *   - assumption: `unconfirmed` khi Brief; brief_note: mọi `addendum[]` khi Brief; screen: `pending` khi S-5;
 *   - flag_red: cờ đỏ mở, chưa "giữ nguyên"; riêng `unconfirmed_assumption` / `screen_pending_at_baseline` (S-9) đổi
 *     thành việc assumption / screen theo `target_id` để thẻ đưa đúng thao tác miễn phí;
 *   - flag_yellow_group: cờ vàng mở chưa waive, chưa giữ nguyên, gom theo phần tử đã chuẩn hoá, không có thì `rule_id@section_id`.
 *   - chế độ 1 (`flagsOnly`): cờ đỏ cũng gom theo đúng khoá đó (một CR sửa cả nhóm); nhóm một cờ giữ khoá `flag_red:<id>`,
 *     nhóm nhiều cờ khoá `flag_red:<khoá nhóm>`. Cờ đỏ vẫn đứng trước cờ vàng.
 *   - cờ đang thuộc change request chưa kết thúc (FLF-445) không vào hàng.
 */

import type { PendingItem, PendingKind, PendingQueue } from "../pipeline/pipeline.dto.js"
import { orderedSteps } from "../pipeline/step-registry.js"
import { SOURCE_COLLECTIONS, entityPathOf } from "../project/requirement-source.service.js"
import { listSections, ownerStepOf, sectionsOfPath } from "./section-registry.js"
import type { Flag, Spine } from "./spine.types.js"

const KIND_ORDER: Readonly<Record<PendingKind, number>> = {
  assumption: 0,
  brief_note: 1,
  screen: 2,
  flag_red: 3,
  flag_yellow_group: 4
}

/** Cờ đỏ ở S-9 mà việc thật là một giả định / một màn: thẻ phải đưa thao tác của giả định / màn, không phải "sửa trong chat". */
const ASSUMPTION_FLAG_RULE = "unconfirmed_assumption"
const SCREEN_FLAG_RULE = "screen_pending_at_baseline"

/** Id trần: `FN3`, `A01`, `SCR-02`. Chuỗi có `[`, `.`, khoảng trắng là nhãn / path, không phải id. */
const BARE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

const compareIds = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

/** Bảng id → collection; id trùng giữa các collection thì collection đứng trước trong `SOURCE_COLLECTIONS` thắng. */
export const buildIdIndex = (spine: Spine): Map<string, string> => {
  const index = new Map<string, string>()
  for (const collection of SOURCE_COLLECTIONS) {
    const list = (spine as unknown as Record<string, Array<{ id?: unknown }> | undefined>)[collection]
    if (!Array.isArray(list)) continue
    for (const el of list) if (typeof el.id === "string" && !index.has(el.id)) index.set(el.id, collection)
  }
  return index
}

/** `target_id` của cờ (id trần, nhãn, ref path, path thô) → `<collection>[id=X]`; không chuẩn hoá được ⇒ null. */
export const normalizeTarget = (target: string | null | undefined, idIndex: ReadonlyMap<string, string>): string | null => {
  const raw = target?.trim()
  if (!raw) return null
  const viaPath = entityPathOf(raw)
  if (viaPath) return viaPath
  if (!BARE_ID.test(raw)) return null
  const collection = idIndex.get(raw)
  return collection ? `${collection}[id=${raw}]` : null
}

interface Draft {
  item: Omit<PendingItem, "dependents">
  /** Khoá xếp: id phần tử cuối cùng. */
  elementId: string
}

export interface PendingQueueOptions {
  /**
   * Id cờ đang thuộc change request chưa kết thúc (FLF-445) — đã có người xử lý, không đưa vào hàng.
   * CR kết thúc mà cờ còn mở ⇒ cờ quay lại hàng như thường.
   */
  flagsInCr?: ReadonlySet<string>
  /**
   * Dự án chế độ 1 (import, FLF-445): mọi sửa đi qua change request (`POST /changes` bị chặn) ⇒ hàng chỉ có cờ; cờ đỏ
   * giả định / màn giữ là cờ (sửa qua CR) thay vì đổi thành việc giả định / màn.
   */
  flagsOnly?: boolean
}

export const buildPendingQueue = (spine: Spine, options: PendingQueueOptions = {}): PendingQueue => {
  const flagsInCr = options.flagsInCr ?? new Set<string>()
  const flagsOnly = options.flagsOnly ?? false
  const phase = spine.progress?.current_phase ?? null
  const inBrief = !flagsOnly && phase !== null && (phase.startsWith("B-") || phase === "S-1")
  const inScreenLoop = !flagsOnly && phase === "S-5"

  const stepIndex = new Map(orderedSteps(spine).map((s, i) => [s.id, i]))
  const stepRank = (stepId: string): number => stepIndex.get(stepId) ?? Number.POSITIVE_INFINITY
  const sectionIndex = new Map(listSections(spine).map((s, i) => [s.id, i]))
  const sectionRank = (sectionId: string | null): number => (sectionId === null ? Number.POSITIVE_INFINITY : (sectionIndex.get(sectionId) ?? Number.POSITIVE_INFINITY))
  const idIndex = buildIdIndex(spine)

  const drafts: Draft[] = []
  const seen = new Set<string>()
  const push = (draft: Draft): void => {
    if (seen.has(draft.item.key)) return
    seen.add(draft.item.key)
    drafts.push(draft)
  }

  const assumptionDraft = (id: string, fallbackSection: string | null): Draft | null => {
    const a = spine.assumptions.find((x) => x.id === id)
    if (!a) return null
    return {
      elementId: a.id,
      item: {
        key: `assumption:${a.id}`,
        kind: "assumption",
        blocking: true,
        owner_step: a.origin_step_id,
        section_id: sectionsOfPath(spine, a.path).owner[0] ?? fallbackSection,
        entity_path: entityPathOf(a.path),
        refs: { assumption_id: a.id }
      }
    }
  }

  const screenDraft = (id: string): Draft | null => {
    const s = spine.screens.find((x) => x.id === id)
    if (!s) return null
    return {
      elementId: s.id,
      item: {
        key: `screen:${s.id}`,
        kind: "screen",
        blocking: true,
        owner_step: `S-5.1@${s.id}`,
        section_id: s.primary_function_id ? `function:${s.primary_function_id}` : "fixed:3.1.2",
        entity_path: `screens[id=${s.id}]`,
        refs: { screen_id: s.id }
      }
    }
  }

  if (inBrief) {
    for (const a of spine.assumptions) {
      if (a.status !== "unconfirmed") continue
      const d = assumptionDraft(a.id, null)
      if (d) push(d)
    }
    for (const note of spine.addendum) {
      push({
        elementId: note.id,
        item: {
          key: `brief_note:${note.id}`,
          kind: "brief_note",
          blocking: true,
          owner_step: ownerStepOf(note.target_section, spine),
          section_id: note.target_section,
          entity_path: `addendum[id=${note.id}]`,
          refs: { addendum_id: note.id }
        }
      })
    }
  }

  if (inScreenLoop) {
    for (const s of spine.screens) {
      if (s.detail_status !== "pending") continue
      const d = screenDraft(s.id)
      if (d) push(d)
    }
  }

  const yellow = new Map<string, Flag[]>()
  const red = new Map<string, Flag[]>()
  const groupKeyOf = (flag: Flag): string => normalizeTarget(flag.target_id, idIndex) ?? `${flag.rule_id}@${flag.section_id}`
  const addTo = (map: Map<string, Flag[]>, flag: Flag): void => {
    const key = groupKeyOf(flag)
    const bucket = map.get(key)
    if (bucket) bucket.push(flag)
    else map.set(key, [flag])
  }
  for (const flag of spine.flags) {
    if (flag.resolved_at !== null || flagsInCr.has(flag.id)) continue
    if (flag.level === "red") {
      if (flag.kept_reason !== null) continue
      // Chế độ 1: cờ đỏ gom nhóm như cờ vàng (sửa qua CR theo nhóm)
      if (flagsOnly) {
        addTo(red, flag)
        continue
      }
      const target = flagsOnly ? null : (flag.target_id ?? null)
      const converted =
        target !== null && flag.rule_id === ASSUMPTION_FLAG_RULE
          ? assumptionDraft(target, flag.section_id)
          : target !== null && flag.rule_id === SCREEN_FLAG_RULE
            ? screenDraft(target)
            : null
      if (converted) {
        push(converted)
        continue
      }
      push({
        elementId: flag.id,
        item: {
          key: `flag_red:${flag.id}`,
          kind: "flag_red",
          blocking: true,
          owner_step: flag.remediation_step,
          section_id: flag.section_id,
          entity_path: normalizeTarget(flag.target_id, idIndex),
          refs: { flag_ids: [flag.id] }
        }
      })
      continue
    }
    // Đã bỏ qua, hoặc đã "giữ nguyên + lý do" (chế độ 1 không bỏ qua được, FLF-445) ⇒ người dùng đã quyết
    if (flag.waived_by_user || flag.kept_reason !== null) continue
    addTo(yellow, flag)
  }

  // Đại diện nhóm: cờ có bước soạn sớm nhất, rồi section sớm nhất, rồi id nhỏ nhất
  const byLead = (flags: readonly Flag[]): Flag[] =>
    [...flags].sort((a, b) => stepRank(a.remediation_step) - stepRank(b.remediation_step) || sectionRank(a.section_id) - sectionRank(b.section_id) || compareIds(a.id, b.id))

  for (const [groupKey, flags] of red) {
    const sorted = byLead(flags)
    const lead = sorted[0]
    push({
      elementId: flags.length === 1 ? lead.id : groupKey,
      item: {
        key: flags.length === 1 ? `flag_red:${lead.id}` : `flag_red:${groupKey}`,
        kind: "flag_red",
        blocking: true,
        owner_step: lead.remediation_step,
        section_id: lead.section_id,
        entity_path: normalizeTarget(lead.target_id, idIndex),
        refs: { flag_ids: sorted.map((f) => f.id).sort(compareIds) }
      }
    })
  }

  for (const [groupKey, flags] of yellow) {
    const sorted = byLead(flags)
    const lead = sorted[0]
    push({
      elementId: groupKey,
      item: {
        key: `flag_yellow_group:${groupKey}`,
        kind: "flag_yellow_group",
        blocking: false,
        owner_step: lead.remediation_step,
        section_id: lead.section_id,
        entity_path: groupKey.includes("[id=") || groupKey.startsWith("project.") ? groupKey : null,
        refs: { flag_ids: sorted.map((f) => f.id).sort(compareIds) }
      }
    })
  }

  drafts.sort(
    (a, b) =>
      KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
      cmpRank(stepRank(a.item.owner_step), stepRank(b.item.owner_step)) ||
      cmpRank(sectionRank(a.item.section_id), sectionRank(b.item.section_id)) ||
      compareIds(a.elementId, b.elementId)
  )

  // dependents: số việc khác cùng phần tử thuộc bước soạn SAU việc này
  const byEntity = new Map<string, number[]>()
  for (const d of drafts) {
    if (d.item.entity_path === null) continue
    const ranks = byEntity.get(d.item.entity_path)
    const rank = stepRank(d.item.owner_step)
    if (ranks) ranks.push(rank)
    else byEntity.set(d.item.entity_path, [rank])
  }
  const items: PendingItem[] = drafts.map(({ item }) => {
    const mine = stepRank(item.owner_step)
    const dependents = item.entity_path === null ? 0 : (byEntity.get(item.entity_path) ?? []).filter((r) => r > mine).length
    return { ...item, dependents }
  })

  return { total: items.length, items }
}

/** So hai hạng có thể là Infinity (Infinity - Infinity = NaN). */
const cmpRank = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1)
