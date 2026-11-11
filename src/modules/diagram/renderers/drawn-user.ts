/**
 * FLF-375 (user chốt 10/11): luật "actor tổng quát `User`" áp **khi FlintFlow vẽ sơ đồ use case** của tài liệu upload,
 * không áp lên dữ liệu của file. Business-flow §2: bản 0.1 ghi nhận nguyên trạng file — lệch mẫu chỉ là cờ vàng
 * (`actor_generalization_missing`), muốn thêm `User` vào tài liệu thì tạo CR.
 *
 * Luật vẽ (user chốt: "use case nào 2 actor trở lên cùng có thì thêm actor User, các actor còn lại kế thừa — như luật đăng
 * nhập, không chỉ riêng đăng nhập"): **không use case nào nối ≥ 2 actor người**. Use case có ≥ 2 actor người ⇒ trên hình
 * thêm actor `User` (in nghiêng), các actor đó kế thừa `User`, use case chỉ nối `User` (+ actor hệ thống / thời gian).
 * Actor đã kế thừa một actor khác cùng nối use case (Customer kế thừa Guest) không tính là actor thứ hai. Actor đã có cha
 * trong file vẫn giữ cạnh cũ và thêm cạnh → `User` chỉ trên hình. Trả **bản sao** Spine chỉ để vẽ. Spine đã có actor tên
 * "User" ⇒ dùng chính actor đó.
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

/**
 * Cạnh kế thừa thêm chỉ có trên hình (actor đã có cha trong file, vd Customer → Guest, nay thêm Customer → User). Gắn theo
 * bản sao Spine `withDrawnUser` trả về — không đổi dữ liệu.
 */
const extraGeneralizations = new WeakMap<Spine, [string, string][]>()
export const drawnGeneralizations = (spine: Spine): [string, string][] => extraGeneralizations.get(spine) ?? []

export const withDrawnUser = (spine: Spine): Spine => {
  if (!isUploadedDocument(spine)) return spine
  const byId = new Map(spine.actors.map((a) => [a.id, a]))
  const human = (id: string): boolean => byId.get(id)?.kind === "human"
  const existing = spine.actors.find((a) => a.kind === "human" && isUserName(a.name))
  const userId = existing?.id ?? DRAWN_USER_ID
  /** Tổ tiên của actor theo `parent_id` (Customer → Guest); vòng / id chết ⇒ dừng. */
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = []
    let cur = byId.get(id)?.parent_id?.trim()
    while (cur && byId.has(cur) && !out.includes(cur) && cur !== id) {
      out.push(cur)
      cur = byId.get(cur)?.parent_id?.trim()
    }
    return out
  }

  // TechMart 11/11: actor có tổ tiên cũng nối use case đó thì đã được kế thừa (Customer kế thừa Guest ở "Search Products")
  // ⇒ chỉ tính actor "gốc" trong use case. Còn ≥ 2 actor người không liên quan nhau ⇒ use case nối `User`, CHÍNH các actor
  // đó kế thừa `User` (không đẩy tổ tiên của chúng lên — Guest không đăng nhập thì không thành con của User).
  const children = new Set<string>()
  const useCases = spine.use_cases.map((uc) => {
    const humans = uc.actor_ids.filter((id) => human(id) && id !== userId)
    const roots = humans.filter((id) => !ancestorsOf(id).some((a) => humans.includes(a)))
    if (roots.length < 2) return uc
    roots.forEach((id) => children.add(id))
    return { ...uc, actor_ids: [userId, ...uc.actor_ids.filter((id) => !humans.includes(id) && id !== userId)] }
  })
  if (!children.size) return spine

  const names = [...children].map((id) => byId.get(id)!.name)
  const user: Actor = existing ?? ({ id: DRAWN_USER_ID, name: "User", kind: "human", description: `Any of ${names.join(", ")}.`, parent_id: null } as Actor)
  // Actor chưa có cha ⇒ cha là User; đã có cha trong file ⇒ giữ cha cũ, thêm cạnh → User chỉ trên hình (đa kế thừa UML)
  const extra: [string, string][] = []
  const actors = [
    ...spine.actors.map((a) => {
      if (!children.has(a.id) || a.id === userId) return a
      if (a.parent_id && byId.has(a.parent_id)) {
        extra.push([a.id, userId])
        return a
      }
      return { ...a, parent_id: userId }
    }),
    ...(existing ? [] : [user])
  ]
  const drawn = { ...spine, actors, use_cases: useCases }
  if (extra.length) extraGeneralizations.set(drawn, extra)
  return drawn
}
