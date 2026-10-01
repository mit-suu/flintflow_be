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
