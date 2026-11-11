/**
 * Hình học sơ đồ use case (UML 2.5.1) và sơ đồ phân cấp actor — port từ `docs/technical/usecase-diagram-layout.md`
 * §2–§7 (bản chạy được ở `docs/diagrams/usecase/build-diagrams.mjs`). Đơn vị px, trục y hướng xuống (khớp `Scene`).
 *
 * Ba cột: actor người bên trái, khung hệ thống ở giữa chứa một cột ellipse, actor `system`/`time` bên phải; cả hai cột
 * actor nằm NGOÀI khung. Quy ước này là phương án đầu tiên; không sạch thì `layoutOptions` thử đổi thứ tự hàng và chia actor
 * người sang hai bên (FLF-369) — mọi chỗ dưới đây suy bên từ bên được gán, không từ `kind`. Hai bất biến làm mọi association là MỘT đoạn thẳng không cắt ellipse nào:
 * - mọi ellipse cùng `rx`, `ry`, cùng `cx` ⇒ đỉnh trái / phải của chúng thẳng hàng dọc;
 * - association nối bàn tay actor tới đỉnh trái (actor bên trái) hoặc đỉnh phải (actor bên phải) của ellipse đích. Một đoạn
 *   thẳng từ ngoài cột tới đỉnh luôn nằm hẳn ngoài cột cho tới khi chạm đích ⇒ không vào được ellipse khác.
 *
 * include / extend là đoạn dọc tại `cx` giữa hai ellipse KỀ NHAU (thứ tự hàng do `usecase.renderer.ts` bảo đảm), nét đứt,
 * mũi tên hở ở đầu `to`, nhãn lệch phải. Hàng nào không kề nhau thì ném lỗi — đó là lỗi của bộ chia hình, không phải dữ liệu.
 */

import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import { FILL, fontDescent, stereotype, textWidth } from "../../../shared/diagram/svg-kit.js"
import { Scene } from "../../../shared/diagram/svg-scene.js"
import type { ActorKind } from "../../spine/spine.types.js"

export type RelationKind = "include" | "extend"

export interface UseCaseRow {
  id: string
  name: string
}
export interface DiagramActor {
  id: string
  name: string
  kind: ActorKind
  /** Có actor con kế thừa ⇒ in nghiêng. */
  abstract: boolean
}
export interface Association {
  actorId: string
  useCaseId: string
}
/** Mũi tên đi `from` → `to`: include = base → included; extend = extension → base. */
export interface Relation {
  from: string
  to: string
  kind: RelationKind
}
/** Generalization actor người → actor người (đường liền, tam giác rỗng ở `parent`), vẽ ngay trên sơ đồ use case. */
export interface Generalization {
  child: string
  parent: string
}
export interface UseCaseDiagram {
  system: string
  /** Thứ tự dọc từ trên xuống. */
  rows: UseCaseRow[]
  actors: DiagramActor[]
  associations: Association[]
  relations: Relation[]
  /**
   * QLHS 11/11 bug #13: tài liệu upload vẽ cạnh kế thừa (vd mọi vai trò → `User`) ngay trên hình — không có hình phân cấp
   * riêng. Actor cha ở cột sát khung, actor con ở cột ngoài cùng bên trái. Thiếu ⇒ hình như cũ.
   */
  generalizations?: Generalization[]
}

const TEXT_SIZE = 16
const TITLE_SIZE = 18
const LINE_HEIGHT = 21
const ROW_GAP = 30
const BOUND_PAD_X = 46
const BOUND_PAD_TOP = 58
const BOUND_PAD_BOTTOM = 34
const MAX_ELLIPSE_TEXT_WIDTH = 230
const MAX_ELLIPSE_LINES = 3
const MAX_ACTOR_TEXT_WIDTH = 200
const MAX_ACTOR_LINES = 2
/** Nhãn `<<include>>` / `<<extend>>` lệch phải đường dọc. */
const RELATION_LABEL_OFFSET = 14
const ACTOR_GAP_Y = 26
/** Actor nhiều cha: thanh gom của cha thứ k lệch sang trái k bước; nhánh tới cha thứ k thấp hơn hông k bước. */
const GENERALIZATION_BUS_STEP = 14
const GENERALIZATION_STUB_STEP = 10
/** Khoảng ngang giữa cột actor cha và cột actor con (cạnh generalization nằm trong khoảng này). */
const GENERALIZATION_COLUMN_GAP = 110
/** Đầu / cuối cạnh generalization cách hình que để không chạm tay / chữ. */
const GENERALIZATION_PAD = 8
/** Đoạn thân mang tam giác chung khi một actor cha có ≥ 2 actor con. */
const GENERALIZATION_TRUNK = 36
/** Khoảng cách actor ↔ khung: thử lần lượt tới khi `checkScene` sạch (đường thoải hơn thì không quệt chữ actor khác). */
export const ACTOR_BOUNDARY_GAPS: readonly number[] = [120, 200, 300, 440]

/** Hình que: đầu r = 10, thân y+20 → y+50, tay ngang y+31 dài 32, chân tới y+74, tên từ y+96. */
const FIGURE = { head: 10, bodyTop: 20, bodyBottom: 50, arm: 32, armY: 31, leg: 24, legY: 74, label: 96, labelLine: 20 }

/**
 * Gói `text` thành ≤ `maxLines` dòng cân nhau nhất (tối thiểu hoá bề rộng dòng dài nhất), chỉ cắt ở khoảng trắng.
 * Vừa một dòng, hoặc chỉ một từ ⇒ giữ nguyên.
 */
export const wrapLines = (text: string, size: number, maxWidth: number, maxLines: number): string[] => {
  const words = text.split(/\s+/).filter((w) => w !== "")
  const joined = words.join(" ")
  const full = textWidth(joined, size)
  if (words.length < 2 || full <= maxWidth) return [joined]
  const lineCount = Math.min(maxLines, words.length, Math.ceil(full / maxWidth))
  const span = (i: number, j: number): number => textWidth(words.slice(i, j).join(" "), size)
  // best[k][j]: bề rộng dòng dài nhất nhỏ nhất khi chia j từ đầu thành k dòng; cut[k][j] = nơi dòng k bắt đầu
  const best: number[][] = Array.from({ length: lineCount + 1 }, () => Array<number>(words.length + 1).fill(Infinity))
  const cut: number[][] = Array.from({ length: lineCount + 1 }, () => Array<number>(words.length + 1).fill(0))
  best[0][0] = 0
  for (let k = 1; k <= lineCount; k++)
    for (let j = k; j <= words.length; j++)
      for (let i = k - 1; i < j; i++) {
        const width = Math.max(best[k - 1][i], span(i, j))
        if (width < best[k][j]) {
          best[k][j] = width
          cut[k][j] = i
        }
      }
  const lines: string[] = []
  for (let k = lineCount, j = words.length; k > 0; k--) {
    const i = cut[k][j]
    lines.unshift(words.slice(i, j).join(" "))
    j = i
  }
  return lines
}

interface FigureMetrics {
  lines: string[]
  width: number
  /** Từ đỉnh đầu tới đáy chữ cuối. */
  height: number
}

const figureMetrics = (lines: string[]): FigureMetrics => ({
  lines,
  width: Math.max(FIGURE.arm, ...lines.map((l) => textWidth(l, TEXT_SIZE))),
  height: Math.ceil(FIGURE.label + (lines.length - 1) * FIGURE.labelLine + fontDescent(TEXT_SIZE)) + 1
})

const actorLines = (actor: DiagramActor): string[] => {
  const name = wrapLines(actor.name || actor.id, TEXT_SIZE, MAX_ACTOR_TEXT_WIDTH, MAX_ACTOR_LINES)
  return actor.kind === "human" ? name : [stereotype(actor.kind), ...name]
}

/** Hình que tại `cx`, đỉnh đầu ở `top`. Mọi mảnh là phần tử Scene để `checkScene` kiểm cả actor. */
const drawActor = (scene: Scene, id: string, name: string, cx: number, top: number, lines: string[], italic: boolean): void => {
  scene.circle(`${id}#head`, cx, top + FIGURE.head, FIGURE.head, { name })
  const part = (suffix: string, a: [number, number], b: [number, number]) => scene.line(`${id}#${suffix}`, a, b, { name: `${name} (hình que)` })
  part("body", [cx, top + FIGURE.bodyTop], [cx, top + FIGURE.bodyBottom])
  part("arms", [cx - FIGURE.arm / 2, top + FIGURE.armY], [cx + FIGURE.arm / 2, top + FIGURE.armY])
  part("leg-l", [cx, top + FIGURE.bodyBottom], [cx - FIGURE.leg / 2, top + FIGURE.legY])
  part("leg-r", [cx, top + FIGURE.bodyBottom], [cx + FIGURE.leg / 2, top + FIGURE.legY])
  lines.forEach((line, i) => scene.text(`${id}#name-${i}`, cx, top + FIGURE.label + i * FIGURE.labelLine, line, { size: TEXT_SIZE, italic, name: line }))
}

const byIdThen = <T extends { id: string }>(want: Map<string, number>) => (a: T, b: T): number =>
  (want.get(a.id) ?? 0) - (want.get(b.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export interface PackItem {
  id: string
  /** Vị trí đầu mong muốn. */
  want: number
  /** Chiều cao chiếm chỗ, đã gồm khoảng cách tới phần tử kế. */
  size: number
}
export interface PackBlock {
  items: PackItem[]
  /** Độ lệch của từng phần tử so với `top` của khối. */
  offsets: number[]
  top: number
}

/**
 * Xếp một cột phần tử theo thứ tự cho sẵn, không chồng nhau, mỗi phần tử gần `want` nhất có thể (tổng bình phương độ
 * lệch nhỏ nhất). Phần tử chen nhau gộp thành khối liền; khối đặt ở trung bình `want - offset` của các phần tử trong
 * nó — tức căn giữa quanh chỗ chúng muốn ở —, chạm khối trước thì gộp tiếp. Một phần tử đứng riêng ⇒ đúng `want`.
 */
export const packBlocks = (items: readonly PackItem[]): PackBlock[] => {
  const blocks: (PackBlock & { span: number })[] = []
  for (const item of items) {
    let block = { items: [item], offsets: [0], top: item.want, span: item.size }
    for (let prev = blocks[blocks.length - 1]; prev && prev.top + prev.span > block.top; prev = blocks[blocks.length - 1]) {
      blocks.pop()
      const offsets = [...prev.offsets, ...block.offsets.map((o) => o + prev.span)]
      const merged = [...prev.items, ...block.items]
      const top = merged.reduce((sum, it, i) => sum + it.want - offsets[i], 0) / merged.length
      block = { items: merged, offsets, top, span: prev.span + block.span }
    }
    blocks.push(block)
  }
  return blocks.map(({ items: list, offsets, top }) => ({ items: list, offsets, top }))
}

export type ActorSide = "left" | "right"

/** Một phương án bố cục: khoảng cách actor ↔ khung, bên đặt từng actor, thứ tự hàng use case. */
export interface LayoutOption {
  gap: number
  /** Thiếu ⇒ quy ước mặc định: actor người trái, actor `system`/`time` phải. */
  sides?: ReadonlyMap<string, ActorSide>
  /** Thứ tự id use case từ trên xuống; thiếu ⇒ `d.rows`. */
  rowOrder?: readonly string[]
}

const defaultSide = (a: DiagramActor): ActorSide => (a.kind === "human" ? "left" : "right")

/** Dựng Scene theo một phương án bố cục. */
const buildScene = (d: UseCaseDiagram, option: LayoutOption): Scene => {
  const { gap } = option
  const sideOf = (a: DiagramActor): ActorSide => option.sides?.get(a.id) ?? defaultSide(a)
  const scene = new Scene()
  const byRowId = new Map(d.rows.map((r) => [r.id, r]))
  const orderedRows = option.rowOrder ? option.rowOrder.map((id) => byRowId.get(id)!) : d.rows
  const rows = orderedRows.map((r) => ({ ...r, lines: wrapLines(r.name || r.id, TEXT_SIZE, MAX_ELLIPSE_TEXT_WIDTH, MAX_ELLIPSE_LINES), cy: 0 }))
  const index = new Map(rows.map((r, i) => [r.id, i]))

  // Một cỡ ellipse cho mọi use case — đó là điều kiện để đỉnh thẳng hàng. Chia √2: hộp chữ nội tiếp ellipse.
  const textW = Math.max(0, ...rows.flatMap((r) => r.lines.map((l) => textWidth(l, TEXT_SIZE))))
  const textH = Math.max(1, ...rows.map((r) => r.lines.length)) * LINE_HEIGHT
  const labelW = d.relations.length > 0 ? Math.max(...(["include", "extend"] as const).map((k) => textWidth(stereotype(k), TEXT_SIZE))) : 0
  // Nhãn quan hệ nằm trong bề rộng cột ⇒ không đoạn association nào (luôn ở ngoài cột) cắt được nhãn
  const rx = Math.max(Math.ceil(textW / 1.41 + 26), d.relations.length > 0 ? Math.ceil(RELATION_LABEL_OFFSET + labelW + 8) : 0)
  const ry = Math.ceil(textH / 1.41 + 22)

  const cx = 0
  const half = Math.max(rx + BOUND_PAD_X, Math.ceil(textWidth(d.system, TITLE_SIZE, true) / 2) + 24)
  rows.forEach((r, i) => (r.cy = BOUND_PAD_TOP + ry + i * (2 * ry + ROW_GAP)))
  const boundBottom = (rows[rows.length - 1]?.cy ?? BOUND_PAD_TOP) + ry + BOUND_PAD_BOTTOM

  const left = d.actors.filter((a) => sideOf(a) === "left")
  const right = d.actors.filter((a) => sideOf(a) === "right")
  const metrics = new Map(d.actors.map((a) => [a.id, figureMetrics(actorLines(a))]))
  const colWidth = (list: DiagramActor[]): number => Math.max(0, ...list.map((a) => metrics.get(a.id)!.width))
  // Generalization (chỉ giữa hai actor bên trái): tầng = số tổ tiên có trên hình; tầng 0 sát khung, con ra ngoài
  const generalizations = (d.generalizations ?? []).filter((g) => left.some((a) => a.id === g.child) && left.some((a) => a.id === g.parent) && g.child !== g.parent)
  const parentOf = new Map(generalizations.map((g) => [g.child, g.parent]))
  const level = (id: string): number => {
    let n = 0
    for (let cur = parentOf.get(id), seen = new Set([id]); cur !== undefined && !seen.has(cur); cur = parentOf.get(cur)) {
      seen.add(cur)
      n++
    }
    return n
  }
  const levels: DiagramActor[][] = []
  for (const a of left) (levels[level(a.id)] ??= []).push(a)
  const levelX: number[] = []
  levels.forEach((list = [], i) => {
    levelX[i] = i === 0 ? -half - gap - colWidth(list) / 2 : levelX[i - 1] - colWidth(levels[i - 1] ?? []) / 2 - GENERALIZATION_COLUMN_GAP - colWidth(list) / 2
  })
  const rightX = half + gap + colWidth(right) / 2

  // Actor ở trung điểm các use case nó nối. Actor chen nhau thì gộp thành khối xếp liền, khối CĂN GIỮA quanh trung
  // bình vị trí mong muốn của các actor trong khối (không chỉ đẩy xuống): nhiều actor cùng nối một use case thì toả đều
  // trên dưới use case đó, đường association của actor ngoài cùng bớt dốc nên không quệt qua chữ actor kề bên.
  const place = (list: DiagramActor[], fallback: (id: string) => number | undefined = () => undefined): Map<string, number> => {
    const want = new Map(
      list.map((a): [string, number] => {
        const ys = d.associations.filter((x) => x.actorId === a.id).map((x) => rows[index.get(x.useCaseId) ?? 0]?.cy ?? BOUND_PAD_TOP)
        // Actor con không còn use case riêng ⇒ đứng ngang actor cha
        if (ys.length === 0 && fallback(a.id) !== undefined) return [a.id, fallback(a.id)!]
        return [a.id, (ys.length > 0 ? (Math.min(...ys) + Math.max(...ys)) / 2 : BOUND_PAD_TOP) - FIGURE.armY]
      })
    )
    const blocks = packBlocks(
      [...list].sort(byIdThen(want)).map((a) => ({ id: a.id, want: want.get(a.id)!, size: metrics.get(a.id)!.height + ACTOR_GAP_Y }))
    )
    return new Map(blocks.flatMap((b) => b.items.map((item, i): [string, number] => [item.id, b.top + b.offsets[i]])))
  }
  const tops = new Map(place(right))
  for (const list of levels) if (list) for (const [id, top] of place(list, (id) => tops.get(parentOf.get(id) ?? ""))) tops.set(id, top)
  const columnX = (a: DiagramActor): number => (sideOf(a) === "left" ? levelX[level(a.id)] : rightX)
  const hand = (a: DiagramActor): [number, number] => [columnX(a) + (sideOf(a) === "left" ? FIGURE.arm / 2 : -FIGURE.arm / 2), tops.get(a.id)! + FIGURE.armY]

  scene.rect("system", -half, 0, 2 * half, boundBottom, { fill: FILL, container: true, name: d.system })
  scene.text("system#name", cx, BOUND_PAD_TOP / 2 + 1, d.system, { size: TITLE_SIZE, bold: true, owner: "system" })

  // Association trước: ellipse vẽ đè đầu mút
  for (const link of d.associations) {
    const actor = d.actors.find((a) => a.id === link.actorId)
    const row = rows[index.get(link.useCaseId) ?? -1]
    if (!actor || !row) throw new Error(`usecase-layout: association ${link.actorId} → ${link.useCaseId} trỏ tới phần tử không có trong hình`)
    const to: [number, number] = [sideOf(actor) === "left" ? cx - rx : cx + rx, row.cy]
    scene.line(`${link.actorId}~${link.useCaseId}`, hand(actor), to, { name: `${actor.name} — ${row.name}` })
  }

  // Generalization kiểu "shared target" của UML, gồm các đoạn thẳng (kind này không cho đường gấp khúc): mỗi actor con
  // một nhánh ngang từ hông hình que sang thanh dọc nằm giữa khe hai cột (tên actor không bao giờ lấn vào khe), thanh dọc
  // gom mọi nhánh về ngang tay actor cha, rồi đoạn thân ngang mang MỘT tam giác rỗng chạm ngay trái tay actor cha.
  const childrenOf = new Map<string, string[]>()
  for (const g of generalizations) childrenOf.set(g.parent, [...(childrenOf.get(g.parent) ?? []), g.child])
  // TechMart 11/11: actor có HAI cha trên hình (Customer → Guest theo file, Customer → User chỉ trên hình) ⇒ mỗi cha một
  // thanh gom lệch nhau trong khe, nhánh của từng cha ở độ cao riêng dưới hông — không đoạn nào chồng lên nhau
  const parentsOfChild = new Map<string, string[]>()
  for (const g of generalizations) parentsOfChild.set(g.child, [...(parentsOfChild.get(g.child) ?? []), g.parent])
  const busSlot = new Map<string, number>()
  for (const parentId of childrenOf.keys()) {
    const sameLevel = [...childrenOf.keys()].filter((id) => level(id) === level(parentId))
    busSlot.set(parentId, sameLevel.indexOf(parentId))
  }
  for (const [parentId, kids] of childrenOf) {
    const parent = d.actors.find((a) => a.id === parentId)!
    const [pl, cl] = [level(parentId), level(parentId) + 1]
    const tip: [number, number] = [columnX(parent) - FIGURE.arm / 2 - GENERALIZATION_PAD, tops.get(parentId)! + FIGURE.armY]
    const childEdge = levelX[cl] + Math.max(FIGURE.arm, colWidth(levels[cl] ?? [])) / 2
    const parentEdge = levelX[pl] - Math.max(FIGURE.arm, colWidth(levels[pl] ?? [])) / 2
    const busX = Math.min((childEdge + parentEdge) / 2, tip[0] - GENERALIZATION_TRUNK) - (busSlot.get(parentId) ?? 0) * GENERALIZATION_BUS_STEP
    const ys = [tip[1]]
    for (const childId of kids) {
      const child = d.actors.find((a) => a.id === childId)!
      const lane = Math.max(0, (parentsOfChild.get(childId) ?? []).indexOf(parentId))
      const hip: [number, number] = [columnX(child), tops.get(childId)! + FIGURE.bodyBottom + lane * GENERALIZATION_STUB_STEP]
      ys.push(hip[1])
      scene.line(`gen:${childId}>${parentId}`, hip, [busX, hip[1]], { name: `${child.name} → ${parent.name}` })
    }
    const [top, bottom] = [Math.min(...ys), Math.max(...ys)]
    if (bottom - top > 0.5) scene.line(`gen:bus>${parentId}`, [busX, top], [busX, bottom], { name: `→ ${parent.name} (thanh gom)` })
    const trunk = `gen:*>${parentId}`
    scene.line(trunk, [busX, tip[1]], tip, { name: `→ ${parent.name}` })
    scene.arrow(trunk, "triangle")
  }

  for (const rel of d.relations) {
    const [from, to] = [rows[index.get(rel.from) ?? -1], rows[index.get(rel.to) ?? -1]]
    if (!from || !to || Math.abs(index.get(rel.from)! - index.get(rel.to)!) !== 1) {
      throw new Error(`usecase-layout: ${rel.kind} ${rel.from} → ${rel.to} phải nối hai use case kề nhau trong hình`)
    }
    const down = to.cy > from.cy
    const [y1, y2] = down ? [from.cy + ry, to.cy - ry] : [from.cy - ry, to.cy + ry]
    const id = `${rel.kind}:${rel.from}>${rel.to}`
    scene.line(id, [cx, y1], [cx, y2], { dashed: true, name: `${from.name} → ${to.name}` })
    scene.arrow(id, "open")
    scene.text(`${id}#label`, cx + RELATION_LABEL_OFFSET, (y1 + y2) / 2, stereotype(rel.kind), { size: TEXT_SIZE, anchor: "start", baseline: "central", owner: id })
  }

  for (const r of rows) {
    const id = `uc:${r.id}`
    scene.ellipse(id, cx, r.cy, rx, ry, { fill: FILL, name: r.name })
    r.lines.forEach((line, i) => scene.text(`${id}#name-${i}`, cx, r.cy + (i - (r.lines.length - 1) / 2) * LINE_HEIGHT, line, { size: TEXT_SIZE, baseline: "central", owner: id }))
  }

  for (const a of d.actors) drawActor(scene, `actor:${a.id}`, a.name, columnX(a), tops.get(a.id)!, metrics.get(a.id)!.lines, a.abstract)
  return scene
}

/**
 * Chia actor người sang hai bên — chỉ có nghĩa khi có ≥ 2 actor người cùng nối một use case (khi đó đường của actor ngoài
 * cùng dốc, dễ quệt chữ actor kề). Actor nhiều use case nhất giữ bên trái (hoà ⇒ id nhỏ), nửa còn lại — ít use case, thường
 * là actor phụ như officer / admin — sang phải; actor `system`/`time` vẫn bên phải. Không cần chia ⇒ `null`.
 */
export const splitSides = (d: UseCaseDiagram): Map<string, ActorSide> | null => {
  // Có generalization trên hình ⇒ mọi actor người bên trái, cạnh kế thừa không băng qua khung hệ thống
  if ((d.generalizations ?? []).length > 0) return null
  const humans = d.actors.filter((a) => a.kind === "human")
  const humanIds = new Set(humans.map((h) => h.id))
  const shared = d.rows.some((r) => d.associations.filter((x) => x.useCaseId === r.id && humanIds.has(x.actorId)).length >= 2)
  if (!shared) return null
  const count = (id: string): number => d.associations.filter((x) => x.actorId === id).length
  const ranked = [...humans].sort((a, b) => count(b.id) - count(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const left = new Set(ranked.slice(0, Math.ceil(ranked.length / 2)).map((a) => a.id))
  return new Map(d.actors.map((a): [string, ActorSide] => [a.id, left.has(a.id) ? "left" : "right"]))
}

/**
 * Thứ tự hàng gom theo actor (barycenter): mỗi khối hàng — một chuỗi include/extend liền nhau, hoặc một use case đơn —
 * xếp theo trung bình chỉ số (trong `d.actors`) của các actor nối tới nó; hoà ⇒ giữ thứ tự cũ. Khối không bị cắt nên hai use
 * case có quan hệ vẫn kề nhau. Trùng thứ tự hiện tại ⇒ `null`.
 */
export const barycenterRows = (d: UseCaseDiagram): string[] | null => {
  const linked = (a: string, b: string): boolean => d.relations.some((r) => (r.from === a && r.to === b) || (r.from === b && r.to === a))
  const blocks: string[][] = []
  for (const row of d.rows) {
    const last = blocks[blocks.length - 1]
    if (last && linked(last[last.length - 1], row.id)) last.push(row.id)
    else blocks.push([row.id])
  }
  const actorIndex = new Map(d.actors.map((a, i) => [a.id, i]))
  const weight = (block: string[]): number => {
    const ix = d.associations.filter((x) => block.includes(x.useCaseId)).map((x) => actorIndex.get(x.actorId) ?? 0)
    return ix.length > 0 ? ix.reduce((sum, i) => sum + i, 0) / ix.length : Infinity
  }
  const order = blocks
    .map((block, i) => ({ block, i, w: weight(block) }))
    .sort((a, b) => a.w - b.w || a.i - b.i)
    .flatMap((b) => b.block)
  return order.every((id, i) => id === d.rows[i].id) ? null : order
}

/**
 * Các phương án bố cục theo thứ tự thử — tất định, rẻ trước. Đứng đầu là cách vẽ cũ (actor người trái, thứ tự hàng sẵn
 * có) với từng khoảng cách ⇒ hình đã sạch theo cách cũ vẽ ra y như cũ. Sau đó thứ tự hàng barycenter, rồi chia actor người
 * hai bên (lệch quy ước người trái / hệ thống phải nên chỉ tới lượt khi mọi phương án giữ quy ước đều không sạch), rồi cả
 * hai. Phương án trùng phương án trước bị bỏ. Trần: 2 × 2 × `ACTOR_BOUNDARY_GAPS.length`.
 */
export const layoutOptions = (d: UseCaseDiagram): LayoutOption[] => {
  const orders: (string[] | undefined)[] = [undefined]
  const order = barycenterRows(d)
  if (order) orders.push(order)
  const sides: (Map<string, ActorSide> | undefined)[] = [undefined]
  const split = splitSides(d)
  if (split) sides.push(split)
  return sides.flatMap((side) => orders.flatMap((rowOrder) => ACTOR_BOUNDARY_GAPS.map((gap): LayoutOption => ({ gap, sides: side, rowOrder }))))
}

/**
 * Scene của một sơ đồ use case: thử các phương án của `layoutOptions` theo thứ tự, dừng ở phương án đầu tiên `checkScene`
 * sạch. Không phương án nào sạch ⇒ trả scene ít issue nhất (hoà ⇒ phương án thử trước); `svgPart` báo `issues` và
 * `usecase.renderer.ts` tách hình.
 */
export const layoutUseCaseDiagram = (d: UseCaseDiagram): Scene => {
  let best: { scene: Scene; issues: number } | null = null
  for (const option of layoutOptions(d)) {
    const scene = buildScene(d, option)
    const issues = checkScene(scene, { allowBends: false }).length
    if (issues === 0) return scene
    if (best === null || issues < best.issues) best = { scene, issues }
  }
  return best!.scene
}

// ─── Sơ đồ phân cấp actor ───────────────────────────────────────────

export interface HierarchyActor {
  id: string
  name: string
  abstract: boolean
}

const HIERARCHY_ROW_PITCH = 170
const HIERARCHY_COLUMN_GAP = 90
/** Đầu mũi tên và gốc đường cách hình que này để không chạm chữ / đầu. */
const HIERARCHY_PAD = 8

/**
 * Scene phân cấp actor (UML generalization): mỗi actor một hình que, actor con nằm dưới actor cha, đường liền một đoạn
 * thẳng từ trên đầu actor con tới dưới tên actor cha, đầu tam giác rỗng ở phía cha. Actor cha nằm giữa các con.
 * `parents`: actor con → actor cha, chỉ cạnh hợp lệ giữa các actor trong `actors`.
 */
export const layoutActorHierarchy = (actors: readonly HierarchyActor[], parents: ReadonlyMap<string, string>): Scene => {
  const scene = new Scene()
  const known = new Map(actors.map((a) => [a.id, a]))
  const children = new Map<string, string[]>()
  for (const [child, parent] of parents) {
    if (known.has(child) && known.has(parent)) children.set(parent, [...(children.get(parent) ?? []), child])
  }
  for (const list of children.values()) list.sort()
  const roots = actors.filter((a) => !(parents.has(a.id) && known.has(parents.get(a.id)!))).map((a) => a.id).sort()
  const metrics = new Map(actors.map((a) => [a.id, figureMetrics(wrapLines(a.name || a.id, TEXT_SIZE, MAX_ACTOR_TEXT_WIDTH, MAX_ACTOR_LINES))]))

  const centre = new Map<string, number>()
  const depth = new Map<string, number>()
  /** Đặt cây gốc `id` từ `left`; trả mép phải của cây. */
  const place = (id: string, left: number, level: number, seen: Set<string>): number => {
    depth.set(id, level)
    const kids = (children.get(id) ?? []).filter((k) => !seen.has(k))
    let right = left
    if (kids.length === 0) {
      right = left + metrics.get(id)!.width
      centre.set(id, left + metrics.get(id)!.width / 2)
      return right
    }
    let cursor = left
    for (const kid of kids) {
      seen.add(kid)
      cursor = place(kid, cursor, level + 1, seen) + HIERARCHY_COLUMN_GAP
    }
    cursor -= HIERARCHY_COLUMN_GAP
    const mid = (centre.get(kids[0])! + centre.get(kids[kids.length - 1])!) / 2
    centre.set(id, mid)
    return Math.max(cursor, mid + metrics.get(id)!.width / 2)
  }
  let cursor = 0
  const seen = new Set<string>(roots)
  for (const root of roots) cursor = place(root, cursor, 0, seen) + HIERARCHY_COLUMN_GAP

  const top = (id: string): number => depth.get(id)! * HIERARCHY_ROW_PITCH
  for (const [parent, kids] of children) {
    for (const kid of kids) {
      if (!centre.has(kid) || !centre.has(parent)) continue
      const id = `gen:${kid}>${parent}`
      const from: [number, number] = [centre.get(kid)!, top(kid) - HIERARCHY_PAD]
      const to: [number, number] = [centre.get(parent)!, top(parent) + metrics.get(parent)!.height + HIERARCHY_PAD]
      scene.line(id, from, to, { name: `${known.get(kid)!.name} → ${known.get(parent)!.name}` })
      scene.arrow(id, "triangle")
    }
  }
  for (const a of actors) {
    if (centre.has(a.id)) drawActor(scene, `actor:${a.id}`, a.name, centre.get(a.id)!, top(a.id), metrics.get(a.id)!.lines, a.abstract)
  }
  return scene
}
