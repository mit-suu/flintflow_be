import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { spineSchema } from "../../spine/spine.schema.js"
import type { Entity, Spine } from "../../spine/spine.types.js"
import { svgTitleOf } from "./common.js"
import { renderKind } from "./index.js"
import { DIAGRAM_LABELS } from "./labels.js"
import { renderStateMachine, stateMachineInput, transitionLabel } from "./state-machine.renderer.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../fixtures/spine-fixture-19-screens.json"), "utf8")))
const entityOf = (spine: Spine, id: string): Entity => spine.entities.find((e) => e.id === id)!

describe("transitionLabel — event [guard] / action", () => {
  it("ghép đủ ba phần; guard / action trống thì bỏ cả ký hiệu", () => {
    expect(transitionLabel({ event: "submit", guard: "all fields valid", action: "notify reviewer" })).toBe("submit [all fields valid] / notify reviewer")
    expect(transitionLabel({ event: "submit", guard: "all fields valid" })).toBe("submit [all fields valid]")
    expect(transitionLabel({ event: "cancel", action: "release lock" })).toBe("cancel / release lock")
    expect(transitionLabel({ event: "cancel", guard: "  ", action: "" })).toBe("cancel")
  })

  it("gộp khoảng trắng và xuống dòng", () => {
    expect(transitionLabel({ event: " verify \n email ", guard: "a   b" })).toBe("verify email [a b]")
  })
})

describe("stateMachineInput", () => {
  it("transition tự thân thành internal transition của state, không thành đường", () => {
    const input = stateMachineInput(entityOf(FIXTURE, "E01"))
    expect(input.states.find((s) => s.name === "Active")?.internal).toEqual(["update profile / save profile"])
    expect(input.transitions.some((t) => t.from === t.to)).toBe(false)
    expect(input.transitions).toHaveLength(5)
  })
})

describe("renderStateMachine — mỗi entity có vòng đời một hình", () => {
  it("một hình cho mỗi entity có states (theo id); chủ = entity, section = fixed:3.1.5; tiêu đề SVG", () => {
    const parts = renderStateMachine(FIXTURE)
    expect(parts.map((p) => [p.kind, p.format, p.owner_kind, p.owner_id, p.section])).toEqual([
      ["state_machine", "svg", "entity", "E01", "fixed:3.1.5"],
      ["state_machine", "svg", "entity", "E08", "fixed:3.1.5"]
    ])
    for (const p of parts) {
      expect(p.issues, p.owner_id!).toEqual([])
      expect(p.source).toContain("#7ACFF5")
    }
    expect(svgTitleOf(parts[0].source)).toBe("State Machine Diagram — User")
  })

  it("nhãn máy theo ngôn ngữ tài liệu; chữ trên hình là chữ của Spine (nhãn dài gói dòng)", () => {
    const [user] = renderStateMachine(FIXTURE, null, DIAGRAM_LABELS.vi)
    expect(svgTitleOf(user.source)).toBe("Sơ đồ trạng thái — User")
    expect(user.source).toContain("administrator] / notify user")
  })

  it("entity không có states ⇒ không có hình (không bịa vòng đời)", () => {
    const bare = structuredClone(FIXTURE)
    for (const e of bare.entities) {
      e.states = []
      e.transitions = []
    }
    expect(renderStateMachine(bare)).toEqual([])
    const old = structuredClone(FIXTURE)
    for (const e of old.entities) {
      delete e.states
      delete e.transitions
    }
    expect(renderStateMachine(old)).toEqual([])
  })

  it("tất định; renderKind dùng cùng renderer; không có state ngoài Spine", () => {
    const a = renderKind(FIXTURE, "state_machine", null)
    const b = renderKind(structuredClone(FIXTURE), "state_machine", null)
    expect(a.map((p) => p.source)).toEqual(b.map((p) => p.source))
    expect(a.map((p) => p.source_hash).every((h) => h.length === 64)).toBe(true)
    // mọi tên state trên hình đều nằm trong Spine
    const names = new Set(entityOf(FIXTURE, "E08").states!.map((s) => s.name))
    const texts = [...a[1].source.matchAll(/font-weight="bold"[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(texts.sort()).toEqual([...names].sort())
  })

  it("hash của hình theo từng entity; đổi tên state đổi hash hình entity đó", () => {
    const before = renderKind(FIXTURE, "state_machine", null)
    const changed = structuredClone(FIXTURE)
    entityOf(changed, "E08").states![1].name = "Frozen"
    const after = renderKind(changed, "state_machine", null)
    expect(after[0].source_hash).toBe(before[0].source_hash)
    expect(after[1].source_hash).not.toBe(before[1].source_hash)
  })

  it("transition nối state không tồn tại không được vẽ, hình vẫn hợp lệ", () => {
    const broken = structuredClone(FIXTURE)
    entityOf(broken, "E08").transitions!.push({ from: "E08-ST1", to: "E08-ST99", event: "ghost" })
    const [, part] = renderStateMachine(broken)
    expect(part.issues).toEqual([])
    expect(part.source).not.toContain("ghost")
  })
})
