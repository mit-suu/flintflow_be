import fs from "node:fs"
import path from "node:path"
import { describe, it, expect } from "vitest"
import { getSkillsDir } from "./prompt-assets.js"

/**
 * Luật văn phong của tin nhắn người dùng đọc nằm trong hai skill: `elicit-loop` viết lời chat, `draft-to-ops` viết tin
 * nhắn cổng duyệt. Cơ chế nạp prompt chỉ đưa thân `SKILL.md` vào prompt — không nạp `references/` và không có đường ra
 * ngoài thư mục skill — nên phần chung không thể sống trong một file dùng chung mà không sửa loader, `asset_version` và
 * cache skill index. Thay vào đó phần chung là một block có mốc, có mặt trong cả hai file, và test này chặn đúng thứ đã
 * sinh ra FLF-241: hai bản trôi lệch im lặng. Sửa một bên mà quên bên kia ⇒ đỏ.
 */
const START = "<!-- voice:shared:start -->"
const END = "<!-- voice:shared:end -->"

const SKILLS = ["action/elicit-loop", "action/draft-to-ops"] as const

const sharedBlockOf = (skill: string): string => {
  const file = path.join(getSkillsDir(), ...skill.split("/"), "SKILL.md")
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  expect(start, `${skill}: thiếu mốc ${START}`).toBeGreaterThanOrEqual(0)
  expect(end, `${skill}: thiếu mốc ${END}`).toBeGreaterThan(start)
  return text.slice(start + START.length, end).trim()
}

describe("block văn phong dùng chung của elicit-loop và draft-to-ops", () => {
  it("giống nhau từng byte ở cả hai SKILL.md", () => {
    const [elicit, draft] = SKILLS.map(sharedBlockOf)
    expect(draft).toBe(elicit)
  })

  it("không rỗng — xoá nội dung giữa hai mốc không làm test xanh", () => {
    for (const skill of SKILLS) {
      const block = sharedBlockOf(skill)
      expect(block.length, skill).toBeGreaterThan(200)
      expect(block.split("\n").filter((l) => l.trim() !== "").length, skill).toBeGreaterThanOrEqual(4)
    }
  })

  it("mang đủ các luật chung, không chỉ một dòng còn sót", () => {
    const block = sharedBlockOf(SKILLS[0])
    for (const rule of ["Mở lời", "Điều tôi tự quyết", "Xưng hô", "chữ nội bộ"]) expect(block, rule).toContain(rule)
    // Hai lỗi đo được ở lượt chạy thật: câu đầu nhắc lại thứ user vừa nhập, và "mình" dạng sở hữu cho tổ chức của khách
    expect(block).toContain("vừa nhập hoặc vừa chọn")
    expect(block).toContain("bệnh viện mình")
  })

  it("điều user đã nói mà còn để mở ngã rẽ không bị gom vào mục tự quyết", () => {
    // Không có vế này thì câu "Không đổi nó thành câu hỏi" ngay trên nó thắng, và mọi luật mới về việc
    // đề xuất lại một ngã rẽ user để mở đều vô nghĩa — lượt chạy thật: AI tự chốt nền tảng web rồi chỉ
    // nói "nếu sau này cần thêm app điện thoại, bạn nói tôi nhé".
    for (const skill of SKILLS) {
      const block = sharedBlockOf(skill)
      expect(block, `${skill}: thiếu vế ngã rẽ còn để mở`).toContain("còn để mở một ngã rẽ có hệ quả")
      expect(block, `${skill}: thiếu phương án giữ nguyên lời user`).toContain("giữ nguyên lời user")
    }
  })

  it("vốn từ thay cho tên field: tuân thủ và đối tượng dùng, không còn cụm gộp hai thang", () => {
    for (const skill of SKILLS) {
      const block = sharedBlockOf(skill)
      // Cụm cũ gộp "ai dùng" với "luật nào" vào một thang nên không gọi đúng tên thứ gì — nó đẻ ra thẻ hỏi có option
      // không loại trừ nhau. Luật này vừa CẤM nói tên field/giá trị thô, vừa CHỈ ĐỊNH từ được phép thay: thiếu vốn từ
      // cho đối tượng dùng thì khi nói về một hệ thống có người dùng thật, model không còn từ nào hợp lệ.
      expect(block.toLowerCase(), `${skill}: còn cụm gộp hai thang`).not.toContain("mức độ quan trọng")
      expect(block, `${skill}: thiếu vốn từ tuân thủ`).toContain("tuân thủ")
      expect(block, `${skill}: thiếu vốn từ đối tượng dùng`).toContain("ai dùng hệ thống")
      // Có vốn từ chưa đủ: lượt chạy thật vẫn ra "còn vai trò nào dùng hệ thống không" — hỏi bằng một từ gần
      // nghĩa nhưng là thuật ngữ mô hình (trùng `roles[]`), và bắt khách tự phân loại người thành hạng mục.
      expect(block, `${skill}: thiếu luật hỏi về người`).toContain("còn ai phải dùng nó nữa không")
      expect(block, `${skill}: thiếu vế cấm hỏi theo vai trò`).toContain("còn vai trò nào")
    }
  })

  it("trần 25 từ/câu là luật riêng của tin cổng, không nằm trong block chung và không áp cho chat", () => {
    const draftFile = fs.readFileSync(path.join(getSkillsDir(), "action", "draft-to-ops", "SKILL.md"), "utf8")
    const elicitFile = fs.readFileSync(path.join(getSkillsDir(), "action", "elicit-loop", "SKILL.md"), "utf8")
    expect(draftFile).toContain("~25 words")
    expect(sharedBlockOf("action/draft-to-ops")).not.toContain("25")
    expect(elicitFile).not.toContain("25 words")
  })

  it("không ví dụ nào trong hai skill còn mở bằng từ đệm bị cấm", () => {
    const OPENERS = ["Vậy là", "Thế là", "Rõ rồi,", "Được rồi,", "Tuyệt vời", "Đã ghi nhận", "Cảm ơn bạn đã chia sẻ"]
    for (const skill of SKILLS) {
      const file = path.join(getSkillsDir(), ...skill.split("/"), "SKILL.md")
      const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")
      const body = text.slice(0, text.indexOf(START)) + text.slice(text.indexOf(END) + END.length)
      for (const opener of OPENERS) expect(body, `${skill}: ví dụ mở bằng "${opener}"`).not.toContain(`"${opener}`)
    }
  })
})
