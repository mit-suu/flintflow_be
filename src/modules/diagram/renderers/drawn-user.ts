/**
 * FLF-375 (user chốt 10/11): luật "actor tổng quát `User`" áp **khi FlintFlow vẽ sơ đồ use case** của tài liệu upload,
 * không áp lên dữ liệu của file. Business-flow §2: bản 0.1 ghi nhận nguyên trạng file — lệch mẫu chỉ là cờ vàng
 * (`actor_generalization_missing`), muốn thêm `User` vào tài liệu thì tạo CR.
 *
 * Luật vẽ (user chốt: "use case nào 2 actor trở lên cùng có thì thêm actor User, các actor còn lại kế thừa — như luật đăng
 * nhập, không chỉ riêng đăng nhập"): **không use case nào nối ≥ 2 actor người**. Use case có ≥ 2 actor người ⇒ trên hình
 * thêm actor `User` (in nghiêng), các actor đó kế thừa `User`, use case chỉ nối `User` (+ actor hệ thống / thời gian).
 * Actor đã có cha trong file (Customer kế thừa Guest) giữ cạnh của mình; nó vẫn bị thay bằng `User` trên use case chung
 * khi tổ tiên của nó là con của `User`. Trả **bản sao** Spine chỉ để vẽ. Spine đã có actor tên "User" ⇒ dùng chính actor đó.
 */

import type { Actor, Spine } from "../../spine/spine.types.js"

/** Id của actor `User` chỉ có trên hình — không trùng id thật nào (id thật theo mẫu `A01`, `ACT-…`). */
export const DRAWN_USER_ID = "__user"

const isUserName = (name: string): boolean => /^users?$/i.test(name.trim())

/**
 * Chỉ dự án tạo bằng file upload (Spine có mục nguyên văn của file). Dự án FlintFlow tự soạn đã áp luật `User` vào dữ
 * liệu lúc soạn (S-3.1 / S-3.2) — vẽ thêm ở đó sẽ đổi hình của bản đã ký.
 */
export const isUploadedDocument = (spine: Spine): boolean => spine.custom_sections.some((c) => c.source === "import")

export const withDrawnUser = (spine: Spine): Spine => {
  if (!isUploadedDocument(spine)) return spine
  const byId = new Map(spine.actors.map((a) => [a.id, a]))
  const human = (id: string): boolean => byId.get(id)?.kind === "human"
  const existing = spine.actors.find((a) => a.kind === "human" && isUserName(a.name))
  const userId = existing?.id ?? DRAWN_USER_ID
  /** Gốc của actor theo `parent_id` (Customer → Guest); vòng / id chết ⇒ dừng. */
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let cur = id
    while (!seen.has(cur)) {
      seen.add(cur)
      const parent = byId.get(cur)?.parent_id?.trim()
      if (!parent || !byId.has(parent) || parent === userId) break
      cur = parent
    }
    return cur
  }

  // Use case có ≥ 2 actor người (khác User) ⇒ gốc của từng actor thành con của User; use case chỉ nối User
  const children = new Set<string>()
  const useCases = spine.use_cases.map((uc) => {
    const humans = uc.actor_ids.filter((id) => human(id) && id !== userId)
    if (humans.length < 2) return uc
    humans.forEach((id) => children.add(rootOf(id)))
    return { ...uc, actor_ids: [userId, ...uc.actor_ids.filter((id) => !humans.includes(id) && id !== userId)] }
  })
  if (!children.size) return spine

  const names = [...children].map((id) => byId.get(id)!.name)
  const user: Actor = existing ?? ({ id: DRAWN_USER_ID, name: "User", kind: "human", description: `Any of ${names.join(", ")}.`, parent_id: null } as Actor)
  const actors = [...spine.actors.map((a) => (children.has(a.id) && a.id !== userId ? { ...a, parent_id: userId } : a)), ...(existing ? [] : [user])]
  return { ...spine, actors, use_cases: useCases }
}
