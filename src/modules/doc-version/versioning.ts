/**
 * Đánh số version tài liệu mode 1 (G4) — hàm thuần. FLF-171, plan §5.3.
 * Import = `0.1`; mỗi CR ghi xong = minor tiếp theo (`0.2`, `0.3`…); release = major tiếp theo (`1.0`, `2.0`…).
 * Khác quy ước `v1.N[-conditional]` của mode 2 (`pipeline/s9/baseline.service.ts`), không dùng chung.
 */

export const DOC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Bản gốc khi import SRS mới. Project cũ có thể còn bản `0.0` — vẫn hợp lệ theo `DOC_VERSION_PATTERN`. */
export const IMPORTED_DOC_VERSION = "0.1"

/** Bản gốc cũ `0.0` (trước FLF-284): import đang dở / project cũ vẫn phải tìm thấy block + version import. */
export const LEGACY_IMPORTED_DOC_VERSION = "0.0"

/** Dùng cho truy vấn ĐỌC / XOÁ bản gốc; ghi mới luôn dùng `IMPORTED_DOC_VERSION`. */
export const IMPORTED_DOC_VERSIONS = [IMPORTED_DOC_VERSION, LEGACY_IMPORTED_DOC_VERSION]

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

/** Bỏ ký tự Windows cấm trong tên file; rỗng ⇒ `SRS`. */
export const sanitizeFileBase = (value: string): string => value.replace(/[\\/:*?"<>|]+/g, "_").trim() || "SRS"

export interface VersionFileNameParts {
  /** Tên dự án (chưa làm sạch). */
  name: string
  /** Bản phát hành (`x.0` của mode 1, baseline của mode 2) ⇒ không `_DRAFT`, không mã CR. */
  release: boolean
  /** Release: số của chính nó (`2.0`). Bản nháp: release gốc (`1.0`; `0`/`v0` = chỉ có bản import); `null` = chưa có gốc. */
  base: string | null
  /** Bản nháp: CR mới nhất đã ghi vào nó (`CR-014`); bỏ qua với release. */
  latestCr?: string | null
  tracked?: boolean
  /** File gốc người dùng upload: `_original` thay cho `_DRAFT`. */
  original?: boolean
  ext?: "docx" | "pdf"
}

/**
 * Quy tắc tên file chung cho tải version mode 1 và xuất mode 2, Word lẫn PDF (FLF-334). Không mang mã dự án — máy nhận
 * dự án qua stamp trong file. `Lumen_v2.0.docx` · `Lumen_v1.0+CR-014_DRAFT.docx` · `Lumen_v0_DRAFT.docx` ·
 * `Lumen_DRAFT.docx` (mode 2 chưa baseline) · `…_tracked_DRAFT.docx` · `…_original.docx`.
 */
export const versionFileName = (parts: VersionFileNameParts): string => {
  const base = parts.base ? sanitizeFileBase(parts.base.trim().replace(/^v/i, "")) : null
  const cr = !parts.release && base && parts.latestCr ? `+${sanitizeFileBase(parts.latestCr)}` : ""
  const label = base ? `_v${base}${cr}` : ""
  const tail = parts.original ? "_original" : parts.release ? "" : "_DRAFT"
  return `${sanitizeFileBase(parts.name)}${label}${parts.tracked ? "_tracked" : ""}${tail}.${parts.ext ?? "docx"}`
}

/** Tối thiểu của một version để suy release gốc / CR mới nhất (khớp `IDocVersion`). */
export interface LineageVersion {
  version: string
  kind: string
  cr_ids: readonly string[]
}

export interface VersionLineage {
  release: boolean
  /** Release: chính nó. Bản nháp: version release (`x.0`) gần nhất trước nó, `0` khi chưa có (chỉ có bản import). */
  base: string
  /** Bản nháp: mã CR cuối của version gần nhất (tính cả chính nó, sau release gốc) có CR; release ⇒ `null`. */
  latestCr: string | null
}

/**
 * Release gốc + CR mới nhất của `target` trong lịch sử version (thứ tự bất kỳ). Cùng ý "kể từ lần phát hành trước" với
 * `review-package.service.pendingCrIds`, nhưng tính tại một version bất kỳ (bản nháp cũ trong lịch sử) và theo số version.
 */
export const versionLineage = (versions: readonly LineageVersion[], target: string): VersionLineage => {
  if (isReleaseVersion(target)) return { release: true, base: target, latestCr: null }
  const history = versions.filter((v) => compareDocVersions(v.version, target) <= 0).sort((a, b) => compareDocVersions(b.version, a.version))
  // Theo số (`x.0`), không theo `kind`: bản chuyển đổi từ mode 2 (FLF-318) là `1.0` mang kind `imported`
  const lastRelease = history.find((v) => isReleaseVersion(v.version)) ?? null
  const since = lastRelease ? history.slice(0, history.indexOf(lastRelease)) : history
  const withCr = since.find((v) => v.cr_ids.length > 0)
  const latestCr = withCr ? withCr.cr_ids[withCr.cr_ids.length - 1] : null
  return { release: false, base: lastRelease?.version ?? "0", latestCr }
}
