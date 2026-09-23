import { describe, expect, it } from "vitest"
import {
  checkPassword,
  passwordError,
  passwordLevel,
  PASSWORD_MAX_LENGTH
} from "./password-policy.js"

describe("password-policy — luật cứng", () => {
  it("mật khẩu đạt chuẩn ⇒ không lỗi", () => {
    expect(checkPassword("Mua2Roi!")).toBeNull() // 8 ký tự, đủ 4 nhóm
    expect(checkPassword("bien-xanh-2026")).toBeNull() // 14 ký tự, 3 nhóm
  })

  it("ngắn hơn 8 ký tự ⇒ too_short, kể cả khi đủ phức tạp", () => {
    expect(checkPassword("Ab1!xy")).toBe("too_short")
  })

  it(`dài hơn ${PASSWORD_MAX_LENGTH} ký tự ⇒ too_long, vì bcrypt lặng lẽ cắt phần dư`, () => {
    expect(checkPassword(`A1!${"a".repeat(PASSWORD_MAX_LENGTH)}`)).toBe("too_long")
  })

  it("tiếng Việt có dấu ⇒ not_ascii", () => {
    expect(checkPassword("Đườngxưa1!")).toBe("not_ascii")
    expect(checkPassword("Muaroi2026ữ!")).toBe("not_ascii")
  })

  it("khoảng trắng và emoji cũng không được ⇒ not_ascii", () => {
    expect(checkPassword("Mua Roi 2026!")).toBe("not_ascii")
    expect(checkPassword("Muaroi2026!🙂")).toBe("not_ascii")
  })

  it("chỉ 2 nhóm ký tự ⇒ not_complex", () => {
    expect(checkPassword("matkhaudai")).toBe("not_complex")
    expect(checkPassword("matkhau2026")).toBe("not_complex")
  })

  it("mật khẩu kiểu 'đúng khuôn mẫu' vẫn được nhận — không còn danh sách chặn", () => {
    // Danh sách mật khẩu phổ biến đã bị gỡ: 35/35 mục trong đó đều đã bị `too_short`/`not_complex`
    // chặn sẵn, nên nó chỉ còn tác dụng bắt nhầm (`Password1!` bị rút gọn thành `password`).
    expect(checkPassword("Password1!")).toBeNull()
    expect(checkPassword("Flintflow2026")).toBeNull()

    // Các mục trong danh sách cũ vẫn bị chặn, chỉ là bằng luật khác
    expect(checkPassword("password")).toBe("not_complex")
    expect(checkPassword("123456")).toBe("too_short")
    expect(checkPassword("qwerty123")).toBe("not_complex")
    expect(checkPassword("flintflow123")).toBe("not_complex")
  })
})

describe("password-policy — ngưỡng 'Khá' trở lên mới được dùng", () => {
  it("qua hết luật cứng nhưng mới mức 1 ⇒ not_strong_enough", () => {
    // 8 ký tự, đúng 3 nhóm ⇒ chưa dài, chưa đủ 4 nhóm
    expect(passwordLevel("muaroi2!")).toBe(1)
    expect(checkPassword("muaroi2!")).toBe("not_strong_enough")
  })

  it("mức 2 (Khá) ⇒ được dùng: hoặc từ 12 ký tự, hoặc đủ 4 nhóm", () => {
    expect(passwordLevel("muaroi2026!x")).toBe(2) // 12 ký tự, 3 nhóm
    expect(passwordLevel("Mua2Roi!")).toBe(2) // 8 ký tự nhưng đủ 4 nhóm
    expect(checkPassword("muaroi2026!x")).toBeNull()
    expect(checkPassword("Mua2Roi!")).toBeNull()
  })

  it("mức 3 (Mạnh) ⇒ từ 12 ký tự VÀ đủ 4 nhóm", () => {
    expect(passwordLevel("Binh1211!xyz")).toBe(3) // 12 ký tự — ngay mốc
    expect(passwordLevel("Binh1211!xy")).toBe(2) // 11 ký tự — chưa tới
  })

  it("vi phạm luật cứng ⇒ mức 0 dù dài bao nhiêu", () => {
    expect(passwordLevel("matkhaudaithoodai")).toBe(0)
  })
})

describe("password-policy — KHÔNG còn đối chiếu với tên / email", () => {
  it("mật khẩu trùng tên hay phần email vẫn được chấp nhận", () => {
    expect(checkPassword("Minhhoang2026")).toBeNull()
    expect(checkPassword("Quangvinh!9")).toBeNull()
  })
})

describe("passwordError", () => {
  it("trả thông điệp tiếng Việt, hoặc null khi đạt", () => {
    expect(passwordError("Mua2Roi!")).toBeNull()
    expect(passwordError("abc")).toContain("ít nhất 8 ký tự")
    expect(passwordError("muaroi2!")).toContain("chưa đủ mạnh")
  })
})
