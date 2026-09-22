/**
 * gate-table.ts
 * ─────────────────────────────────────────────────────────────────
 * Bảng thu gọn hiện ngay tại cổng chốt của những step mà kết quả LÀ một bảng (FLF-177 WP-5 · BUG-20,
 * `03-live-status-flow.md` Lớp 4).
 *
 * Lượt test: S-9.4 tự xếp "nhắc lịch SMS = COULD" mà gate không hiện bảng ưu tiên nào, nên user chỉ phát
 * hiện khi đọc tài liệu xuất ra. Ma trận quyền (S-4.3) cũng vậy. Một bảng ngay tại chỗ duyệt là cách rẻ
 * nhất để người thấy AI đã quyết gì.
 */

import type { Spine } from "../spine/spine.types.js"

export interface GateTable {
  title_vi: string
  columns: string[]
  rows: string[][]
  /** Số dòng bị cắt bớt (bảng thu gọn) — UI nói "và N dòng nữa". */
  truncated: number
}

/** Bảng ở gate là để LIẾC, không phải để đọc hết — tài liệu mới là nơi đọc đủ. */
export const MAX_TABLE_ROWS = 40

const PRIORITY_LABEL: Readonly<Record<string, string>> = { must: "Must", should: "Should", could: "Could", wont: "Won't" }

const priorityOf = (value: string | null): string => (value === null ? "— chưa xếp" : (PRIORITY_LABEL[value] ?? value))

const clip = <T>(rows: T[]): { rows: T[]; truncated: number } => ({
  rows: rows.slice(0, MAX_TABLE_ROWS),
  truncated: Math.max(0, rows.length - MAX_TABLE_ROWS)
})

/** MoSCoW của S-9.4: mọi function và NFR kèm mức ưu tiên vừa được xếp. */
const moscowTable = (spine: Spine): GateTable => {
  const order = ["must", "should", "could", "wont", null] as const
  const rank = (p: string | null): number => order.indexOf(p as (typeof order)[number])
  const all = [
    ...spine.functions.map((f) => ({ id: f.id, name: f.name, kind: "Chức năng", priority: f.priority })),
    ...spine.nfrs.map((n) => ({ id: n.id, name: n.statement, kind: "Yêu cầu phi chức năng", priority: n.priority }))
  ].sort((a, b) => rank(a.priority) - rank(b.priority) || (a.id < b.id ? -1 : 1))

  const { rows, truncated } = clip(all)
  return {
    title_vi: "Mức ưu tiên MoSCoW",
    columns: ["Mã", "Loại", "Tên", "Ưu tiên"],
    rows: rows.map((r) => [r.id, r.kind, r.name, priorityOf(r.priority)]),
    truncated
  }
}

/** Ma trận quyền của S-4.3: mỗi màn một dòng, mỗi vai trò một cột, ô là các hành động được phép. */
const permissionTable = (spine: Spine): GateTable => {
  const roles = spine.roles
  const byScreen = new Map<string, Map<string, string[]>>()
  for (const p of spine.permissions) {
    const row = byScreen.get(p.screen_id) ?? new Map<string, string[]>()
    row.set(p.role_id, [...(row.get(p.role_id) ?? []), p.action])
    byScreen.set(p.screen_id, row)
  }

  const all = spine.screens.map((screen) => {
    const row = byScreen.get(screen.id) ?? new Map<string, string[]>()
    return [screen.id, screen.name, ...roles.map((role) => (row.get(role.id) ?? []).sort().join(", ") || "—")]
  })
  const { rows, truncated } = clip(all)
  return { title_vi: "Ma trận quyền theo màn", columns: ["Mã màn", "Màn hình", ...roles.map((r) => r.name)], rows, truncated }
}

/**
 * Bảng của step, hoặc `null` nếu step này không sinh bảng. `templateId` là id step không có `@màn`.
 */
export const gateTableOf = (spine: Spine, templateId: string): GateTable | null => {
  if (templateId === "S-9.4") return moscowTable(spine)
  if (templateId === "S-4.3") return permissionTable(spine)
  return null
}
