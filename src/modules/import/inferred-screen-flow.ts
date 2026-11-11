/**
 * QLHS 11/11 bug #15: file upload không có sơ đồ / mục luồng màn và chỉ ghi vài chuyển màn ("nút Sửa mở M3") ⇒ hình §3.1.1
 * là các màn đứng rời. User chốt: suy luồng từ use case + vai — màn Đăng nhập → màn chính của từng vai theo use case vai đó
 * làm, cộng chuyển màn file ghi. Cạnh suy ra ghi vào `flow_to` như cạnh thường, kèm một cờ vàng "Cần xem" liệt kê từng cạnh
 * để người duyệt xác nhận (sai thì sửa bằng CR). Hàm thuần, tất định, không gọi AI. Chỉ chạy ở finalize import (mode 1).
 *
 * Màn của use case: function của use case có `screen_id` / là `primary_function_id` của màn; không có ⇒ màn trùng tên use case
 * nhất ("Điểm danh hằng ngày" ↔ "Điểm danh"). Màn chưa nối use case nào ⇒ ma trận phân quyền (vai ⇒ actor).
 * Màn đã có đường vào do file ghi (M2 → M3) ⇒ đăng nhập trỏ tới màn đầu của đường đó (M2), không trỏ thẳng M3.
 */

import type { Op } from "../spine/op.types.js"
import type { Spine } from "../spine/spine.types.js"
import type { Finding } from "./check.service.js"
import { realSectionId, type resolveProvisional } from "./extracted-entities.js"
import type { IExtractionDraft } from "./extraction-draft.model.js"
import type { HeadingMapEntry } from "./template-profile.model.js"

export const SCREEN_FLOW_SECTION_ID = "fixed:3.1.1"

type FlowSource = Pick<Spine, "screens" | "actors" | "roles" | "permissions" | "use_cases" | "functions">

export interface InferredFlowEdge {
  from: string
  to: string
  trigger: string
  /** Tên actor người đi vào màn `to` (thứ tự `actors[]`). */
  actor_names: string[]
}

const LOGIN_NAME = /đăng\s*nhập|\blog\s*-?\s*in\b|\bsign\s*-?\s*in\b/iu
/** Mã đầu tên ("M1", "SCR-01:", "UC-05 –") không phải chữ của tên. */
const LEADING_CODE = /^\s*[A-Z]{1,4}[-_. ]?\d+[a-z]?\s*[.:)\-–—]?\s+/u
const STOPWORDS = new Set(["màn", "hình", "trang", "giao", "diện", "screen", "page", "form", "và", "and", "the", "of"])

export const cleanName = (name: string): string => name.replace(LEADING_CODE, "").trim()

const tokens = (name: string): Set<string> =>
  new Set(
    cleanName(name)
      .normalize("NFC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t && !STOPWORDS.has(t))
  )

/**
 * Độ khớp tên màn ↔ tên use case: `[chứa trọn, số từ chung, phần từ màn được phủ]`, `null` = không khớp. Chứa trọn = mọi từ
 * của bên ngắn có ở bên dài; không chứa trọn thì cần ≥ 2 từ chung và ≥ 60% bên ngắn (một từ chung "học" / "nhập" là trùng hợp).
 */
export const nameMatch = (screenName: string, useCaseName: string): [number, number, number] | null => {
  const s = tokens(screenName)
  const u = tokens(useCaseName)
  if (!s.size || !u.size) return null
  const common = [...s].filter((t) => u.has(t)).length
  if (!common) return null
  const contained = common === Math.min(s.size, u.size)
  if (!contained && (common < 2 || common / Math.min(s.size, u.size) < 0.6)) return null
  return [contained ? 1 : 0, common, common / s.size]
}

const better = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

export const isLoginName = (name: string): boolean => LOGIN_NAME.test(name)

/**
 * Luồng thưa: file ghi chuyển màn cho dưới một nửa số màn (màn có cạnh vào hoặc ra). Từ 3 màn trở lên mới xét.
 */
export const isSparseFlow = (screens: FlowSource["screens"]): boolean => {
  if (screens.length < 3) return false
  const ids = new Set(screens.map((s) => s.id))
  const linked = new Set<string>()
  for (const s of screens) {
    for (const e of s.flow_to) {
      if (e.to === s.id || !ids.has(e.to)) continue
      linked.add(s.id)
      linked.add(e.to)
    }
  }
  return linked.size * 2 < screens.length
}

/**
 * Cạnh suy ra (chưa có trong `flow_to`): một cạnh màn đăng nhập → mỗi màn vào của vai, trigger = tên màn đăng nhập + các vai
 * ("Đăng nhập (Giáo viên, Quản trị)"). Không có màn đăng nhập / luồng không thưa ⇒ `[]`.
 */
export const inferScreenFlow = (spine: FlowSource): InferredFlowEdge[] => {
  const screens = spine.screens
  if (!isSparseFlow(screens)) return []
  const loginUseCases = spine.use_cases.filter((u) => isLoginName(u.name))
  const fnScreen = new Map(spine.functions.map((f) => [f.id, f.screen_id]))
  const screensOfFunctions = (fnIds: readonly string[]): string[] => {
    const set = new Set(fnIds)
    return screens.filter((s) => fnIds.some((f) => fnScreen.get(f) === s.id) || (s.primary_function_id !== null && set.has(s.primary_function_id))).map((s) => s.id)
  }
  const login =
    screens.find((s) => !s.is_popup && isLoginName(s.name)) ??
    screens.find((s) => !s.is_popup && loginUseCases.some((u) => screensOfFunctions(u.function_ids).includes(s.id)))
  if (!login) return []

  const human = new Set(spine.actors.filter((a) => a.kind === "human").map((a) => a.id))
  const candidates = screens.filter((s) => s.id !== login.id && !s.is_popup)
  const candidateIds = new Set(candidates.map((s) => s.id))
  const actorsOf = new Map<string, Set<string>>(candidates.map((s) => [s.id, new Set()]))

  // 1. Use case ⇒ màn (function, rồi tên) ⇒ actor người của use case
  for (const uc of spine.use_cases) {
    if (isLoginName(uc.name)) continue
    const actors = uc.actor_ids.filter((a) => human.has(a))
    if (!actors.length) continue
    let targets = screensOfFunctions(uc.function_ids).filter((id) => candidateIds.has(id))
    if (!targets.length) {
      let best: { id: string; score: [number, number, number] } | null = null
      for (const s of candidates) {
        const score = nameMatch(s.name, uc.name)
        if (score && (!best || better(score, best.score))) best = { id: s.id, score }
      }
      targets = best ? [best.id] : []
    }
    for (const t of targets) for (const a of actors) actorsOf.get(t)!.add(a)
  }
  // 2. Màn chưa nối use case nào ⇒ vai được vào màn (ma trận phân quyền)
  const roleActor = new Map(spine.roles.map((r) => [r.id, r.actor_id]))
  for (const s of candidates) {
    const set = actorsOf.get(s.id)!
    if (set.size) continue
    for (const p of spine.permissions) {
      const a = p.screen_id === s.id ? roleActor.get(p.role_id) : null
      if (a && human.has(a)) set.add(a)
    }
  }

  // 3. Màn có đường vào do file ghi (không tính từ màn đăng nhập) ⇒ vai đi qua màn đầu của đường đó
  const preds = new Map<string, string[]>()
  for (const s of screens) {
    if (s.id === login.id) continue
    for (const e of s.flow_to) if (e.to !== s.id && candidateIds.has(e.to)) preds.set(e.to, [...(preds.get(e.to) ?? []), s.id])
  }
  const rootsOf = (id: string): string[] => {
    const seen = new Set([id])
    const queue = [id]
    const roots: string[] = []
    while (queue.length) {
      const cur = queue.shift()!
      const ps = (preds.get(cur) ?? []).filter((p) => candidateIds.has(p))
      if (!ps.length) roots.push(cur)
      for (const p of ps) if (!seen.has(p)) (seen.add(p), queue.push(p))
    }
    return roots.length ? roots : [id]
  }
  const entryActors = new Map<string, Set<string>>()
  for (const s of candidates) {
    const actors = actorsOf.get(s.id)!
    if (!actors.size) continue
    for (const r of rootsOf(s.id)) {
      const set = entryActors.get(r) ?? new Set<string>()
      actors.forEach((a) => set.add(a))
      entryActors.set(r, set)
    }
  }

  const stated = new Set(login.flow_to.map((e) => e.to))
  const loginLabel = cleanName(login.name) || login.name
  const actorOrder = spine.actors.filter((a) => human.has(a.id))
  return candidates
    .filter((s) => entryActors.has(s.id) && !stated.has(s.id))
    .map((s) => {
      const set = entryActors.get(s.id)!
      const names = actorOrder.filter((a) => set.has(a.id)).map((a) => a.name.trim() || a.id)
      return { from: login.id, to: s.id, trigger: `${loginLabel} (${names.join(", ")})`, actor_names: names }
    })
}

/**
 * QLHS 11/11 bug #15: file có luồng màn của riêng nó (ảnh sơ đồ luồng màn đọc được, hoặc heading xếp vào mục Screens Flow)
 * ⇒ không suy thêm cạnh — hình / mục của người dùng là nguồn.
 */
export const hasOwnScreenFlow = (
  drafts: readonly Pick<IExtractionDraft, "diagram_images">[],
  headingMap: readonly Pick<HeadingMapEntry, "section_id">[],
  provisional: ReturnType<typeof resolveProvisional>
): boolean =>
  drafts.some((d) => (d.diagram_images ?? []).some((i) => i.kind === "screen_flow")) ||
  headingMap.some((h) => realSectionId(h.section_id, provisional) === SCREEN_FLOW_SECTION_ID)

export const inferredFlowOps = (edges: readonly InferredFlowEdge[]): Op[] =>
  edges.map((e) => ({
    op: "add",
    path: `screens[id=${e.from}].flow_to[]`,
    value: { to: e.to, trigger: e.trigger }
  }))

/** Một cờ vàng "Cần xem" cho cả lô cạnh suy ra — câu nêu tên màn, không in mã. */
export const inferredFlowFindings = (spine: Pick<Spine, "screens">, edges: readonly InferredFlowEdge[]): Finding[] => {
  if (!edges.length) return []
  const name = (id: string): string => {
    const s = spine.screens.find((x) => x.id === id)
    return s ? cleanName(s.name) || s.name : id
  }
  const list = edges.map((e) => `${name(e.from)} → ${name(e.to)} (${e.actor_names.join(", ")})`).join("; ")
  return [
    {
      rule: "needs_review",
      section_id: SCREEN_FLOW_SECTION_ID,
      message: `Cần xem: Luồng màn hình suy từ use case và vai — cần xác nhận: ${list}; file không ghi các chuyển màn này, sai thì sửa bằng change request`,
      block_ids: [],
      target_id: `screens[id=${edges[0].from}].flow_to`
    }
  ]
}
