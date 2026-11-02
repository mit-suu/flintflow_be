import { describe, expect, it } from "vitest"
import { checkScene } from "../../../shared/diagram/svg-geometry.js"
import type { Scene, SceneElement } from "../../../shared/diagram/svg-scene.js"
import { layoutStateMachine, type StateInput, type StateMachineInput } from "./state-machine-layout.js"

const st = (id: string, name: string, extra: Partial<StateInput> = {}): StateInput => ({ id, name, initial: false, final: false, internal: [], ...extra })
const tr = (from: string, to: string, text: string) => ({ from, to, text })

const CHANGE_REQUEST: StateMachineInput = {
  states: [
    st("D", "Draft", { initial: true, internal: ["edit / save draft"] }),
    st("S", "Submitted"),
    st("A", "Approved"),
    st("R", "Rejected"),
    st("P", "Applied", { final: true }),
    st("X", "Cancelled", { final: true })
  ],
  transitions: [
    tr("D", "S", "submit [all fields valid]"),
    tr("S", "A", "approve [reviewer is lead]"),
    tr("S", "R", "reject / notify author"),
    tr("R", "D", "revise"),
    tr("D", "S", "resubmit"),
    tr("A", "P", "apply / write baseline"),
    tr("S", "D", "withdraw"),
    tr("D", "X", "cancel")
  ]
}

const scene = (input: StateMachineInput): Scene => {
  const s = layoutStateMachine(input)
  expect(s, "layout").not.toBeNull()
  expect(checkScene(s!, { allowBends: false })).toEqual([])
  return s!
}

const connectors = (s: Scene) => s.elements.filter((e): e is Extract<SceneElement, { type: "path" }> => e.role === "connector" && e.type === "path")
const el = (s: Scene, id: string): SceneElement => {
  const found = s.find(id)
  expect(found, id).toBeDefined()
  return found!
}

const cross = (o: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
/** Số cặp đường cắt nhau thật (không tính chung đầu mút). */
const crossings = (s: Scene): number => {
  const lines = connectors(s)
  let n = 0
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const [a, b] = lines[i].points
      const [c, d] = lines[j].points
      const shared = [a, b].some((p) => [c, d].some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1))
      if (!shared && cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) n++
    }
  return n
}

describe("state-machine-layout — ký pháp UML", () => {
  it("initial là chấm đặc, final là bullseye (vòng + lõi đặc), state là chữ nhật bo góc", () => {
    const s = scene(CHANGE_REQUEST)
    expect(el(s, "I")).toMatchObject({ type: "ellipse", fill: "#000", rx: 9, ry: 9 })
    for (const id of ["F:P", "F:X"]) {
      expect(el(s, id)).toMatchObject({ type: "ellipse", fill: "#fff", rx: 12 })
      expect(el(s, `${id}#core`)).toMatchObject({ type: "ellipse", fill: "#000", rx: 7 })
    }
    expect(s.find("F:D")).toBeUndefined()
    for (const id of ["S:D", "S:S", "S:A", "S:R", "S:P", "S:X"]) expect(el(s, id)).toMatchObject({ type: "rect", fill: "#7ACFF5", radius: 12 })
  })

  it("mọi transition là MỘT đoạn thẳng (không gấp khúc), mũi tên hở ở đích", () => {
    const s = scene(CHANGE_REQUEST)
    const lines = connectors(s)
    // 8 transition + 1 initial + 2 final
    expect(lines).toHaveLength(11)
    for (const line of lines) {
      expect(line.points, line.id).toHaveLength(2)
      const head = el(s, `${line.id}#end`)
      expect(head).toMatchObject({ type: "path", closed: false, fill: "none" })
    }
  })

  it("nhãn `event [guard] / action` có mặt trên đúng đường; đường initial / final không nhãn", () => {
    const s = scene(CHANGE_REQUEST)
    expect(el(s, "T:S>A#label")).toMatchObject({ type: "text", text: "approve [reviewer is lead]", owner: "T:S>A" })
    expect(el(s, "T:A>P#label")).toMatchObject({ text: "apply / write baseline" })
    expect(s.find("START#label")).toBeUndefined()
    expect(s.find("END:P#label")).toBeUndefined()
  })

  it("chiều mũi tên đúng: đầu mũi tên nằm sát state đích", () => {
    const s = scene(CHANGE_REQUEST)
    const line = connectors(s).find((l) => l.id === "T:S>A")!
    const head = el(s, "T:S>A#end") as Extract<SceneElement, { type: "path" }>
    const tip = head.points[1]
    expect(tip).toEqual(line.points[1])
    const a = el(s, "S:A") as Extract<SceneElement, { type: "rect" }>
    expect(tip[0]).toBeGreaterThanOrEqual(a.x - 0.01)
    expect(tip[0]).toBeLessThanOrEqual(a.x + a.w + 0.01)
    expect(tip[1]).toBeGreaterThanOrEqual(a.y - 0.01)
    expect(tip[1]).toBeLessThanOrEqual(a.y + a.h + 0.01)
  })
})

describe("state-machine-layout — transition giữa cùng một cặp state", () => {
  const PAIR: StateMachineInput = {
    states: [st("A", "Open", { initial: true }), st("B", "Closed")],
    transitions: [tr("A", "B", "close"), tr("B", "A", "reopen [within 30 days]"), tr("A", "B", "auto close / archive")]
  }

  it("ba đoạn giữa hai state là ba đoạn song song lệch nhau, không chồng", () => {
    const s = scene(PAIR)
    const pair = connectors(s).filter((l) => l.id.startsWith("T:"))
    expect(pair).toHaveLength(3)
    const dir = (l: (typeof pair)[number]) => {
      const [a, b] = l.points
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      return [(b[0] - a[0]) / len, (b[1] - a[1]) / len] as const
    }
    const base = dir(pair[0])
    for (const l of pair) {
      const d = dir(l)
      expect(Math.abs(d[0] * base[1] - d[1] * base[0]), l.id).toBeLessThan(0.01)
    }
    // khoảng cách vuông góc giữa các đoạn ≥ 20px
    const offset = (l: (typeof pair)[number]) => -base[1] * l.points[0][0] + base[0] * l.points[0][1]
    const offs = pair.map(offset).sort((a, b) => a - b)
    expect(offs[1] - offs[0]).toBeGreaterThanOrEqual(20)
    expect(offs[2] - offs[1]).toBeGreaterThanOrEqual(20)
    expect(crossings(s)).toBe(0)
  })

  it("hai transition ngược chiều có mũi tên ở hai đầu khác nhau", () => {
    const s = scene({ states: PAIR.states, transitions: [tr("A", "B", "close"), tr("B", "A", "reopen")] })
    const ab = connectors(s).find((l) => l.id === "T:A>B")!
    const ba = connectors(s).find((l) => l.id === "T:B>A")!
    expect(ab.points[1][0] === ba.points[1][0] && ab.points[1][1] === ba.points[1][1]).toBe(false)
    expect(crossings(s)).toBe(0)
  })
})

describe("state-machine-layout — internal transition (self-transition)", () => {
  it("không vẽ đường; chữ nằm trong ngăn dưới của state, có đường chia ngăn, state cao hơn state thường", () => {
    const s = scene(CHANGE_REQUEST)
    expect(s.find("T:D>D")).toBeUndefined()
    const draft = el(s, "S:D") as Extract<SceneElement, { type: "rect" }>
    const plain = el(s, "S:S") as Extract<SceneElement, { type: "rect" }>
    expect(draft.h).toBeGreaterThan((el(s, "S:A") as Extract<SceneElement, { type: "rect" }>).h)
    expect(el(s, "S:D#internal-0")).toMatchObject({ type: "text", text: "edit / save draft", owner: "S:D", anchor: "start" })
    expect(el(s, "S:D#divider")).toMatchObject({ role: "decoration", owner: "S:D" })
  })

  it("nhiều internal transition, nhãn dài được gói dòng và vẫn nằm trong state", () => {
    const input: StateMachineInput = {
      states: [
        st("A", "Active", {
          initial: true,
          internal: ["update profile / save profile", "receive notification [notifications enabled] / append to the inbox and refresh the unread counter in the header"]
        }),
        st("B", "Closed", { final: true })
      ],
      transitions: [tr("A", "B", "close")]
    }
    const s = scene(input)
    const lines = s.elements.filter((e) => e.id.startsWith("S:A#internal-"))
    expect(lines.length).toBeGreaterThanOrEqual(3)
  })
})

describe("state-machine-layout — ca biên", () => {
  it("không có state ⇒ null", () => {
    expect(layoutStateMachine({ states: [], transitions: [] })).toBeNull()
  })

  it("một state vừa initial vừa final", () => {
    const s = scene({ states: [st("A", "Settled", { initial: true, final: true })], transitions: [] })
    expect(connectors(s).map((l) => l.id).sort()).toEqual(["END:A", "START"])
  })

  it("state không tới được từ initial vẫn được vẽ", () => {
    const s = scene({ states: [st("A", "Open", { initial: true }), st("B", "Orphaned")], transitions: [tr("A", "A", "touch")] })
    expect(el(s, "S:B")).toBeDefined()
  })

  it("nhiều final: mỗi state final một bullseye riêng", () => {
    const input: StateMachineInput = {
      states: [st("A", "Open", { initial: true }), st("B", "Won", { final: true }), st("C", "Lost", { final: true }), st("D", "Withdrawn", { final: true }), st("E", "Expired", { final: true })],
      transitions: [tr("A", "B", "win"), tr("A", "C", "lose"), tr("A", "D", "withdraw"), tr("A", "E", "expire [no activity for 30 days]")]
    }
    const s = scene(input)
    expect(s.elements.filter((e) => /^F:[BCDE]$/.test(e.id))).toHaveLength(4)
  })

  it("hơn 10 state: chuỗi có đường quay lui và hai chiều, checkScene rỗng", () => {
    const ids = Array.from({ length: 14 }, (_, i) => `N${String(i + 1).padStart(2, "0")}`)
    const input: StateMachineInput = {
      states: ids.map((id, i) => st(id, `Stage ${i + 1}`, { initial: i === 0, final: i === ids.length - 1 })),
      transitions: [
        ...ids.slice(1).map((id, i) => tr(ids[i], id, `advance ${i + 1}`)),
        tr("N05", "N03", "send back [rework needed]"),
        tr("N08", "N06", "return"),
        tr("N06", "N08", "forward [checks passed] / log"),
        tr("N02", "N12", "fast track")
      ]
    }
    const s = scene(input)
    for (const l of connectors(s)) expect(l.points).toHaveLength(2)
  })

  it("guard và action rất dài: nhãn nhiều dòng, không đè state / đường", () => {
    const long = "approve [the reviewer holds the lead role and every open comment of the change request is resolved] / notify the author, write the audit entry and refresh the dashboard counters"
    const s = scene({ states: [st("A", "Submitted", { initial: true }), st("B", "Approved", { final: true })], transitions: [tr("A", "B", long)] })
    expect(s.elements.filter((e) => e.id.startsWith("T:A>B#label") && e.type === "text").length).toBeGreaterThanOrEqual(2)
  })

  it("tên state dài được gói dòng trong state", () => {
    const s = scene({ states: [st("A", "Awaiting confirmation from the second approver", { initial: true }), st("B", "Done", { final: true })], transitions: [tr("A", "B", "confirm")] })
    expect(s.elements.filter((e) => e.id.startsWith("S:A#name-")).length).toBeGreaterThanOrEqual(2)
  })

  it("tất định: hai lần vẽ cho cùng markup", () => {
    expect(layoutStateMachine(CHANGE_REQUEST)!.toSvg("t")).toBe(layoutStateMachine(CHANGE_REQUEST)!.toSvg("t"))
  })
})

describe("state-machine-layout — không có hai đường cắt nhau (tiêu chí riêng ngoài checkScene)", () => {
  const cases: Record<string, StateMachineInput> = {
    "vòng đời tuyến tính": {
      states: [st("A", "Draft", { initial: true }), st("B", "Submitted"), st("C", "Approved"), st("D", "Published", { final: true })],
      transitions: [tr("A", "B", "submit"), tr("B", "C", "approve"), tr("C", "D", "publish")]
    },
    "rẽ nhánh hai kết thúc": {
      states: [st("A", "Pending", { initial: true }), st("B", "Accepted", { final: true }), st("C", "Expired", { final: true })],
      transitions: [tr("A", "B", "accept"), tr("A", "C", "expire [after 7 days]")]
    },
    "quay lui về đầu": {
      states: [st("A", "Draft", { initial: true }), st("B", "Submitted"), st("C", "Rejected"), st("D", "Approved", { final: true })],
      transitions: [tr("A", "B", "submit"), tr("B", "C", "reject"), tr("C", "A", "revise"), tr("B", "D", "approve")]
    }
  }
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => expect(crossings(scene(input))).toBe(0))
  }

  it("vòng đời Change Request: không đoạn nào cắt nhau", () => {
    expect(crossings(scene(CHANGE_REQUEST))).toBe(0)
  })
})
