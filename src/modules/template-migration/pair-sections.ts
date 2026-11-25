/**
 * Ghép mục của tài liệu hiện tại (heading cũ) với mục của mẫu đích (heading mới) — hàm thuần, không AI, không DB.
 *
 * - Heading cũ và heading mới trùng y hệt tên (đã bỏ số mục) ghép trước mọi luật khác: file mẫu có thể gán cùng `section_id` cho
 *   hai heading anh em ("Quy tắc nghiệp vụ tổng quát" và "Hệ thống bên ngoài" cùng `fixed:1`), heading trùng tên không để mục
 *   khung khác giành. Hai mục khung khác id vẫn không ghép theo chữ.
 * - Heading mới cùng `section_id` với heading cha của nó (vd "Trong phạm vi" dưới "Phạm vi" cùng `slot:scope`) là heading con
 *   của mục đó: không là lựa chọn của mục bị tách, không là mục thiếu (`children`).
 * - Mục khung (`fixed:*`, `group:*`, `slot:*`) ghép theo `section_id`. Mẫu đích có nhiều heading cùng `section_id` (IEEE tách
 *   Reliability / Availability cùng về 4.2.2) ⇒ ghép heading đầu, ghi vào `split` để BA chọn nơi đặt.
 *   Mục FPT và phần nhỏ `slot:*` chồng lấn (`overlapsOf`: 5.1 ↔ slot:business_rules) ghép với nhau như cùng một mục; một mục cũ
 *   chồng lấn với nhiều phần nhỏ ⇒ ghép phần đầu, phần còn lại vào `split`.
 * - Mục riêng (`custom:*` / `unmapped`) ghép theo `titleSimilarity` trên chữ heading đã bỏ số mục; dưới ngưỡng ⇒ chưa ghép.
 *   Một mục khung chưa ghép được còn thử ghép theo chữ với mục riêng của phía kia (mẫu mới đặt tên khác mapping), nhưng hai mục
 *   khung khác id không bao giờ ghép với nhau theo chữ.
 * - FLF-491: heading riêng (`custom:*` / `unmapped`) có tên đúng tên trong danh mục mục khung ("1 Tổng quan sản phẩm" ⇒ `fixed:1`), hoặc
 *   chỉ có số mục + chỗ điền ("4.2.4 …" ⇒ `fixed:4.2.4`), ghép theo id đó (`by: "title"`, "Cần xem"). Heading con cũ không có chỗ ở mẫu
 *   đích (mục cha đã ghép, mẫu đích không còn heading con chưa có chủ trong cây con của nó) đi theo mục cha (`Follower.kind: "child"`).
 * - Heading phần tử (`feature:*`, `function:*`, UC / màn / chức năng nhận ra qua tên hoặc mã trong Spine, mục riêng lồng dưới
 *   mục chứa phần tử) và phần nối (heading rỗng) **đi theo mục khung cha** — không bao giờ vào 4 nhóm. Heading phần tử của
 *   mẫu đích chỉ là ví dụ của mẫu ⇒ bỏ qua.
 */
import { foldText, splitHeadingNumber, titleSimilarity } from "../import/text-similarity.js"
import { overlapsOf } from "../import/content-slots.js"
import { classifySection } from "../import/template-skeleton.js"
import { catalogSectionOf } from "../import/section-catalog.js"

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
  kind: "element" | "continuation" | "child"
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
  /** Heading con của mẫu đích nằm cùng mục với heading cha — thuộc mục cha, không là mục thiếu. Bản ghi cũ không có field này. */
  children?: string[]
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

/** Heading mới mà heading cha gần nhất (theo cấp) mang cùng `section_id` khung — chỉ suy được khi biết cấp. */
const childKeys = (neu: readonly NewHeading[]): Set<string> => {
  const out = new Set<string>()
  const stack: { level: number; sectionId: string }[] = []
  for (const n of neu) {
    if (n.level === undefined) continue
    while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent && isFrameworkId(n.section_id) && parent.sectionId === n.section_id) out.add(n.key)
    stack.push({ level: n.level, sectionId: n.section_id })
  }
  return out
}

/** Id dùng để ghép theo id: id khung của heading, hoặc id mục khung suy từ danh mục khi heading đứng ngoài khung (FLF-491). */
const effectiveId = (h: { heading_text: string; section_id: string }): string => (isFrameworkId(h.section_id) ? h.section_id : (catalogSectionOf(h.heading_text) ?? h.section_id))

/** Tên heading để so trùng y hệt: bỏ số mục, gập dấu / hoa thường. */
const exactTitle = (text: string): string => foldText(titleOf(text))

/** Ghép tự động. Cùng đầu vào ⇒ cùng kết quả. */
export const pairSections = (old: readonly OldHeading[], neu: readonly NewHeading[], options: PairOptions = {}): PairingResult => {
  const threshold = options.threshold ?? CUSTOM_PAIR_THRESHOLD
  const { main, followers } = splitOld(old, options)
  const ignored = newElementKeys(neu)
  const ignored_new = neu.filter((n) => ignored.has(n.key)).map((n) => n.key)
  const candidates = neu.filter((n) => !ignored.has(n.key))
  const children = childKeys(candidates)

  const byId = new Map<string, NewHeading[]>()
  for (const n of candidates) {
    const id = effectiveId(n)
    if (isFrameworkId(id) && !children.has(n.key)) byId.set(id, [...(byId.get(id) ?? []), n])
  }

  const claimed = new Set<string>()
  const pairOf = new Map<string, SectionPair>()
  const split: PairingResult["split"] = []

  // Trùng y hệt tên ghép trước (không cho mục khung cùng id giành heading của mục khác)
  for (const o of main) {
    const title = exactTitle(o.heading_text)
    if (!title) continue
    const n = candidates.find((c) => !claimed.has(c.key) && !children.has(c.key) && exactTitle(c.heading_text) === title && !(isFrameworkId(o.section_id) && isFrameworkId(c.section_id) && o.section_id !== c.section_id))
    if (!n) continue
    claimed.add(n.key)
    pairOf.set(o.key, { old_key: o.key, new_key: n.key, by: o.section_id === n.section_id ? "section_id" : "title", score: 1, needs_review: !!n.auto_confirmed })
  }

  for (const o of main) {
    const exact = pairOf.get(o.key)
    if (exact) {
      // Ghép theo tên trùng mà cùng id: heading cùng id còn lại của mẫu đích vẫn là phần tách của mục này
      const rest = exact.by === "section_id" ? (byId.get(effectiveId(o)) ?? []).filter((n) => !claimed.has(n.key)) : []
      for (const n of rest) claimed.add(n.key)
      if (rest.length) split.push({ old_key: o.key, new_keys: [exact.new_key!, ...rest.map((n) => n.key)] })
      continue
    }
    // Heading mới đã có chủ (hai heading cũ cùng section_id) không ghép lần nữa: heading cũ thứ hai để chưa ghép cho BA quyết
    const oid = effectiveId(o)
    const found = isFrameworkId(oid) ? byId.get(oid)?.filter((n) => !claimed.has(n.key)) : undefined
    if (!found?.length) continue
    // Ghép nhờ danh mục (id thật của một phía không là id khung đó) ⇒ "Cần xem"
    const viaCatalog = o.section_id !== oid || found[0].section_id !== oid
    pairOf.set(o.key, viaCatalog ? { old_key: o.key, new_key: found[0].key, by: "title", score: 0.9, needs_review: true } : { old_key: o.key, new_key: found[0].key, by: "section_id", score: 1, needs_review: !!found[0].auto_confirmed })
    for (const n of found) claimed.add(n.key)
    if (found.length > 1) split.push({ old_key: o.key, new_keys: found.map((n) => n.key) })
  }

  // Mục FPT ↔ phần nhỏ chồng lấn (mẫu bắt buộc map heading vào slot thay vì mục FPT cha)
  for (const o of main) {
    if (pairOf.has(o.key) || !isFrameworkId(o.section_id)) continue
    const overlap = new Set(overlapsOf(o.section_id))
    const found = candidates.filter((n) => !claimed.has(n.key) && !children.has(n.key) && overlap.has(n.section_id))
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

  // FLF-491: heading con cũ không có chỗ ở mẫu đích đi theo mục cha đã ghép
  const childOf = new Map<string, string>()
  const parentStack: OldHeading[] = []
  const levelOfNew = (i: number): number | undefined => neu[i].level
  for (const o of main) {
    while (parentStack.length && parentStack[parentStack.length - 1].level >= o.level) parentStack.pop()
    const nearest = parentStack[parentStack.length - 1]
    parentStack.push(o)
    if (!nearest || pairOf.get(o.key)?.new_key || o.section_id === "fixed:I") continue
    const a = childOf.has(nearest.key) ? main.find((m) => m.key === childOf.get(nearest.key)) : nearest
    const target = a ? pairOf.get(a.key)?.new_key : null
    if (!a || !target) continue
    const at = neu.findIndex((n) => n.key === target)
    const base = levelOfNew(at)
    if (at < 0 || base === undefined) continue
    let free = false
    for (let j = at + 1; j < neu.length; j++) {
      const lv = levelOfNew(j)
      if (lv === undefined || lv <= base) break
      if (!ignored.has(neu[j].key) && !children.has(neu[j].key) && !claimed.has(neu[j].key)) free = true
    }
    if (free) continue
    const eo = effectiveId(o)
    const ea = effectiveId(a)
    const en = effectiveId(neu[at])
    const related = (x: string, y: string): boolean => x === y || overlapsOf(x).includes(y) || overlapsOf(y).includes(x)
    if (isFrameworkId(eo) && !related(eo, ea) && !related(eo, en)) continue
    childOf.set(o.key, a.key)
  }
  for (const [childKey, parentKey] of childOf) {
    followers.push({ old_key: childKey, kind: "child", parent_old_key: parentKey })
  }
  for (const f of followers) if (f.parent_old_key && childOf.has(f.parent_old_key) && f.kind !== "child") f.parent_old_key = childOf.get(f.parent_old_key)!
  const mainPaired = main.filter((o) => !childOf.has(o.key))

  return {
    pairs: mainPaired.map((o) => pairOf.get(o.key) ?? { old_key: o.key, new_key: null, by: null, score: 0, needs_review: false }),
    followers,
    ignored_new,
    split,
    children: [...children].filter((k) => !claimed.has(k))
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
