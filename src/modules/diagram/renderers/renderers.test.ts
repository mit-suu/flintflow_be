import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import { VIETNAMESE_DIACRITICS } from "../../spine/deterministic-check.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import { allTargets, layoutOwners, renderKind } from "./index.js"
import { saltCell } from "./screen-layout.renderer.js"
import { DEFAULT_IN, DEFAULT_OUT, contextActors, titleCase } from "./context.renderer.js"
import { buildContextLayout } from "./context-layout.js"
import { DIAGRAM_LABELS } from "./labels.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)
const mutate = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const only = (spine: Spine, kind: Parameters<typeof renderKind>[1], owner: string | null = null) => {
  const parts = renderKind(spine, kind, owner)
  expect(parts).toHaveLength(1)
  return parts[0]
}
const withoutFlows = (s: Spine) =>
  s.actors.forEach((a) => {
    delete a.flows_in
    delete a.flows_out
  })

describe("renderers trên fixture 19 màn", () => {
  it("5 hình cố định (class tính một target) + wireframe cho 5 màn signed_off", () => {
    expect(layoutOwners(FIXTURE)).toEqual(["S01", "S05", "S07", "S09", "S10"])
    expect(allTargets(FIXTURE)).toHaveLength(11)
  })

  it("mọi hình: mở/đóng đúng, không dấu tiếng Việt, ổn định giữa hai lần gọi (snapshot)", () => {
    for (const target of allTargets(FIXTURE)) {
      const rendered = renderKind(FIXTURE, target.kind, target.owner_id)
      for (const [index, part] of rendered.entries()) {
        const [open, close] =
          part.format === "svg"
            ? ["<?xml", "</svg>"]
            : part.kind === "screen_layout"
              ? ["@startsalt", "@endsalt"]
              : part.kind === "screen_flow"
                ? ["@startdot", "@enddot"]
                : ["@startuml", "@enduml"]
        expect(part.source.startsWith(open), part.kind).toBe(true)
        expect(part.source.endsWith(`${close}\n`), part.kind).toBe(true)
        expect(VIETNAMESE_DIACRITICS.test(part.source), part.kind).toBe(false)
        expect(renderKind(FIXTURE, target.kind, target.owner_id)[index].source).toBe(part.source)
        const owner = part.owner_id ? `@${part.owner_id}` : ""
        expect(part.source).toMatchSnapshot(`${part.kind}${owner}${rendered.length > 1 ? ` part ${index + 1}` : ""}`)
      }
    }
  })

  it("context: SVG — một hình tròn, mỗi actor một hộp, mỗi luồng một đoạn thẳng có đầu mũi tên và một nhãn", () => {
    const part = only(FIXTURE, "context")
    const svg = part.source
    expect(part.section).toBe("fixed:1")
    expect(part.format).toBe("svg")
    expect(part.issues).toEqual([])
    expect(svg).not.toContain("@startdot")
    expect(svg).toContain(">FlintFlow<")
    // Không tiêu đề; đúng một vòng tròn; mỗi actor một hộp #7ACFF5 (cộng một hình tròn cùng màu)
    expect(svg).not.toContain("<title>")
    expect(svg.match(/<circle /g)).toHaveLength(1)
    expect(svg.match(/<rect [^>]*fill="#7ACFF5"/g)).toHaveLength(FIXTURE.actors.length)
    const flows = FIXTURE.actors.reduce((n, a) => n + (a.flows_in ?? []).length + (a.flows_out ?? []).length, 0)
    expect(svg.match(/<line /g)).toHaveLength(flows)
    expect(svg.match(/<polygon /g)).toHaveLength(flows)
    expect(svg).not.toContain("stroke-dasharray")
    // Mỗi nhãn nằm trên nền trắng không viền
    expect(svg.match(/<rect [^>]*fill="#fff" transform=/g)).toHaveLength(flows)
  })

  it("context: nhãn là tên gói dữ liệu Title Case của flows_in / flows_out — actor một chiều không bịa chiều còn lại", () => {
    const svg = only(FIXTURE, "context").source
    const actors = contextActors(FIXTURE.actors)
    for (const a of FIXTURE.actors) {
      const mine = actors.find((x) => x.id === a.id)!
      expect(mine.inbound, a.id).toEqual((a.flows_in ?? []).map(titleCase))
      expect(mine.outbound, a.id).toEqual((a.flows_out ?? []).map(titleCase))
      for (const text of [...mine.inbound, ...mine.outbound]) expect(svg, text).toContain(`>${text}<`)
    }
    // Email Service chỉ nhận dữ liệu, Scheduler chỉ phát tín hiệu
    expect(actors.find((a) => a.id === "A08")).toMatchObject({ inbound: [], outbound: ["Email Request"] })
    expect(actors.find((a) => a.id === "A09")).toMatchObject({ inbound: ["Housekeeping Tick"], outbound: [] })
  })

  it("context: người dùng bên trái tâm, hệ thống ngoài và bộ hẹn giờ bên phải", () => {
    const layout = buildContextLayout(contextActors(FIXTURE.actors), "FlintFlow")
    const at = (id: string) => layout.actors.find((a) => a.id === id)!
    for (const id of ["A01", "A02", "A03", "A04"]) expect(at(id).side, id).toBe("left")
    for (const id of ["A05", "A06", "A07", "A08", "A09"]) expect(at(id).side, id).toBe("right")
    for (const id of ["A01", "A04"]) expect(at(id).box.x + at(id).box.w, id).toBeLessThan(layout.circle.cx)
    for (const id of ["A05", "A09"]) expect(at(id).box.x, id).toBeGreaterThan(layout.circle.cx)
  })

  it("context: chỉ có người dùng ⇒ chia đôi sang hai nửa", () => {
    const humans = mutate((s) => (s.actors = s.actors.filter((a) => a.kind === "human")))
    const layout = buildContextLayout(contextActors(humans.actors), "FlintFlow")
    expect(["A01", "A02", "A03", "A04"].map((id) => layout.actors.find((a) => a.id === id)!.side)).toEqual(["left", "left", "right", "right"])
    expect(only(humans, "context").issues).toEqual([])
  })

  it.each([
    { name: "6 nhãn một chiều", count: 6 },
    { name: "12 nhãn một chiều", count: 12 }
  ])("context: không giới hạn, không gộp — mỗi phần tử là một mũi tên ($name)", ({ count }) => {
    const labels = Array.from({ length: count }, (_, i) => `Flow ${i}`)
    const spine = mutate((s) => {
      const a = s.actors.find((x) => x.id === "A01")!
      a.flows_in = labels
      a.flows_out = labels
    })
    const part = only(spine, "context")
    const actor = contextActors(spine.actors).find((a) => a.id === "A01")!
    expect(actor.inbound).toEqual(labels)
    expect(actor.outbound).toEqual(labels)
    for (const text of labels) expect(part.source.split(`>${text}<`).length - 1, text).toBe(2)
    expect(part.issues).toEqual([])
  })

  it("context: chữ có ký tự đặc biệt được escape, không sinh phần tử lạ", () => {
    const spine = mutate((s) => {
      const a = s.actors.find((x) => x.id === "A01")!
      a.flows_in = ["Send R&D <proposal>"]
      a.flows_out = ["Accepted > proposal & summary"]
      a.name = "<script>x</script>"
    })
    const { source: svg, issues } = only(spine, "context")
    expect(svg).toContain("Send R&amp;D &lt;proposal&gt;")
    expect(svg).toContain("Accepted &gt; Proposal &amp; Summary")
    expect(svg).not.toContain("<script")
    expect(issues).toEqual([])
  })

  it.each([
    { name: "hai chiều lệch độ dài", flowsIn: ["first", "second"], flowsOut: ["first result"], inbound: ["First", "Second"], outbound: ["First Result"] },
    { name: "chỉ chiều vào", flowsIn: ["sensor reading"], flowsOut: [] as string[], inbound: ["Sensor Reading"], outbound: [] as string[] },
    { name: "phần tử rỗng bị bỏ", flowsIn: ["", "  ", "order"], flowsOut: ["", "receipt"], inbound: ["Order"], outbound: ["Receipt"] }
  ])("context: dữ liệu luồng $name ⇒ đúng số mũi tên, không bịa nhãn", ({ flowsIn, flowsOut, inbound, outbound }) => {
    const spine = mutate((s) => {
      const a = s.actors.find((x) => x.id === "A03")!
      a.flows_in = flowsIn
      a.flows_out = flowsOut
    })
    const before = structuredClone(spine)
    expect(contextActors(spine.actors).find((a) => a.id === "A03")).toMatchObject({ inbound, outbound })
    expect(only(spine, "context").issues).toEqual([])
    expect(spine).toEqual(before)
  })

  it("context: không khai báo luồng ⇒ một mũi tên mang nhãn dự phòng theo kind, không lấy tên use case làm nhãn", () => {
    const spine = mutate(withoutFlows)
    const part = only(spine, "context")
    for (const a of contextActors(spine.actors)) {
      if (a.kind === "system") expect(a, a.id).toMatchObject({ inbound: [], outbound: [DEFAULT_OUT.system] })
      else expect(a, a.id).toMatchObject({ inbound: [DEFAULT_IN[a.kind]], outbound: [] })
    }
    for (const uc of FIXTURE.use_cases) expect(part.source, uc.id).not.toContain(`>${uc.name}<`)
    expect(part.issues).toEqual([])
  })

  it.each([
    {
      name: "chỉ người dùng gửi vào ⇒ người dùng đầu tiên nhận kết quả",
      actors: [["A01", "human", ["order"], []], ["A02", "human", ["feedback"], []]] as const,
      expected: { A01: { inbound: ["Order"], outbound: [DEFAULT_OUT.human] }, A02: { inbound: ["Feedback"], outbound: [] } }
    },
    {
      name: "chỉ hệ thống nhận ra ⇒ hệ thống đầu tiên gửi phản hồi",
      actors: [["A01", "system", [], ["sms"]], ["A02", "system", [], []]] as const,
      expected: { A01: { inbound: [DEFAULT_IN.system], outbound: ["Sms"] }, A02: { inbound: [], outbound: [DEFAULT_OUT.system] } }
    },
    {
      name: "chỉ bộ hẹn giờ chưa có luồng ⇒ thêm chiều ra",
      actors: [["T01", "time", [], []], ["T02", "time", [], []]] as const,
      expected: { T01: { inbound: [DEFAULT_IN.time], outbound: [DEFAULT_OUT.time] }, T02: { inbound: [DEFAULT_IN.time], outbound: [] } }
    },
    {
      name: "người dùng chỉ vào, hệ thống chỉ ra ⇒ giữ nguyên",
      actors: [["A01", "human", ["order"], []], ["A02", "system", [], ["sms"]]] as const,
      expected: { A01: { inbound: ["Order"], outbound: [] }, A02: { inbound: [], outbound: ["Sms"] } }
    }
  ])("context: toàn sơ đồ luôn có cả chiều vào lẫn chiều ra ($name)", ({ actors, expected }) => {
    const spine = mutate((s) => {
      s.use_cases = []
      s.actors = actors.map(([id, kind, flowsIn, flowsOut]) => ({ id, kind, name: `Actor ${id}`, description: "", flows_in: [...flowsIn], flows_out: [...flowsOut] }))
    })
    const result = contextActors(spine.actors)
    for (const [id, flows] of Object.entries(expected)) expect(result.find((a) => a.id === id), id).toMatchObject(flows)
    expect(result.some((a) => a.inbound.length > 0)).toBe(true)
    expect(result.some((a) => a.outbound.length > 0)).toBe(true)
    expect(only(spine, "context").issues).toEqual([])
  })

  it("context: Title Case giữ từ viết hoa sẵn, từ nối ngắn viết thường, tiếng Việt giữ nguyên", () => {
    expect(titleCase("payment request")).toBe("Payment Request")
    expect(titleCase("SRS file and OTP code for the AI")).toBe("SRS File and OTP Code for the AI")
    expect(titleCase("sign-in via eKYC")).toBe("Sign-in via eKYC")
    const vi = contextActors([{ id: "A01", name: "Khách", kind: "human", description: "", flows_in: ["thông tin đăng ký"], flows_out: [] }], DIAGRAM_LABELS.vi)
    expect(vi[0].inbound).toEqual(["thông tin đăng ký"])
  })

  it("screen_layout: salt gắn function:<primary>, chỉ màn có primary function", () => {
    const part = only(FIXTURE, "screen_layout", "S07")
    expect(part).toMatchObject({ section: "function:FN028", owner_kind: "screen", owner_id: "S07" })
    for (const f of FIXTURE.functions.filter((x) => x.screen_id === "S07")) expect(part.source).toContain(saltCell(f.name))
    expect(renderKind(mutate((s) => (s.screens.find((x) => x.id === "S07")!.primary_function_id = null)), "screen_layout", "S07")).toEqual([])
    expect(renderKind(FIXTURE, "screen_layout", "S99")).toEqual([])
    expect(saltCell('a | b {c} "d" [e]')).toBe("a b c d e")
    // `^` mở ô tiêu đề, `()` mở widget radio/checkbox trong Salt
    expect(saltCell("Login (OAuth)^")).toBe("Login OAuth")
  })

  it("Spine rỗng vẫn sinh hình hợp lệ về cú pháp", () => {
    const empty = createEmptySpine({ name: "Empty" })
    expect(renderKind(empty, "screen_flow")).toEqual([])
    expect(only(empty, "erd").source).toContain("No entities yet")
    const context = only(empty, "context")
    expect(context.source).toContain(">Empty<")
    expect(context.source).not.toContain("<line ")
    expect(context.issues).toEqual([])
  })
})

describe("source_hash (DoD T10)", () => {
  const usecaseHash = (spine: Spine): string => renderKind(spine, "usecase")[0].source_hash

  it("đổi actors[].description không đổi hash usecase; đổi name thì đổi", () => {
    const base = usecaseHash(FIXTURE)
    expect(usecaseHash(mutate((s) => (s.actors[0].description = "Changed")))).toBe(base)
    expect(usecaseHash(mutate((s) => (s.actors[0].name = "Changed")))).not.toBe(base)
  })
})

describe("tên hệ thống (FLF-177)", () => {
  it("boundary use case + sơ đồ ngữ cảnh in `project.system_name`, chưa có ⇒ `project.name`", () => {
    const named = mutate((s) => (s.project.system_name = "ShipFast Delivery"))
    for (const part of renderKind(named, "usecase")) expect(part.source).toContain(">ShipFast Delivery</text>")
    expect(only(named, "context").source).toContain(">ShipFast Delivery<")

    const unnamed = mutate((s) => {
      s.project.system_name = null
      s.project.name = "Du an giao hang"
    })
    for (const part of renderKind(unnamed, "usecase")) expect(part.source).toContain(">Du an giao hang</text>")
    expect(only(unnamed, "context").source).toContain(">Du an giao hang<")
  })

  it("system_name rỗng/khoảng trắng coi như chưa đặt", () => {
    const blank = mutate((s) => {
      s.project.system_name = "   "
      s.project.name = "Du an giao hang"
    })
    expect(only(blank, "context").source).toContain(">Du an giao hang<")
  })
})
