/**
 * §3.1.1 Screens Flow — source_fields: `screens[].name/.flow_to[].to/.is_popup/.tabs/.feature_id/.queue_order` ·
 * `features[].name/.order` · actor người dùng màn (`screen-actors.ts`).
 * Đúng ký pháp hình mẫu §3.1.1 của template SRS FPT ("draw the Screens Flow for the system"), dựng bằng SVG (hình học ở
 * `screen-flow-layout.ts`): màn = chữ nhật, pop-up = ô-van, màn nhiều tab = khung chứa các tab, mũi tên tam giác đặc.
 * Ô vàng của template ⇒ nền `#7ACFF5` cho màn dùng chung (`sharedScreenIds`), màn còn lại nền trắng.
 *
 * MỘT HÌNH CHO CẢ HỆ THỐNG. Quá `MAX_SCREENS_PER_DIAGRAM` màn, quá `MAX_COLUMNS` cột (in vào trang A4 chữ quá nhỏ) hoặc
 * không qua `checkScene` ⇒ mỗi actor người một hình gồm các màn actor đó dùng (`screenActorSets`, kể cả màn của actor tổng
 * quát mà nó kế thừa) — màn dùng chung có mặt ở mọi hình, như Screens flow for User / for Admin. Hình của actor trùng hẳn
 * vào hình của actor khác thì bỏ; màn chưa nối actor nào vào hình "Other screens" (liên kết thưa — quá 20% màn chưa nối — thì bỏ qua bước này). Hình theo actor vẫn không vừa ⇒ chia
 * theo feature nguyên vẹn (`features[].order`; màn có feature không tồn tại gom vào nhóm cuối), một feature tự nó không
 * vừa thì tách đôi theo hạng trong luồng. Mỗi hình kèm các màn trên đường từ màn vào tới màn của nó (cây của
 * cả hệ thống) để màn có cha ở hình khác không thành mồ côi — màn hub có thể có mặt ở nhiều hình. Phần đầu giữ id gốc của hình
 * (`diagram.service.ts#assignIds`).
 *
 * Vẽ MỌI màn (template vẽ toàn hệ thống), kể cả màn chưa nối được actor nào — cờ `orphan_screen` nhắc sửa dữ liệu; ẩn màn
 * đó làm màn con của nó thành gốc trơ trọi. Cạnh quay lại màn
 * trước không vẽ — điều hướng quay lại là ngầm định. Trigger / guard của `flow_to` không vẽ (template không ghi nhãn cạnh).
 * Hình không vẽ tiêu đề; `<title>` của SVG là chú thích (`section-renderer`).
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { actorParents, ancestorsOf } from "../../spine/actor-generalization.js"
import { screenActorSets, sharedScreenIds } from "../../spine/screen-actors.js"
import type { Screen, Spine } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { byId, compareIds, svgPart } from "./common.js"
import { DIAGRAM_LABELS, type DiagramLabels } from "./labels.js"
import { flowColumns, flowTree, layoutScreenFlow, planFlow, type FlowDiagram } from "./screen-flow-layout.js"

export const MAX_SCREENS_PER_DIAGRAM = 40
/** Tách theo actor chỉ khi phần màn chưa nối actor nào không quá tỉ lệ này. */
const MAX_UNLINKED_SHARE = 0.2
/** Quá số cột này hình bị thu nhỏ quá mức khi đặt vừa bề ngang trang A4 (hình mẫu Report 3: 9 cột). */
export const MAX_COLUMNS = 10
export const SCREEN_FLOW_SECTION = "fixed:3.1.1"

const byQueueOrder = (a: Screen, b: Screen): number =>
  (a.queue_order ?? Number.MAX_SAFE_INTEGER) - (b.queue_order ?? Number.MAX_SAFE_INTEGER) || compareIds(a.id, b.id)

/** Màn theo feature (`features[].order`, rồi id); màn có feature không tồn tại gom vào nhóm cuối. */
const groupByFeature = (spine: Spine, screens: Screen[]): Screen[][] => {
  const features = [...spine.features].sort((a, b) => a.order - b.order || compareIds(a.id, b.id))
  const known = new Set(features.map((f) => f.id))
  const groups = features.map((f) => screens.filter((s) => s.feature_id === f.id)).filter((g) => g.length > 0)
  const rest = screens.filter((s) => !known.has(s.feature_id))
  if (rest.length > 0) groups.push(rest)
  return groups
}

const flowsOf = (screens: readonly Screen[]): [string, string][] => screens.flatMap((s) => s.flow_to.map((e): [string, string] => [s.id, e.to]))
const popupsOf = (screens: readonly Screen[]): Set<string> => new Set(screens.filter((s) => s.is_popup).map((s) => s.id))

/** Cắt `screens` (đã theo thứ tự ưu tiên) làm đôi theo hạng trong luồng, trả lại thứ tự ưu tiên trong từng nửa. */
const halve = (screens: Screen[]): Screen[][] => {
  const plan = planFlow(screens.map((s) => s.id), popupsOf(screens), flowsOf(screens))
  const position = new Map(screens.map((s, i) => [s.id, i]))
  const ranked = [...screens].sort((a, b) => plan.rank.get(a.id)! - plan.rank.get(b.id)! || position.get(a.id)! - position.get(b.id)!)
  const size = Math.ceil(ranked.length / 2)
  return [ranked.slice(0, size), ranked.slice(size)].map((p) => p.sort(byQueueOrder)).filter((p) => p.length > 0)
}

/**
 * Mỗi actor người (theo thứ tự `actors[]`) một nhóm: màn mà actor đó hoặc actor tổng quát của nó dùng. Nhóm nằm trọn trong
 * nhóm khác thì bỏ (actor tổng quát thường chỉ có phần chung); màn chưa nối actor nào thành nhóm cuối. Dưới hai actor,
 * hoặc quá `MAX_UNLINKED_SHARE` số màn chưa nối actor ⇒ rỗng (renderer chia theo feature như trước).
 */
const byActor = (spine: Spine, screens: Screen[], labels: DiagramLabels): { name: string | undefined; screens: Screen[] }[] => {
  const sets = screenActorSets(spine)
  const parents = actorParents(spine.actors)
  const used = new Set([...sets.values()].flat())
  const groups = spine.actors
    .filter((a) => a.kind === "human" && used.has(a.id))
    .map((a) => {
      const self = new Set([a.id, ...ancestorsOf(a.id, parents)])
      return { name: a.name as string | undefined, screens: screens.filter((s) => (sets.get(s.id) ?? []).some((id) => self.has(id))) }
    })
    .filter((g) => g.screens.length > 0)
  const kept = groups.filter(
    (g, i) => !groups.some((o, j) => j !== i && o.screens.length >= g.screens.length && g.screens.every((s) => o.screens.includes(s)) && (o.screens.length > g.screens.length || j < i))
  )
  const orphans = screens.filter((s) => (sets.get(s.id) ?? []).length === 0)
  // Liên kết màn ↔ actor còn thưa thì hình theo actor vừa thiếu màn vừa thiếu lối vào ⇒ chia theo feature
  if (kept.length < 2 || orphans.length > screens.length * MAX_UNLINKED_SHARE) return []
  return orphans.length > 0 ? [...kept, { name: labels.otherScreens, screens: orphans }] : kept
}

const meta = (): Pick<RenderedPart, "kind" | "section" | "owner_kind" | "owner_id"> => ({ kind: "screen_flow", section: SCREEN_FLOW_SECTION, owner_kind: null, owner_id: null })

/** Mọi hình luồng màn của Spine theo thứ tự trong tài liệu: tiêu đề + dữ liệu hình (thường đúng một hình). */
export const partitionScreenFlow = (spine: Spine, labels: DiagramLabels = DIAGRAM_LABELS.en): { title: string; diagram: FlowDiagram }[] => {
  const shared = sharedScreenIds(spine)
  const drawn = byId(spine.screens).sort(byQueueOrder)
  if (drawn.length === 0) return []

  const diagramOf = (screens: Screen[]): FlowDiagram => ({
    nodes: screens.map((s) => ({ id: s.id, name: s.name, popup: s.is_popup, tabs: s.tabs, shared: shared.has(s.id) })),
    edges: flowsOf(screens)
  })
  /** Hình đọc được: không quá `MAX_COLUMNS` cột và qua `checkScene`. */
  const readable = (screens: Screen[]): boolean =>
    flowColumns(diagramOf(screens)) <= MAX_COLUMNS && checkScene(layoutScreenFlow(diagramOf(screens)), { allowBends: true }).length === 0
  const fits = (screens: Screen[]): boolean => screens.length <= MAX_SCREENS_PER_DIAGRAM && readable(screens)
  /** Phần không vừa: nhiều feature ⇒ tách theo feature trước; một feature ⇒ tách đôi theo hạng; một màn lẻ thì dừng. */
  const refine = (screens: Screen[]): Screen[][] => {
    if (screens.length < 2 || fits(screens)) return [screens]
    const groups = groupByFeature(spine, screens)
    return (groups.length > 1 ? groups : halve(screens)).flatMap(refine)
  }
  /** Không vừa ⇒ gói tham lam các feature nguyên vẹn tới `MAX_SCREENS_PER_DIAGRAM` màn mỗi phần, rồi tinh chỉnh từng phần. */
  const split = (screens: Screen[]): Screen[][] => {
    if (fits(screens)) return [screens]
    const packed: Screen[][] = []
    let current: Screen[] = []
    for (const group of groupByFeature(spine, screens)) {
      if (current.length > 0 && current.length + group.length > MAX_SCREENS_PER_DIAGRAM) {
        packed.push(current)
        current = []
      }
      current.push(...group)
    }
    if (current.length > 0) packed.push(current)
    return packed.map((p) => p.sort(byQueueOrder)).flatMap(refine)
  }

  if (fits(drawn)) return [{ title: labels.screensFlowTitle(), diagram: diagramOf(drawn) }]
  const roles = byActor(spine, drawn, labels)
  const groups = roles.length > 0 ? roles : [{ name: undefined, screens: drawn }]
  // Màn cha nằm ở hình khác thì cạnh vào bị cắt và màn thành mồ côi ⇒ hình kèm các màn trên đường từ màn vào tới màn của
  // nó (theo cây của cả hệ thống) nếu hình vẫn đọc được, không thì chỉ màn cha trực tiếp, không nữa thì giữ nguyên (luồng
  // rất sâu đã tách theo hạng). Màn kèm theo chỉ là ngữ cảnh nên không tính vào trần `MAX_SCREENS_PER_DIAGRAM`. Màn hub vì thế có thể có mặt ở nhiều hình, như màn dùng chung khi tách theo actor.
  const { parent } = flowTree(planFlow(drawn.map((s) => s.id), popupsOf(drawn), flowsOf(drawn)))
  const lift = (screens: Screen[], levels: number): Screen[] => {
    const ids = new Set(screens.map((s) => s.id))
    for (const s of screens) {
      let up = parent.get(s.id)
      for (let k = 0; k < levels && up !== undefined; k++, up = parent.get(up)) ids.add(up)
    }
    return drawn.filter((s) => ids.has(s.id))
  }
  const withAncestors = (screens: Screen[]): Screen[] =>
    [lift(screens, Number.MAX_SAFE_INTEGER), lift(screens, 1)].find((c) => c.length === screens.length || readable(c)) ?? screens
  return groups.flatMap(({ name, screens }) => {
    const pieces = split(screens)
    return pieces.map((piece, i) => {
      const part = [name, pieces.length > 1 ? `${i + 1}/${pieces.length}` : undefined].filter((x) => x !== undefined).join(", ")
      return { title: labels.screensFlowTitle(part || undefined), diagram: diagramOf(withAncestors(piece)) }
    })
  })
}

export const renderScreenFlow: Renderer = (spine, _ownerId, labels = DIAGRAM_LABELS.en) =>
  partitionScreenFlow(spine, labels).map(({ title, diagram }) => svgPart(layoutScreenFlow(diagram), { allowBends: true }, meta(), title))
