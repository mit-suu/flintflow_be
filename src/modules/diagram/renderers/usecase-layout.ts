/**
 * Hình học sơ đồ use case (UML 2.5.1) và sơ đồ phân cấp actor — port từ `docs/technical/usecase-diagram-layout.md`
 * §2–§7 (bản chạy được ở `docs/diagrams/usecase/build-diagrams.mjs`). Đơn vị px, trục y hướng xuống (khớp `Scene`).
 *
 * Ba cột: actor người bên trái, khung hệ thống ở giữa chứa một cột ellipse, actor `system`/`time` bên phải; cả hai cột
 * actor nằm NGOÀI khung. Hai bất biến làm mọi association là MỘT đoạn thẳng không cắt ellipse nào:
 * - mọi ellipse cùng `rx`, `ry`, cùng `cx` ⇒ đỉnh trái / phải của chúng thẳng hàng dọc;
 * - association nối bàn tay actor tới đỉnh trái (actor trái) hoặc đỉnh phải (actor phải) của ellipse đích. Một đoạn
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
export interface UseCaseDiagram {
  system: string
  /** Thứ tự dọc từ trên xuống. */
  rows: UseCaseRow[]
  actors: DiagramActor[]
  associations: Association[]
  relations: Relation[]
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

/** Dựng Scene với khoảng cách actor ↔ khung `gap`. */
const buildScene = (d: UseCaseDiagram, gap: number): Scene => {
  const scene = new Scene()
  const rows = d.rows.map((r) => ({ ...r, lines: wrapLines(r.name || r.id, TEXT_SIZE, MAX_ELLIPSE_TEXT_WIDTH, MAX_ELLIPSE_LINES), cy: 0 }))
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

  const left = d.actors.filter((a) => a.kind === "human")
  const right = d.actors.filter((a) => a.kind !== "human")
  const metrics = new Map(d.actors.map((a) => [a.id, figureMetrics(actorLines(a))]))
  const colWidth = (list: DiagramActor[]): number => Math.max(0, ...list.map((a) => metrics.get(a.id)!.width))
  const leftX = -half - gap - colWidth(left) / 2
  const rightX = half + gap + colWidth(right) / 2

  // Actor ở trung điểm các use case nó nối, rồi đẩy xuống để chữ không dính nhau
  const place = (list: DiagramActor[]): Map<string, number> => {
    const want = new Map(
      list.map((a): [string, number] => {
        const ys = d.associations.filter((x) => x.actorId === a.id).map((x) => rows[index.get(x.useCaseId) ?? 0]?.cy ?? BOUND_PAD_TOP)
        return [a.id, (ys.length > 0 ? (Math.min(...ys) + Math.max(...ys)) / 2 : BOUND_PAD_TOP) - FIGURE.armY]
      })
    )
    const tops = new Map<string, number>()
    let floor = -Infinity
    for (const a of [...list].sort(byIdThen(want))) {
      const top = Math.max(want.get(a.id)!, floor)
      tops.set(a.id, top)
      floor = top + metrics.get(a.id)!.height + ACTOR_GAP_Y
    }
    return tops
  }
  const tops = new Map([...place(left), ...place(right)])
  const columnX = (a: DiagramActor): number => (a.kind === "human" ? leftX : rightX)
  const hand = (a: DiagramActor): [number, number] => [columnX(a) + (a.kind === "human" ? FIGURE.arm / 2 : -FIGURE.arm / 2), tops.get(a.id)! + FIGURE.armY]

  scene.rect("system", -half, 0, 2 * half, boundBottom, { fill: FILL, container: true, name: d.system })
  scene.text("system#name", cx, BOUND_PAD_TOP / 2 + 1, d.system, { size: TITLE_SIZE, bold: true, owner: "system" })

  // Association trước: ellipse vẽ đè đầu mút
  for (const link of d.associations) {
    const actor = d.actors.find((a) => a.id === link.actorId)
    const row = rows[index.get(link.useCaseId) ?? -1]
    if (!actor || !row) throw new Error(`usecase-layout: association ${link.actorId} → ${link.useCaseId} trỏ tới phần tử không có trong hình`)
    const to: [number, number] = [actor.kind === "human" ? cx - rx : cx + rx, row.cy]
    scene.line(`${link.actorId}~${link.useCaseId}`, hand(actor), to, { name: `${actor.name} — ${row.name}` })
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
 * Scene của một sơ đồ use case. Khoảng cách actor ↔ khung tăng dần tới khi `checkScene` sạch: đường association thoải
 * hơn thì không quệt qua chữ / hình actor khác. Hết cỡ mà còn lỗi ⇒ trả bản cuối, `svgPart` báo `issues`.
 */
export const layoutUseCaseDiagram = (d: UseCaseDiagram): Scene => {
  let scene = buildScene(d, ACTOR_BOUNDARY_GAPS[0])
  for (const gap of ACTOR_BOUNDARY_GAPS) {
    scene = buildScene(d, gap)
    if (checkScene(scene, { allowBends: false }).length === 0) break
  }
  return scene
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
