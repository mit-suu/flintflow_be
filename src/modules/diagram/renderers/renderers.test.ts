import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine, UseCase } from "../../spine/spine.types.js"
import { VIETNAMESE_DIACRITICS } from "../../spine/deterministic-check.js"
import { createEmptySpine } from "../../spine/spine.repository.js"
import { allTargets, layoutOwners, renderKind } from "./index.js"
import { MAX_ASSOCIATIONS_PER_DIAGRAM, MAX_CLUSTER_SPAN, MAX_USE_CASES_PER_DIAGRAM, actorUseCaseCounts, dependentUseCaseIds, partitionUseCases } from "./usecase.renderer.js"
import { saltCell } from "./screen-layout.renderer.js"
import { screenFlowTitleOf } from "./screen-flow.renderer.js"
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
/** Sơ đồ use case có thể tách nhiều phần — luật cạnh áp trên toàn sơ đồ nên xét chung. */
const usecaseParts = (spine: Spine): string[] => renderKind(spine, "usecase").map((p) => p.source)
const usecasePuml = (spine: Spine): string => usecaseParts(spine).join("\n")
const declaredActors = (puml: string): string[] => [...puml.matchAll(/^actor "[^"]*" as (\w+)/gm)].map((m) => m[1])
const withoutFlows = (s: Spine) =>
  s.actors.forEach((a) => {
    delete a.flows_in
    delete a.flows_out
  })

describe("renderers trên fixture 19 màn", () => {
  it("4 hình cố định + wireframe cho 5 màn signed_off", () => {
    expect(layoutOwners(FIXTURE)).toEqual(["S01", "S05", "S07", "S09", "S10"])
    expect(allTargets(FIXTURE)).toHaveLength(9)
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
                : part.kind === "erd"
                  ? ["@startchen", "@endchen"]
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

  it("usecase: mọi use case và cạnh include/extend", () => {
    const puml = usecasePuml(FIXTURE)
    for (const uc of FIXTURE.use_cases) expect(puml).toContain(`usecase "${uc.name}" as ${uc.id}`)
    for (const uc of FIXTURE.use_cases) for (const inc of uc.includes) expect(puml).toContain(`${uc.id} ..> ${inc} : <<include>>`)
    for (const uc of FIXTURE.use_cases) for (const base of uc.extends) expect(puml).toContain(`${uc.id} ..> ${base} : <<extend>>`)
  })

  it("usecase: cạnh actor là association; actor người không nối use case phụ thuộc khi gốc của nó cùng hình", () => {
    expect(usecasePuml(FIXTURE)).not.toMatch(/^A\d+ -->/m)
    const human = new Set(FIXTURE.actors.filter((a) => a.kind === "human").map((a) => a.id))
    const byUc = new Map(FIXTURE.use_cases.map((u) => [u.id, u]))
    for (const puml of usecaseParts(FIXTURE)) {
      const inPart = new Set([...puml.matchAll(/usecase "[^"]*" as (\w+)/g)].map((m) => m[1]))
      for (const [, actorId, ucId] of puml.matchAll(/^(A\d+) -- (UC\d+)$/gm)) {
        if (!human.has(actorId)) continue
        const uc = byUc.get(ucId)!
        const viaBase = FIXTURE.use_cases.some((o) => o.id !== ucId && inPart.has(o.id) && o.includes.includes(ucId)) || uc.extends.some((b) => inPart.has(b))
        // ngoại lệ: actor không còn cạnh nào khác trong hình thì giữ một cạnh
        const others = [...puml.matchAll(new RegExp(`^${actorId} -- `, "gm"))].length
        if (others > 1) expect(viaBase, `${actorId} -- ${ucId}`).toBe(false)
      }
    }
    expect(usecasePuml(FIXTURE)).toContain("UC12 -- A07") // actor system giữ cạnh ở use case bị include
  })

  it("usecase: mỗi hình tối đa một actor người có cạnh; use case chung xuất hiện ở hình của từng actor", () => {
    for (const puml of usecaseParts(FIXTURE)) {
      expect(new Set([...puml.matchAll(/^(A\d+) -- UC/gm)].map((m) => m[1])).size, puml).toBeLessThanOrEqual(1)
    }
    // Log In (UC02) có Founder, Business Analyst, Administrator, Guest ⇒ có mặt ở 4 hình, mỗi hình một cạnh
    const withLogIn = usecaseParts(FIXTURE).filter((p) => p.includes('as UC02'))
    expect(withLogIn).toHaveLength(4)
    expect(withLogIn.map((p) => p.match(/^(A\d+) -- UC02$/m)?.[1])).toEqual(["A01", "A02", "A03", "A04"])
  })

  it("usecase: actor người viết `A -- UC` (trái), actor system/time viết `UC -- A` (phải)", () => {
    const kind = new Map(FIXTURE.actors.map((a) => [a.id, a.kind]))
    for (const puml of usecaseParts(FIXTURE)) {
      for (const [, left, right] of puml.matchAll(/^(\w+) -- (\w+)$/gm)) {
        if (left.startsWith("A")) expect(kind.get(left), `${left} -- ${right}`).toBe("human")
        else expect(kind.get(right), `${left} -- ${right}`).not.toBe("human")
      }
      // actor người khai báo trước `rectangle`, actor system/time sau
      const [before, after] = puml.split(/^rectangle /m)
      for (const id of declaredActors(before)) expect(kind.get(id), id).toBe("human")
      for (const id of declaredActors(after)) expect(kind.get(id), id).not.toBe("human")
    }
  })

  it("usecase: actor tham gia use case luôn được vẽ, kể cả khi mọi cạnh của nó bị bỏ", () => {
    const participating = new Set(FIXTURE.use_cases.flatMap((u) => u.actor_ids))
    expect(participating.size).toBe(9)
    const declared = usecaseParts(FIXTURE).flatMap(declaredActors)
    for (const id of participating) expect(declared, id).toContain(id)

    // A03 (người) chỉ còn tham gia UC20, UC21, cả hai bị UC05 (của Founder) include. UC05 không nằm trong
    // hình của A03 ⇒ A03 nối thẳng cả hai, không use case nào lơ lửng
    const spine = mutate((s) => {
      const uc02 = s.use_cases.find((u) => u.id === "UC02")!
      uc02.actor_ids = uc02.actor_ids.filter((a) => a !== "A03")
      s.use_cases.find((u) => u.id === "UC05")!.includes = ["UC20", "UC21"]
    })
    expect(usecasePuml(spine).match(/^A03 -- \w+$/gm)).toEqual(["A03 -- UC20", "A03 -- UC21"])
  })

  it("usecase: actor system chỉ tham gia use case mở rộng/bị include vẫn giữ mọi cạnh", () => {
    // A07 tham gia 2 use case và cả hai đều bị UC09 include
    const spine = mutate((s) => (s.use_cases.find((u) => u.id === "UC10")!.actor_ids = ["A07"]))
    expect(usecasePuml(spine).match(/^\w+ -- A07$/gm)).toEqual(["UC10 -- A07", "UC12 -- A07"])
  })

  it("screen_flow: DOT — màn là hình chữ nhật, màn nhiều tab là cluster, popup hình ô-van, cạnh flow_to", () => {
    const puml = renderKind(FIXTURE, "screen_flow").map((p) => p.source).join("\n")
    const tabbed = FIXTURE.screens.find((s) => s.tabs.length > 0)!
    expect(puml).toContain('node [fontname="DejaVu Sans", fontsize=11, shape=box, color="#000000"];')
    expect(puml).not.toContain("style=rounded")
    expect(puml).toContain(`subgraph cluster_${tabbed.id} {`)
    expect(puml).toContain(`${tabbed.id}_T1 [label="${tabbed.tabs[0]}"];`)
    for (const popup of FIXTURE.screens.filter((s) => s.is_popup)) {
      expect(puml).toContain(`${popup.id} [label="${popup.name}", shape=ellipse];`)
      expect(puml).not.toContain(`${popup.id} [label="${popup.name}\\n(pop-up)"`)
    }
    // Cạnh đi từ màn nhiều tab gắn vào cluster
    expect(puml).toContain("S07_T1 -> S08 [ltail=cluster_S07];")
  })

  it("screen_flow: một sơ đồ cho mỗi actor người, bắt đầu bằng hình thoi mang tên actor", () => {
    const parts = renderKind(FIXTURE, "screen_flow")
    expect(parts.map((p) => screenFlowTitleOf(p.source))).toEqual([
      "Screens flow for Founder",
      "Screens flow for Business Analyst",
      "Screens flow for Administrator",
      "Screens flow for Guest"
    ])
    expect(parts.every((p) => p.owner_id === null && p.section === "fixed:3.1.1")).toBe(true)
    expect(parts.every((p) => p.source.startsWith("@startdot\n") && p.source.endsWith("@enddot\n"))).toBe(true)

    const admin = parts[2].source
    expect(admin).toContain('START [label="Administrator", shape=diamond, style=solid];')
    expect(admin).toContain("START -> S01;")
    expect(admin).toContain("S14 -> S16;")
    // Màn của actor khác và cạnh sang màn ngoài nhóm không vẽ
    expect(admin).not.toContain("cluster_S07")
    expect(admin).not.toContain("S01 -> S05;")

    const guest = parts[3].source
    expect(guest).toContain('START [label="Guest", shape=diamond, style=solid];')
    expect(guest).toContain("START -> S01;")
    expect(guest).toContain("S01 -> S02;")
  })

  it("screen_flow: mũi tên một chiều — cặp màn trỏ qua lại chỉ giữ chiều đi tiếp từ màn vào", () => {
    const [founder, , admin, guest] = renderKind(FIXTURE, "screen_flow").map((p) => p.source)
    // Login ⇄ Register: chỉ Login → Register
    expect(guest).toContain("S01 -> S02;")
    expect(guest).not.toContain("S02 -> S01;")
    // Workspace ⇄ Diagram Preview: chỉ Workspace → Preview
    expect(founder).toContain("S07_T1 -> S08 [ltail=cluster_S07];")
    expect(founder).not.toContain("S08 -> S07_T1")
    expect(admin).toContain("S14 -> S15;")
    expect(admin).not.toContain("S15 -> S14;")
    for (const p of [founder, admin, guest]) {
      const edges = new Set([...p.matchAll(/^ {2}(\w+) -> (\w+)/gm)].map((m) => `${m[1]}>${m[2]}`))
      for (const e of edges) expect(edges.has(e.split(">").reverse().join(">")), e).toBe(false)
    }
  })

  it("screen_flow: màn chỉ tới được qua màn của actor khác được nối tắt từ màn trong nhóm, không đứng ngang Login", () => {
    // Login → Manager Dashboard → Grade Entry; Lecturer dùng Login + Grade Entry nhưng không dùng Dashboard
    const spine = mutate((s) => {
      s.actors = [
        { ...s.actors.find((a) => a.kind === "human")!, id: "A01", name: "Manager" },
        { ...s.actors.find((a) => a.kind === "human")!, id: "A02", name: "Lecturer" }
      ]
      s.roles = [
        { ...s.roles[0], id: "R1", actor_id: "A01" },
        { ...s.roles[0], id: "R2", actor_id: "A02" }
      ]
      const base = s.screens[0]
      s.screens = [
        { ...base, id: "S01", name: "Login", flow_to: ["S02", "S04"], is_popup: false, tabs: [] },
        { ...base, id: "S02", name: "Manager Dashboard", flow_to: ["S03"], is_popup: false, tabs: [] },
        { ...base, id: "S03", name: "Grade Entry", flow_to: [], is_popup: false, tabs: [] },
        { ...base, id: "S04", name: "Lecturer Schedule", flow_to: [], is_popup: false, tabs: [] }
      ]
      const perm = s.permissions[0]
      s.permissions = [
        ...["S01", "S02", "S03"].map((id) => ({ ...perm, screen_id: id, role_id: "R1" })),
        ...["S01", "S03", "S04"].map((id) => ({ ...perm, screen_id: id, role_id: "R2" }))
      ]
      s.use_cases = []
    })
    const [manager, lecturer] = renderKind(spine, "screen_flow").map((p) => p.source)
    expect(manager).toContain("START -> S01;")
    expect(manager).toContain("S02 -> S03;")
    // Lecturer: Grade Entry nối từ Login (qua Dashboard bị lọc), START chỉ trỏ vào Login
    expect([...lecturer.matchAll(/START -> (\w+)/g)].map((m) => m[1])).toEqual(["S01"])
    expect(lecturer).toContain("S01 -> S03;")
    expect(lecturer).toContain("S01 -> S04;")
    expect(lecturer).not.toContain("S02")
  })

  it("screen_flow: màn public (chỉ Guest) nằm trong sơ đồ của mọi actor, Login và landing công khai cùng là màn vào", () => {
    // Login → Reset Password, Login → Teacher Home / Student Home; Public Landing đứng ngang Login
    const spine = mutate((s) => {
      s.actors = [
        { ...s.actors.find((a) => a.kind === "human")!, id: "A01", name: "Teacher" },
        { ...s.actors.find((a) => a.kind === "human")!, id: "A02", name: "Student" }
      ]
      s.roles = [
        { ...s.roles[0], id: "R1", actor_id: "A01" },
        { ...s.roles[0], id: "R2", actor_id: "A02" },
        { ...s.roles[0], id: "R3", name: "Guest", actor_id: null }
      ]
      const base = s.screens[0]
      s.screens = [
        { ...base, id: "S01", name: "Login", flow_to: ["S02", "S03", "S04"], is_popup: false, tabs: [] },
        { ...base, id: "S02", name: "Reset Password", flow_to: [], is_popup: false, tabs: [] },
        { ...base, id: "S03", name: "Teacher Home", flow_to: [], is_popup: false, tabs: [] },
        { ...base, id: "S04", name: "Student Home", flow_to: [], is_popup: false, tabs: [] },
        { ...base, id: "S05", name: "Public Landing", flow_to: [], is_popup: false, tabs: [] }
      ]
      const perm = s.permissions[0]
      s.permissions = [
        ...["S01", "S02", "S05"].map((id) => ({ ...perm, screen_id: id, role_id: "R3" })),
        { ...perm, screen_id: "S03", role_id: "R1" },
        { ...perm, screen_id: "S04", role_id: "R2" }
      ]
      s.use_cases = []
    })
    const parts = renderKind(spine, "screen_flow")
    expect(parts.map((p) => screenFlowTitleOf(p.source))).toEqual(["Screens flow for Teacher", "Screens flow for Student"])
    const [teacher, student] = parts.map((p) => p.source)
    for (const p of [teacher, student]) {
      expect([...p.matchAll(/START -> (\w+)/g)].map((m) => m[1])).toEqual(["S01", "S05"])
      expect(p).toContain("S01 -> S02;")
    }
    expect(teacher).toContain("S01 -> S03;")
    expect(teacher).not.toContain("S04")
    expect(student).toContain("S01 -> S04;")
    expect(student).not.toContain("S03")
  })

  it("screen_flow: màn Đăng ký đứng ngang Login sau hình thoi actor và trỏ sang Login", () => {
    // Register → Login → Teacher Home; Login vẫn là màn vào dù có cạnh tới từ Register
    const spine = mutate((s) => {
      s.actors = [{ ...s.actors.find((a) => a.kind === "human")!, id: "A01", name: "Teacher" }]
      s.roles = [
        { ...s.roles[0], id: "R1", actor_id: "A01" },
        { ...s.roles[0], id: "R3", name: "Guest", actor_id: null }
      ]
      const base = s.screens[0]
      s.screens = [
        { ...base, id: "S01", name: "Login", flow_to: ["S02", "S03"], is_popup: false, tabs: [], queue_order: 1 },
        { ...base, id: "S02", name: "Reset Password", flow_to: [], is_popup: false, tabs: [], queue_order: 2 },
        { ...base, id: "S03", name: "Teacher Home", flow_to: [], is_popup: false, tabs: [], queue_order: 3 },
        { ...base, id: "S04", name: "Register", flow_to: ["S01"], is_popup: false, tabs: [], queue_order: 4 }
      ]
      const perm = s.permissions[0]
      s.permissions = [
        ...["S01", "S02", "S04"].map((id) => ({ ...perm, screen_id: id, role_id: "R3" })),
        { ...perm, screen_id: "S03", role_id: "R1" }
      ]
      s.use_cases = []
    })
    const [teacher] = renderKind(spine, "screen_flow").map((p) => p.source)
    // Login và Register cùng sau hình thoi; Reset Password treo dưới Login, không phải màn vào
    expect([...teacher.matchAll(/START -> (\w+)/g)].map((m) => m[1])).toEqual(["S01", "S04"])
    expect(teacher).toContain("S04 -> S01;")
    expect(teacher).not.toContain("S01 -> S04;")
    expect(teacher).toContain("S01 -> S02;")
    expect(teacher).toContain("S01 -> S03;")
  })

  it("screen_flow: màn không actor nào dùng không vẽ ở sơ đồ nào; chưa có liên kết actor ⇒ một sơ đồ chung", () => {
    const withOrphan = mutate((s) => {
      s.screens.push({ ...s.screens.find((x) => x.id === "S13")!, id: "S20", name: "Orphan Screen", flow_to: [] })
    })
    const parts = renderKind(withOrphan, "screen_flow")
    expect(parts).toHaveLength(renderKind(FIXTURE, "screen_flow").length)
    expect(parts.every((p) => !p.source.includes("S20"))).toBe(true)

    const unlinked = mutate((s) => {
      s.permissions = []
      s.use_cases = s.use_cases.map((u) => ({ ...u, function_ids: [] }))
    })
    const [single, ...rest] = renderKind(unlinked, "screen_flow")
    expect(rest).toEqual([])
    expect(screenFlowTitleOf(single.source)).toBeNull()
    expect(single.source).toContain("START [label=\"\", shape=circle")
    expect(single.source).toContain("START -> S01;")
  })

  it("screen_flow: nhãn DOT escape dấu ngoặc kép và gạch chéo", () => {
    const tricky = mutate((s) => {
      s.screens.find((x) => x.id === "S01")!.name = 'Log "in" \\ out'
    })
    // Tên có một `\` ⇒ DOT nhận `\\`; `"` đổi thành `'`
    expect(renderKind(tricky, "screen_flow")[3].source).toContain("S01 [label=\"Log 'in' \\\\ out\"];")
  })

  it("erd: ký pháp Chen — hình thoi chứa động từ, cha 1 – con N, thiếu động từ ⇒ has", () => {
    const { source: puml } = only(FIXTURE, "erd")
    expect(puml).toContain('entity "User" as E01 {\n}')
    expect(puml).toContain("E01 -1- R_E01_E02\nR_E01_E02 -N- E02")
    const withVerb = mutate((s) => (s.entities.find((e) => e.id === "E01")!.relation_verbs = { E02: "owns" }))
    expect(only(withVerb, "erd").source).toContain('relationship "owns" as R_E01_E02 {')
    const oneToOne = mutate((s) => (s.entities.find((e) => e.id === "E01")!.relation_cardinality = { E02: "1" }))
    expect(only(oneToOne, "erd").source).toContain("R_E01_E02 -1- E02")
    expect(only(oneToOne, "erd").source).toContain("R_E01_E05 -N- E05")
    // Liên kết tuỳ chọn: phía cha (0,1) — `-0..1-` là lỗi cú pháp trong @startchen
    const optional = mutate((s) => (s.entities.find((e) => e.id === "E01")!.relation_optional = ["E02"]))
    expect(only(optional, "erd").source).toContain("E01 -(0,1)- R_E01_E02")
    expect(only(optional, "erd").source).toContain("E01 -1- R_E01_E05")
    expect(only(mutate((s) => delete s.entities.find((e) => e.id === "E01")!.relation_verbs), "erd").source).toContain(
      'relationship "has" as R_E01_E02 {'
    )
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
    expect(only(empty, "screen_flow").source).toContain("NO_SCREENS")
    expect(only(empty, "erd").source).toContain("NO_ENTITIES")
    const context = only(empty, "context")
    expect(context.source).toContain(">Empty<")
    expect(context.source).not.toContain("<line ")
    expect(context.issues).toEqual([])
  })
})

describe("usecase > 20 ⇒ tách theo cụm quan hệ", () => {
  const uc = (n: number, extra: Partial<UseCase> = {}): UseCase => ({
    id: `UC${String(n).padStart(3, "0")}`,
    name: `Use Case ${n}`,
    actor_ids: ["A01"],
    function_ids: [],
    description: "",
    includes: [],
    extends: [],
    ...extra
  })
  /** n use case KHÔNG quan hệ ⇒ phủ đường dồn cụm đơn vào phần. */
  const independentUseCases = (n: number): UseCase[] => Array.from({ length: n }, (_, i) => uc(i + 1))
  /** Cụm 3 phần tử đặt đúng ranh giới dồn ⇒ phủ luật "không cắt giữa cụm". */
  const clusteredUseCases = (): UseCase[] => [
    ...independentUseCases(MAX_USE_CASES_PER_DIAGRAM - 1),
    uc(90, { includes: ["UC091"] }),
    uc(91),
    uc(92, { extends: ["UC091"] })
  ]
  /** Một chuỗi include dài hơn trần cứng ⇒ phủ đường cắt cưỡng bức. */
  const oversizedCluster = (n: number): UseCase[] =>
    Array.from({ length: n }, (_, i) => uc(i + 1, i > 0 ? { includes: [`UC${String(i).padStart(3, "0")}`] } : {}))
  const withUseCases = (useCases: UseCase[]): Spine => mutate((s) => (s.use_cases = useCases))

  it("mỗi phần ≤ 20, đủ mọi use case, không trùng, tiêu đề theo nhóm actor", () => {
    const spine = withUseCases(independentUseCases(45))
    const parts = partitionUseCases(spine.use_cases)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.useCases.length <= MAX_USE_CASES_PER_DIAGRAM)).toBe(true)
    expect(parts.flatMap((p) => p.useCases).map((u) => u.id).sort()).toEqual(spine.use_cases.map((u) => u.id).sort())

    const rendered = renderKind(spine, "usecase")
    expect(rendered).toHaveLength(parts.length)
    expect(rendered[0].source).toContain(`title Use Cases — ${spine.actors.find((a) => a.id === "A01")!.name}`)
    expect(new Set(rendered.map((r) => r.source_hash)).size).toBe(1)
  })

  it("tách theo actor người chính: use case của một actor người nằm trọn một hình", () => {
    // Xen kẽ id giữa hai actor người; actor system A05 (id nhỏ hơn không phải lý do để nhóm) đi cùng A01
    const spine = withUseCases(
      Array.from({ length: 24 }, (_, i) => uc(i + 1, { actor_ids: i % 2 === 0 ? ["A01", "A05"] : ["A02"] }))
    )
    const rendered = renderKind(spine, "usecase").map((p) => p.source)
    expect(rendered.length).toBeGreaterThan(1)
    for (const actorId of ["A01", "A02"]) {
      const holding = rendered.filter((p) => new RegExp(`^${actorId} -- `, "m").test(p))
      expect(holding, actorId).toHaveLength(1)
    }
    const names = (id: string) => spine.actors.find((a) => a.id === id)!.name
    expect(rendered[0]).toContain(`title Use Cases — ${names("A01")}`)
    expect(rendered[1]).toContain(`title Use Cases — ${names("A02")}`)
  })

  it("quá trần số cạnh dù ≤ 20 use case ⇒ tách, mỗi phần ≤ trần cạnh", () => {
    const spine = withUseCases(Array.from({ length: 15 }, (_, i) => uc(i + 1, { actor_ids: ["A01", "A02"] })))
    const rendered = renderKind(spine, "usecase")
    expect(rendered.length).toBeGreaterThan(1)
    for (const { source: puml } of rendered) {
      expect(puml.match(/^\w+ -- \w+$/gm)!.length).toBeLessThanOrEqual(MAX_ASSOCIATIONS_PER_DIAGRAM)
    }
  })

  it("≤ 20 use case giữ một hình, không có dòng title", () => {
    const rendered = renderKind(withUseCases(independentUseCases(MAX_USE_CASES_PER_DIAGRAM)), "usecase")
    expect(rendered).toHaveLength(1)
    expect(rendered[0].source).not.toContain("title ")
  })

  it("không cắt giữa cụm quan hệ", () => {
    const cluster = ["UC090", "UC091", "UC092"]
    const holding = partitionUseCases(clusteredUseCases()).filter((p) => p.useCases.some((u) => cluster.includes(u.id)))
    expect(holding).toHaveLength(1)
    expect(holding[0].useCases.map((u) => u.id)).toEqual(cluster)
  })

  it("cụm vượt trần cứng bị cắt: mọi phần ≤ 20, không cạnh trỏ ra ngoài phần", () => {
    const spine = withUseCases(oversizedCluster(MAX_CLUSTER_SPAN + 5))
    expect(partitionUseCases(spine.use_cases).every((p) => p.useCases.length <= MAX_USE_CASES_PER_DIAGRAM)).toBe(true)
    for (const { source: puml } of renderKind(spine, "usecase")) {
      const declared = new Set([...puml.matchAll(/usecase "[^"]*" as (\w+)/g)].map((m) => m[1]))
      for (const [, target] of puml.matchAll(/^\w+ \.\.> (\w+) :/gm)) expect(declared).toContain(target)
    }
  })

  it("tên actor có dấu nháy hoặc xuống dòng vẫn cho tiêu đề một dòng", () => {
    const spine = mutate((s) => {
      s.use_cases = independentUseCases(45)
      s.actors.find((a) => a.id === "A01")!.name = 'Founder "Prime"\nAdmin'
    })
    const title = renderKind(spine, "usecase")[0].source.split("\n").find((l) => l.startsWith("title "))
    expect(title).toBe("title Use Cases — Founder 'Prime' Admin")
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
    for (const part of usecaseParts(named)) expect(part).toContain('rectangle "ShipFast Delivery" {')
    expect(only(named, "context").source).toContain(">ShipFast Delivery<")

    const unnamed = mutate((s) => {
      s.project.system_name = null
      s.project.name = "Du an giao hang"
    })
    expect(usecasePuml(unnamed)).toContain('rectangle "Du an giao hang" {')
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
