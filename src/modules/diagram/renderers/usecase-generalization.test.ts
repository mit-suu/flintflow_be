import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Spine } from "../../spine/spine.types.js"
import { renderKind } from "./index.js"
import { liftToGeneral, type ActorKinds } from "./usecase.renderer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

/**
 * Fixture: Log In (UC02) có Founder A01, Business Analyst A02, Administrator A03, Guest A04. Thêm actor
 * tổng quát `User` A10 và cho A01–A03 chuyên biệt hoá nó; Guest đứng ngoài cây kế thừa.
 */
const withUser = (fn: (s: Spine) => void = () => {}): Spine => {
  const s = structuredClone(FIXTURE)
  s.actors.push({ id: "A10", name: "User", kind: "human", description: "Any signed-in person using the platform." })
  for (const a of s.actors) if (["A01", "A02", "A03"].includes(a.id)) a.parent_id = "A10"
  fn(s)
  return s
}
const parts = (s: Spine): string[] => renderKind(s, "usecase").map((p) => p.puml)
const partOf = (s: Spine, title: string): string => {
  const found = parts(s).find((p) => p.includes(`title Use Cases — ${title}\n`))
  expect(found, title).toBeDefined()
  return found!
}
const KINDS: ActorKinds = new Map([
  ["U", "human"], ["C", "human"], ["V", "human"], ["G", "human"], ["P", "system"]
])

describe("liftToGeneral", () => {
  const parents = new Map([["C", "U"], ["V", "C"]])

  it("≥ 2 actor cùng cây ⇒ tổ tiên chung gần nhất, ở vị trí actor đầu", () => {
    expect(liftToGeneral(["G", "C", "V"], KINDS, new Map([["C", "U"], ["V", "U"]]))).toEqual(["G", "U"])
    // V chuyên biệt hoá C ⇒ chung gần nhất là C, không phải gốc U
    expect(liftToGeneral(["V", "C", "P"], KINDS, parents)).toEqual(["C", "P"])
  })

  it("chỉ chung cho MỘT PHẦN vai trò ⇒ không nâng; có sẵn actor cha ⇒ bỏ actor con thừa", () => {
    const three = new Map([["C", "U"], ["V", "U"], ["G", "U"]])
    // U có ba con C, V, G: C + V chưa đủ ⇒ nâng lên U sẽ nói sai rằng G cũng làm được
    expect(liftToGeneral(["C", "V"], KINDS, three)).toEqual(["C", "V"])
    expect(liftToGeneral(["V", "C", "G", "P"], KINDS, three)).toEqual(["U", "P"])
    expect(liftToGeneral(["U", "C"], KINDS, three)).toEqual(["U"])
  })

  it("một actor đơn, actor ngoài cây và actor system không bị nâng", () => {
    expect(liftToGeneral(["C"], KINDS, parents)).toEqual(["C"])
    expect(liftToGeneral(["C", "G", "P"], KINDS, parents)).toEqual(["C", "G", "P"])
    expect(liftToGeneral(["P"], new Map([["P", "system"]]), new Map([["P", "U"]]))).toEqual(["P"])
  })
})

describe("usecase diagram với generalization", () => {
  it("không có parent_id ⇒ không có mũi tên kế thừa", () => {
    expect(parts(FIXTURE).join("")).not.toContain("<|--")
  })

  it("use case chung lên hình User, actor con không nối lại vào nó", () => {
    const user = partOf(withUser(), "User")
    expect(user).toContain("A10 -- UC02")
    for (const child of ["A01", "A02", "A03"]) expect(user).not.toContain(`${child} -- UC02`)
    // Guest nằm ngoài cây kế thừa ⇒ vẫn nối thẳng
    expect(parts(withUser()).join("\n")).toContain("A04 -- UC02")
  })

  it("mỗi actor con một hình, chỉ use case riêng + mũi tên kế thừa tới User", () => {
    const s = withUser()
    const founder = partOf(s, "Founder")
    expect(founder).toContain("A10 <|-- A01")
    expect(founder).toMatch(/^actor "User" as A10$/m)
    expect(founder).not.toContain("UC02")
    expect(founder).not.toMatch(/^A10 -- /m)
    // UC13 (Founder + Business Analyst) bị Sign Baseline include ⇒ đi theo cụm của Business Analyst,
    // không kéo use case riêng của Business Analyst sang hình User
    const analyst = partOf(s, "Business Analyst")
    for (const uc of ["UC13", "UC14", "UC15"]) expect(analyst).toContain(`as ${uc}`)
    expect(partOf(s, "User")).not.toContain("as UC15")
    expect(partOf(s, "Administrator")).toContain("A10 <|-- A03")
    // Hình User đứng đầu (actor tổng quát trước actor chuyên biệt)
    expect(parts(s)[0]).toContain("title Use Cases — User\n")
  })

  it("use case chung một phần vai trò xuất hiện ở hình của TỪNG vai trò, mỗi hình chỉ nối actor của nó", () => {
    // View Grades chỉ Founder + Business Analyst (không có Administrator) ⇒ không lên hình User
    const s = withUser((sp) => {
      sp.use_cases.push({ id: "UC30", name: "View Grades", actor_ids: ["A01", "A02"], function_ids: [], description: "x", includes: [], extends: [] })
    })
    expect(partOf(s, "User")).not.toContain("as UC30")
    const founder = partOf(s, "Founder")
    expect(founder).toContain("A01 -- UC30")
    expect(founder).not.toContain("A02")
    const analyst = partOf(s, "Business Analyst")
    expect(analyst).toContain("A02 -- UC30")
    expect(analyst).not.toMatch(/^A01 -- /m)
  })

  it("mỗi hình có tối đa một actor người nối use case; mọi use case đều có mặt", () => {
    const s = withUser()
    for (const p of parts(s)) {
      const humans = new Set([...p.matchAll(/^(A\d+) -- UC/gm)].map((m) => m[1]))
      expect(humans.size, p).toBeLessThanOrEqual(1)
    }
    const declared = new Set(parts(s).flatMap((p) => [...p.matchAll(/usecase "[^"]*" as (\w+)/g)].map((m) => m[1])))
    expect([...declared].sort()).toEqual(s.use_cases.map((u) => u.id).sort())
  })

  it("actor con không còn use case riêng vẫn hiện ở hình của cha", () => {
    // Administrator A03 có Log In (chung) + UC20/UC21 riêng; bỏ hai use case riêng ⇒ A03 chỉ còn Log In
    const s = withUser((sp) => {
      sp.use_cases = sp.use_cases.filter((u) => !["UC20", "UC21"].includes(u.id))
    })
    const user = partOf(s, "User")
    expect(user).toContain("A10 <|-- A03")
    expect(parts(s).some((p) => p.includes("title Use Cases — Administrator"))).toBe(false)
  })

  it("screen flow: không có hình riêng cho actor tổng quát User", () => {
    const s = withUser((sp) => {
      sp.use_cases.find((u) => u.id === "UC02")!.actor_ids = ["A10", "A04"]
    })
    const titles = renderKind(s, "screen_flow").map((p) => /label="([^"]*)"/.exec(p.puml)?.[1])
    expect(titles).not.toContain("Screens flow for User")
    expect(titles).toContain("Screens flow for Founder")
  })

  it("parent_id không hợp lệ (actor system) bị bỏ qua", () => {
    const s = withUser((sp) => {
      sp.actors.find((a) => a.id === "A05")!.parent_id = "A10"
    })
    expect(parts(s).join("\n")).not.toContain("<|-- A05")
  })
})
