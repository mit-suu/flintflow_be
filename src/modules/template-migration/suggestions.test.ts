import { describe, expect, it } from "vitest"
import { classify, decidableItems, settleDecisions, type TableShape, type TableShapes } from "./classify.js"
import { pairSections, type NewHeading, type OldHeading } from "./pair-sections.js"
import { buildOutline } from "./outline.js"

const old = (key: string, heading_text: string, level: number, section_id = key): OldHeading => ({ key, heading_text, level, section_id })
const neu = (index: number, heading_text: string, section_id: string, level?: number): NewHeading => ({ key: `n${index}`, heading_text, section_id, ...(level !== undefined ? { level } : {}) })
const tables = (entries: Record<string, TableShape[]>): TableShapes => new Map(Object.entries(entries))

const run = (oldDoc: OldHeading[], newDoc: NewHeading[], extra: { oldTables?: TableShapes; newTables?: TableShapes } = {}) => {
  const pairing = pairSections(oldDoc, newDoc)
  return { pairing, groups: classify({ old: oldDoc, neu: newDoc, pairing, ...extra }) }
}

/**
 * Ca thật CHỢVIỆT (DB dev 19/11, lần đổi mẫu `6afea113…`): nạp lại chính file xuất của dự án, đã xoá 4.2.3 trong file. File mẫu gán
 * `fixed:1` cho cả "Quy tắc nghiệp vụ tổng quát" và "Hệ thống bên ngoài"; "Trong / Ngoài phạm vi" cùng `slot:scope` với cha.
 */
const choVietOld = [
  old("fixed:I", "I. Lịch sử thay đổi", 1),
  old("custom:CS01", "1 Tổng quan sản phẩm", 1),
  old("slot:goals", "Mục tiêu", 2),
  old("slot:scope", "Phạm vi phát hành 1.0", 2),
  old("custom:CS02", "", 3),
  old("fixed:1", "Quy tắc nghiệp vụ tổng quát", 2),
  old("custom:CS05", "Hệ thống bên ngoài", 2),
  old("group:2", "2 Yêu cầu người dùng", 1),
  old("fixed:2.1", "2.1 Tác nhân", 2),
  old("group:4", "4 Yêu cầu phi chức năng", 1),
  old("group:4.2", "4.2 Thuộc tính chất lượng", 2),
  old("fixed:4.2.1", "4.2.1 Tính khả dụng", 3),
  old("fixed:4.2.2", "4.2.2 Độ tin cậy", 3),
  old("fixed:4.2.3", "4.2.3 Hiệu năng", 3),
  old("fixed:4.2.4", "4.2.4 Thuộc tính đặc thù", 3),
  old("fixed:3.1.3", "3.1.3 Phân quyền màn hình", 3)
]
const choVietNew = [
  neu(0, "I. Lịch sử thay đổi", "fixed:I", 1),
  neu(1, "1 Tổng quan sản phẩm", "unmapped", 1),
  neu(2, "Mục tiêu", "slot:goals", 2),
  neu(3, "Phạm vi phát hành 1.0", "slot:scope", 2),
  neu(4, "Trong phạm vi", "slot:scope", 3),
  neu(5, "Ngoài phạm vi", "slot:scope", 3),
  neu(6, "Quy tắc nghiệp vụ tổng quát", "fixed:1", 2),
  neu(7, "Hệ thống bên ngoài", "fixed:1", 2),
  neu(8, "2 Yêu cầu người dùng", "group:2", 1),
  neu(9, "2.1 Tác nhân", "fixed:2.1", 2),
  neu(10, "4 Yêu cầu phi chức năng", "group:4", 1),
  neu(11, "4.2 Thuộc tính chất lượng", "group:4.2", 2),
  neu(12, "4.2.1 Tính khả dụng", "fixed:4.2.1", 3),
  neu(13, "4.2.2 Độ tin cậy", "fixed:4.2.2", 3),
  neu(14, "4.2.4 Thuộc tính đặc thù", "fixed:4.2.4", 3),
  neu(15, "3.1.3 Phân quyền màn hình", "fixed:3.1.3", 3)
]
// Ma trận phân quyền: bên dự án đã map cột vai trò vào field, bên mẫu đích chỉ có chữ tiêu đề
const permOld: TableShape = { columns: ["permissions[].screen_id", "permissions[].role_id", "permissions[].role_id"], headers: ["Màn hình", "Người mua", "Người bán"] }
const permNew: TableShape = { columns: ["h:man hinh", "h:khach vang lai", "h:quan tri vien san"], headers: ["Màn hình", "Khách vãng lai", "Quản trị viên sàn"] }

describe("nạp lại chính file xuất (CHỢVIỆT, bỏ 4.2.3)", () => {
  const { pairing, groups } = run(choVietOld, choVietNew, { oldTables: tables({ "fixed:3.1.3": [permOld] }), newTables: tables({ "fixed:3.1.3": [permNew] }) })

  it("heading trùng y hệt tên thắng section_id; heading con cùng mục không thành split", () => {
    expect(pairing.pairs.find((p) => p.old_key === "custom:CS05")).toMatchObject({ new_key: "n7", by: "title" })
    expect(pairing.pairs.find((p) => p.old_key === "fixed:1")).toMatchObject({ new_key: "n6", by: "section_id" })
    expect(pairing.split).toEqual([])
    expect(pairing.children).toEqual(["n4", "n5"])
  })

  it("chỉ đúng 1 dòng cần xem: 4.2.3, chọn sẵn Không in ra, không có dòng đoán", () => {
    expect(groups.extra.map((e) => [e.id, e.suggested, e.confidence])).toEqual([["e:fixed:4.2.3", "drop_from_print", "high"]])
    expect(groups.conflict).toEqual([])
    expect(groups.missing).toEqual([])
    expect(settleDecisions(groups, []).undecided).toEqual([])
  })

  it("dàn tiêu đề: 4.2.3 đỏ nằm giữa 4.2.2 và 4.2.4, kèm nội dung sẽ không in", () => {
    const spine = { custom_sections: [], nfrs: [{ id: "NFR-17", category: "performance", statement: "Trang chủ tải dưới 2 giây" }, { id: "NFR-03", category: "usability", statement: "Không tính" }] }
    const outline = buildOutline({ old: choVietOld, neu: choVietNew, pairing, groups, decisions: [], spine: spine as never })
    const titles = outline.map((o) => o.heading_text)
    expect(titles.indexOf("4.2.3 Hiệu năng")).toBe(titles.indexOf("4.2.2 Độ tin cậy") + 1)
    expect(outline.find((o) => o.heading_text === "4.2.3 Hiệu năng")).toMatchObject({ status: "dropped", dropped_items: [{ id: "NFR-17", text: "Trang chủ tải dưới 2 giây" }], dropped_total: 1 })
    expect(outline.filter((o) => o.status !== "kept").map((o) => o.heading_text)).toEqual(["4.2.3 Hiệu năng"])
    expect(outline.some((o) => o.dropped_items && o.status !== "dropped")).toBe(false)
  })

  it("dàn tiêu đề: heading con cùng mục (Trong / Ngoài phạm vi) hiện gộp vào mục cha, vẫn chấm xám", () => {
    const outline = buildOutline({ old: choVietOld, neu: choVietNew, pairing, groups, decisions: [] })
    expect(outline.filter((o) => o.merged_into !== undefined).map((o) => [o.heading_text, o.status, o.merged_into])).toEqual([
      ["Trong phạm vi", "kept", "Phạm vi phát hành 1.0"],
      ["Ngoài phạm vi", "kept", "Phạm vi phát hành 1.0"]
    ])
  })

  it("bản ghi cũ không có children ⇒ không dòng nào gộp", () => {
    const { children: _children, ...legacy } = pairing
    const outline = buildOutline({ old: choVietOld, neu: choVietNew, pairing: legacy, groups, decisions: [] })
    expect(outline.some((o) => o.merged_into !== undefined)).toBe(false)
  })
})

describe("cột vai trò của bảng phân quyền màn hình", () => {
  it("vai trò khác nhau giữa dự án và mẫu không gây conflict bảng", () => {
    const { groups } = run([old("fixed:3.1.3", "3.1.3 Screen Authorization", 3)], [neu(0, "3.1.3 Screen Authorization", "fixed:3.1.3")], { oldTables: tables({ "fixed:3.1.3": [permOld] }), newTables: tables({ "fixed:3.1.3": [{ columns: ["h:man hinh", "h:admin"], headers: ["Màn hình", "Admin"] }] }) })
    expect(groups.conflict).toEqual([])
  })

  it("hai bên đều có cột vai trò chưa gán field (h:<tên vai trò>) ⇒ không conflict bảng (lỗi #2 test FLF-447)", () => {
    const oldShape: TableShape = { columns: ["h:man hinh", "h:nguoi mua", "h:nguoi ban", "h:quan tri vien"], headers: ["Màn hình", "Người mua", "Người bán", "Quản trị viên"] }
    const { groups } = run([old("fixed:3.1.3", "3.1.3 Phân quyền màn hình", 2)], [neu(0, "3.1.3 Phân quyền màn hình", "fixed:3.1.3", 2)], { oldTables: tables({ "fixed:3.1.3": [oldShape] }), newTables: tables({ "fixed:3.1.3": [permNew] }) })
    expect(groups.conflict).toEqual([])
  })

  it("cột khung đứng trước cột màn hình vẫn được so", () => {
    const withNo: TableShape = { columns: ["h:stt", "permissions[].screen_id", "h:nguoi mua"], headers: ["STT", "Màn hình", "Người mua"] }
    const { groups } = run([old("fixed:3.1.3", "3.1.3 Phân quyền màn hình", 2)], [neu(0, "3.1.3 Phân quyền màn hình", "fixed:3.1.3", 2)], { oldTables: tables({ "fixed:3.1.3": [withNo] }), newTables: tables({ "fixed:3.1.3": [permNew] }) })
    expect(groups.conflict.map((c) => c.kind)).toEqual(["table_columns"])
  })

  it("thiếu hẳn cột màn hình ở mẫu đích vẫn là conflict", () => {
    const { groups } = run([old("fixed:3.1.3", "3.1.3 Screen Authorization", 3)], [neu(0, "3.1.3 Screen Authorization", "fixed:3.1.3")], { oldTables: tables({ "fixed:3.1.3": [permOld] }), newTables: tables({ "fixed:3.1.3": [{ columns: ["h:chuc nang"], headers: ["Chức năng"] }] }) })
    expect(groups.conflict.map((c) => [c.kind, c.suggested, c.suggested_reason])).toEqual([["table_columns", "map_by_header", "map_columns"]])
  })
})

describe("lựa chọn chọn sẵn theo từng loại", () => {
  it("bảng khác cột ⇒ xếp theo cột mới; mẫu mới không có bảng ⇒ giữ bảng cũ; Record of Changes ⇒ chuyển lịch sử; tách ⇒ heading hợp nghĩa", () => {
    const { groups } = run(
      [old("fixed:I", "I. Record of Changes", 1), old("fixed:2.1", "2.1 Actors", 2), old("fixed:5.2", "5.2 Common", 2), old("fixed:4.2.2", "4.2.2 Reliability", 3)],
      [neu(0, "Revision History", "fixed:I"), neu(1, "2.1 Actors", "fixed:2.1"), neu(2, "5.2 Common", "fixed:5.2"), neu(3, "Reliability", "fixed:4.2.2"), neu(4, "Availability", "fixed:4.2.2")],
      {
        oldTables: tables({ "fixed:I": [{ columns: ["h:a"] }], "fixed:2.1": [{ columns: ["h:actor"] }], "fixed:5.2": [{ columns: ["h:x"] }] }),
        newTables: tables({ "fixed:I": [{ columns: ["h:b"] }], "fixed:2.1": [{ columns: ["h:actor", "h:role"] }] })
      }
    )
    expect(groups.conflict.map((c) => [c.id, c.suggested, c.suggested_reason, c.confidence])).toEqual([
      ["c:record_of_changes:fixed:I", "map_by_header", "keep_history", "high"],
      ["c:table_columns:fixed:2.1", "map_by_header", "map_columns", "high"],
      ["c:table_columns:fixed:5.2", "keep_old_table", "no_table_in_new", "high"],
      ["c:split_section:fixed:4.2.2", "to:n3", "best_fit", "high"]
    ])
  })

  it("Record of Changes mất ở mẫu mới ⇒ Không in ra (dữ liệu giữ)", () => {
    const { groups } = run([old("fixed:I", "I. Record of Changes", 1)], [neu(0, "1 Introduction", "fixed:1")])
    expect(groups.conflict[0]).toMatchObject({ suggested: "drop_from_print", confidence: "high" })
  })

  it("không bao giờ chọn sẵn ai_resolve hay lựa chọn cần AI", () => {
    const { groups } = run(
      [old("group:4", "4 NFR", 1), old("custom:c1", "Legacy appendix", 2), old("fixed:I", "I. Record of Changes", 1)],
      [neu(0, "4 NFR", "group:4", 1), neu(1, "4.2.3 Performance", "fixed:4.2.3", 2)]
    )
    for (const item of [...groups.extra, ...groups.conflict]) {
      expect(item.suggested).not.toBe("ai_resolve")
      expect(item.ai_choices).not.toContain(item.suggested)
    }
    // mục chữ tự do chuyển vào mục có cấu trúc cần AI ⇒ không đoán, Không in ra
    expect(groups.extra.find((e) => e.id === "e:custom:c1")).toMatchObject({ suggested: "drop_from_print", confidence: "high" })
    for (const item of decidableItems(groups).values()) expect(item.default).not.toBe("ai_resolve")
  })
})

describe("gợi ý Chuyển vào theo nghĩa (place-score)", () => {
  const baseOld = [old("group:4.2", "4.2 Quality Attributes", 2), old("slot:security", "4.2.4 Security", 3)]
  const baseNew = [neu(0, "4.2 Quality Attributes", "group:4.2", 2), neu(1, "4.2.5 Security requirements", "fixed:4.2.4", 3)]

  it("mục mẫu nói đúng khái niệm, hơn hẳn hạng hai ⇒ chọn sẵn (high), không chặn ready", () => {
    const { groups } = run(baseOld, baseNew)
    expect(groups.extra[0]).toMatchObject({ suggested: "move_to:n1", confidence: "high", suggested_reason: "best_fit" })
    expect(groups.extra[0].targets?.[0]).toMatchObject({ new_key: "n1" })
    expect(settleDecisions(groups, []).undecided).toEqual([])
  })

  it("không mục nào hợp nghĩa, mục không có dữ liệu ⇒ Không in ra", () => {
    const { groups } = run(baseOld, [neu(0, "4.2 Quality Attributes", "group:4.2", 2), neu(1, "4.2.5 Specific attributes", "fixed:4.2.4", 3)])
    expect(groups.extra[0]).toMatchObject({ suggested: "drop_from_print", confidence: "high", suggested_reason: "no_place" })
  })

  it("không mục nào hợp nghĩa nhưng mục có dữ liệu ⇒ giữ thành mục riêng (guess), không bao giờ Không in ra độ tin cao", () => {
    const pairing = pairSections(baseOld, [neu(0, "4.2 Quality Attributes", "group:4.2", 2), neu(1, "4.2.5 Specific attributes", "fixed:4.2.4", 3)])
    const groups = classify({ old: baseOld, neu: [neu(0, "4.2 Quality Attributes", "group:4.2", 2), neu(1, "4.2.5 Specific attributes", "fixed:4.2.4", 3)], pairing, oldData: new Map([["slot:security", { size: 3, sample: "" }]]) })
    expect(groups.extra[0]).toMatchObject({ suggested: "keep_custom", confidence: "guess", suggested_reason: "kept_for_data", data_size: 3 })
    expect(settleDecisions(groups, []).undecided).toEqual(["e:slot:security"])
  })

  it("khác nhóm cha vẫn gợi ý được (nghĩa quyết định, không phải vị trí)", () => {
    const { groups } = run(baseOld, [neu(0, "4.2 Quality Attributes", "group:4.2", 2), neu(2, "5 Appendix", "group:5", 2), neu(1, "5.9 Security requirements", "fixed:4.2.4", 3)])
    expect(groups.extra[0]).toMatchObject({ suggested: "move_to:n1" })
  })

  it("mục đích đã có cặp vẫn nhận được phần gộp (N mục cũ ⇒ 1 mục mới)", () => {
    const { groups } = run([...baseOld, old("fixed:4.2.4", "4.2.4 Other", 3)], baseNew)
    expect(groups.extra.find((e) => e.id === "e:slot:security")).toMatchObject({ suggested: "move_to:n1" })
  })
})
