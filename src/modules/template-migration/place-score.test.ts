import { describe, expect, it } from "vitest"
import { classify, settleDecisions } from "./classify.js"
import { CHOVIET_DATA, CHOVIET_HEADINGS, JAM01_FILLED_FROM_SPINE, JAM01_HEADINGS } from "./choviet-jam01.fixture.js"
import { pairSections, type NewHeading } from "./pair-sections.js"
import { confidenceOf, itemTarget, rankTargets, scoreTarget } from "./place-score.js"

const run = () => {
  const pairing = pairSections(CHOVIET_HEADINGS, JAM01_HEADINGS)
  const groups = classify({ old: CHOVIET_HEADINGS, neu: JAM01_HEADINGS, pairing, oldData: CHOVIET_DATA, newFilled: JAM01_FILLED_FROM_SPINE })
  return { pairing, groups }
}
const heading = (key: string): string => JAM01_HEADINGS.find((n) => n.key === key)?.heading_text ?? key
const keyOf = (text: string): string => JAM01_HEADINGS.find((n) => n.heading_text === text)!.key

describe("place-score — golden ChoViet (FPT) ⇒ jam01 (IEEE 29148)", () => {
  const { pairing, groups } = run()
  const extraTarget = (oldKey: string) => groups.extra.find((e) => e.old_key === oldKey)?.suggested
  const conflictOf = (oldKey: string) => groups.conflict.find((c) => c.old_key === oldKey)

  it.each([
    ["o2", "1.2 Phạm vi sản phẩm"],
    ["o7", "3.1.3 Giao diện phần mềm"],
    ["o12", "3.2 Chức năng"],
    ["o18", "3.2 Chức năng"],
    ["o46", "3.2 Chức năng"],
    ["o15", "3.1.1 Giao diện người dùng"],
    ["o17", "3.3.2 Bảo mật"],
    ["o41", "3.3 Chất lượng dịch vụ"],
    ["o19", "5. Phụ lục"],
    ["o48", "5. Phụ lục"]
  ])("mục thừa %s gợi ý gộp vào %s", (oldKey, target) => {
    expect(extraTarget(oldKey)).toBe(`move_to:${keyOf(target)}`)
  })

  it("Quy tắc nghiệp vụ tổng quát ghép 2.1 Góc nhìn sản phẩm, không bao giờ heading nhóm 1. Giới thiệu", () => {
    expect(pairing.pairs.find((p) => p.old_key === "o6")?.new_key).toBe(keyOf("2.1 Góc nhìn sản phẩm"))
    expect(conflictOf("o6")).toBeUndefined()
  })

  it("4.1 Giao tiếp hệ thống ngoài: 3.1.3 Giao diện phần mềm xếp trên 3.1.2 Giao diện phần cứng", () => {
    expect(conflictOf("o39")).toMatchObject({ kind: "split_section", suggested: `to:${keyOf("3.1.3 Giao diện phần mềm")}`, suggested_reason: "best_fit" })
  })

  it("4.2.2 Độ tin cậy chia theo phần tử: NFR có uptime ⇒ 3.3.4 Tính sẵn sàng", () => {
    expect(conflictOf("o42")).toMatchObject({
      kind: "split_section",
      suggested: "distribute",
      confidence: "high",
      item_targets: [
        { id: "NFR-05", new_key: keyOf("3.3.3 Độ tin cậy") },
        { id: "NFR-06", new_key: keyOf("3.3.4 Tính sẵn sàng") }
      ]
    })
  })

  it("5.4 Yêu cầu khác ⇒ placement gợi ý 2.5 Giả định và phụ thuộc (same_data), không giữ 3.4 Tuân thủ", () => {
    const c = conflictOf("o49")
    expect(c).toMatchObject({ kind: "placement", new_key: keyOf("3.4 Tuân thủ"), suggested: `move_to:${keyOf("2.5 Giả định và phụ thuộc")}`, suggested_reason: "same_data" })
    expect(c?.choices).toContain("keep_pair")
    expect(c?.choices).not.toContain(`move_to:${keyOf("3.4 Tuân thủ")}`)
  })

  it("không mục có dữ liệu nào bị chọn sẵn Không in ra với độ tin cao", () => {
    for (const item of [...groups.extra, ...groups.conflict]) {
      if ((CHOVIET_DATA.get(item.old_key)?.size ?? 0) > 0) expect([item.suggested, item.confidence]).not.toEqual(["drop_from_print", "high"])
    }
  })

  it("Chuyển vào của Mục tiêu có 1.2 (mục đã có cặp); của ERD có 5. Phụ lục", () => {
    expect(groups.extra.find((e) => e.old_key === "o2")?.choices).toContain(`move_to:${keyOf("1.2 Phạm vi sản phẩm")}`)
    expect(groups.extra.find((e) => e.old_key === "o19")?.choices).toContain(`move_to:${keyOf("5. Phụ lục")}`)
  })

  it("mục thiếu có dữ liệu Spine (1.1 Mục đích, 2.5 Giả định) không phải Cần viết", () => {
    const filled = groups.missing.filter((m) => m.filled_from_spine).map((m) => heading(m.new_key))
    expect(filled).toEqual(["1.1 Mục đích tài liệu", "2.5 Giả định và phụ thuộc"])
    expect(groups.missing.filter((m) => m.filled_from_spine).every((m) => !m.needs_content)).toBe(true)
  })

  it("gợi ý kèm top 3 đích và cỡ dữ liệu", () => {
    const e = groups.extra.find((x) => x.old_key === "o12")!
    expect(e.targets?.length).toBe(3)
    expect(e.data_size).toBe(35)
  })

  it("cùng đầu vào ⇒ cùng kết quả", () => {
    expect(run().groups).toEqual(groups)
  })

  it("mọi dòng high đều dùng được ngay; dòng guess chặn ready tới khi BA xác nhận", () => {
    const { undecided } = settleDecisions(groups, [])
    const guesses = [...groups.extra, ...groups.conflict].filter((i) => i.confidence === "guess").map((i) => i.id)
    expect(undecided.sort()).toEqual(guesses.sort())
  })
})

describe("place-score — mẫu IEEE tiếng Anh", () => {
  const neu: NewHeading[] = [
    { key: "n0", heading_text: "3.1 External Interfaces", section_id: "unmapped", level: 2 },
    { key: "n1", heading_text: "3.1.1 User Interfaces", section_id: "fixed:3.1.2", level: 3 },
    { key: "n2", heading_text: "3.1.2 Hardware Interfaces", section_id: "fixed:4.1", level: 3 },
    { key: "n3", heading_text: "3.1.3 Software Interfaces", section_id: "fixed:4.1", level: 3 },
    { key: "n4", heading_text: "3.2 Functions", section_id: "group:3", level: 2 },
    { key: "n5", heading_text: "5 Appendix", section_id: "group:5", level: 1 }
  ]
  const targets = neu.map((n, i) => ({ ...n, has_children: (neu[i + 1]?.level ?? 0) > (n.level ?? 0) }))

  it("External Interfaces (cổng thanh toán qua API) ⇒ Software Interfaces", () => {
    const ranked = rankTargets({ heading_text: "4.1 External Interfaces", section_id: "fixed:4.1", sample: "The system integrates the payment gateway through a REST API." }, targets)
    expect(ranked[0].new_key).toBe("n3")
    expect(confidenceOf(ranked)).not.toBeNull()
  })

  it("Use Case Descriptions ⇒ Functions; Message List ⇒ Appendix", () => {
    expect(rankTargets({ heading_text: "2.2.2 Use Case Descriptions", section_id: "fixed:2.2.2" }, targets)[0].new_key).toBe("n4")
    expect(rankTargets({ heading_text: "5.3 Message List", section_id: "fixed:5.3" }, targets)[0].new_key).toBe("n5")
  })

  it("heading nhóm có mục con bị trừ điểm so với cùng mục không có mục con", () => {
    const s = { heading_text: "External Interfaces", section_id: "unmapped" }
    expect(scoreTarget(s, { ...targets[0], has_children: true }).score).toBeLessThan(scoreTarget(s, { ...targets[0], has_children: false }).score)
  })

  it("itemTarget: phần tử chỉ khớp tên đúng một mục mới phân loại", () => {
    expect(itemTarget("Uptime 99.9% per month", [{ key: "a", heading_text: "Reliability", section_id: "fixed:4.2.2" }, { key: "b", heading_text: "Availability", section_id: "fixed:4.2.2" }])).toBe("b")
    expect(itemTarget("Retry three times", [{ key: "a", heading_text: "Reliability", section_id: "fixed:4.2.2" }, { key: "b", heading_text: "Availability", section_id: "fixed:4.2.2" }])).toBeNull()
  })
})
