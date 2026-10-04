import { describe, it, expect } from "vitest"
import { scoreBrief, unsourcedQuantifiers, topicKeyOf, type RecordedRun, type RecordedQuestion } from "./elicit-brief-metrics.js"

/**
 * Chỉ số của eval luồng Brief chấm bằng phép đếm trên dữ liệu đã ghi, nên nó phải đỏ đúng chỗ trên các
 * khuyết tật thật và **không** đỏ ở những chỗ hợp lệ trông giống. Test dựng lượt chạy tổng hợp: không gọi
 * provider, không cần BE chạy.
 */

const question = (over: Partial<RecordedQuestion> = {}): RecordedQuestion => ({
  id: "Q_uptime",
  text: "Hệ thống cần sẵn sàng tới mức nào?",
  options: [],
  ...over
})

const run = (over: Partial<RecordedRun> = {}): RecordedRun => ({
  case_id: "test",
  turns: [{ user_message: "ý tưởng của tôi", reply: "Tôi hiểu rồi.", questions: [] }],
  spine: { form_factor: [], stakes: null, assumption_paths: [], decisions: [] },
  ...over
})

describe("scoreBrief — câu hỏi và chủ đề", () => {
  it("đếm câu mỗi lượt và rút chủ đề từ id hợp đồng", () => {
    const m = scoreBrief(
      run({
        turns: [
          { user_message: "ý tưởng", reply: "a", questions: [question({ id: "Q_form_factor" }), question({ id: "Q_stakes" })] },
          { user_message: "web thôi", reply: "b", questions: [question({ id: "Q3" })] }
        ]
      })
    )
    expect(m.questions_per_turn).toEqual([2, 1])
    expect(m.topic_keys).toEqual(["form_factor", "stakes"])
  })

  it("id không theo chủ đề không sinh chủ đề giả", () => {
    expect(topicKeyOf("Q_working_hours")).toBe("working_hours")
    expect(topicKeyOf("Q1")).toBeNull()
  })
})

describe("scoreBrief — hình dạng lựa chọn", () => {
  it("bắt nhãn lồng nhau: thẻ tuân thủ có option 2 chứa hiển ngôn option 1", () => {
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "quản lý hồ sơ bệnh nhân",
            reply: "Tôi theo hướng này.",
            questions: [
              question({
                id: "Q_stakes",
                text: "Yếu tố tuân thủ, pháp lý của dự án này như thế nào?",
                header: "Tuân thủ",
                options: [
                  { label: "Tuân thủ quy định nội bộ và pháp luật (Khuyến nghị)", description: "Có quy định pháp luật phải theo" },
                  { label: "Tuân thủ quy định nội bộ", description: "Chỉ theo quy định nội bộ của tổ chức" }
                ]
              })
            ]
          }
        ]
      })
    )
    expect(m.nested_labels).toBe(1)
    expect(m.options_without_description).toBe(0)
  })

  it("bắt option là số trần, và không bắt số đã nói được gì", () => {
    const bare = scoreBrief(
      run({
        turns: [
          {
            user_message: "x",
            reply: "y",
            questions: [question({ options: [{ label: "200" }, { label: "1.000" }] })]
          }
        ]
      })
    )
    expect(bare.numeric_only_options).toBe(2)
    expect(bare.options_without_description).toBe(2)

    const explained = scoreBrief(
      run({
        turns: [
          {
            user_message: "x",
            reply: "y",
            questions: [
              question({
                options: [
                  { label: "200", description: "Đủ cho một cơ sở; một máy chủ" },
                  { label: "1.000", description: "Cần máy chủ dự phòng, chi phí gấp đôi" }
                ]
              })
            ]
          }
        ]
      })
    )
    expect(explained.numeric_only_options).toBe(0)
    expect(explained.options_without_description).toBe(0)
  })

  it("bắt option \"không thêm gì\" trên thẻ tick nhiều ô, và ứng viên nêu trong ngoặc mà không có option", () => {
    // Nguyên văn thẻ gặp lúc chạy thật: ngoặc gợi "kế toán" nhưng không option nào nhận, và "Chỉ ba vai trò
    // trên" tick cùng "Thêm quản trị hệ thống" là tự mâu thuẫn.
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "Sinh viên, giảng viên và Phòng Đào tạo dùng hệ thống.",
            reply: "Tôi ghi ba nhóm này.",
            questions: [
              question({
                id: "Q_actors",
                text: "Ngoài sinh viên, giảng viên và Phòng Đào tạo, còn vai trò nào dùng hệ thống không (lãnh đạo khoa, kế toán, quản trị hệ thống)?",
                header: "Người dùng",
                multiple: true,
                options: [
                  { label: "Chỉ ba vai trò trên (Khuyến nghị)", description: "Đủ cho mục tiêu tra cứu tự phục vụ" },
                  { label: "Thêm quản trị hệ thống", description: "Một nhóm kỹ thuật riêng quản tài khoản và phân quyền" },
                  { label: "Thêm lãnh đạo khoa/cơ sở", description: "Xem báo cáo tổng hợp theo cơ sở, không nhập liệu" }
                ]
              })
            ]
          }
        ]
      })
    )
    expect(m.none_option_on_multiselect).toBe(1)
    expect(m.candidate_without_option).toEqual(["kế toán"])
  })

  it("option \"giữ nguyên lời user\" trên thẻ tick nhiều ô là hợp lệ, không bị bắt nhầm", () => {
    // Phép quyết định cố ý sinh option này; bắt nhầm nó là xoá mất thứ vừa dựng ở phase 6.
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "Tôi muốn một hệ thống web.",
            reply: "Tôi để phương án giữ nguyên lời bạn đứng trước.",
            questions: [
              question({
                id: "Q_form_factor",
                text: "Hệ thống chạy trên nền tảng nào?",
                multiple: true,
                options: [
                  { label: "Chỉ web như bạn nói (Khuyến nghị)", description: "Đủ cho người dùng ngồi máy tính" },
                  { label: "Web và ứng dụng di động", description: "Thêm app cho người tra cứu khi di chuyển" }
                ]
              })
            ]
          }
        ]
      })
    )
    expect(m.none_option_on_multiselect).toBe(0)
    expect(m.candidate_without_option).toEqual([])
  })

  it("ngoặc một cụm (chú thích, đuôi khuyến nghị) không bị coi là danh sách ứng viên", () => {
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "x",
            reply: "y",
            questions: [
              question({
                text: "Hệ thống cần sẵn sàng tới mức nào (tính theo tháng)?",
                multiple: true,
                options: [{ label: "99%", description: "a" }, { label: "99.9%", description: "b" }]
              })
            ]
          }
        ]
      })
    )
    expect(m.candidate_without_option).toEqual([])
  })

  it("thẻ một lựa chọn không bị áp luật của thẻ tick nhiều ô", () => {
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "x",
            reply: "y",
            questions: [question({ multiple: false, options: [{ label: "Chỉ ba vai trò trên", description: "a" }, { label: "Thêm kế toán", description: "b" }] })]
          }
        ]
      })
    )
    expect(m.none_option_on_multiselect).toBe(0)
  })

  it("hai nhãn khác hẳn nhau không tính là lồng nhau", () => {
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "x",
            reply: "y",
            questions: [question({ options: [{ label: "Web", description: "a" }, { label: "Mobile", description: "b" }] })]
          }
        ]
      })
    )
    expect(m.nested_labels).toBe(0)
  })
})

describe("scoreBrief — vốn từ bị cấm", () => {
  it("bắt mã bước, tên field và giá trị thô trong chữ user đọc", () => {
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "x",
            reply: "Tôi đã ghi stakes vào hồ sơ và sẽ sang B-0.2.",
            questions: [question({ options: [{ label: "web_app", description: "nền tảng web" }] })]
          }
        ]
      })
    )
    expect(m.banned_vocab).toContain("stakes")
    expect(m.banned_vocab).toContain("B-0.2")
    expect(m.banned_vocab).toContain("web_app")
  })

  it("bắt từ đệm khi nó mở lời đáp, bỏ qua khi nằm giữa câu", () => {
    const opened = scoreBrief(run({ turns: [{ user_message: "x", reply: "Vậy là tôi theo hướng web.", questions: [] }] }))
    expect(opened.banned_vocab).toContain("Vậy là")

    const inside = scoreBrief(run({ turns: [{ user_message: "x", reply: "Phòng khám nghỉ trưa, vậy là khung giờ bị chia hai.", questions: [] }] }))
    expect(inside.banned_vocab).toEqual([])
  })
})

describe("unsourcedQuantifiers — AI thêm số user chưa nói", () => {
  it("đếm lượng từ AI thêm trước cụm danh từ user có dùng", () => {
    expect(unsourcedQuantifiers("Ba file Excel rời rạc là gốc của việc này.", "Chúng tôi đang dùng nhiều file Excel rời rạc.")).toEqual([
      "ba file excel rời"
    ])
  })

  it("không đếm lượng từ chính user đã nói", () => {
    expect(unsourcedQuantifiers("Ba file Excel rời rạc.", "Chúng tôi có ba file Excel rời rạc.")).toEqual([])
  })

  it("không đếm số AI đề xuất trong lựa chọn — chỉ xét lời đáp", () => {
    const m = scoreBrief(
      run({
        turns: [
          {
            user_message: "Trường có nhiều cơ sở.",
            reply: "Tôi cần biết quy mô truy cập cùng lúc.",
            questions: [
              question({
                options: [
                  { label: "khoảng 50 người dùng cùng lúc (Khuyến nghị)", description: "Đủ cho một cơ sở" },
                  { label: "200 người dùng cùng lúc", description: "Cần máy chủ dự phòng" }
                ]
              })
            ]
          }
        ]
      })
    )
    expect(m.unsourced_quantifiers).toBe(0)
  })

  it("không đếm số AI đề xuất cho cụm user chưa dùng", () => {
    expect(unsourcedQuantifiers("Tôi đề xuất 99.5% thời gian hoạt động.", "Hệ thống đặt lịch cho phòng khám.")).toEqual([])
  })
})

describe("scoreBrief — giá trị Spine của luồng Brief", () => {
  it("ghi giá trị tuân thủ và giả định kèm theo", () => {
    const m = scoreBrief(
      run({
        turns: [{ user_message: "x", reply: "y", questions: [question({ id: "Q_stakes" }), question({ id: "Q_form_factor" })] }],
        spine: {
          form_factor: ["web_app"],
          stakes: "production",
          assumption_paths: ["project.stakes"],
          decisions: [{ topic_key: "stakes", answer: "Tuân thủ quy định nội bộ" }]
        }
      })
    )
    expect(m.stakes_value).toBe("production")
    expect(m.has_stakes_assumption).toBe(true)
    expect(m.b0_fields_set_without_card_or_assumption).toEqual([])
  })

  it("bắt field B-0 bị tự quyết mà không hỏi, không ghi giả định", () => {
    const m = scoreBrief(
      run({
        turns: [{ user_message: "hệ thống web cho trường", reply: "y", questions: [question({ id: "Q_stakes" })] }],
        spine: {
          form_factor: ["web_app"],
          stakes: "production",
          assumption_paths: ["project.stakes"],
          decisions: []
        }
      })
    )
    expect(m.b0_fields_set_without_card_or_assumption).toEqual(["form_factor"])
  })

  it("lượt hỏng trước khi đọc được Spine không sinh khuyết tật giả", () => {
    const m = scoreBrief(run({ spine: null }))
    expect(m.stakes_value).toBeNull()
    expect(m.has_stakes_assumption).toBe(false)
    expect(m.b0_fields_set_without_card_or_assumption).toEqual([])
  })
})
