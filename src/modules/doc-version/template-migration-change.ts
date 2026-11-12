/**
 * Change do một lần đổi mẫu ghi vào Spine có `txn` bắt đầu bằng `TEMPLATE_MIGRATION_TXN_PREFIX` (schema Change không có field
 * `source`). Đổi mẫu không phải thay đổi nội dung của khách ⇒ không vào Record of Changes, không tính là thay đổi thường.
 */

import { TEMPLATE_MIGRATION_TXN_PREFIX } from "../template-migration/edited-since.js"

export { TEMPLATE_MIGRATION_TXN_PREFIX }

export const isTemplateMigrationChange = (change: { txn?: string | null }): boolean => !!change.txn?.startsWith(TEMPLATE_MIGRATION_TXN_PREFIX)

export const withoutTemplateMigration = <T extends { txn?: string | null }>(rows: readonly T[]): T[] =>
  rows.filter((row) => !isTemplateMigrationChange(row))
