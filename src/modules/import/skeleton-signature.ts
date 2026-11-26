/**
 * FLF-466 phase 10 - chữ ký khung: so một khung với mẫu có sẵn của org / với lần lưu trước. Gồm heading cấp khung (cấp + chữ chuẩn
 * hoá), tiêu đề cột, chữ hướng dẫn (chuẩn hoá) và heading còn chờ duyệt - hai dự án khác mục riêng không trùng nhau. Tính trên chữ
 * gốc của file (trước khi AI đổi tên riêng) nên kết quả không phụ thuộc lượt AI.
 */
import { createHash } from "node:crypto"
import { normalizeTitle } from "./org-mapping.js"
import type { PlannedItem, ReviewHeading } from "./template-skeleton.js"

export const skeletonSignature = (items: readonly PlannedItem<unknown>[], waiting: readonly Pick<ReviewHeading, "level" | "heading_text">[]): string =>
  createHash("sha256")
    .update(
      [
        ...items.flatMap((i) =>
          i.kind === "heading" ? [`h|${i.level}|${normalizeTitle(i.text)}`] : i.kind === "table" ? [`t|${i.headers.map(normalizeTitle).join("|")}`] : [`g|${normalizeTitle(i.text)}`]
        ),
        ...waiting.map((w) => `p|${w.level}|${normalizeTitle(w.heading_text)}`)
      ].join("\n")
    )
    .digest("hex")
