/**
 * Ghép mục của tài liệu hiện tại (heading cũ) với mục của mẫu đích (heading mới) — hàm thuần, không AI, không DB.
 *
 * - Mục khung (`fixed:*`, `group:*`, `slot:*`) ghép theo `section_id`. Mẫu đích có nhiều heading cùng `section_id` (IEEE tách
 *   Reliability / Availability cùng về 4.2.2) ⇒ ghép heading đầu, ghi vào `split` để BA chọn nơi đặt.
 *   Mục FPT và phần nhỏ `slot:*` chồng lấn (`overlapsOf`: 5.1 ↔ slot:business_rules) ghép với nhau như cùng một mục; một mục cũ
 *   chồng lấn với nhiều phần nhỏ ⇒ ghép phần đầu, phần còn lại vào `split`.
 * - Mục riêng (`custom:*` / `unmapped`) ghép theo `titleSimilarity` trên chữ heading đã bỏ số mục; dưới ngưỡng ⇒ chưa ghép.
 *   Một mục khung chưa ghép được còn thử ghép theo chữ với mục riêng của phía kia (mẫu mới đặt tên khác mapping), nhưng hai mục
 *   khung khác id không bao giờ ghép với nhau theo chữ.
 * - Heading phần tử (`feature:*`, `function:*`, UC / màn / chức năng nhận ra qua tên hoặc mã trong Spine, mục riêng lồng dưới
 *   mục chứa phần tử) và phần nối (heading rỗng) **đi theo mục khung cha** — không bao giờ vào 4 nhóm. Heading phần tử của
 *   mẫu đích chỉ là ví dụ của mẫu ⇒ bỏ qua.
 */
import { foldText, splitHeadingNumber, titleSimilarity } from "../import/text-similarity.js"
import { overlapsOf } from "../import/content-slots.js"
import { classifySection } from "../import/template-skeleton.js"

/** Heading của tài liệu hiện tại (layout của project), theo thứ tự tài liệu. `key` duy nhất trong một migration. */
export interface OldHeading {
  key: string
  heading_text: string
  level: number
  section_id: string
}

/** Heading của mẫu đích (`OrgTemplateVersion.headings`), `key` = `n<vị trí>`. */
export interface NewHeading {
  key: string
  heading_text: string
  section_id: string
  /** Mapping độ tin thấp được tự nhận lúc đăng mẫu — hiện "Cần xem". */
  auto_confirmed?: boolean
  guidance?: string
  /** Cấp heading trong file mẫu (đọc lúc chuẩn bị) — thiếu thì không áp luật "lồng dưới mục chứa phần tử". */
  level?: number
}

/** `overlap`: mục FPT ↔ phần nhỏ `slot:*` dùng chung dữ liệu (mẫu bắt buộc chia nhỏ mục FPT). */
export type PairBy = "section_id" | "overlap" | "title" | "manual"

export interface SectionPair {
  old_key: string
  /** `null` = chưa ghép được. */
  new_key: string | null
  by: PairBy | null
  score: number
  needs_review: boolean
}

export interface Follower {
  old_key: string
  kind: "element" | "continuation"
  /** Mục khung / mục riêng cha ở tài liệu hiện tại; `null` = không có heading cha. */
  parent_old_key: string | null
}

export interface PairingResult {
  /** Mỗi heading cũ không phải phần tử / phần nối đúng một dòng, theo thứ tự tài liệu. */
  pairs: SectionPair[]
  followers: Follower[]
  /** Heading phần tử của mẫu đích (ví dụ của mẫu) — không tính là mục thiếu. */
  ignored_new: string[]
  /** Mục cũ có nhiều heading cùng `section_id` ở mẫu đích (ghép heading đầu). */
  split: { old_key: string; new_keys: string[] }[]
}

export interface PairOptions {
  /** Tên phần tử trong Spine (UC, tính năng, chức năng, màn), đã `foldText`. */
  elementNames?: ReadonlySet<string>
  /** Mã phần tử trong Spine đã qua `normalizeElementId`. */
  elementIds?: ReadonlySet<string>
  threshold?: number
}

/** Dưới ngưỡng này heading riêng để chưa ghép (BA ghép tay) — thà thiếu còn hơn ghép sai. */
export const CUSTOM_PAIR_THRESHOLD = 0.6
/** Ghép theo chữ dưới mức này vẫn ghép nhưng hiện "Cần xem". */
export const TITLE_REVIEW_BELOW = 0.85

/** Mục khung chứa các heading phần tử viết tay: mục riêng lồng dưới chúng là phần tử, không phải mục riêng độc lập. */
const ELEMENT_CONTAINERS: ReadonlySet<string> = new Set(["fixed:2.2.2", "fixed:3.1.2", "fixed:3.1.4"])

export const isFrameworkId = (sectionId: string): boolean => sectionId.startsWith("fixed:") || sectionId.startsWith("group:") || sectionId.startsWith("slot:")

const titleOf = (text: string): string => splitHeadingNumber(text).title

/** Mã phần tử so không phân biệt hoa thường và dấu gạch (`UC-01` ≈ `UC01`). */
export const normalizeElementId = (id: string): string => id.toUpperCase().replace(/[-_]/g, "")

const tokensOf = (text: string): string[] => (text.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).map(normalizeElementId)

const isElementByData = (heading: OldHeading, options: PairOptions): boolean => {
  const title = foldText(titleOf(heading.heading_text))
  if (title && options.elementNames?.has(title)) return true
  const ids = options.elementIds
  return !!ids?.size && tokensOf(heading.heading_text).some((t) => ids.has(t))
}

/** Heading cũ ⇒ phần tử / phần nối đi theo cha, còn lại là mục chính cần ghép. */
const splitOld = (old: readonly OldHeading[], options: PairOptions): { main: OldHeading[]; followers: Follower[] } => {
  const main: OldHeading[] = []
  const followers: Follower[] = []
  const stack: { level: number; key: string; sectionId: string; element: boolean }[] = []
  /** Cha khung của phần tử = heading không phải phần tử gần nhất phía trên. */
  const nearestOwner = (): string | null => [...stack].reverse().find((s) => !s.element)?.key ?? null
  let last: { key: string; element: boolean; parent: string | null } | null = null

  for (const h of old) {
    if (!h.heading_text.trim()) {
      // Phần nối (heading rỗng) theo heading đứng ngay trước nó
      followers.push({ old_key: h.key, kind: "continuation", parent_old_key: last ? (last.element ? last.parent : last.key) : null })
      continue
    }
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    const custom = classifySection({ section_id: h.section_id }) === "custom"
    const nestedInContainer = custom && stack.some((s) => !s.element && ELEMENT_CONTAINERS.has(s.sectionId))
    const cls = classifySection({ section_id: h.section_id })
    // Mục khung giữ là mục khung dù chữ trùng tên một phần tử trong Spine; chỉ mục riêng mới bị nhận là phần tử theo dữ liệu / vị trí
    const element = cls === "element" || (cls === "custom" && (isElementByData(h, options) || nestedInContainer))
    const parent = nearestOwner()
    stack.push({ level: h.level, key: h.key, sectionId: h.section_id, element })
    last = { key: h.key, element, parent }
    if (element) followers.push({ old_key: h.key, kind: "element", parent_old_key: parent })
    else main.push(h)
  }
  return { main, followers }
}

/**
 * Heading phần tử của mẫu đích (chỉ là ví dụ của mẫu): id tạm `feature:@` / `function:@`, và — khi biết cấp heading — mục riêng
 * (`unmapped`) lồng dưới mục chứa phần tử (UC / màn / chức năng mẫu không được gán id tạm ở những mục này).
 */
const newElementKeys = (neu: readonly NewHeading[]): Set<string> => {
  const out = new Set<string>()
  const stack: { level: number; sectionId: string }[] = []
  for (const n of neu) {
    const cls = classifySection({ section_id: n.section_id })
    if (cls === "element") out.add(n.key)
    if (n.level === undefined) continue
    while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop()
    if (cls === "custom" && stack.some((s) => ELEMENT_CONTAINERS.has(s.sectionId))) out.add(n.key)
    stack.push({ level: n.level, sectionId: n.section_id })
  }
  return out
}

/** Ghép tự động. Cùng đầu vào ⇒ cùng kết quả. */
export const pairSections = (old: readonly OldHeading[], neu: readonly NewHeading[], options: PairOptions = {}): PairingResult => {
  const threshold = options.threshold ?? CUSTOM_PAIR_THRESHOLD
  const { main, followers } = splitOld(old, options)
  const ignored = newElementKeys(neu)
  const ignored_new = neu.filter((n) => ignored.has(n.key)).map((n) => n.key)
  const candidates = neu.filter((n) => !ignored.has(n.key))

  const byId = new Map<string, NewHeading[]>()
  for (const n of candidates) if (isFrameworkId(n.section_id)) byId.set(n.section_id, [...(byId.get(n.section_id) ?? []), n])

  const claimed = new Set<string>()
  const pairOf = new Map<string, SectionPair>()
  const split: PairingResult["split"] = []

  for (const o of main) {
    // Heading mới đã có chủ (hai heading cũ cùng section_id) không ghép lần nữa: heading cũ thứ hai để chưa ghép cho BA quyết
    const found = isFrameworkId(o.section_id) ? byId.get(o.section_id)?.filter((n) => !claimed.has(n.key)) : undefined
    if (!found?.length) continue
    pairOf.set(o.key, { old_key: o.key, new_key: found[0].key, by: "section_id", score: 1, needs_review: !!found[0].auto_confirmed })
    for (const n of found) claimed.add(n.key)
    if (found.length > 1) split.push({ old_key: o.key, new_keys: found.map((n) => n.key) })
  }

  // Mục FPT ↔ phần nhỏ chồng lấn (mẫu bắt buộc map heading vào slot thay vì mục FPT cha)
  for (const o of main) {
    if (pairOf.has(o.key) || !isFrameworkId(o.section_id)) continue
    const overlap = new Set(overlapsOf(o.section_id))
    const found = candidates.filter((n) => !claimed.has(n.key) && overlap.has(n.section_id))
    if (!found.length) continue
    pairOf.set(o.key, { old_key: o.key, new_key: found[0].key, by: "overlap", score: 1, needs_review: !!found[0].auto_confirmed })
    for (const n of found) claimed.add(n.key)
    if (found.length > 1) split.push({ old_key: o.key, new_keys: found.map((n) => n.key) })
  }

  // Ghép theo chữ cho phần còn lại; hai mục khung (khác id) không ghép với nhau theo chữ
  const oldLeft = main.filter((o) => !pairOf.has(o.key))
  const newLeft = candidates.filter((n) => !claimed.has(n.key))
  const scored: { o: OldHeading; n: NewHeading; score: number; oi: number; ni: number }[] = []
  oldLeft.forEach((o, oi) =>
    newLeft.forEach((n, ni) => {
      if (isFrameworkId(o.section_id) && isFrameworkId(n.section_id)) return
      const score = titleSimilarity(titleOf(o.heading_text), titleOf(n.heading_text))
      if (score >= threshold) scored.push({ o, n, score, oi, ni })
    })
  )
  scored.sort((a, b) => b.score - a.score || a.oi - b.oi || a.ni - b.ni)
  for (const { o, n, score } of scored) {
    if (pairOf.has(o.key) || claimed.has(n.key)) continue
    claimed.add(n.key)
    pairOf.set(o.key, { old_key: o.key, new_key: n.key, by: "title", score: Math.round(score * 100) / 100, needs_review: score < TITLE_REVIEW_BELOW || !!n.auto_confirmed })
  }

  return {
    pairs: main.map((o) => pairOf.get(o.key) ?? { old_key: o.key, new_key: null, by: null, score: 0, needs_review: false }),
    followers,
    ignored_new,
    split
  }
}

export class PairEditError extends Error {}

export interface PairEdit {
  old_key: string
  new_key: string | null
}

/**
 * BA sửa cặp. Mọi `old_key` phải có trong `pairs` đã lưu, mọi `new_key` phải là heading không phải phần tử của mẫu đích và không
 * dùng cho hai mục cũ. Ném `PairEditError` khi sai (service trả 400).
 */
export const applyPairEdits = (result: PairingResult, neu: readonly NewHeading[], edits: readonly PairEdit[]): PairingResult => {
  const known = new Set(result.pairs.map((p) => p.old_key))
  const eligible = new Set(neu.filter((n) => !result.ignored_new.includes(n.key)).map((n) => n.key))
  const edited = new Map<string, string | null>()
  for (const e of edits) {
    if (!known.has(e.old_key)) throw new PairEditError(`Mục "${e.old_key}" không có trong danh sách ghép của lần đổi mẫu này.`)
    if (e.new_key !== null && !eligible.has(e.new_key)) throw new PairEditError(`Mục "${e.new_key}" không phải mục của mẫu đích.`)
    if (edited.has(e.old_key)) throw new PairEditError(`Mục "${e.old_key}" được sửa hai lần trong cùng một lượt.`)
    edited.set(e.old_key, e.new_key)
  }
  const pairs = result.pairs.map((p): SectionPair => (edited.has(p.old_key) ? { old_key: p.old_key, new_key: edited.get(p.old_key)!, by: edited.get(p.old_key) === null ? null : "manual", score: edited.get(p.old_key) === null ? 0 : 1, needs_review: false } : p))
  const used = new Set<string>()
  for (const p of pairs) {
    if (!p.new_key) continue
    if (used.has(p.new_key)) throw new PairEditError(`Mục "${p.new_key}" của mẫu đích đang được ghép với hai mục cũ.`)
    used.add(p.new_key)
  }
  // Heading mới BA vừa ghép tay cho mục khác không còn là lựa chọn của mục bị tách nào; entry chỉ còn ≤ 1 heading không còn là "tách"
  const taken = new Set([...edited.values()].filter((k): k is string => k !== null))
  const split = result.split
    .filter((sp) => !edited.has(sp.old_key))
    .map((sp) => ({ ...sp, new_keys: sp.new_keys.filter((k) => !taken.has(k)) }))
    .filter((sp) => sp.new_keys.length > 1)
  return { ...result, pairs, split }
}
