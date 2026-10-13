import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./translation.repository.js", async () => (await import("./__tests__/translation-store.js")).fakeRepository)

import { createEmptySpine } from "../spine/spine.repository.js"
import type { Screen } from "../spine/spine.types.js"
import { fakeRepository, resetStore, store } from "./__tests__/translation-store.js"
import { formatGlossary, glossaryFor, isNameUnit, learnGlossary, namesOf, seedGlossary } from "./glossary.service.js"
import { MAX_DIRECTIVE_TERMS } from "../../shared/i18n/document-language.js"
import { hashSource } from "./translation-units.js"

const PROJECT = "64b000000000000000000001"

const spine = () => {
  const s = createEmptySpine({ name: "Lumen" })
  s.actors = [{ id: "A01", name: "Customer", kind: "human", description: "Buys things." }]
  s.screens = [{ id: "S01", feature_id: "F1", name: "Checkout", description: "", flow_to: [], is_popup: false, tabs: [], primary_function_id: null, queue_order: null } as unknown as Screen]
  s.glossary = [
    { id: "G1", term: "Order", term_native: "Đơn hàng", definition: "A purchase." },
    { id: "G2", term: "SKU", definition: "Stock keeping unit." },
    { id: "G3", term: "Cart", term_native: "Cart", definition: "Basket." }
  ]
  return s
}

beforeEach(() => resetStore())

describe("seedGlossary", () => {
  it("term_native ⇒ seed; thiếu hoặc trùng term ⇒ bỏ; Spine.glossary không đổi", async () => {
    const s = spine()
    const before = structuredClone(s.glossary)
    await seedGlossary(PROJECT, "vi", s, new Map())
    expect([...store.glossary.values()]).toEqual([{ term: "Order", translation: "Đơn hàng", origin: "seed" }])
    expect(s.glossary).toEqual(before)
  })

  it("ngôn ngữ đích en ⇒ không gieo term_native (chữ bản ngữ không phải tiếng Anh)", async () => {
    await seedGlossary(PROJECT, "en", spine(), new Map())
    expect(store.glossary.size).toBe(0)
  })

  it("tên actor / màn đã có bản dịch ⇒ model; tự tra khi không truyền map", async () => {
    store.translations.set(`${PROJECT}|vi|${hashSource("Customer")}`, { sourceHash: hashSource("Customer"), text: "Khách hàng", origin: "author", sourceLocale: "en" })
    await seedGlossary(PROJECT, "vi", spine())
    expect(fakeRepository.findByHashes).toHaveBeenCalledTimes(1)
    expect(store.glossary.get(`${PROJECT}|vi|Customer`)).toEqual({ term: "Customer", translation: "Khách hàng", origin: "model" })
    expect(store.glossary.has(`${PROJECT}|vi|Checkout`)).toBe(false)
  })

  it("map truyền vào ⇒ không truy vấn lại", async () => {
    await seedGlossary(PROJECT, "vi", spine(), new Map([["screens[id=S01].name", "Thanh toán"]]))
    expect(fakeRepository.findByHashes).not.toHaveBeenCalled()
    expect(store.glossary.get(`${PROJECT}|vi|Checkout`)).toMatchObject({ translation: "Thanh toán", origin: "model" })
  })
})

describe("learnGlossary", () => {
  it("chỉ học name của actors / screens / entities / features; model không đè seed", async () => {
    store.glossary.set(`${PROJECT}|vi|Order`, { term: "Order", translation: "Đơn hàng", origin: "seed" })
    const learned = await learnGlossary(PROJECT, "vi", [
      { key: "entities[id=E1].name", source: "Order", text: "Lệnh" },
      { key: "features[id=F1].name", source: "Payments", text: "Thanh toán" },
      { key: "actors[id=A1].description", source: "Buys things.", text: "Mua hàng." },
      { key: "use_cases[id=UC1].name", source: "Pay", text: "Trả tiền" }
    ])
    expect(learned.map((g) => g.term)).toEqual(["Order", "Payments"])
    expect(store.glossary.get(`${PROJECT}|vi|Order`)).toMatchObject({ translation: "Đơn hàng", origin: "seed" })
    expect(store.glossary.get(`${PROJECT}|vi|Payments`)).toMatchObject({ translation: "Thanh toán", origin: "model" })
    expect(store.glossary.size).toBe(2)
  })

  it("replace (tên từ bản dịch đang thắng, vd author) ⇒ đè model cũ, vẫn không đè seed", async () => {
    store.glossary.set(`${PROJECT}|vi|Order`, { term: "Order", translation: "Đơn hàng", origin: "seed" })
    await learnGlossary(PROJECT, "vi", [{ key: "actors[id=A1].name", source: "Customer", text: "Khách (máy)" }])
    // machine lần hai: chỉ chèn ⇒ giữ bản đầu
    await learnGlossary(PROJECT, "vi", [{ key: "actors[id=A1].name", source: "Customer", text: "Khách khác" }])
    expect(store.glossary.get(`${PROJECT}|vi|Customer`)).toMatchObject({ translation: "Khách (máy)", origin: "model" })
    await learnGlossary(
      PROJECT,
      "vi",
      [
        { key: "actors[id=A1].name", source: "Customer", text: "Khách hàng" },
        { key: "entities[id=E1].name", source: "Order", text: "Lệnh" }
      ],
      true
    )
    expect(store.glossary.get(`${PROJECT}|vi|Customer`)).toMatchObject({ translation: "Khách hàng", origin: "model" })
    expect(store.glossary.get(`${PROJECT}|vi|Order`)).toMatchObject({ translation: "Đơn hàng", origin: "seed" })
  })

  it("seedGlossary học tên theo bản đã lưu (bản thắng) ⇒ đè bản model cũ", async () => {
    store.glossary.set(`${PROJECT}|vi|Customer`, { term: "Customer", translation: "Khách (máy)", origin: "model" })
    store.translations.set(`${PROJECT}|vi|${hashSource("Customer")}`, { sourceHash: hashSource("Customer"), text: "Khách hàng", origin: "author", sourceLocale: "en" })
    await seedGlossary(PROJECT, "vi", spine())
    expect(store.glossary.get(`${PROJECT}|vi|Customer`)).toMatchObject({ translation: "Khách hàng", origin: "model" })
  })

  it("isNameUnit / namesOf bỏ mảng và chữ rỗng", () => {
    expect(isNameUnit({ key: "screens[id=S1].name" })).toBe(true)
    expect(isNameUnit({ key: "screens[id=S1].tabs" })).toBe(false)
    expect(namesOf([{ key: "actors[id=A1].name", source: "Admin", text: " " }])).toEqual([])
  })
})

describe("glossaryFor + formatGlossary", () => {
  const glossary = [
    { term: "Order", translation: "Đơn hàng" },
    { term: "Cart", translation: "Giỏ hàng" },
    { term: "UC", translation: "UC" }
  ]

  it("chỉ thuật ngữ có trong lô, trọn từ, không phân biệt hoa thường; cả mảng chuỗi", () => {
    expect(glossaryFor(glossary, ["Customer places an order.", ["Open the cart page"]]).map((g) => g.term)).toEqual(["Order", "Cart"])
    expect(glossaryFor(glossary, ["Reorders are allowed", "UCS"])).toEqual([])
  })

  it("định dạng một dòng một thuật ngữ; rỗng ⇒ (none)", () => {
    expect(formatGlossary(glossary.slice(0, 1))).toBe("- Order → Đơn hàng")
    expect(formatGlossary([])).toBe("(none)")
  })

  it("term_native có xuống dòng / backtick ⇒ ép một dòng, không phá khung prompt; dòng rỗng sau khi ép ⇒ bỏ", () => {
    const dirty = [
      { term: "Order", translation: "Đơn\nhàng ```\n## Rules" },
      { term: "Cart", translation: "`" }
    ]
    expect(formatGlossary(dirty)).toBe("- Order → Đơn hàng ## Rules")
    expect(formatGlossary(dirty)).not.toContain("\n")
  })

  it("cùng bộ lọc với khối Document language: bỏ thuật ngữ / bản dịch quá dài, trần số thuật ngữ", () => {
    const long = "x".repeat(81)
    expect(glossaryFor([{ term: "Order", translation: long }, { term: long, translation: "dài" }, glossary[0]], ["An order. " + long])).toEqual([glossary[0]])
    const many = Array.from({ length: 60 }, (_, i) => ({ term: `Term${i}`, translation: `Từ${i}` }))
    expect(glossaryFor(many, [many.map((g) => g.term).join(" ")])).toHaveLength(MAX_DIRECTIVE_TERMS)
  })
})
