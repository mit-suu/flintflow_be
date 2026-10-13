/**
 * Khối `known_keys` của prompt I-4 theo phạm vi từng lượt gọi. Trước đây mỗi lượt nhận MỌI phần tử đã trích (bảng của
 * cả tài liệu, section trước…) — tài liệu càng dài prompt càng phình, 200 trang thì khối này ngang một lô chữ 24k.
 *
 * Model dùng known_keys để chép lại đúng mã của phần tử mà chữ đang nói tới (tham chiếu `actor_ids: ["A01"]`, use case
 * đã có mã ở bảng…). Chỉ cần phần tử lượt đó có thể nhắc tới:
 *   1. feature/function tạm của section (function nhận id theo heading, feature cha);
 *   2. phần tử của chính section (bảng tất định, ảnh, lô trước);
 *   3. phần tử có mã xuất hiện trong chữ gửi đi (`DocBlock.mentions` + mã dạng `UC-01` trong chữ, so bằng `idKey`);
 *   4. phần tử có tên xuất hiện trong chữ — so theo dãy từ liền nhau, mỗi từ về dạng `compactKey` (bỏ dấu, hoa thường,
 *      số ít, tách camelCase) ⇒ "SubscriptionPlan" khớp "subscription_plans", "Log in" không khớp "catalog index";
 *   5. loại luôn gửi (`always`): danh sách nhỏ mà chữ hay nhắc bằng tên trôi (tác nhân, vai trò; ảnh: loại diagram vẽ).
 * Cắt cứng theo `KNOWN_KEYS_CHARS`, theo đúng thứ tự trên ⇒ tất định.
 *
 * Chỉ CHỮ của prompt bị thu hẹp. Ghép phần tử ở code (`itemsFromAi` → `aiItemId`, `findKnownId`, `onlyNewFromVision`…)
 * vẫn dùng toàn bộ phần tử đã biết: model không thấy mã thì ghi tên, code vẫn phân giải về đúng phần tử ⇒ không nhân đôi.
 */

import { compactKey, idKey, type EntityItem } from "./extracted-entities.js"
import { foldText, splitHeadingNumber } from "./text-similarity.js"

/** Trần ký tự của khối known_keys (~1k token) — nhỏ so với lô chữ 24k ký tự. */
export const KNOWN_KEYS_CHARS = 4_000

export interface KnownKeysScope {
  /** Feature/function tạm của section. */
  provisional: readonly EntityItem[]
  /** Phần tử đã có của section đang trích. */
  section: readonly EntityItem[]
  /** Chữ gửi kèm lượt gọi (lô block; ảnh: tiêu đề + caption + chữ của section). */
  text: string
  /** Mã nhận được trong chữ (`DocBlock.mentions`). */
  mentions?: readonly { id: string }[]
  /** Loại phần tử luôn gửi (sau phần nhắc tới). */
  always?: readonly string[]
}

const nameOf = (it: EntityItem): string | null =>
  typeof it.value.name === "string" ? it.value.name : typeof it.value.term === "string" ? it.value.term : null

/** Mã dạng tài liệu trong chữ: `UC-01`, `BR12`, `NFR_03`, `FR-3.2.1`. */
const CODE_RE = /\b[A-Za-z]{1,5}[-_ ]?\d+(?:\.\d+)*\b/g

/** Dãy từ để so tên: tách camelCase, gập dấu / hoa thường, mỗi từ về số ít — bọc khoảng trắng hai đầu để so cả từ. */
const wordsOf = (s: string): string => {
  const words = foldText(splitHeadingNumber(s).title.replace(/([a-z0-9])([A-Z])/g, "$1 $2"))
    .split(" ")
    .filter(Boolean)
    .map(compactKey)
  return ` ${words.join(" ")} `
}

const entry = (it: EntityItem): string => {
  const name = typeof it.value.name === "string" ? ` (${it.value.name})` : ""
  return `${it.id}${name}`
}

/**
 * Phần tử đưa vào known_keys của một lượt gọi, theo thứ tự ưu tiên, đã bỏ trùng (`entity|id`) và cắt theo `cap` ký tự.
 * `known` = mọi phần tử đã biết (section trước, bảng tất định của cả tài liệu, feature/function tạm).
 */
export const scopeKnownKeys = (known: readonly EntityItem[], scope: KnownKeysScope, cap = KNOWN_KEYS_CHARS): EntityItem[] => {
  const codes = new Set<string>([...(scope.mentions ?? []).map((m) => idKey(m.id)), ...[...scope.text.matchAll(CODE_RE)].map((m) => idKey(m[0]))])
  const words = wordsOf(scope.text)
  const named = (it: EntityItem): boolean => {
    const name = nameOf(it)
    const key = name ? wordsOf(name) : " "
    return key.trim() !== "" && words.includes(key)
  }
  const always = new Set(scope.always ?? [])
  const all = known.filter((it) => it.id)
  const ranked = [
    ...scope.provisional,
    ...scope.section,
    ...all.filter((it) => codes.has(idKey(it.id!))),
    ...all.filter(named),
    ...all.filter((it) => always.has(it.entity))
  ]
  // Phần tử ảnh chỉ giữ phần mới (`onlyNewFromVision`: A01 chỉ còn `kind`) ⇒ in tên theo phần tử cùng khoá khác: model
  // phải thấy "A01 (Learner)" mới chép lại được khoá
  const names = new Map<string, string>()
  for (const it of [...scope.provisional, ...scope.section, ...known]) {
    const key = `${it.entity}|${it.id}`
    if (it.id && typeof it.value.name === "string" && !names.has(key)) names.set(key, it.value.name)
  }
  const out: EntityItem[] = []
  const seen = new Set<string>()
  let size = 0
  for (let it of ranked) {
    if (!it.id) continue
    const key = `${it.entity}|${it.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const name = names.get(key)
    if (typeof it.value.name !== "string" && name !== undefined) it = { ...it, value: { ...it.value, name } }
    // mỗi phần tử tốn chữ của nó + ", " (dòng mới của loại tính gộp vào đây — trần là xấp xỉ trên)
    const cost = entry(it).length + it.entity.length + 4
    if (size + cost > cap) break
    size += cost
    out.push(it)
  }
  return out
}

/** `actors: A01 (Learner), A02 (Admin)` — mỗi loại một dòng, theo thứ tự xuất hiện; rỗng ⇒ `(none yet)`. */
export const knownKeysText = (items: readonly EntityItem[]): string => {
  const byEntity = new Map<string, string[]>()
  for (const it of items) {
    if (!it.id) continue
    byEntity.set(it.entity, [...(byEntity.get(it.entity) ?? []), entry(it)])
  }
  return [...byEntity].map(([e, ids]) => `${e}: ${[...new Set(ids)].join(", ")}`).join("\n") || "(none yet)"
}
