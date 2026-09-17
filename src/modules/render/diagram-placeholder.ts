/**
 * diagram-placeholder.ts
 * ─────────────────────────────────────────────────────────────────
 * Ảnh thay thế cho sơ đồ `render_status = "ok"` nhưng PNG chưa tải được lúc assemble/đọc tài liệu.
 * PNG xám nhạt sinh bằng `node:zlib` (không thêm dependency), tính một lần lúc import; caption nêu rõ
 * sơ đồ nào chưa render để người đọc thấy lý do thay vì thiếu hình lặng lẽ. Writer `.docx` đo kích
 * thước bằng `image-size` nên đây phải là PNG hợp lệ thật (IHDR/IDAT/IEND + CRC32).
 */

import { deflateSync } from "node:zlib"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

const crc32 = (data: Buffer): number => {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const chunk = (type: string, data: Buffer): Buffer => {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/** PNG grayscale 8-bit một màu (color type 0, filter 0 mỗi dòng). */
export const buildPlaceholderPng = (width: number, height: number, gray = 0xe6): Buffer => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, gray)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

export const DIAGRAM_PLACEHOLDER_WIDTH = 800
export const DIAGRAM_PLACEHOLDER_HEIGHT = 240

/** Base64 của ảnh placeholder — dạng `ImageBlock.png` khi qua HTTP. */
export const DIAGRAM_PLACEHOLDER_PNG = buildPlaceholderPng(DIAGRAM_PLACEHOLDER_WIDTH, DIAGRAM_PLACEHOLDER_HEIGHT).toString("base64")

/** Caption cho ảnh placeholder (nội dung SRS là tiếng Anh). */
export const pendingImageCaption = (caption: string | undefined, diagramId: string): string =>
  `${caption ? `${caption} — ` : ""}image pending: diagram ${diagramId} has not been rendered yet`
