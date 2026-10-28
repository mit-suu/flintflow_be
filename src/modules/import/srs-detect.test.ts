import { describe, expect, it } from "vitest"
import { DocxPackage, readBlocks } from "../docx-ooxml/index.js"
import { makeDocx, p, styled, table } from "../docx-ooxml/testing/make-docx.js"
import { classifyDocument, type DetectableBlock } from "./srs-detect.js"
import { makeIeeeSrsDocx, makeSrsDocx } from "./testing/srs-fixture.js"

const blocksOf = async (docx: Buffer): Promise<DetectableBlock[]> => readBlocks(await DocxPackage.load(docx))
const classify = async (docx: Buffer) => classifyDocument(await blocksOf(docx))

const h1 = (t: string) => styled("u1", t)
const h2 = (t: string) => styled("u2", t)

/** Mẫu FPT trống: chỉ heading + chữ hướng dẫn trong ngoặc. */
const emptyFptTemplate = () =>
  makeDocx({
    body: [
      p("Software Requirement Specification"),
      h1("I. Record of Changes"),
      h1("1 Product Overview"),
      p("[Describe the product and its purpose]"),
      h1("2 User Requirements"),
      h2("2.1 Actors"),
      p("[List actors]"),
      h2("2.2 Use Cases"),
      h1("3 Functional Requirements"),
      h2("3.1 System Functional Overview"),
      h1("4 Non-Functional Requirements"),
      h1("5 Requirement Appendix"),
      h2("5.5 Glossary")
    ].join("")
  })

const cv = () =>
  makeDocx({
    body: [
      p("NGUYEN VAN A"),
      p("Senior Backend Developer"),
      h1("Work Experience"),
      p("2021–2024: FPT Software — built billing services in Node.js."),
      p("2019–2021: VNG — payment gateway integration."),
      h1("Education"),
      p("FPT University, Software Engineering, GPA 3.4"),
      h1("Skills"),
      p("Node.js, TypeScript, MongoDB, Docker"),
      p("Hobbies: football, reading")
    ].join("")
  })

const invoice = () =>
  makeDocx({
    body: [
      p("HOÁ ĐƠN GIÁ TRỊ GIA TĂNG"),
      p("Đơn vị bán hàng: Công ty TNHH ABC"),
      table([
        ["STT", "Tên hàng hoá", "Đơn vị", "Số lượng", "Đơn giá", "Thành tiền"],
        ["1", "Laptop", "cái", "2", "20.000.000", "40.000.000"]
      ]),
      p("Tổng tiền hàng: 40.000.000"),
      p("Thuế GTGT 10%: 4.000.000"),
      p("Tổng tiền thanh toán: 44.000.000")
    ].join("")
  })

const testPlan = () =>
  makeDocx({
    body: [
      p("Test Plan — Lumen release 1.2"),
      h1("1. Test cases"),
      table([
        ["Test case", "Steps", "Expected result", "Actual result", "Pass/Fail"],
        ["TC-01 Login", "Enter valid credentials", "Dashboard shown", "Dashboard shown", "Pass"],
        ["TC-02 Login wrong password", "Enter wrong password", "Error shown", "", ""]
      ]),
      h1("2. Test schedule"),
      p("Regression on Monday; test suite reruns nightly.")
    ].join("")
  })

const meetingMinutes = () =>
  makeDocx({
    body: [
      p("BIÊN BẢN HỌP ngày 12/09/2026"),
      p("Thành phần tham dự: anh Nam, chị Linh, team dev"),
      p("Agenda: tiến độ sprint 4, kế hoạch demo"),
      p("Action items: Linh gửi slide trước thứ 5; Nam chốt lịch với khách."),
      p("Kết luận: dời demo sang tuần sau.")
    ].join("")
  })

const freeTextSrs = () =>
  makeDocx({
    body: [
      p("Yêu cầu phần mềm cổng cấp phép xây dựng"),
      p("Hệ thống có các tác nhân: Công dân, Cán bộ thẩm định, Lãnh đạo Sở."),
      p("Ca sử dụng chính: nộp hồ sơ (UC-01), thẩm định hồ sơ (UC-02), ký quyết định (UC-03)."),
      p("Yêu cầu phi chức năng: thời gian phản hồi dưới 3 giây, bảo mật theo chuẩn của Bộ."),
      p("Quy tắc nghiệp vụ BR-01: công trình trên 7 tầng phải có văn bản PCCC.")
    ].join("")
  })

describe("classifyDocument (FLF-331, I-1 nhận diện SRS — 0 credit)", () => {
  it("SRS theo mẫu FPT và mẫu IEEE 830 ⇒ srs, độ tin cao", async () => {
    const fpt = await classify(await makeSrsDocx())
    expect(fpt.kind).toBe("srs")
    expect(fpt.confidence).toBeGreaterThanOrEqual(0.8)
    expect(fpt.signals.some((s) => s.startsWith("heading:"))).toBe(true)

    expect((await classify(await makeSrsDocx({ numberedOnly: true }))).kind).toBe("srs")
    expect((await classify(await makeIeeeSrsDocx())).kind).toBe("srs")
  })

  it("mẫu FPT trống (chỉ heading + chữ hướng dẫn) ⇒ srs_template, vẫn được nhận", async () => {
    const res = await classify(await emptyFptTemplate())
    expect(res.kind).toBe("srs_template")
    expect(res.reasons[0]).toContain("mẫu SRS")
  })

  it("SRS không theo mẫu nào, viết văn xuôi tiếng Việt ⇒ không bị chặn (srs hoặc unknown, không bao giờ not_srs)", async () => {
    const res = await classify(await freeTextSrs())
    expect(["srs", "unknown"]).toContain(res.kind)
    expect(res.signals).toEqual(expect.arrayContaining([expect.stringMatching(/^keyword:/), expect.stringMatching(/^id:UC/)]))
  })

  it("CV, hoá đơn, test plan, biên bản họp ⇒ not_srs kèm lý do nêu loại tài liệu", async () => {
    const cases: [string, Promise<Buffer>, string][] = [
      ["cv", cv(), "hồ sơ / CV"],
      ["invoice", invoice(), "hoá đơn"],
      ["test_plan", testPlan(), "kiểm thử"],
      ["meeting", meetingMinutes(), "biên bản họp"]
    ]
    for (const [name, docx, label] of cases) {
      const res = await classify(await docx)
      expect(res.kind, name).toBe("not_srs")
      expect(res.signals, name).toContain(`against:${name}`)
      expect(res.reasons[0], name).toContain(label)
    }
  })

  it("tiêu đề là tài liệu khác (Report 4 – Software Design Document…) ⇒ not_srs dù bên trong đầy use case / actor / mã UC", async () => {
    // Như file thật bị nhận nhầm: bìa báo cáo đồ án FPT, Record of Changes, rồi thiết kế nhắc lại use case và actor
    const designBody = [
      h1("I. Record of Changes"),
      h1("1 System Design"),
      h2("1.1 System Architecture"),
      p("The Student actor and the Lecturer actor use the web client; each use case UC-01, UC-11, UC-66 maps to a controller."),
      h2("1.2 Package Diagram"),
      h1("2 Database Design"),
      p("Stakeholder data, screen settings and the glossary live in separate tables; performance and security follow the NFRs."),
      h1("3 Detailed Design"),
      h2("3.1 Class Diagram"),
      h2("3.2 Sequence Diagram")
    ]
    const cases: [string, string, string][] = [
      ["Report 4 – Software Design Document", "design", "thiết kế"],
      ["Report 2 – Project Management Plan", "project_plan", "kế hoạch quản lý dự án"],
      ["Report 5 – Software Test Documentation", "test_doc", "kiểm thử"],
      ["Report 5 – Test Documentation", "test_doc", "kiểm thử"],
      ["Report 6 – User Guide", "user_guide", "hướng dẫn"],
      ["TÀI LIỆU THIẾT KẾ HỆ THỐNG", "design", "thiết kế"]
    ]
    // Bảng Record of Changes ngay sau bìa nhắc "SRS" (tài liệu test / thiết kế bám SRS) — không phải tiêu đề
    const changeLog = table([
      ["Date", "In charge", "Change Description"],
      ["16/09/2026", "Hiep", "v0.1: Initial version based on SRS v1.0"]
    ])
    for (const [title, kind, label] of cases) {
      const res = await classify(await makeDocx({ body: [p("CAPSTONE PROJECT REPORT"), p(title), p("– Danang, Sep 2026 –"), changeLog, ...designBody].join("") }))
      expect(res.kind, title).toBe("not_srs")
      expect(res.signals, title).toEqual([`title:${kind}`])
      expect(res.reasons[0], title).toContain(label)
    }
  })

  it("tiêu đề SRS thắng tiêu đề loại khác: Report 3 – Software Requirement Specification (nhắc tài liệu thiết kế ở đầu) vẫn là srs", async () => {
    const res = await classify(
      await makeDocx({
        body: [
          p("CAPSTONE PROJECT REPORT"),
          p("Report 3 – Software Requirement Specification"),
          p("Related documents: Software Design Document, User Guide"),
          h1("I. Record of Changes"),
          h1("1 Product Overview"),
          h1("2 User Requirements"),
          h2("2.1 Actors"),
          h2("2.2 Use Cases"),
          h1("3 Functional Requirements")
        ].join("")
      })
    )
    expect(res.kind).toBe("srs")
    expect(res.signals).toContain("title:srs")
  })

  it("chữ liền không cấu trúc, không từ khoá SRS ⇒ not_srs; vài đoạn có một từ khoá ⇒ unknown (không chặn)", async () => {
    const sentences = [
      "Hôm nay trời đẹp nên cả nhóm quyết định đi dã ngoại ở bán đảo Sơn Trà từ sáng sớm.",
      "Xe xuất phát lúc bảy giờ, đường ven biển vắng và gió mát, ai cũng tranh thủ chụp ảnh.",
      "Đến nơi mọi người dựng lều, chuẩn bị đồ nướng và chia nhau đi nhặt củi khô quanh bãi.",
      "Buổi trưa trời nắng gắt, nhóm nghỉ dưới tán cây và kể chuyện cũ hồi còn đi học.",
      "Chiều có mưa rào bất chợt nên phải thu dọn nhanh, nhưng không ai thấy phiền vì chuyến đi vui.",
      "Trên đường về cả nhóm ghé quán hải sản quen, gọi thêm vài món và bàn kế hoạch cho lần sau.",
      "Về tới thành phố thì trời đã tối, mọi người chia tay và hẹn tuần sau gặp lại.",
      "Ai cũng đồng ý rằng những chuyến đi ngắn như vậy giúp cả nhóm gắn bó hơn nhiều."
    ]
    const prose = await classify(await makeDocx({ body: sentences.map((x) => p(x)).join("") }))
    expect(prose.kind).toBe("not_srs")
    // Tài liệu ngắn (vài dòng) không đủ bằng chứng ⇒ unknown, không chặn
    expect((await classify(await makeDocx({ body: [p("Hôm nay trời đẹp."), p("Chúng tôi đi dã ngoại."), p("Buổi chiều về sớm.")].join("") }))).kind).toBe("unknown")

    const vague = await classify(await makeDocx({ body: [p("Ghi chú nhanh"), p("Cần thêm màn hình báo cáo cho kế toán."), p("Hỏi lại khách về quy trình duyệt.")].join("") }))
    expect(vague.kind).toBe("unknown")
    expect(vague.reasons[0]).toContain("Chưa chắc")
  })

  it("bảng use case / requirement là tín hiệu; mã UC/FR đếm theo mã khác nhau", () => {
    const blocks: DetectableBlock[] = [
      { kind: "paragraph", text: "Danh sách chức năng", level: null, rows: null },
      { kind: "table", text: "", level: null, rows: [["ID", "Use case", "Actor", "Description"], ["UC-01", "Login", "User", "…"], ["UC-02", "Logout", "User", "…"], ["UC-03", "Reset", "User", "…"]] }
    ]
    const res = classifyDocument(blocks)
    expect(res.signals).toEqual(expect.arrayContaining(["table:1", "id:UC-01,UC-02,UC-03"]))
    expect(res.kind).not.toBe("not_srs")
  })
})
