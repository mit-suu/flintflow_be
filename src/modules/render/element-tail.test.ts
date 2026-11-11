/** FLF-375 (B15): đuôi "Nhãn: giá trị" của phần tử trong file upload cập nhật theo phần tử, giữ định dạng file. */
import { describe, expect, it } from "vitest"
import { createEmptySpine } from "../spine/spine.repository.js"
import { elementOfKey, isLabelLine, refreshTailBlock } from "./element-tail.js"

const line = (text: string) => ({ kind: "list_item" as const, text, rows: null, image_ref: null })

describe("element-tail", () => {
  const nfr = { id: "REQ-PERF-004", statement: "Hệ thống phải lưu dữ liệu của ít nhất 5.000 học sinh trong 10 năm học.", threshold: "ít nhất 5.000 học sinh", metric: "dung lượng" }

  it("thay giá trị theo nhãn khớp trường; nhãn khác giữ nguyên", () => {
    expect(refreshTailBlock(line("Phát biểu: … và nên nhập xong tệp XLSX 2.000 dòng trong vòng 30 giây."), nfr).text).toBe(`Phát biểu: ${nfr.statement}`)
    expect(refreshTailBlock(line("Tiêu chí chấp nhận: cũ"), nfr).text).toBe("Tiêu chí chấp nhận: ít nhất 5.000 học sinh")
    expect(refreshTailBlock(line("Lý do: Nhà trường lưu hồ sơ 10 năm."), nfr).text).toBe("Lý do: Nhà trường lưu hồ sơ 10 năm.")
    expect(refreshTailBlock(line("Kiểm chứng: Test (kiểm thử tải)"), nfr).text).toBe("Kiểm chứng: Test (kiểm thử tải)")
  })

  it("chỉ dòng dạng Nhãn: giá trị là đuôi; tra phần tử theo khoá đoạn", () => {
    expect(isLabelLine(line("Phát biểu: x"))).toBe(true)
    expect(isLabelLine(line("Một câu văn xuôi không có nhãn"))).toBe(false)
    const s = createEmptySpine({ name: "QLHS" })
    s.nfrs.push(nfr as never)
    expect(elementOfKey(s, "nfrs:REQ-PERF-004")).toMatchObject({ id: "REQ-PERF-004" })
    expect(elementOfKey(s, "nfrs:REQ-INT-005")).toBeUndefined()
  })
})
