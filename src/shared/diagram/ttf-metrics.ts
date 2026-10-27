/**
 * ttf-metrics.ts
 * ─────────────────────────────────────────────────────────────────
 * Đọc advance width + ascent/descent từ file `.ttf` (bảng `head`, `hhea`, `hmtx`, `cmap` format 4).
 * Chỉ dùng để SINH bảng `svg-kit-metrics.ts` (script `generate-svg-metrics.ts`) và để test bảng đó
 * còn khớp font đóng gói — runtime không đọc font để đo chữ.
 */

export interface FontMetrics {
  unitsPerEm: number
  ascent: number
  descent: number
  /** Advance width theo đơn vị font, khoá là code point. */
  advance: Map<number, number>
}

const tableOffsets = (buf: Buffer): Map<string, number> => {
  const count = buf.readUInt16BE(4)
  const tables = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16
    tables.set(buf.toString("latin1", rec, rec + 4), buf.readUInt32BE(rec + 8))
  }
  return tables
}

const need = (tables: Map<string, number>, tag: string): number => {
  const offset = tables.get(tag)
  if (offset === undefined) throw new Error(`font thiếu bảng ${tag}`)
  return offset
}

/** cmap format 4 (Unicode BMP): code point → glyph id. */
const glyphIndex = (buf: Buffer, cmap: number): ((code: number) => number) => {
  const count = buf.readUInt16BE(cmap + 2)
  let sub = -1
  for (let i = 0; i < count; i++) {
    const rec = cmap + 4 + i * 8
    const platform = buf.readUInt16BE(rec)
    const encoding = buf.readUInt16BE(rec + 2)
    const offset = cmap + buf.readUInt32BE(rec + 4)
    if (((platform === 3 && encoding === 1) || platform === 0) && buf.readUInt16BE(offset) === 4) sub = offset
  }
  if (sub < 0) throw new Error("font không có cmap format 4")
  const segX2 = buf.readUInt16BE(sub + 6)
  const ends = sub + 14
  const starts = ends + segX2 + 2
  const deltas = starts + segX2
  const ranges = deltas + segX2
  return (code) => {
    for (let s = 0; s < segX2; s += 2) {
      if (code > buf.readUInt16BE(ends + s)) continue
      const start = buf.readUInt16BE(starts + s)
      if (code < start) return 0
      const delta = buf.readInt16BE(deltas + s)
      const rangeOffset = buf.readUInt16BE(ranges + s)
      if (rangeOffset === 0) return (code + delta) & 0xffff
      const glyph = buf.readUInt16BE(ranges + s + rangeOffset + (code - start) * 2)
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff
    }
    return 0
  }
}

/** Width của các code point trong `codes` có glyph trong font (glyph 0 = không có ⇒ bỏ). */
export const readFontMetrics = (buf: Buffer, codes: Iterable<number>): FontMetrics => {
  const tables = tableOffsets(buf)
  const head = need(tables, "head")
  const hhea = need(tables, "hhea")
  const hmtx = need(tables, "hmtx")
  const numberOfHMetrics = buf.readUInt16BE(hhea + 34)
  const glyphOf = glyphIndex(buf, need(tables, "cmap"))
  const advance = new Map<number, number>()
  for (const code of codes) {
    const glyph = glyphOf(code)
    if (glyph === 0) continue
    const metric = Math.min(glyph, numberOfHMetrics - 1)
    advance.set(code, buf.readUInt16BE(hmtx + metric * 4))
  }
  return {
    unitsPerEm: buf.readUInt16BE(head + 18),
    ascent: buf.readInt16BE(hhea + 4),
    descent: -buf.readInt16BE(hhea + 6),
    advance
  }
}

/** Ký tự cần đo: ASCII in được, Latin-1, Latin Extended-A, chữ Việt có dấu, vài dấu câu hay gặp. */
export const MEASURED_CODES: readonly number[] = Object.freeze([
  ...range(0x20, 0x7e),
  ...range(0xa0, 0x17f),
  0x1a0, 0x1a1, 0x1af, 0x1b0,
  ...range(0x300, 0x303), 0x309, 0x323,
  ...range(0x1ea0, 0x1ef9),
  0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x2190, 0x2192, 0x2194, 0x2212
])

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}
