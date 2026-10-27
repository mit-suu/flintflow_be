import { describe, expect, it } from "vitest"
import { checkScene } from "./svg-geometry.js"
import { textWidth, type Point } from "./svg-kit.js"
import { Scene } from "./svg-scene.js"

const rules = (scene: Scene, allowBends = false) => checkScene(scene, { allowBends }).map((i) => i.rule)

describe("luật 1 — một đoạn thẳng, gấp khúc vuông góc khi kind cho phép", () => {
  const bent = (points: Point[]) => {
    const scene = new Scene()
    scene.polyline("L", points, { name: "places" })
    return scene
  }

  it("đoạn thẳng xiên ⇒ hợp lệ", () => {
    const scene = new Scene()
    scene.line("L", [0, 0], [100, 37])
    expect(rules(scene)).toEqual([])
  })

  it("allowBends: false từ chối polyline", () => {
    const issues = checkScene(bent([[0, 0], [100, 0], [100, 80]]), { allowBends: false })
    expect(issues).toMatchObject([{ rule: "bend", ids: ["L"] }])
    expect(issues[0].message).toContain(`"places"`)
  })

  it("allowBends: true nhận polyline vuông góc, từ chối polyline xiên", () => {
    expect(rules(bent([[0, 0], [100, 0.3], [100, 80]]), true)).toEqual([])
    expect(rules(bent([[0, 0], [100, 20], [100, 80]]), true)).toEqual(["bend"])
  })
})

describe("luật 2 — chữ không đè chữ / hình", () => {
  it("hai chữ chồng ⇒ text_overlap; cách nhau ⇒ sạch", () => {
    const scene = new Scene()
    scene.text("A", 0, 0, "Customer", { anchor: "start" })
    scene.text("B", 30, 4, "Order", { anchor: "start" })
    expect(rules(scene)).toEqual(["text_overlap"])
    const clean = new Scene()
    clean.text("A", 0, 0, "Customer", { anchor: "start" })
    clean.text("B", 0, 30, "Order", { anchor: "start" })
    expect(rules(clean)).toEqual([])
  })

  it("chữ đè hình không phải chủ ⇒ lỗi; chữ trong hình chủ ⇒ sạch", () => {
    const scene = new Scene()
    scene.rect("E1", 0, 0, 120, 50, { name: "Order" })
    scene.text("E1.name", 60, 30, "Order", { owner: "E1" })
    expect(rules(scene)).toEqual([])
    scene.rect("E2", 70, 10, 120, 50, { name: "Invoice" })
    expect(checkScene(scene, { allowBends: false })).toMatchObject([{ rule: "text_overlap", ids: ["E1.name", "E2"] }])
  })

  it("hình chứa (boundary): chữ bên trong sạch, chữ cắt viền ⇒ lỗi", () => {
    const scene = new Scene()
    scene.rect("B", 0, 0, 400, 300, { container: true, name: "System" })
    scene.ellipse("U1", 200, 150, 80, 30, { name: "Place Order" })
    scene.text("U1.name", 200, 155, "Place Order", { owner: "U1" })
    expect(rules(scene)).toEqual([])
    scene.text("T", 400, 100, "Outside")
    expect(rules(scene)).toEqual(["text_overlap"])
  })

  it("đầu mũi tên của đường khác che chữ ⇒ lỗi", () => {
    const scene = new Scene()
    scene.text("T", 100, 50, "Label")
    scene.line("L", [100, 0], [100, 50])
    scene.arrow("L", "classic")
    expect(rules(scene)).toContain("text_overlap")
  })
})

describe("luật 2b — chữ thuộc hình nằm trọn trong hình", () => {
  it("tên đậm tràn hộp ⇒ text_overflow", () => {
    const scene = new Scene()
    scene.rect("E", 0, 0, 60, 40, { name: "Administrator" })
    scene.text("E.name", 30, 25, "Administrator", { owner: "E", bold: true, size: 15 })
    expect(checkScene(scene, { allowBends: false })).toMatchObject([{ rule: "text_overflow", ids: ["E.name", "E"] }])
  })

  it("chữ vừa hộp / hình tròn ⇒ sạch", () => {
    const scene = new Scene()
    const w = textWidth("Administrator", 15, true) + 30
    scene.rect("E", 0, 0, w, 54)
    scene.text("E.name", w / 2, 32, "Administrator", { owner: "E", bold: true, size: 15 })
    scene.circle("P", 400, 200, 150)
    scene.text("P.name", 400, 205, "FlintFlow System", { owner: "P", bold: true, size: 15 })
    expect(rules(scene)).toEqual([])
  })
})

describe("luật 3 — đường không cắt qua chữ", () => {
  it("đường cắt chữ ⇒ line_over_text; nhãn của chính nó ⇒ sạch", () => {
    const scene = new Scene()
    scene.line("L", [0, 0], [200, 0], { name: "submits" })
    scene.label("L", "submits")
    expect(rules(scene)).toEqual([])
    scene.text("T", 150, 4, "other")
    expect(rules(scene)).toContain("line_over_text")
  })

  it("nhãn của đường khác nằm trên đường ⇒ lỗi", () => {
    const scene = new Scene()
    scene.line("A", [0, 0], [200, 0])
    scene.label("A", "flow A")
    scene.line("B", [100, -50], [100, 50])
    expect(rules(scene)).toEqual(expect.arrayContaining(["line_over_text"]))
  })
})

describe("luật 4 — hai đoạn không chồng nhau", () => {
  it("hai đường trùng phương, sát nhau ⇒ line_overlap", () => {
    const scene = new Scene()
    scene.line("A", [0, 0], [100, 0])
    scene.line("B", [50, 0.5], [150, 0.5])
    expect(rules(scene)).toEqual(["line_overlap"])
  })

  it("song song cách 22px, hoặc chỉ chạm đầu mút ⇒ sạch", () => {
    const scene = new Scene()
    scene.line("A", [0, 0], [100, 0])
    scene.line("B", [0, 22], [100, 22])
    scene.line("C", [100, 0], [200, 0.5])
    expect(rules(scene)).toEqual([])
  })

  it("đoạn kề quay ngược trên chính nó ⇒ line_overlap; đoạn dài lệch góc nhỏ, xa dần ⇒ không chồng", () => {
    const retrace = new Scene()
    retrace.polyline("L", [[0, 0], [100, 0], [50, 0]])
    expect(rules(retrace, true)).toEqual(["line_overlap"])
    const drift = new Scene()
    drift.line("A", [0, 0], [1000, 0])
    drift.line("B", [0, 0.5], [1000, 9])
    expect(rules(drift)).toEqual([])
  })

  it("polyline tự quay lại trên chính nó ⇒ line_overlap", () => {
    const scene = new Scene()
    scene.polyline("L", [[0, 0], [100, 0], [100, 20], [100, 20], [50, 0]])
    expect(rules(scene, true)).toContain("bend")
    const back = new Scene()
    back.polyline("L", [[0, 0], [100, 0], [100, 10], [100, 0], [40, 0]])
    expect(rules(back, true)).toContain("line_overlap")
  })
})

describe("luật 5 — đường không xuyên hình", () => {
  it("đường chạm viền hai đầu ⇒ sạch; xuyên hộp thứ ba ⇒ line_through_shape", () => {
    const scene = new Scene()
    scene.rect("A", 0, 0, 50, 50)
    scene.rect("B", 300, 0, 50, 50)
    scene.line("L", [50, 25], [300, 25])
    scene.arrow("L", "open")
    expect(rules(scene)).toEqual([])
    scene.circle("C", 175, 25, 30, { name: "Middle" })
    const issues = checkScene(scene, { allowBends: false })
    expect(issues).toMatchObject([{ rule: "line_through_shape", ids: ["L", "C"] }])
    expect(issues[0].message).toContain(`"Middle"`)
  })

  it("đường đi xuyên boundary (container) ⇒ sạch", () => {
    const scene = new Scene()
    scene.rect("B", 100, 0, 300, 200, { container: true })
    scene.line("L", [0, 100], [250, 100])
    expect(rules(scene)).toEqual([])
  })
})

// ─── fixture thật: mẫu context của docs/diagram_guideline/context ──────────────

type Flow = { label: string; dir: "in" | "out" }
type Entity = { name: string; flows: Flow[] }

/** Dữ liệu `docs/diagram_guideline/context/example-flintflow.data.mjs`. */
const EXAMPLE: { title: string; process: string; left: Entity[]; right: Entity[] } = {
  title: "Context Diagram — FlintFlow",
  process: "FlintFlow System",
  left: [
    { name: "Guest", flows: [{ label: "Registration Details", dir: "in" }, { label: "Login Credentials", dir: "in" }, { label: "OTP / Reset Code", dir: "in" }] },
    {
      name: "Analyst",
      flows: [
        { label: "SRS File / Template", dir: "in" },
        { label: "Raw Documents", dir: "in" },
        { label: "Chat Instructions", dir: "in" },
        { label: "Review Decisions", dir: "in" },
        { label: "AI Questions", dir: "out" },
        { label: "Requirement List", dir: "out" },
        { label: "SRS Draft + Flags", dir: "out" }
      ]
    },
    {
      name: "Lead",
      flows: [
        { label: "Approval Decision", dir: "in" },
        { label: "Member Invitation", dir: "in" },
        { label: "Purchase Order", dir: "in" },
        { label: "Review Package", dir: "out" },
        { label: "Top-up Notice", dir: "out" }
      ]
    },
    { name: "Viewer", flows: [{ label: "Comments", dir: "in" }, { label: "Released SRS", dir: "out" }] },
    { name: "Administrator", flows: [{ label: "Account Status Change", dir: "in" }, { label: "Credit Adjustment", dir: "in" }, { label: "Usage and Cost Report", dir: "out" }] }
  ],
  right: [
    { name: "Identity Provider", flows: [{ label: "Authentication Request", dir: "out" }, { label: "Verified Identity", dir: "in" }] },
    { name: "LLM Provider", flows: [{ label: "Prompt + Project Context", dir: "out" }, { label: "AI Response", dir: "in" }] },
    { name: "Email Service", flows: [{ label: "OTP / Invitation Email", dir: "out" }] },
    { name: "Payment Gateway", flows: [{ label: "Payment Request", dir: "out" }, { label: "Payment Result", dir: "in" }] }
  ]
}

/** Hình học của `build-context-diagram.mjs`, dựng qua `Scene`. */
const buildContext = (data: typeof EXAMPLE): Scene => {
  const R = 150, RING_X = 560, RING_Y = 360, ENT_H = 54, FLOW_GAP = 22, BUNDLE_GAP = 24, SPAN = 70, MARGIN = 30, TOP = 60
  const anglesFor = (entities: Entity[], side: "left" | "right"): number[] => {
    const base = side === "left" ? 180 : 0
    if (entities.length === 1) return [(base * Math.PI) / 180]
    const width = entities.map((e) => (e.flows.length - 1) * FLOW_GAP)
    const need = width.slice(1).map((w, i) => (((w + width[i]) / 2 + BUNDLE_GAP) / R) * (180 / Math.PI))
    const total = need.reduce((a, b) => a + b, 0)
    const gaps = total < 2 * SPAN ? need.map((g) => g + (2 * SPAN - total) / need.length) : need
    let t = -gaps.reduce((a, b) => a + b, 0) / 2
    return entities.map((_, i) => {
      if (i > 0) t += gaps[i - 1]
      return ((side === "left" ? base - t : base + t) * Math.PI) / 180
    })
  }
  const rayIntoBox = ([px, py]: Point, [ux, uy]: Point, box: { x: number; y: number; w: number; h: number }) => {
    const tx = ux === 0 ? [-Infinity, Infinity] : [(box.x - px) / ux, (box.x + box.w - px) / ux].sort((a, b) => a - b)
    const ty = uy === 0 ? [-Infinity, Infinity] : [(box.y - py) / uy, (box.y + box.h - py) / uy].sort((a, b) => a - b)
    return Math.max(tx[0], ty[0])
  }

  const entities = [
    ...data.left.map((e, i, a) => ({ ...e, angle: anglesFor(a, "left")[i] })),
    ...data.right.map((e, i, a) => ({ ...e, angle: anglesFor(a, "right")[i] }))
  ]
  const entW = Math.ceil(Math.max(150, ...entities.map((e) => textWidth(e.name, 15))) + 30)
  const cx = MARGIN + entW + RING_X - entW / 2
  const cy = TOP + RING_Y + ENT_H / 2 + 10
  const scene = new Scene()
  const width = Math.ceil(cx + RING_X + entW / 2 + MARGIN)
  scene.text("title", width / 2, 34, data.title, { size: 18, bold: true })

  entities.forEach((e, ei) => {
    const ex = cx + RING_X * Math.cos(e.angle)
    const ey = cy + RING_Y * Math.sin(e.angle)
    const h = Math.max(ENT_H, (e.flows.length - 1) * FLOW_GAP + 28)
    const box = { x: ex - entW / 2, y: ey - h / 2, w: entW, h }
    const len = Math.hypot(ex - cx, ey - cy)
    const u: Point = [(ex - cx) / len, (ey - cy) / len]
    const p: Point = [-u[1], u[0]]
    e.flows.forEach((f, k) => {
      const o = (k - (e.flows.length - 1) / 2) * FLOW_GAP
      const base: Point = [cx + p[0] * o, cy + p[1] * o]
      const tc = Math.sqrt(R * R - o * o)
      const onCircle: Point = [base[0] + u[0] * tc, base[1] + u[1] * tc]
      const tb = rayIntoBox(base, u, box)
      const onBox: Point = [base[0] + u[0] * tb, base[1] + u[1] * tb]
      const id = `E${ei}.F${k}`
      scene.line(id, f.dir === "in" ? onBox : onCircle, f.dir === "in" ? onCircle : onBox, { name: f.label })
      scene.arrow(id, "classic")
      scene.label(id, f.label)
    })
    scene.rect(`E${ei}`, box.x, box.y, entW, h, { name: e.name })
    scene.text(`E${ei}.name`, ex, ey + 5, e.name, { size: 15, bold: true, owner: `E${ei}` })
  })
  scene.circle("P", cx, cy, R, { name: data.process })
  scene.text("P.name", cx, cy + 5, data.process, { size: 15, bold: true, owner: "P" })
  return scene
}

describe("fixture thật — mẫu context của guideline", () => {
  it("dựng qua Scene ⇒ 0 issue", () => {
    expect(checkScene(buildContext(EXAMPLE), { allowBends: false })).toEqual([])
  })

  it("nhãn quá dài đè nhãn bên cạnh ⇒ bộ kiểm bắt, message nêu tên luồng", () => {
    const data = structuredClone(EXAMPLE)
    data.left[1].flows[0].label = "An extremely long data flow label that cannot possibly fit between the circle and the box"
    const issues = checkScene(buildContext(data), { allowBends: false })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.message.includes("An extremely long data flow label"))).toBe(true)
  })
})
