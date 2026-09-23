/** Loại version tài liệu mode 1 — tách khỏi model để DTO/FE không kéo mongoose. FLF-171. */
export const DOC_VERSION_KINDS = ["imported", "cr_revision", "release"] as const
export type DocVersionKind = (typeof DOC_VERSION_KINDS)[number]
