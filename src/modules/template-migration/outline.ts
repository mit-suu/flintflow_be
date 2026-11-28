/**
 * Dàn tiêu đề của tài liệu sau khi đổi mẫu (bước Áp dụng) — hàm thuần, không AI, không DB.
 *
 * Đọc **cùng kế hoạch với file Word** (`planLayout`: thứ tự đặt, phần gộp, đánh số lại, mục in từ Spine), không tự suy cặp: dãy heading
 * của dàn tiêu đề (bỏ dòng `dropped` / `merged_into`) = layout của profile (bỏ heading phần tử) = heading của file dựng ra. Mục cũ
 * không in ra chen vào sau mục mới mà heading cũ đứng trước nó đã ghép tới (đúng chỗ người đọc tìm). Trạng thái mỗi dòng:
 *  - `kept`         : heading có cặp (chép nguyên nội dung), heading nhóm, phần gộp (cấp đích + 1), mục cũ giữ thành mục riêng; mục in từ
 *                     dữ liệu Spine mang `from_spine`; heading con cùng mục với heading cha (`pairing.children`) mang `merged_into`;
 *  - `receives`     : mục nhận phần ngoài cặp chính (phần gộp từ mục khác, kể cả khi đã có cặp) — `parts` liệt kê từng phần;
 *  - `needs_content`: mục không cặp, không phần gộp, Spine trống ⇒ cần viết (cờ đỏ chặn phát hành tới khi viết xong);
 *  - `dropped`      : mục cũ thật sự không in ở đâu (dữ liệu giữ trong Spine) — kèm tóm tắt nội dung sẽ không in.
 * Lựa chọn hiệu lực = quyết định của BA, không có thì lựa chọn chọn sẵn (kể cả dòng đoán, để BA thấy hậu quả trước khi xác nhận).
 */
import { planLayout, type PlannedLayoutEntry } from "./build-base-file.js"
import { DROP_FROM_PRINT, missingAfterMoves, readChoice, type MigrationGroups } from "./classify.js"
import type { HeadingNumbering } from "./numbering.js"
import { sectionItemsOf, type SectionDataSpine } from "./section-data.js"
import type { NewHeading, OldHeading, PairingResult } from "./pair-sections.js"

export type OutlineStatus = "kept" | "receives" | "needs_content" | "dropped"

/** Một phần tử của mục không in ra: mã (nếu có) + câu ngắn. */
export interface DroppedItem {
  id: string | null
  text: string
}

/** Một phần nội dung của mục: cặp chính, phần gộp từ mục cũ khác, hoặc phần tử chia từ mục bị tách. */
export interface OutlinePart {
  heading_text: string
  kind: "pair" | "merged" | "distributed"
}

export interface OutlineEntry {
  heading_text: string
  level: number
  status: OutlineStatus
  /** `receives`: heading cũ gộp vào; `kept` của phần gộp / mục cũ giữ thành mục riêng: chính heading cũ. */
  from_heading?: string[]
  /** Bảng của mục đổi theo mẫu mới: `map` = xếp theo cột mẫu mới, `keep` = giữ bảng cũ, `drop` = bỏ bảng. */
  table_change?: "map" | "keep" | "drop"
  /** `dropped`: tóm tắt nội dung không in (tối đa `DROPPED_PREVIEW` dòng) + tổng số phần tử. */
  dropped_items?: DroppedItem[]
  dropped_total?: number
  /** Heading con cùng mục với heading cha: không in thành mục riêng, nội dung nằm dưới heading cha (chữ heading cha). */
  merged_into?: string
  /** Mục không có cặp nhưng in từ dữ liệu Spine (tầm nhìn, giả định…). */
  from_spine?: true
  /** Các phần nội dung của mục (chỉ khi có phần ngoài cặp chính). */
  parts?: OutlinePart[]
}

export interface OutlineInput {
  old: readonly OldHeading[]
  neu: readonly NewHeading[]
  pairing: PairingResult
  groups: MigrationGroups
  decisions: readonly { id: string; choice: string }[]
  /** Spine để tóm tắt nội dung mục không in ra; thiếu ⇒ không có `dropped_items`. */
  spine?: SectionDataSpine | null
  /** Đổi ngược về bản chụp file nền cũ. */
  targetIsSnapshot?: boolean
  numbering?: HeadingNumbering
}

export const DROPPED_PREVIEW = 5
/** Tóm tắt nội dung của một mục cũ (mục chữ tự do ⇒ đoạn văn; mục khung ⇒ phần tử Spine thuộc mục). */
export const droppedItemsOf = (sectionId: string, spine: NonNullable<OutlineInput["spine"]>): DroppedItem[] => sectionItemsOf(sectionId, spine)

const hasSpineElements = (spine: OutlineInput["spine"]): boolean => !!spine && (spine.functions?.length ?? 0) + (spine.use_cases?.length ?? 0) + (spine.features?.length ?? 0) + (spine.screens?.length ?? 0) > 0

export const buildOutline = (input: OutlineInput): OutlineEntry[] => {
  const decided = new Map(input.decisions.map((d) => [d.id, readChoice(input.groups, d.id, d.choice)]))
  const choiceOf = (item: { id: string; suggested?: string }): string | null => decided.get(item.id) ?? item.suggested ?? null
  const effective = [...input.groups.extra, ...input.groups.conflict].flatMap((i) => {
    const choice = choiceOf(i)
    return choice ? [{ id: i.id, choice }] : []
  })
  const groups = missingAfterMoves(input.groups, effective)
  const oldByKey = new Map(input.old.map((o) => [o.key, o]))
  const needsContent = new Set(groups.missing.filter((m) => m.needs_content).map((m) => m.new_key))
  const layout = planLayout(
    {
      targetHeadings: input.neu,
      oldHeadings: input.old,
      pairing: input.pairing,
      groups: input.groups,
      decisions: [...input.decisions.map((d) => ({ id: d.id, choice: decided.get(d.id) ?? d.choice })), ...effective.filter((e) => !decided.has(e.id))],
      targetIsSnapshot: !!input.targetIsSnapshot,
      hasSpineElements: hasSpineElements(input.spine),
      ...(input.numbering ? { numbering: input.numbering } : {})
    },
    () => "outline"
  )

  // Bảng của mục có cặp đổi theo quyết định conflict bảng (theo `old_key`)
  const tableOf = new Map<string, OutlineEntry["table_change"]>()
  for (const c of groups.conflict) {
    if (c.kind !== "table_columns" && c.kind !== "record_of_changes") continue
    if (!c.new_key) continue
    const choice = choiceOf(c)
    tableOf.set(c.old_key, choice === "keep_old_table" || choice === "keep_custom" ? "keep" : choice === "delete" || choice === DROP_FROM_PRINT ? "drop" : "map")
  }
  // Phần gộp theo heading đích (kể cả phần không in lại vì mục đích đã in đúng dữ liệu đó từ Spine)
  const mergedInto = new Map<string, string[]>()
  const addMerged = (newKey: string, oldKey: string): void => {
    const text = oldByKey.get(oldKey)?.heading_text
    if (text) mergedInto.set(newKey, [...(mergedInto.get(newKey) ?? []), text])
  }
  for (const e of layout.entries) if (e.kind === "moved" && e.new_key && e.old_key) addMerged(e.new_key, e.old_key)
  const pairedOld = new Set(input.pairing.pairs.filter((p) => p.new_key).map((p) => p.old_key))
  for (const d of effective) {
    const target = d.choice.startsWith("move_to:") ? d.choice.slice("move_to:".length) : null
    const oldKey = d.id.startsWith("e:") ? d.id.slice(2) : d.id.startsWith("c:placement:") ? d.id.slice("c:placement:".length) : null
    if (!target || !oldKey) continue
    const shown = layout.entries.some((e) => e.old_key === oldKey && (e.kind === "moved" || e.kind === "target"))
    // Phần gộp `same_data` không có dòng riêng trong layout — vẫn kể là phần của mục đích
    if (!shown) addMerged(target, oldKey)
    // Phần gộp duy nhất vào mục trống: nội dung nằm ngay dưới heading đích (dòng target mang old_key của nó)
    else if (!pairedOld.has(oldKey) || d.id.startsWith("c:placement:")) {
      if (layout.entries.some((e) => e.kind === "target" && e.new_key === target && e.old_key === oldKey)) addMerged(target, oldKey)
    }
  }

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

  const entries: { key: string; old_key: string | null; entry: OutlineEntry }[] = []
  const toEntry = (e: PlannedLayoutEntry): OutlineEntry => {
    const base = { heading_text: e.heading_text, level: e.level }
    if (e.kind !== "target") return { ...base, status: "kept", from_heading: [oldByKey.get(e.old_key ?? "")?.heading_text ?? e.heading_text] }
    const merged = e.new_key ? (mergedInto.get(e.new_key) ?? []) : []
    const change = e.old_key ? tableOf.get(e.old_key) : undefined
    const pairText = e.old_key && pairedOld.has(e.old_key) ? oldByKey.get(e.old_key)?.heading_text : undefined
    const distributed = e.items !== undefined
    if (merged.length) {
      const parts: OutlinePart[] = [...(pairText && !merged.includes(pairText) ? [{ heading_text: pairText, kind: distributed ? ("distributed" as const) : ("pair" as const) }] : []), ...merged.map((t) => ({ heading_text: t, kind: "merged" as const }))]
      return { ...base, status: "receives", from_heading: merged, parts, ...(change ? { table_change: change } : {}), ...(e.from_spine ? { from_spine: true as const } : {}) }
    }
    if (e.missing && e.new_key && needsContent.has(e.new_key)) return { ...base, status: "needs_content" }
    return {
      ...base,
      status: "kept",
      ...(change ? { table_change: change } : {}),
      ...(e.from_spine ? { from_spine: true as const } : {}),
      ...(distributed && pairText ? { parts: [{ heading_text: pairText, kind: "distributed" as const }] } : {})
    }
  }
  for (const e of layout.entries) {
    if (e.kind === "follower" || !e.heading_text.trim()) continue
    entries.push({ key: e.new_key ?? `old:${e.old_key}`, old_key: e.kind === "target" ? e.old_key : null, entry: toEntry(e) })
  }
  // Heading con gộp vào mục cha: không có trong layout, hiện ngay sau mục cha để BA thấy nó đi đâu
  input.neu.forEach((n, i) => {
    const parent = parentText.get(n.key)
    if (parent === undefined || layout.entries.some((e) => e.new_key === n.key)) return
    const prevKey = input.neu.slice(0, i).reverse().find((p) => entries.some((x) => x.key === p.key))?.key
    const at = prevKey ? entries.findIndex((x) => x.key === prevKey) + 1 : 0
    entries.splice(at, 0, { key: n.key, old_key: null, entry: { heading_text: n.heading_text, level: n.level ?? 1, status: "kept", merged_into: parent } })
  })

  // Mục cũ không in ra: chen sau mục mới (và cây con của nó) mà heading cũ đứng trước đã ghép tới
  const mainOrder = input.pairing.pairs.map((p) => p.old_key)
  const insertAfter = (oldKey: string): number => {
    const i = mainOrder.indexOf(oldKey)
    for (let k = i - 1; k >= 0; k--) {
      const at = entries.findIndex((e) => e.old_key === mainOrder[k])
      if (at < 0) continue
      let end = at
      while (end + 1 < entries.length && entries[end + 1].entry.level > entries[at].entry.level) end++
      return end + 1
    }
    return 0
  }
  const extras: { at: number; entry: OutlineEntry; key: string }[] = []
  const pushDropped = (oldKey: string): void => {
    const o = oldByKey.get(oldKey)
    if (!o) return
    const entry: OutlineEntry = { heading_text: o.heading_text, level: o.level, status: "dropped" }
    if (input.spine) {
      const items = droppedItemsOf(o.section_id, input.spine)
      entry.dropped_items = items.slice(0, DROPPED_PREVIEW)
      entry.dropped_total = items.length
    }
    extras.push({ at: insertAfter(oldKey), entry, key: `old:${oldKey}` })
  }
  for (const e of groups.extra) if (choiceOf(e) === DROP_FROM_PRINT) pushDropped(e.old_key)
  for (const c of groups.conflict) if (c.kind === "record_of_changes" && !c.new_key && choiceOf(c) === DROP_FROM_PRINT) pushDropped(c.old_key)
  // Chèn từ cuối lên để vị trí đã tính không lệch; cùng vị trí giữ thứ tự tài liệu cũ
  extras
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => b.at - a.at || b.i - a.i)
    .forEach((x) => entries.splice(x.at, 0, { key: x.key, old_key: null, entry: x.entry }))
  return entries.map((e) => e.entry)
}
