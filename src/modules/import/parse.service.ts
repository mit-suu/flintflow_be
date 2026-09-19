/**
 * Tách + neo block (I-2, nút 1.5). FLF-171, plan §6 2B; G3.
 * Hàm thuần theo nội dung file: parse lại cùng một file ra cùng `block_id` (gán tuần tự theo thứ tự tài liệu),
 * nên preflight/parse/finalize có thể đọc lại file gốc mà không cần lưu bản trung gian.
 * File đã mang bookmark `_ff_Bxxxx` (bản FlintFlow từng lưu) ⇒ giữ id đó, block mới nhận id tiếp theo.
 */

import {
  DocxPackage,
  blockIdOfBookmark,
  ensureBlockBookmarks,
  isAnchorable,
  readBlocks,
  type OoxmlBlock
} from "../docx-ooxml/index.js"
import { BLOCK_ID_PATTERN } from "./import.constants.js"
import { scanCodeMentions, type Mention } from "./mentions.js"

export interface ParsedBlock extends OoxmlBlock {
  block_id: string
  mentions: Mention[]
}

export interface ParsedDocument {
  pkg: DocxPackage
  blocks: ParsedBlock[]
}

export const formatBlockId = (n: number): string => `B${String(n).padStart(4, "0")}`

const blockNumber = (id: string): number => Number(id.slice(1))

/**
 * Gán `block_id` cho mọi block và ghi bookmark neo vào đoạn chưa có. Block có bookmark hợp lệ giữ id cũ;
 * bảng/ảnh ngoài đoạn không có bookmark nhận id theo thứ tự như block khác.
 */
export const assignBlockIds = (blocks: OoxmlBlock[]): ParsedBlock[] => {
  const existing = new Map<OoxmlBlock, string>()
  let max = 0
  for (const b of blocks) {
    const id = blockIdOfBookmark(b.bookmark)
    if (id && BLOCK_ID_PATTERN.test(id)) {
      existing.set(b, id)
      max = Math.max(max, blockNumber(id))
    }
  }
  const ids = new Map<OoxmlBlock, string>(existing)
  for (const b of blocks) if (!ids.has(b)) ids.set(b, formatBlockId(++max))
  ensureBlockBookmarks(
    blocks.filter((b) => isAnchorable(b) && !existing.has(b)),
    (b) => ids.get(b) ?? null
  )
  return blocks.map((b) => Object.assign(b, { block_id: ids.get(b)!, mentions: scanCodeMentions(b.text) }))
}

export const parseDocument = async (data: Buffer): Promise<ParsedDocument> => {
  const pkg = await DocxPackage.load(data)
  return { pkg, blocks: assignBlockIds(await readBlocks(pkg)) }
}
