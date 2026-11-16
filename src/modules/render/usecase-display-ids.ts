/**
 * FLF-420 — mã use case **hiển thị** liên tục theo thứ tự use case (`UC01`, `UC02`…), kể cả khi id trong Spine có lỗ do use
 * case bị xoá (id là khoá Spine, không đổi được — `key_change_forbidden`).
 *
 * Chỉ đổi chữ in ra; Spine, tham chiếu, hash sơ đồ (`spine/source-hash.ts` băm cả id) giữ nguyên. Không áp cho mã của file
 * khách (dự án import đã viết) — bên gọi quyết. Hàm thuần: bản đã ký tính từ snapshot của bản đó nên mã ổn định theo bản.
 */

import type { Spine } from "../spine/spine.types.js"

const label = (n: number, width: number): string => `UC${String(n).padStart(width, "0")}`

/** id use case ⇒ mã hiển thị theo thứ tự `spine.use_cases`; ≥ 100 use case thì 3 chữ số cho mọi mã. */
export const useCaseDisplayIds = (spine: Pick<Spine, "use_cases">): ReadonlyMap<string, string> => {
  const width = Math.max(2, String(spine.use_cases.length).length)
  return new Map(spine.use_cases.map((u, i) => [u.id, label(i + 1, width)]))
}

/** Mã hiển thị của `id`; không có trong bảng (id chết, bảng không áp) ⇒ chính id. */
export const displayUseCaseId = (ids: ReadonlyMap<string, string> | undefined, id: string): string => ids?.get(id) ?? id
