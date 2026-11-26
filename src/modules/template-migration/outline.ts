/**
 * Dàn tiêu đề của tài liệu sau khi đổi mẫu (bước Áp dụng) — hàm thuần, không AI, không DB.
 *
 * Theo thứ tự heading của mẫu đích; mục cũ không in ra / giữ thành mục riêng chen vào sau mục mới mà heading cũ đứng trước nó đã
 * ghép tới (đúng chỗ người đọc tìm). Trạng thái mỗi dòng:
 *  - `kept`         : heading có cặp (chép nguyên nội dung), heading nhóm, mục cũ giữ thành mục riêng; heading con cùng mục với
 *                     heading cha (`pairing.children`) cũng `kept` nhưng mang `merged_into` — bước áp dụng gộp nó vào mục cha;
 *  - `receives`     : mục thiếu nhận nội dung "chuyển vào" từ mục thừa;
 *  - `needs_content`: mục thiếu cần viết (cờ đỏ chặn phát hành tới khi viết xong);
 *  - `dropped`      : mục cũ không in ra (dữ liệu giữ trong Spine) — kèm tóm tắt nội dung sẽ không in.
 * Lựa chọn hiệu lực = quyết định của BA, không có thì lựa chọn chọn sẵn (kể cả dòng đoán, để BA thấy hậu quả trước khi xác nhận).
 */
import { NFR_CATEGORY_BY_SECTION, targetsOf } from "../import/extract-targets.js"
import { contentSlot } from "../import/content-slots.js"
import type { Spine } from "../spine/spine.types.js"
import { DROP_FROM_PRINT, isFreeTextSection, missingAfterMoves, readChoice, type MigrationGroups } from "./classify.js"
import type { NewHeading, OldHeading, PairingResult } from "./pair-sections.js"

export type OutlineStatus = "kept" | "receives" | "needs_content" | "dropped"

/** Một phần tử của mục không in ra: mã (nếu có) + câu ngắn. */
export interface DroppedItem {
  id: string | null
  text: string
}

export interface OutlineEntry {
  heading_text: string
  level: number
  status: OutlineStatus
  /** `receives`: heading cũ chuyển vào; `kept` của mục cũ giữ thành mục riêng: chính heading cũ. */
  from_heading?: string[]
  /** Bảng của mục đổi theo mẫu mới: `map` = xếp theo cột mẫu mới, `keep` = giữ bảng cũ, `drop` = bỏ bảng. */
  table_change?: "map" | "keep" | "drop"
  /** `dropped`: tóm tắt nội dung không in (tối đa `DROPPED_PREVIEW` dòng) + tổng số phần tử. */
  dropped_items?: DroppedItem[]
  dropped_total?: number
  /** Heading con cùng mục với heading cha: không in thành mục riêng, nội dung nằm dưới heading cha (chữ heading cha). */
  merged_into?: string
}

export interface OutlineInput {
  old: readonly OldHeading[]
  neu: readonly NewHeading[]
  pairing: PairingResult
  groups: MigrationGroups
  decisions: readonly { id: string; choice: string }[]
  /** Spine để tóm tắt nội dung mục không in ra; thiếu ⇒ không có `dropped_items`. */
  spine?: Pick<Spine, "custom_sections"> | null
}

export const DROPPED_PREVIEW = 5
const TEXT_FIELDS = ["statement", "name", "description", "text", "term", "title", "content", "message"] as const

const shortText = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length > 140 ? `${one.slice(0, 137)}...` : one
}

const textOf = (item: Record<string, unknown>): string => {
  for (const f of TEXT_FIELDS) if (typeof item[f] === "string" && (item[f] as string).trim()) return item[f] as string
  return ""
}

/** Tóm tắt nội dung của một mục cũ: mục chữ tự do ⇒ đoạn văn; mục khung ⇒ phần tử Spine thuộc mục (NFR lọc theo nhóm). */
export const droppedItemsOf = (sectionId: string, spine: NonNullable<OutlineInput["spine"]>): DroppedItem[] => {
  if (isFreeTextSection(sectionId)) {
    const id = sectionId.startsWith("custom:") ? sectionId.slice("custom:".length) : null
    const section = id ? spine.custom_sections.find((c) => c.id === id) : undefined
    return (section?.blocks ?? []).filter((b) => b.text.trim()).map((b) => ({ id: null, text: shortText(b.text) }))
  }
  const category = NFR_CATEGORY_BY_SECTION[sectionId]
  const out: DroppedItem[] = []
  const targets = contentSlot(sectionId)?.targets ?? targetsOf(sectionId)
  for (const target of targets) {
    const value = (spine as unknown as Record<string, unknown>)[target]
    if (!Array.isArray(value)) continue
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue
      const item = raw as Record<string, unknown>
      if (target === "nfrs" && category && item.category !== category) continue
      const text = textOf(item)
      if (!text) continue
      out.push({ id: typeof item.id === "string" ? item.id : null, text: shortText(text) })
    }
  }
  return out
}

export const buildOutline = (input: OutlineInput): OutlineEntry[] => {
  const decided = new Map(input.decisions.map((d) => [d.id, readChoice(input.groups, d.id, d.choice)]))
  const choiceOf = (item: { id: string; suggested?: string }): string | null => decided.get(item.id) ?? item.suggested ?? null
  const groups = missingAfterMoves(input.groups, [...input.groups.extra, ...input.groups.conflict].map((i) => ({ id: i.id, choice: choiceOf(i) ?? "" })))
  const oldByKey = new Map(input.old.map((o) => [o.key, o]))
  const ignored = new Set(input.pairing.ignored_new)
  const missingByKey = new Map(groups.missing.map((m) => [m.new_key, m]))
  const extraById = new Map(groups.extra.map((e) => [e.id, e]))

  // Bảng của mục có cặp đổi theo quyết định conflict bảng (theo `old_key`)
  const tableOf = new Map<string, OutlineEntry["table_change"]>()
  const splitTarget = new Map<string, string>()
  for (const c of groups.conflict) {
    const choice = choiceOf(c)
    if (c.kind === "split_section") {
      if (choice?.startsWith("to:")) splitTarget.set(c.old_key, choice.slice(3))
      continue
    }
    if (!c.new_key) continue
    tableOf.set(c.old_key, choice === "keep_old_table" || choice === "keep_custom" ? "keep" : choice === "delete" || choice === DROP_FROM_PRINT ? "drop" : "map")
  }
  // Mục cũ ⇒ heading mới nơi nó được đặt (mục bị tách chọn heading khác heading đầu ⇒ theo lựa chọn)
  const pairedNew = new Map<string, string>()
  for (const p of input.pairing.pairs) if (p.new_key) pairedNew.set(p.old_key, splitTarget.get(p.old_key) ?? p.new_key)

  // Heading con gộp vào mục cha ⇒ chữ heading cha gần nhất (theo cấp); bản ghi cũ không có `children` ⇒ không dòng nào gộp
  const children = new Set(input.pairing.children ?? [])
  const parentText = new Map<string, string>()
  const stack: NewHeading[] = []
  for (const n of input.neu) {
    if (n.level === undefined) continue
    while (stack.length && stack[stack.length - 1].level! >= n.level) stack.pop()
    if (children.has(n.key) && stack.length) parentText.set(n.key, stack[stack.length - 1].heading_text)
    stack.push(n)
  }

  const entries: { key: string; entry: OutlineEntry }[] = []
  for (const n of input.neu) {
    if (ignored.has(n.key)) continue
    const level = n.level ?? 1
    const m = missingByKey.get(n.key)
    if (m?.moved_in?.length) {
      entries.push({ key: n.key, entry: { heading_text: n.heading_text, level, status: "receives", from_heading: m.moved_in.map((id) => extraById.get(id)?.heading_text ?? id) } })
    } else if (m?.needs_content) {
      entries.push({ key: n.key, entry: { heading_text: n.heading_text, level, status: "needs_content" } })
    } else {
      const owner = [...pairedNew].find(([, nk]) => nk === n.key)?.[0]
      const change = owner ? tableOf.get(owner) : undefined
      const parent = parentText.get(n.key)
      entries.push({ key: n.key, entry: { heading_text: n.heading_text, level, status: "kept", ...(change ? { table_change: change } : {}), ...(parent !== undefined ? { merged_into: parent } : {}) } })
    }
  }

  // Mục cũ không có chỗ: chen sau mục mới (và cây con của nó) mà heading cũ đứng trước đã ghép tới
  const mainOrder = input.pairing.pairs.map((p) => p.old_key)
  const insertAfter = (oldKey: string): number => {
    const i = mainOrder.indexOf(oldKey)
    for (let k = i - 1; k >= 0; k--) {
      const nk = pairedNew.get(mainOrder[k])
      const at = nk ? entries.findIndex((e) => e.key === nk) : -1
      if (at < 0) continue
      let end = at
      while (end + 1 < entries.length && entries[end + 1].entry.level > entries[at].entry.level) end++
      return end + 1
    }
    return 0
  }
  const extras: { at: number; entry: OutlineEntry; key: string }[] = []
  const pushOld = (oldKey: string, status: OutlineStatus): void => {
    const o = oldByKey.get(oldKey)
    if (!o) return
    const entry: OutlineEntry = { heading_text: o.heading_text, level: o.level, status, ...(status === "kept" ? { from_heading: [o.heading_text] } : {}) }
    if (status === "dropped" && input.spine) {
      const items = droppedItemsOf(o.section_id, input.spine)
      entry.dropped_items = items.slice(0, DROPPED_PREVIEW)
      entry.dropped_total = items.length
    }
    extras.push({ at: insertAfter(oldKey), entry, key: `old:${oldKey}` })
  }
  for (const e of groups.extra) {
    const choice = choiceOf(e)
    if (choice === DROP_FROM_PRINT) pushOld(e.old_key, "dropped")
    else if (choice === "keep_custom" || choice === null) pushOld(e.old_key, "kept")
  }
  for (const c of groups.conflict) {
    if (c.kind !== "record_of_changes" || c.new_key) continue
    const choice = choiceOf(c)
    pushOld(c.old_key, choice === DROP_FROM_PRINT ? "dropped" : "kept")
  }
  // Chèn từ cuối lên để vị trí đã tính không lệch; cùng vị trí giữ thứ tự tài liệu cũ
  extras
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .forEach((x) => entries.splice(x.at, 0, { key: x.key, entry: x.entry }))
  return entries.map((e) => e.entry)
}
