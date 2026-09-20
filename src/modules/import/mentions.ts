/**
 * Quét mention trong text block (I-2 nút 1.5; chạy lại theo tên sau I-4). FLF-171, plan §6 2B.
 * Mã yêu cầu (`UC-01`, `FR-3`, `NFR-02`, `BR-12`, `SCR-05`) nhận tất định; tên actor/entity quét sau khi đã
 * trích Spine. Kết quả dùng ở C-3 (nguồn `mention`).
 */

import type { MentionEntity } from "./import.constants.js"

export interface Mention {
  entity: MentionEntity
  id: string
}

const CODE_PREFIX: Record<string, MentionEntity> = {
  UC: "use_case",
  FR: "function",
  NFR: "nfr",
  BR: "business_rule",
  SCR: "screen",
  SC: "screen"
}

const CODE_PATTERN = /(?<![\p{L}\p{N}])(UC|FR|NFR|BR|SCR|SC)[-_ ]?(\d{1,4}(?:\.\d{1,3})?)(?![\p{L}\p{N}])/gu

/** Chuẩn hoá mã: `UC01`, `UC_01`, `UC 01` ⇒ `UC-01` (giữ số như trong tài liệu). Extract dùng cùng quy tắc làm id Spine. */
export const normalizeCode = (prefix: string, number: string): string => `${prefix.toUpperCase()}-${number}`

const dedupe = (mentions: Mention[]): Mention[] => {
  const seen = new Set<string>()
  return mentions.filter((m) => {
    const key = `${m.entity}:${m.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const scanCodeMentions = (text: string): Mention[] => {
  const out: Mention[] = []
  for (const m of text.matchAll(CODE_PATTERN)) out.push({ entity: CODE_PREFIX[m[1]], id: normalizeCode(m[1], m[2]) })
  return dedupe(out)
}

export interface NamedEntity {
  entity: MentionEntity
  id: string
  name: string
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Quét theo tên (không phân biệt hoa thường, theo ranh giới từ). Tên < 3 ký tự bị bỏ để tránh bắt nhầm. */
export const scanNameMentions = (text: string, names: NamedEntity[]): Mention[] => {
  const out: Mention[] = []
  for (const n of names) {
    const name = n.name.trim()
    if (name.length < 3) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(name)}(?![\\p{L}\\p{N}])`, "iu")
    if (re.test(text)) out.push({ entity: n.entity, id: n.id })
  }
  return dedupe(out)
}

export const scanMentions = (text: string, names: NamedEntity[] = []): Mention[] =>
  dedupe([...scanCodeMentions(text), ...scanNameMentions(text, names)])
