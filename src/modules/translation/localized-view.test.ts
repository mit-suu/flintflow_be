import { describe, expect, it, vi } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { translatedViewOf } from "./localized-view.js"
import { translationUnits } from "./translation-units.js"

const spine = { project: { name: "D", system_name: "S", vision: "Book visits online.", goals: ["Fewer calls"], release_scope: { in: [], out: [] } }, features: [], actors: [], roles: [], use_cases: [], screens: [], permissions: [], entities: [], functions: [], nfrs: [], business_rules: [], common_requirements: [], messages: [], other_requirements: [], glossary: [], addendum: [], custom_sections: [], diagrams: [], assumptions: [] } as unknown as Spine
const vi_ = { locale: "vi", source: "en" } as const

describe("translatedViewOf (FLF-479 #6)", () => {
  it("dự án tiếng Anh / không có ngôn ngữ ⇒ trả đúng Spine, không tra bản dịch", async () => {
    const lookup = vi.fn()
    expect(await translatedViewOf("p", spine, null, lookup)).toBe(spine)
    expect(await translatedViewOf("p", spine, { locale: "en", source: "en" }, lookup)).toBe(spine)
    expect(lookup).not.toHaveBeenCalled()
  })

  it("có bản dịch ⇒ chữ dịch; đơn vị chưa dịch giữ chữ gốc; Spine gốc không đổi", async () => {
    const unit = translationUnits(spine).find((u) => u.ref.field === "vision")!
    const view = await translatedViewOf("p", spine, vi_, async () => ({ map: new Map([[unit.key, "Đặt lịch khám online."]]) }))
    expect(view.project.vision).toBe("Đặt lịch khám online.")
    expect(view.project.goals).toEqual(["Fewer calls"])
    expect(spine.project.vision).toBe("Book visits online.")
  })

  it("chưa có bản dịch nào hoặc tra cứu lỗi ⇒ Spine gốc", async () => {
    expect(await translatedViewOf("p", spine, vi_, async () => ({ map: new Map() }))).toBe(spine)
    expect(await translatedViewOf("p", spine, vi_, async () => { throw new Error("db") })).toBe(spine)
  })
})
