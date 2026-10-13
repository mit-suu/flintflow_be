import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./translation.repository.js", async () => (await import("./__tests__/translation-store.js")).fakeRepository)

import { captureForTurn, captureLocalized, localizedUnitsOf } from "./capture.service.js"
import { fakeRepository, resetStore, store } from "./__tests__/translation-store.js"
import { hashSource } from "./translation-units.js"
import type { Op } from "../spine/op.types.js"

const P = "64b000000000000000000001"

const stored = (value: unknown) => store.translations.get(`${P}|vi|${hashSource(value)}`)

beforeEach(() => {
  resetStore()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("localizedUnitsOf — ghép localized với op cùng path (hàm thuần)", () => {
  it("add phần tử cả object + set một field mảng ⇒ đúng các cặp (hash câu Anh, câu dịch)", () => {
    const ops: Op[] = [
      { op: "add", path: "actors[]", value: { id: "A10", name: "Librarian", description: "Manages books.", kind: "human" } },
      { op: "set", path: "functions[id=FN001].normal", value: ["User opens the form.", "System saves."] }
    ]
    const units = localizedUnitsOf(ops, [
      { path: "functions[id=FN001].normal", value: ["Người dùng mở form.", "Hệ thống lưu."] },
      { path: "actors[]", value: { id: "A10", name: "Thủ thư", description: "Quản lý sách." } }
    ])
    expect(units.map((u) => [u.key, u.text])).toEqual([
      ["functions[id=FN001].normal", ["Người dùng mở form.", "Hệ thống lưu."]],
      ["actors[id=A10].name", "Thủ thư"],
      ["actors[id=A10].description", "Quản lý sách."]
    ])
    expect(units[1].sourceHash).toBe(hashSource("Librarian"))
  })

  it("nhiều op cùng path (add functions[] × 2) ⇒ mỗi mục ghép đúng op theo id, kể cả khi đảo thứ tự", () => {
    const ops: Op[] = [
      { op: "add", path: "functions[]", value: { id: "FN100", name: "Export report" } },
      { op: "add", path: "functions[]", value: { id: "FN101", name: "Print receipt" } }
    ]
    const units = localizedUnitsOf(ops, [
      { path: "functions[]", value: { id: "FN101", name: "In biên lai" } },
      { path: "functions[]", value: { id: "FN100", name: "Xuất báo cáo" } }
    ])
    expect(units.map((u) => [u.key, u.text])).toEqual([
      ["functions[id=FN101].name", "In biên lai"],
      ["functions[id=FN100].name", "Xuất báo cáo"]
    ])
  })

  it("nhiều op cùng path, mục thiếu id: số mục ≠ số op ⇒ bỏ (không gán sang phần tử khác); đủ mục, đúng thứ tự ⇒ ghép theo vị trí", () => {
    const ops: Op[] = [
      { op: "add", path: "functions[]", value: { id: "FN100", name: "Export report" } },
      { op: "add", path: "functions[]", value: { id: "FN101", name: "Print receipt" } }
    ]
    // Model bỏ FN100 và không ghi id — trước đây "In biên lai" bị gán cho "Export report"
    expect(localizedUnitsOf(ops, [{ path: "functions[]", value: { name: "In biên lai" } }])).toEqual([])
    // Một mục có id đứng sai vị trí ⇒ thứ tự không đáng tin ⇒ mục thiếu id bị bỏ, mục có id vẫn ghép đúng
    expect(
      localizedUnitsOf(ops, [
        { path: "functions[]", value: { name: "In biên lai" } },
        { path: "functions[]", value: { id: "FN100", name: "Xuất báo cáo" } }
      ]).map((u) => [u.key, u.text])
    ).toEqual([["functions[id=FN100].name", "Xuất báo cáo"]])
    expect(
      localizedUnitsOf(ops, [
        { path: "functions[]", value: { name: "Xuất báo cáo" } },
        { path: "functions[]", value: { id: "FN101", name: "In biên lai" } }
      ]).map((u) => [u.key, u.text])
    ).toEqual([
      ["functions[id=FN100].name", "Xuất báo cáo"],
      ["functions[id=FN101].name", "In biên lai"]
    ])
  })

  it("op add không có id (apply-change-op: server cấp id) ⇒ vẫn ra bản dịch: một op, nhiều op theo vị trí, validation", () => {
    const one: Op[] = [{ op: "add", path: "use_cases[]", value: { name: "Send Reminder", description: "Sends a reminder to the patient." } }]
    expect(
      localizedUnitsOf(one, [{ path: "use_cases[]", value: { name: "Gửi nhắc", description: "Gửi nhắc cho bệnh nhân." } }]).map((u) => [u.source, u.text])
    ).toEqual([
      ["Send Reminder", "Gửi nhắc"],
      ["Sends a reminder to the patient.", "Gửi nhắc cho bệnh nhân."]
    ])

    const two: Op[] = [
      { op: "add", path: "actors[]", value: { name: "Nurse", description: "Cares for patients.", kind: "human" } },
      { op: "add", path: "actors[]", value: { name: "Doctor", description: "Treats patients.", kind: "human" } }
    ]
    const actors = localizedUnitsOf(two, [
      { path: "actors[]", value: { name: "Y tá", description: "Chăm sóc bệnh nhân." } },
      { path: "actors[]", value: { name: "Bác sĩ", description: "Điều trị bệnh nhân." } }
    ])
    expect(actors.map((u) => [u.source, u.text])).toEqual([
      ["Nurse", "Y tá"],
      ["Cares for patients.", "Chăm sóc bệnh nhân."],
      ["Doctor", "Bác sĩ"],
      ["Treats patients.", "Điều trị bệnh nhân."]
    ])
    // Số mục ≠ số op ⇒ không đoán
    expect(localizedUnitsOf(two, [{ path: "actors[]", value: { name: "Bác sĩ" } }])).toEqual([])

    const validation: Op[] = [{ op: "add", path: "functions[id=FN001].validations[]", value: { kind: "format", statement: "Email must be valid." } }]
    expect(localizedUnitsOf(validation, [{ path: "functions[id=FN001].validations[]", value: { statement: "Email phải hợp lệ." } }])).toMatchObject([
      { sourceHash: hashSource("Email must be valid."), text: "Email phải hợp lệ." }
    ])
  })

  it("set lặp lại cùng path ⇒ bản dịch gắn với giá trị CUỐI (giá trị đang có trong Spine)", () => {
    const ops: Op[] = [
      { op: "set", path: "actors[id=A01].name", value: "Owner" },
      { op: "set", path: "actors[id=A01].name", value: "Product Owner" }
    ]
    const units = localizedUnitsOf(ops, [{ path: "actors[id=A01].name", value: "Chủ sản phẩm" }])
    expect(units.map((u) => [u.source, u.text])).toEqual([["Product Owner", "Chủ sản phẩm"]])
    expect(units[0].sourceHash).toBe(hashSource("Product Owner"))
  })

  it("model chép nguyên câu Anh ⇒ bỏ (giữ 'thiếu' cho dịch theo lô); tên ngắn giữ nguyên tiếng Anh vẫn nhận", () => {
    const ops: Op[] = [
      { op: "set", path: "screens[id=S01].description", value: "Shows all books in the library." },
      { op: "set", path: "functions[id=FN001].normal", value: ["User opens the form.", "System saves."] },
      { op: "set", path: "screens[id=S02].name", value: "Dashboard" }
    ]
    const units = localizedUnitsOf(ops, [
      { path: "screens[id=S01].description", value: " Shows all books in the library. " },
      { path: "functions[id=FN001].normal", value: ["User opens the form.", "System saves."] },
      { path: "screens[id=S02].name", value: "Dashboard" }
    ])
    expect(units.map((u) => [u.key, u.text])).toEqual([["screens[id=S02].name", "Dashboard"]])
  })

  it("bỏ đúng phần lỗi: path lạ, op remove, mảng khác độ dài, hình dạng lệch", () => {
    const ops: Op[] = [
      { op: "set", path: "actors[id=A01].name", value: "Owner" },
      { op: "remove", path: "actors[id=A02]" },
      { op: "set", path: "functions[id=FN001].abnormal", value: ["Error A.", "Error B."] },
      { op: "set", path: "screens[id=S01].description", value: "Login screen." },
      { op: "set", path: "nfrs[id=N01].threshold", value: "≤ 2 s" }
    ]
    const units = localizedUnitsOf(ops, [
      { path: "actors[id=A99].name", value: "Ma" },
      { path: "actors[id=A02]", value: { name: "Đã xoá" } },
      { path: "functions[id=FN001].abnormal", value: ["Lỗi A."] },
      { path: "screens[id=S01].description", value: { text: "Màn đăng nhập." } },
      { path: "actors[id=A01].name", value: "Chủ sở hữu" }
    ])
    expect(units.map((u) => [u.key, u.text])).toEqual([["actors[id=A01].name", "Chủ sở hữu"]])
  })
})

describe("captureLocalized", () => {
  it("localized hợp lệ ⇒ lưu bản author theo hash câu Anh; tên ⇒ glossary model", async () => {
    const ops: Op[] = [
      { op: "add", path: "screens[]", value: { id: "S20", name: "Book List", description: "Shows all books.", tabs: [] } },
      { op: "set", path: "messages[id=M01].text", value: "Saved successfully." }
    ]
    const saved = await captureLocalized(P, "vi", "en", ops, [
      { path: "screens[]", value: { id: "S20", name: "Danh sách sách", description: "Hiển thị mọi cuốn sách." } },
      { path: "messages[id=M01].text", value: "Đã lưu thành công." }
    ])
    expect(saved).toBe(3)
    expect(stored("Book List")).toMatchObject({ text: "Danh sách sách", origin: "author", sourceLocale: "en" })
    expect(stored("Shows all books.")).toMatchObject({ text: "Hiển thị mọi cuốn sách.", origin: "author" })
    expect(stored("Saved successfully.")).toMatchObject({ text: "Đã lưu thành công.", origin: "author" })
    expect(store.glossary.get(`${P}|vi|Book List`)).toEqual({ term: "Book List", translation: "Danh sách sách", origin: "model" })
  })

  it("thêm actor qua chat không có id ⇒ bản author + tên vào glossary", async () => {
    const saved = await captureLocalized(P, "vi", "en", [{ op: "add", path: "actors[]", value: { name: "Pharmacist", description: "Hands out medicine.", kind: "human" } }], [
      { path: "actors[]", value: { name: "Dược sĩ", description: "Phát thuốc." } }
    ])
    expect(saved).toBe(2)
    expect(stored("Pharmacist")).toMatchObject({ text: "Dược sĩ", origin: "author" })
    expect(store.glossary.get(`${P}|vi|Pharmacist`)).toEqual({ term: "Pharmacist", translation: "Dược sĩ", origin: "model" })
  })

  it("author đè bản machine cùng hash; glossary theo bản author (không đè seed)", async () => {
    await fakeRepository.saveTranslations(P, "vi", "en", [{ sourceHash: hashSource("Student"), text: "Học sinh" }], "machine")
    await fakeRepository.upsertGlossary(P, "vi", [{ term: "Student", translation: "Học sinh" }], "model")
    await fakeRepository.upsertGlossary(P, "vi", [{ term: "Teacher", translation: "Giáo viên" }], "seed")

    await captureLocalized(
      P,
      "vi",
      "en",
      [
        { op: "set", path: "actors[id=A01].name", value: "Student" },
        { op: "set", path: "actors[id=A02].name", value: "Teacher" }
      ],
      [
        { path: "actors[id=A01].name", value: "Sinh viên" },
        { path: "actors[id=A02].name", value: "Thầy cô" }
      ]
    )
    expect(stored("Student")).toMatchObject({ text: "Sinh viên", origin: "author" })
    expect(store.glossary.get(`${P}|vi|Student`)?.translation).toBe("Sinh viên")
    expect(store.glossary.get(`${P}|vi|Teacher`)).toMatchObject({ translation: "Giáo viên", origin: "seed" })
  })

  it("không có localized / ngôn ngữ đích = gốc / không ghép được ⇒ không ghi gì", async () => {
    const ops: Op[] = [{ op: "set", path: "actors[id=A01].name", value: "Owner" }]
    expect(await captureLocalized(P, "vi", "en", ops, undefined)).toBe(0)
    expect(await captureLocalized(P, "vi", "en", ops, [])).toBe(0)
    expect(await captureLocalized(P, "en", "en", ops, [{ path: "actors[id=A01].name", value: "Owner" }])).toBe(0)
    expect(await captureLocalized(P, "vi", "en", ops, [{ path: "actors[id=A01].name", value: 42 }])).toBe(0)
    expect(fakeRepository.saveTranslations).not.toHaveBeenCalled()
  })

  it("lỗi lưu ⇒ chỉ log, trả 0, không ném (lượt ghi Spine không hỏng); lỗi học glossary không chặn bản dịch", async () => {
    fakeRepository.saveTranslations.mockRejectedValueOnce(new Error("mongo down"))
    const ops: Op[] = [{ op: "set", path: "actors[id=A01].name", value: "Owner" }]
    const localized = [{ path: "actors[id=A01].name", value: "Chủ sở hữu" }]
    await expect(captureLocalized(P, "vi", "en", ops, localized)).resolves.toBe(0)
    expect(console.warn).toHaveBeenCalled()

    fakeRepository.upsertGlossary.mockRejectedValueOnce(new Error("glossary down"))
    await expect(captureLocalized(P, "vi", "en", ops, localized)).resolves.toBe(1)
    expect(stored("Owner")).toMatchObject({ text: "Chủ sở hữu", origin: "author" })
  })

  it("captureForTurn: lượt không có ngôn ngữ tài liệu ⇒ không làm gì", async () => {
    const ops: Op[] = [{ op: "set", path: "actors[id=A01].name", value: "Owner" }]
    const localized = [{ path: "actors[id=A01].name", value: "Chủ sở hữu" }]
    expect(await captureForTurn(P, null, ops, localized)).toBe(0)
    expect(await captureForTurn(P, { locale: "vi", source: "en" }, ops, localized)).toBe(1)
  })
})
