/**
 * Đánh số version tài liệu mode 1 (G4) — hàm thuần. FLF-171, plan §5.3.
 * Import = `0.0`; mỗi CR ghi xong = minor tiếp theo (`0.1`, `0.2`…); release = major tiếp theo (`1.0`, `2.0`…).
 * Khác quy ước `v1.N[-conditional]` của mode 2 (`pipeline/s9/baseline.service.ts`), không dùng chung.
 */

export const DOC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const IMPORTED_DOC_VERSION = "0.0"

export interface ParsedDocVersion {
  major: number
  minor: number
}

export const isDocVersion = (value: string): boolean => DOC_VERSION_PATTERN.test(value)

export const parseDocVersion = (value: string): ParsedDocVersion => {
  const match = DOC_VERSION_PATTERN.exec(value)
  if (!match) throw new Error(`Version tài liệu không hợp lệ: "${value}" (cần dạng major.minor, vd 0.1)`)
  return { major: Number(match[1]), minor: Number(match[2]) }
}

/** Bản draft kế tiếp sau khi một CR ghi xong: `0.2` ⇒ `0.3`, `1.0` ⇒ `1.1`. */
export const nextMinor = (current: string): string => {
  const { major, minor } = parseDocVersion(current)
  return `${major}.${minor + 1}`
}

/** Bản release kế tiếp: `0.3` ⇒ `1.0`, `1.4` ⇒ `2.0`, `1.0` ⇒ `2.0`. */
export const nextMajor = (current: string): string => `${parseDocVersion(current).major + 1}.0`

/** So sánh để sắp xếp: âm nếu `a` cũ hơn `b`. */
export const compareDocVersions = (a: string, b: string): number => {
  const pa = parseDocVersion(a)
  const pb = parseDocVersion(b)
  return pa.major - pb.major || pa.minor - pb.minor
}

/** `x.0` với x ≥ 1 là bản release (tải về bản sạch); còn lại là draft (có Track Changes + DRAFT). */
export const isReleaseVersion = (value: string): boolean => {
  const { major, minor } = parseDocVersion(value)
  return major >= 1 && minor === 0
}

/**
 * Tên file tải về: bản draft thêm hậu tố `_DRAFT` (G8), vd `Lumen_SRS_v0.2_DRAFT.docx`. Mode 1 v3 (BPMN 6.3: project ID
 * và version "đóng trong file **và tên file**"): có `projectId` ⇒ `Lumen_SRS_<projectId>_v1.0.docx`; bản có đánh dấu
 * (3.14) thêm `_tracked`.
 */
export const downloadFileName = (baseName: string, version: string, opts: { projectId?: string; tracked?: boolean } = {}): string => {
  const safe = baseName.replace(/[\\/:*?"<>|]+/g, "_").trim() || "SRS"
  const id = opts.projectId ? `_${opts.projectId}` : ""
  return `${safe}${id}_v${version}${opts.tracked ? "_tracked" : ""}${isReleaseVersion(version) ? "" : "_DRAFT"}.docx`
}
