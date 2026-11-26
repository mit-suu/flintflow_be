import { describe, expect, it } from "vitest"
import { localizeChangeText } from "./preview-localize.js"
import type { Spine } from "./spine.types.js"

const view = { actors: [{ id: "A01", name: "Bệnh nhân", description: "Người đặt lịch khám." }], project: { vision: "Đặt lịch khám online." } } as unknown as Spine

describe("localizeChangeText - chữ hộp xem trước theo ngôn ngữ tài liệu (FLF-479 #6)", () => {
  it("value lấy từ localized cùng path, before lấy từ Spine đã dịch", () => {
    const change = { path: "actors[id=A01].description", before: "Books visits.", value: "Books and cancels visits." }
    const out = localizeChangeText(change, view, [{ path: "actors[id=A01].description", value: "Đặt và huỷ lịch khám." }])
    expect(out.value).toBe("Đặt và huỷ lịch khám.")
    expect(out.before).toBe("Người đặt lịch khám.")
  })

  it("phần tử mới: chỉ thay các field chữ cùng hình dạng, giữ id và field không dịch", () => {
    const change = { path: "actors[]", before: undefined, value: { id: "A09", name: "Doctor", kind: "human", description: "Treats patients." } }
    const out = localizeChangeText(change, view, [{ path: "actors[]", value: { name: "Bác sĩ", description: "Điều trị bệnh nhân." } }])
    expect(out.value).toEqual({ id: "A09", name: "Bác sĩ", kind: "human", description: "Điều trị bệnh nhân." })
  })

  it("chưa có bản dịch / path không có trên bản xem / lệch hình dạng ⇒ giữ chữ gốc, cùng đối tượng", () => {
    const change = { path: "actors[id=A99].description", before: "Old.", value: "New." }
    expect(localizeChangeText(change, view, undefined)).toBe(change)
    expect(localizeChangeText(change, null, [{ path: "actors[id=A99].description", value: ["x"] }])).toBe(change)
  })
})
