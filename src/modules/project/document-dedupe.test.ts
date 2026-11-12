import { describe, expect, it } from "vitest"
import {
  baseNameOf,
  contentHashOf,
  contentSimilarity,
  findDuplicate,
  findVersionCandidates,
  SIMILARITY_THRESHOLD,
  type ExistingDocument
} from "./document-dedupe.js"

const doc = (over: Partial<ExistingDocument> & { id: string; name: string }): ExistingDocument => ({
  docCode: Number(over.id.replace(/\D/g, "")) || 1,
  contentHash: null,
  extractedText: null,
  supersededBy: null,
  ...over
})

describe("FLF-398 - tên gốc (bỏ dấu phiên bản cuối tên)", () => {
  it.each([
    ["SRS_KhachHang_v1.docx", "srs khachhang"],
    ["SRS_KhachHang_v2.docx", "srs khachhang"],
    ["SRS KhachHang v2 (1).docx", "srs khachhang"],
    ["srs-khachhang-final.docx", "srs khachhang"],
    ["SRS_KhachHang_V1.0.docx", "srs khachhang"],
    ["SRS_KhachHang v2.1.3.pdf", "srs khachhang"],
    ["SRS_KhachHang_ver2.docx", "srs khachhang"],
    ["SRS KhachHang version 3.docx", "srs khachhang"],
    ["SRS_KhachHang_rev3.docx", "srs khachhang"],
    ["SRS_KhachHang - Copy.docx", "srs khachhang"],
    ["SRS_KhachHang - Copy (2).docx", "srs khachhang"],
    ["SRS_KhachHang_20261111.docx", "srs khachhang"],
    ["SRS_KhachHang_2026-11-11.docx", "srs khachhang"],
    ["SRS_KhachHang_11-11-2026.docx", "srs khachhang"],
    ["SRS_KhachHang_draft.docx", "srs khachhang"],
    ["Yêu cầu khách hàng bản 2.docx", "yeu cau khach hang"],
    ["Yêu_cầu_khách_hàng_lần_2.md", "yeu cau khach hang"],
    ["Biên bản họp (1).txt", "bien ban hop"]
  ])("%s ⇒ %s", (name, base) => {
    expect(baseNameOf(name)).toBe(base)
  })

  it("chữ thật ở cuối tên không bị bỏ; tên chỉ có dấu phiên bản giữ nguyên", () => {
    expect(baseNameOf("YeuCau_T10.docx")).toBe("yeucau t10")
    expect(baseNameOf("YeuCau_T11.docx")).toBe("yeucau t11")
    expect(baseNameOf("Draft.docx")).toBe("draft")
    expect(baseNameOf("v1.docx")).toBe("v1")
    expect(baseNameOf("Sprint 2 report.pdf")).toBe("sprint 2 report")
  })
})

describe("FLF-398 - độ giống nội dung", () => {
  const V1 = "Mục tiêu\n\nKhách hàng đặt hàng online.\n\nThanh toán trong 3 giây.\n\nAdmin duyệt đơn."
  it("giống hệt ⇒ 1; sửa một đoạn ⇒ vẫn trên ngưỡng; khác hẳn ⇒ 0", () => {
    expect(contentSimilarity(V1, V1)).toBe(1)
    const v2 = V1.replace("3 giây", "2 giây")
    expect(contentSimilarity(V1, v2)).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD)
    expect(contentSimilarity(V1, "Hoá đơn tháng 10\n\nTổng: 5 triệu")).toBe(0)
    expect(contentSimilarity(V1, "")).toBe(0)
  })
})

describe("FLF-398 - trùng hệt", () => {
  it("cùng hash với bản đang dùng ⇒ trùng; khác hash ⇒ không", () => {
    const hash = contentHashOf(Buffer.from("abc"))
    const existing = [doc({ id: "d1", name: "a.txt", contentHash: hash })]
    expect(findDuplicate(existing, hash, "abc")).toEqual({ document: { id: "d1", name: "a.txt", doc_code: 1 }, supersededBy: null })
    expect(findDuplicate(existing, contentHashOf(Buffer.from("abd")), "abd")).toBeNull()
  })

  it("tài liệu cũ chưa có hash ⇒ so chữ đã đọc", () => {
    const existing = [doc({ id: "d1", name: "legacy.txt", extractedText: "Ghi chú cũ\r\n" })]
    expect(findDuplicate(existing, "h", "Ghi chú cũ")?.document.id).toBe("d1")
    expect(findDuplicate(existing, "h", null)).toBeNull()
  })

  it("trùng bản đã bị thay ⇒ kèm bản đang dùng ở cuối chuỗi thay (v1 ← v2 ← v3)", () => {
    const existing = [
      doc({ id: "d1", name: "srs_v1.docx", contentHash: "h1", supersededBy: "d2" }),
      doc({ id: "d2", name: "srs_v2.docx", contentHash: "h2", supersededBy: "d3" }),
      doc({ id: "d3", name: "srs_v3.docx", contentHash: "h3" })
    ]
    expect(findDuplicate(existing, "h1", null)).toEqual({
      document: { id: "d1", name: "srs_v1.docx", doc_code: 1 },
      supersededBy: { id: "d3", name: "srs_v3.docx", doc_code: 3 }
    })
  })
})

describe("FLF-398 - ứng viên bản mới", () => {
  const TEXT = "Mục tiêu\n\nKhách hàng đặt hàng online.\n\nThanh toán trong 3 giây.\n\nAdmin duyệt đơn."
  it("cùng tên gốc ⇒ ứng viên dù nội dung khác hẳn; tên khác + nội dung giống ≥ ngưỡng ⇒ ứng viên; còn lại thì không", () => {
    const existing = [
      doc({ id: "d1", name: "SRS_KhachHang_v1.docx", extractedText: "Khác hẳn" }),
      doc({ id: "d2", name: "Draft.docx", extractedText: TEXT }),
      doc({ id: "d3", name: "Email.txt", extractedText: "Chỉ nhận thanh toán online." })
    ]
    const v2 = TEXT.replace("3 giây", "2 giây")
    expect(findVersionCandidates(existing, "SRS_KhachHang_v2.docx", v2).map((c) => [c.id, c.reason])).toEqual([
      ["d1", "same_name"],
      ["d2", "similar_content"]
    ])
    expect(findVersionCandidates(existing, "Final.docx", v2).map((c) => c.id)).toEqual(["d2"])
    expect(findVersionCandidates(existing, "Bao_gia.pdf", "Báo giá 10 triệu")).toEqual([])
  })

  it("bản đã bị thay không là ứng viên (v2 đã thay v1, tải v3 ⇒ chỉ hỏi v2)", () => {
    const existing = [
      doc({ id: "d1", name: "srs_v1.docx", supersededBy: "d2" }),
      doc({ id: "d2", name: "srs_v2.docx" })
    ]
    expect(findVersionCandidates(existing, "srs_v3.docx", null).map((c) => c.id)).toEqual(["d2"])
  })
})
