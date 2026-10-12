import { describe, expect, it } from "vitest"
import type { Spine } from "../spine/spine.types.js"
import { computeSourceHash } from "../spine/source-hash.js"
import { translationUnits, type UnitValue } from "../translation/translation-units.js"
import { localizeSpine, renderView } from "./localized-spine.js"

const spine = (): Spine => ({
  project: {
    name: "Demo",
    system_name: "ShipFast",
    vision: "Deliver parcels the same day.",
    goals: ["Cut delivery time", "Track every parcel"],
    type: null,
    domain: null,
    complexity: null,
    form_factor: [],
    stakes: null,
    working_mode: null,
    review_mode: "balanced",
    release_scope: { in: ["Order tracking"], out: ["Refunds", "Loyalty points"] }
  },
  progress: { current_phase: null, current_step: null, screen_cursor: null, screen_queue: [], elicit_turns_this_phase: 0 },
  steps: [],
  features: [{ id: "F1", name: "Ordering", order: 0 }],
  actors: [
    { id: "A01", name: "Customer", kind: "human", description: "Places orders." },
    { id: "A02", name: "Courier", kind: "human", description: "Delivers parcels." }
  ],
  roles: [],
  use_cases: [],
  screens: [{ id: "S01", feature_id: "F1", name: "Checkout", description: "Pay for the order.", flow_to: [], is_popup: false, tabs: ["Cart", "Payment"], primary_function_id: "FN1", queue_order: 1, detail_status: "pending" }],
  permissions: [],
  entities: [{ id: "E01", name: "Order", description: "A purchase.", relations: [] }],
  functions: [
    {
      id: "FN1",
      screen_id: "S01",
      feature_id: "F1",
      order: 0,
      name: "Place Order",
      trigger: "Customer taps Pay.",
      description: "Creates the order.",
      normal: ["Customer confirms the cart.", "System creates the order."],
      abnormal: ["Card declined: show an error."],
      validations: [{ id: "V1", kind: "required", statement: "Cart must not be empty." }],
      business_rule_ids: [],
      priority: "must"
    },
    {
      id: "FN2",
      screen_id: null,
      feature_id: "F1",
      order: 0,
      name: "Expire Carts",
      trigger: "Nightly.",
      description: "Removes stale carts.",
      normal: ["System deletes carts older than 7 days."],
      abnormal: [],
      // Cùng id validation với FN1 — key theo id function + id validation, không lẫn
      validations: [{ id: "V1", kind: "business", statement: "Only carts without payment are removed." }],
      business_rule_ids: [],
      priority: null
    }
  ],
  nfrs: [],
  business_rules: [],
  common_requirements: [],
  messages: [],
  other_requirements: [],
  glossary: [],
  addendum: [],
  custom_sections: [],
  diagrams: [{ id: "D01", kind: "erd", section: "fixed:3.1.5", owner_kind: null, owner_id: null, puml: '@startchen\nentity "Order"\n@endchen', render_status: "ok", source_hash: "h1", rendered_at: "2026-09-01T00:00:00.000Z" }],
  assumptions: [],
  decisions: [],
  flags: [],
  sections: [],
  baselines: [],
  spine_version: 3
})

/** Bản dịch giả: tiền tố `vi:` trên từng chuỗi (mảng giữ độ dài). */
const vi = (value: UnitValue): UnitValue => (typeof value === "string" ? `vi:${value}` : value.map((v) => `vi:${v}`))

const fullOverlay = (s: Spine): Map<string, UnitValue> => new Map(translationUnits(s).map((unit) => [unit.key, vi(unit.value)]))

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

describe("localizeSpine (FLF-265 D11)", () => {
  it("thay theo key: field chuỗi, mảng chuỗi, project.release_scope.in/out, validation theo id của function + validation", () => {
    const source = spine()
    const view = renderView(localizeSpine(source, translationUnits(source), fullOverlay(source)))

    expect(view.project.vision).toBe("vi:Deliver parcels the same day.")
    expect(view.project.goals).toEqual(["vi:Cut delivery time", "vi:Track every parcel"])
    expect(view.project.release_scope).toEqual({ in: ["vi:Order tracking"], out: ["vi:Refunds", "vi:Loyalty points"] })
    expect(view.actors.map((a) => [a.name, a.description])).toEqual([
      ["vi:Customer", "vi:Places orders."],
      ["vi:Courier", "vi:Delivers parcels."]
    ])
    expect(view.screens[0].tabs).toEqual(["vi:Cart", "vi:Payment"])
    expect(view.functions[0].normal).toEqual(["vi:Customer confirms the cart.", "vi:System creates the order."])
    expect(view.functions[0].validations[0].statement).toBe("vi:Cart must not be empty.")
    expect(view.functions[1].validations[0].statement).toBe("vi:Only carts without payment are removed.")

    // Không phải đơn vị dịch ⇒ giữ nguyên: id, enum, tên dự án / hệ thống, sơ đồ, số
    expect(view.project.name).toBe("Demo")
    expect(view.project.system_name).toBe("ShipFast")
    expect(view.functions.map((f) => [f.id, f.priority, f.validations[0].id, f.validations[0].kind])).toEqual([
      ["FN1", "must", "V1", "required"],
      ["FN2", null, "V1", "business"]
    ])
    expect(view.diagrams).toEqual(source.diagrams)
    expect(view.spine_version).toBe(3)
  })

  it("thiếu key ⇒ giữ chữ gốc; chỉ đúng phần tử mang id đó được thay", () => {
    const source = spine()
    const units = translationUnits(source)
    const view = renderView(
      localizeSpine(
        source,
        units,
        new Map<string, UnitValue>([
          ["actors[id=A02].name", "Người giao hàng"],
          ["functions[id=FN2].validations[id=V1].statement", "Chỉ xoá giỏ chưa thanh toán."],
          ["project.release_scope.out", ["Hoàn tiền", "Điểm thưởng"]]
        ])
      )
    )
    expect(view.actors.map((a) => a.name)).toEqual(["Customer", "Người giao hàng"])
    expect(view.functions.map((f) => f.validations[0].statement)).toEqual(["Cart must not be empty.", "Chỉ xoá giỏ chưa thanh toán."])
    expect(view.project.release_scope).toEqual({ in: ["Order tracking"], out: ["Hoàn tiền", "Điểm thưởng"] })
    expect(view.project.vision).toBe(source.project.vision)
    expect(view.functions[0].normal).toEqual(source.functions[0].normal)
  })

  it("chữ dịch lệch hình dạng (mảng khác độ dài, chuỗi thay mảng, rỗng) ⇒ giữ chữ gốc — logic theo chỉ số không lệch dòng", () => {
    const source = spine()
    const view = renderView(
      localizeSpine(
        source,
        translationUnits(source),
        new Map<string, UnitValue>([
          ["functions[id=FN1].normal", ["Chỉ một bước"]],
          ["project.goals", "Một mục tiêu"],
          ["actors[id=A01].name", "   "],
          // Key không có trong Spine (phần tử đã xoá) ⇒ bỏ qua, không ném
          ["actors[id=A99].name", "Ma"]
        ])
      )
    )
    expect(view.functions[0].normal).toEqual(source.functions[0].normal)
    expect(view.project.goals).toEqual(source.project.goals)
    expect(view.actors[0].name).toBe("Customer")
    expect(view.actors).toHaveLength(2)
  })

  it("không sửa Spine gốc (clone sâu) — Spine đóng băng vẫn dựng được bản xem", () => {
    const source = deepFreeze(spine())
    const before = JSON.stringify(source)
    const view = renderView(localizeSpine(source, translationUnits(source), fullOverlay(source)))
    expect(JSON.stringify(source)).toBe(before)
    expect(view).not.toBe(source)
    expect(view.functions[0].normal).not.toBe(source.functions[0].normal)
    expect(Object.isFrozen(view.project)).toBe(false)
  })

  it("bản xem đã dịch không gán được cho Spine (không lọt vào op-engine / check / prompt / hash)", () => {
    const source = spine()
    const localized = localizeSpine(source, translationUnits(source), fullOverlay(source))
    // @ts-expect-error — `LocalizedSpine` không phải `Spine`: chỉ `renderView` mở được, cho đường render
    const leaked: Spine = localized
    // Hàm nhận Spine cũng không nhận bản xem đã dịch — không gọi, chỉ để trình biên dịch kiểm
    const hashTranslated = () =>
      // @ts-expect-error — hash sơ đồ phải tính trên chữ gốc
      computeSourceHash(localized, { kind: "erd", owner_id: null })
    expect(hashTranslated).toBeTypeOf("function")
    // Lúc chạy bản xem cũng không lộ field nào của Spine — chỉ một khoá symbol
    expect(Object.keys(leaked)).toEqual([])
    expect(renderView(localized).project.vision).toBe("vi:Deliver parcels the same day.")
  })
})
