import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { checkOldValueLeft, crReplacedValues, oldValuesLeft, replacedValues, sweepOldValues } from "./old-value-left.js"
import { literalValues } from "./literal-values.js"
import { KEEPABLE_RULES, isKeepable } from "./verify.service.js"
import { createEmptySpine } from "../spine/spine.repository.js"
import type { Spine } from "../spine/spine.types.js"

/**
 * FLF-483 lỗi #32: dữ liệu thật của CR-001 (dự án nha khoa, 26/11) - FN005 và FN006 sau lượt model: chỉ Luồng ngoại lệ và
 * Tương tác đổi 4 giờ thành 6 giờ, Luồng chính bước 4 và Kiểm tra dữ liệu (FN005-V2, FN006-V3) vẫn ghi 4 giờ.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/cr-old-value-fn005-fn006.json"), "utf8")) as Record<string, Record<string, unknown>>

/** Phần tử trước CR: chỗ model đã đổi (Luồng ngoại lệ, Tương tác) còn 4 giờ. */
const beforeOf = (id: "FN005" | "FN006") => JSON.parse(JSON.stringify(DATA[id]).replace(/6 hours/g, "4 hours")) as Record<string, unknown>
const modelProposed = (id: "FN005" | "FN006") => structuredClone(DATA[id])

/** Đề xuất đúng: đổi mọi chỗ 4 giờ thành 6 giờ trong phần tử (trừ nguồn gốc). */
const fullyChanged = (id: "FN005" | "FN006") => {
  const el = structuredClone(DATA[id])
  const source = el.source_ref
  const swapped = JSON.parse(JSON.stringify({ ...el, source_ref: null }).replace(/4 hours/g, "6 hours")) as Record<string, unknown>
  swapped.source_ref = source
  return swapped
}

describe("literalValues - đơn vị thời gian Việt / Anh", () => {
  const folded = (t: string) => literalValues(t)[0]?.folded
  it("'trước 4 tiếng', '4 giờ' và 'at least 4 hours' cùng một dạng", () => {
    expect(folded("hủy trước 4 tiếng")).toBe("4 hour")
    expect(folded("hủy trước 4 giờ")).toBe("4 hour")
    expect(folded("cancelled at least 4 hours ahead")).toBe("4 hour")
  })
  it("phút, ngày, tuần, tháng, năm, giây khớp bản tiếng Anh", () => {
    expect(folded("30 phút")).toBe(folded("30 minutes"))
    expect(folded("7 ngày")).toBe(folded("7 days"))
    expect(folded("2 tuần")).toBe(folded("2 weeks"))
    expect(folded("3 tháng")).toBe(folded("3 months"))
    expect(folded("1 năm")).toBe(folded("1 year"))
    expect(folded("10 giây")).toBe(folded("10 seconds"))
  })
  it("số khác nhau thì không khớp", () => {
    expect(folded("6 tiếng")).not.toBe(folded("4 tiếng"))
  })
})

describe("oldValuesLeft - ca thật FN005 / FN006", () => {
  it("FN005: model chỉ đổi Luồng ngoại lệ ⇒ còn 4 giờ ở Luồng chính bước 4 và Kiểm tra dữ liệu", () => {
    const left = oldValuesLeft(beforeOf("FN005"), modelProposed("FN005"))
    expect(left).toHaveLength(1)
    expect(left[0].folded).toBe("4 hour")
    expect(left[0].places).toEqual(["Luồng chính bước 4", "Kiểm tra dữ liệu"])
  })

  it("FN006: còn ở Luồng chính bước 4 và Kiểm tra dữ liệu", () => {
    const left = oldValuesLeft(beforeOf("FN006"), modelProposed("FN006"))
    expect(left.map((l) => l.places)).toEqual([["Luồng chính bước 4", "Kiểm tra dữ liệu"]])
  })

  it("đổi đủ mọi chỗ ⇒ không còn sót", () => {
    expect(oldValuesLeft(beforeOf("FN005"), fullyChanged("FN005"))).toEqual([])
    expect(oldValuesLeft(beforeOf("FN006"), fullyChanged("FN006"))).toEqual([])
  })

  it("nguồn gốc (source_ref) còn '4 hours' thì không tính", () => {
    const source = "User answer: cancel at least 4 hours before is free"
    expect(oldValuesLeft({ ...beforeOf("FN005"), source_ref: source }, { ...fullyChanged("FN005"), source_ref: source })).toEqual([])
  })

  it("đề xuất không đụng giá trị nào ⇒ không lỗi (RTO của phần tử khác nghĩa không bị kéo vào)", () => {
    const before = { id: "N13", name: "Recovery", description: "Restore within 4 hours (RTO)." }
    expect(oldValuesLeft(before, { ...before, name: "Recovery time" })).toEqual([])
  })

  it("đoạn mới thêm nhắc giá trị cũ để so sánh thì không tính là sót", () => {
    const before = { id: "X", normal: ["Free if at least 4 hours ahead."] }
    const after = { id: "X", normal: ["Free if at least 6 hours ahead."], abnormal: ["Earlier the limit was 4 hours."] }
    expect(oldValuesLeft(before, after)).toEqual([])
  })

  it("replacedValues nêu cách viết thô của giá trị đã đổi", () => {
    expect([...replacedValues(beforeOf("FN005"), modelProposed("FN005")).values()]).toContain("4 hours")
  })
})

describe("checkOldValueLeft - chặn một vòng rồi hạ cảnh báo", () => {
  const spineWith = (fn: Record<string, unknown>): Spine => ({ ...createEmptySpine({ name: "P" }), functions: [fn] }) as unknown as Spine
  const location = (extra: Record<string, unknown> = {}) => ({
    location_id: "L009",
    path: "functions[id=FN005]",
    conclusion: "edit" as const,
    proposal: { old_text: JSON.stringify(beforeOf("FN005")), new_text: JSON.stringify(modelProposed("FN005")), comment_text: null, spine_ops: [], assumptions: [], proposed_at: new Date(), base_hash: null },
    ...extra
  })

  it("lượt đầu ⇒ lỗi chặn old_value_left nêu nhãn người đọc, không nêu đường dẫn", () => {
    const { violations, flags } = checkOldValueLeft(spineWith(beforeOf("FN005")), [location({ redo_count: 0, manual: false }) as never])
    expect(flags.size).toBe(0)
    const v = violations.get("L009")!
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe("old_value_left")
    expect(v[0].message).toContain("Kiểm tra dữ liệu")
    expect(v[0].message).toContain("Luồng chính bước 4")
    expect(v[0].message).not.toMatch(/\[id=|validations/)
  })

  it("AI đã làm lại một lần mà vẫn sót ⇒ hạ thành nhận xét vàng, không chặn", () => {
    const out = checkOldValueLeft(spineWith(beforeOf("FN005")), [location({ redo_count: 1 }) as never])
    expect(out.violations.size).toBe(0)
    expect(out.flags.get("L009")?.[0].rule).toBe("old_value_left")
  })

  it("sửa tay ⇒ nhận xét vàng ngay; BA đã giữ nguyên ⇒ không báo", () => {
    expect(checkOldValueLeft(spineWith(beforeOf("FN005")), [location({ manual: true }) as never]).flags.size).toBe(1)
    const kept = checkOldValueLeft(spineWith(beforeOf("FN005")), [location({ kept_violations: ["old_value_left"] }) as never])
    expect(kept.violations.size + kept.flags.size).toBe(0)
  })

  it("luật nằm trong nhóm 'Giữ nguyên, đúng ý mình'", () => {
    expect(KEEPABLE_RULES.has("old_value_left")).toBe(true)
    expect(isKeepable([{ rule: "old_value_left" }])).toBe(true)
  })

  it("đổi đủ ⇒ không lỗi", () => {
    const loc = location()
    loc.proposal.new_text = JSON.stringify(fullyChanged("FN005"))
    const out = checkOldValueLeft(spineWith(beforeOf("FN005")), [loc as never])
    expect(out.violations.size + out.flags.size).toBe(0)
  })
})

describe("sweepOldValues - lượt quét sau khi ghi", () => {
  const spine = { ...createEmptySpine({ name: "P" }), functions: [modelProposed("FN005"), modelProposed("FN006")] } as unknown as Spine
  const replaced = crReplacedValues([{ conclusion: "edit", proposal: { old_text: JSON.stringify(beforeOf("FN005")), new_text: JSON.stringify(modelProposed("FN005")) } } as never])

  it("mở hit cho phần tử còn giá trị cũ", () => {
    const hits = sweepOldValues(spine, replaced, new Set())
    expect(hits.map((h) => h.path).sort()).toEqual(["functions[id=FN005]", "functions[id=FN006]"])
    expect(hits[0].values).toContain("4 hours")
  })

  it("bỏ phần tử C-3 kết luận không liên quan", () => {
    const hits = sweepOldValues(spine, replaced, new Set(["functions[id=FN006]"]))
    expect(hits.map((h) => h.path)).toEqual(["functions[id=FN005]"])
  })

  it("không có giá trị đổi ⇒ không hit", () => {
    expect(sweepOldValues(spine, new Map(), new Set())).toEqual([])
  })
})
