/** Loại version tài liệu mode 1 — tách khỏi model để DTO/FE không kéo mongoose. FLF-171, FLF-466 (`system_change`). */
export const DOC_VERSION_KINDS = ["imported", "cr_revision", "release", "system_change"] as const
export type DocVersionKind = (typeof DOC_VERSION_KINDS)[number]

/**
 * FLF-466 (BF §2 "Thay đổi hệ thống"): thay đổi sau baseline không đổi ý nghĩa nội dung nên không phải CR.
 * `template_migration` đổi mẫu · `template_revert` hoàn tác đổi mẫu · `screen_mockup` vẽ lại bằng mockup / dùng ảnh gốc.
 */
export const SYSTEM_CHANGE_TYPES = ["template_migration", "template_revert", "screen_mockup"] as const
export type SystemChangeType = (typeof SYSTEM_CHANGE_TYPES)[number]

export interface SystemChangeInfo {
  type: SystemChangeType
  /** Khoá idempotent: id lần đổi mẫu (`<id>` hoặc `<id>:revert`), hoặc id lượt vẽ lại màn. */
  ref: string
  /** Một câu cho dòng riêng trong Gói duyệt ("Đổi mẫu sang Sở XD v3"). */
  summary: string
}

/** Người ghi (`changes[].by`) của Change do một thay đổi hệ thống sinh ra; không phải CR, không vào Record of Changes. */
export const SYSTEM_CHANGE_ACTOR_PREFIX = "system_change:"
export const systemChangeActor = (ref: string): string => `${SYSTEM_CHANGE_ACTOR_PREFIX}${ref}`
export const isSystemChangeActor = (by: string | null | undefined): boolean => !!by?.startsWith(SYSTEM_CHANGE_ACTOR_PREFIX)
