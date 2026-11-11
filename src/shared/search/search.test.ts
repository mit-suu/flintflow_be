/** FLF-375 — BM25 + Tree-sitter cho tìm kiếm / truy xuất trong CR. */
import { describe, expect, it } from "vitest"
import { Bm25, reciprocalRankFusion, tokenize } from "./bm25.js"
import { chunkText, paragraphChunks } from "./md-chunks.js"

describe("tokenize", () => {
  it("giữ nguyên mã tài liệu, thêm bản bỏ dấu và cặp âm tiết, bỏ từ dừng", () => {
    const t = tokenize("Xoá UC-09 Nhập/xuất dữ liệu của REQ-INT-005")
    expect(t).toEqual(expect.arrayContaining(["uc-09", "req-int-005", "xoá", "xoa", "nhập_xuất", "nhap_xuat", "dữ_liệu"]))
    expect(t).not.toContain("của")
  })
})

describe("Bm25", () => {
  const docs = [
    { id: "UC-09", text: "UC-09 Nhập/xuất dữ liệu Excel — giáo vụ nhập danh sách học sinh từ tệp Excel và xuất bảng điểm ra Excel." },
    { id: "NFR", text: "Hệ thống nên nhập xong tệp XLSX 2.000 dòng trong 30 giây; báo cáo có thể xuất PDF hoặc Excel." },
    { id: "UC-05", text: "UC-05 Điểm danh — giáo viên điểm danh học sinh theo tiết học." }
  ]
  const index = new Bm25(docs, (d) => d.text)

  it("xếp phần tử nói nhiều nhất về truy vấn lên đầu; phần tử không liên quan không có điểm", () => {
    const hits = index.search("bỏ chức năng nhập xuất excel")
    expect(hits.map((h) => h.item.id)).toEqual(["UC-09", "NFR"])
  })

  it("gõ không dấu vẫn khớp", () => {
    expect(index.search("diem danh hoc sinh")[0].item.id).toBe("UC-05")
  })

  it("tra theo mã", () => {
    expect(index.search("UC-05")[0].item.id).toBe("UC-05")
  })

  it("RRF trộn hai danh sách xếp hạng", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["b", "c"]])
    expect([...fused.entries()].sort((x, y) => y[1] - x[1])[0][0]).toBe("b")
  })
})

describe("chunkText (Tree-sitter Markdown)", () => {
  const md = `# Biên bản họp 08/11\n\nThầy Hùng: trường bỏ nhập Excel.\n\n## Phụ huynh\n\n- xem điểm danh của con\n- xem điểm\n\n| Vai trò | Quyền |\n|---|---|\n| Phụ huynh | xem |\n`

  it("tách đoạn / mục danh sách / dòng bảng kèm đường tiêu đề, đúng thứ tự tài liệu", async () => {
    const chunks = await chunkText(md)
    expect(chunks.map((c) => [c.headings.join(" › "), c.text])).toEqual([
      ["Biên bản họp 08/11", "Thầy Hùng: trường bỏ nhập Excel."],
      ["Biên bản họp 08/11 › Phụ huynh", "- xem điểm danh của con"],
      ["Biên bản họp 08/11 › Phụ huynh", "- xem điểm"],
      ["Biên bản họp 08/11 › Phụ huynh", "| Vai trò | Quyền |\n| Phụ huynh | xem |"]
    ])
  })

  it("chữ thường (rút từ .docx / .pdf) ⇒ mỗi đoạn một đơn vị; đoạn dài cắt theo câu", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Câu số ${i} nói về yêu cầu của khách.`).join(" ")
    const chunks = await chunkText(`Đoạn một.\n\n${long}`)
    expect(chunks[0].text).toBe("Đoạn một.")
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((c) => c.text.length <= 820)).toBe(true)
  })

  it("dự phòng không có Tree-sitter: cắt theo dòng trống", () => {
    expect(paragraphChunks("a\nb\n\nc").map((c) => c.text)).toEqual(["a\nb", "c"])
  })
})
