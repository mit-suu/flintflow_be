import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { spineSchema } from "./spine.schema.js"
import type { Change, Spine } from "./spine.types.js"
import { NON_WAIVABLE_RULES, RULES, checkUseCaseName, isAccountAccessUseCase, runDeterministicCheck, type FlagCandidate } from "./deterministic-check.js"
import { buildIdIndex, sectionKeyExists } from "./reference-fields.js"
import { computeSourceHash } from "./source-hash.js"
import { createEmptySpine } from "./spine.repository.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE: Spine = spineSchema.parse(
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/spine-fixture-19-screens.json"), "utf8"))
)

const variant = (fn: (s: Spine) => void): Spine => {
  const s = structuredClone(FIXTURE)
  fn(s)
  return s
}
const red = (c: FlagCandidate[]) => c.filter((f) => f.level === "red")
const byRule = (c: FlagCandidate[], rule: string) => c.filter((f) => f.rule_id === rule)

describe("RULES", () => {
  it("12 luật đỏ + 16 luật vàng; 3 luật không waive được", () => {
    expect(RULES.filter((r) => r.level === "red")).toHaveLength(12)
    // FLF-177: thêm screen_placeholder (BUG-03), function_without_uc (BUG-12),
    // derived_from_changed_assumption (BUG-14)
    expect(RULES.filter((r) => r.level === "yellow")).toHaveLength(16)
    expect([...NON_WAIVABLE_RULES].sort()).toEqual(["array_empty", "dead_reference", "render_error"])
  })
})

describe("runDeterministicCheck", () => {
  it("fixture đầy đủ: 0 cờ đỏ (kể cả atBaseline); cờ vàng chỉ là screen_no_function, screen_placeholder, function_without_uc", () => {
    expect(red(runDeterministicCheck(FIXTURE))).toEqual([])
    expect(red(runDeterministicCheck(FIXTURE, [], { atBaseline: true }))).toEqual([])
    const yellowRules = new Set(runDeterministicCheck(FIXTURE).filter((f) => f.level === "yellow").map((f) => f.rule_id))
    for (const r of yellowRules) expect(["screen_no_function", "screen_placeholder", "function_without_uc"]).toContain(r)
  })

  it("BUG-03: màn placeholder chưa qua cổng S-5.1 của nó ⇒ cờ vàng mở lại được; qua cổng rồi thì thôi", () => {
    const placeholders = FIXTURE.screens.filter((s) => s.detail_status === "placeholder").map((s) => s.id)
    expect(placeholders.length).toBeGreaterThan(0)
    const flags = byRule(runDeterministicCheck(FIXTURE), "screen_placeholder")
    expect(flags.map((f) => f.target_id).sort()).toEqual([...placeholders].sort())
    expect(flags[0]).toMatchObject({ level: "yellow", remediation_step: `S-5.1@${flags[0].target_id}` })

    // user đã chốt "để sau" ở cổng S-5.1 của màn ⇒ không còn cờ
    const decided = variant((s) =>
      s.steps.push({ id: `S-5.1@${placeholders[0]}`, status: "accepted", first_seq: null, last_seq: null, accepted_at: new Date().toISOString() })
    )
    expect(byRule(runDeterministicCheck(decided), "screen_placeholder").map((f) => f.target_id)).not.toContain(placeholders[0])
  })

  it("BUG-03: chưa qua S-5 thì chưa cảnh báo màn placeholder", () => {
    const early = variant((s) => (s.progress.current_phase = "S-4"))
    expect(byRule(runDeterministicCheck(early), "screen_placeholder")).toEqual([])
  })

  it("BUG-14: sửa giả định mà phần tử sinh ra từ nó không đổi theo ⇒ cờ vàng", () => {
    const nfr = FIXTURE.nfrs[0]
    const withAssumption = variant((s) => {
      s.assumptions.push({
        id: "AS28",
        path: `nfrs[id=${nfr.id}].statement`,
        statement: "Uptime is 99% during business hours",
        rationale: "User chốt 99%",
        origin_step_id: "S-6.3",
        status: "confirmed",
        confirmed_at: "2026-09-22T10:00:00.000Z"
      })
    })
    // Giả định được sửa ở seq 20; NFR lần cuối được ghi ở seq 10 ⇒ NFR đang lạc hậu
    const changes = [
      { seq: 10, path: `nfrs[id=${nfr.id}].statement`, before: null, value: "x", step_id: "S-6.3" },
      { seq: 20, path: "assumptions[id=AS28].statement", before: "cũ", value: "mới", step_id: null }
    ]
    const flags = byRule(runDeterministicCheck(withAssumption, changes), "derived_from_changed_assumption")
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ level: "yellow", target_id: "AS28" })
    expect(flags[0].message).toContain(nfr.id)

    // NFR được cập nhật sau đó ⇒ cờ biến mất
    const after = [...changes, { seq: 30, path: `nfrs[id=${nfr.id}].statement`, before: "x", value: "y", step_id: "S-6.3" }]
    expect(byRule(runDeterministicCheck(withAssumption, after), "derived_from_changed_assumption")).toEqual([])
  })

  it("FLF-198: xac nhan gia dinh (khong sua noi dung) thi KHONG sinh co vang", () => {
    const nfr = FIXTURE.nfrs[0]
    const withAssumption = variant((s) => {
      s.assumptions.push({
        id: "AS29",
        path: `nfrs[id=${nfr.id}].statement`,
        statement: "Uptime is 99% during business hours",
        rationale: "User xac nhan",
        origin_step_id: "S-6.3",
        status: "confirmed",
        confirmed_at: "2026-09-22T10:00:00.000Z"
      })
    })
    // Chi co lượt ghi `status` (unconfirmed -> confirmed) sau khi NFR duoc ghi: noi dung khong doi.
    const changes = [
      { seq: 10, path: `nfrs[id=${nfr.id}].statement`, before: null, value: "x", step_id: "S-6.3" },
      { seq: 20, path: "assumptions[id=AS29].status", before: "unconfirmed", value: "confirmed", step_id: null }
    ]
    expect(byRule(runDeterministicCheck(withAssumption, changes), "derived_from_changed_assumption")).toEqual([])

    // Bac bo thi van canh bao: field dan xuat dang dua tren mot gia dinh da bi bo
    const rejected = variant((s) => {
      s.assumptions.push({ ...withAssumption.assumptions[withAssumption.assumptions.length - 1], id: "AS30", status: "rejected" })
    })
    const rejectChanges = [
      { seq: 10, path: `nfrs[id=${nfr.id}].statement`, before: null, value: "x", step_id: "S-6.3" },
      { seq: 20, path: "assumptions[id=AS30].status", before: "unconfirmed", value: "rejected", step_id: null }
    ]
    expect(byRule(runDeterministicCheck(rejected, rejectChanges), "derived_from_changed_assumption")).toHaveLength(1)
  })

  it("BUG-12: function nền không use case nào tham chiếu ⇒ cờ vàng về S-3.2", () => {
    const withBackground = variant((s) => {
      s.functions.push({
        id: "FN900",
        screen_id: null,
        feature_id: s.features[0].id,
        order: 99,
        name: "Send Appointment Reminder",
        trigger: "24h before the appointment",
        description: "",
        normal: [],
        abnormal: [],
        validations: [],
        business_rule_ids: [],
        priority: null
      })
    })
    expect(byRule(runDeterministicCheck(withBackground), "function_without_uc")).toContainEqual(
      expect.objectContaining({ target_id: "FN900", level: "yellow", remediation_step: "S-3.2" })
    )
  })

  it("orphan_screen: màn không actor người nào dùng, màn đứng riêng trong luồng, popup không ai mở", () => {
    const flags = byRule(
      runDeterministicCheck(
        variant((s) => {
          const tpl = s.screens.find((x) => x.id === "S13")!
          s.screens.push({ ...tpl, id: "S20", name: "No Actor", flow_to: [] })
          s.permissions.push({ id: "P999", screen_id: "S21", role_id: s.roles[0].id, action: "view" })
          s.screens.push({ ...tpl, id: "S21", name: "Isolated", flow_to: [] })
          s.permissions.push({ id: "P998", screen_id: "S22", role_id: s.roles[0].id, action: "view" })
          s.screens.push({ ...tpl, id: "S22", name: "Lonely Popup", flow_to: [], is_popup: true })
        })
      ),
      "orphan_screen"
    )
    expect(flags.map((f) => f.target_id)).toEqual(["S20", "S21", "S22"])
    expect(flags.every((f) => f.level === "yellow" && f.section_id === "fixed:3.1.1" && f.remediation_step === "S-4.2")).toBe(true)
  })

  it("orphan_screen_at_baseline: màn mồ côi thành cờ đỏ chỉ khi ký baseline", () => {
    const orphaned = variant((s) => {
      s.screens.push({ ...s.screens.find((x) => x.id === "S13")!, id: "S20", name: "No Actor", flow_to: [] })
    })
    expect(byRule(runDeterministicCheck(orphaned), "orphan_screen_at_baseline")).toEqual([])
    expect(byRule(runDeterministicCheck(orphaned, [], { atBaseline: true }), "orphan_screen_at_baseline")).toMatchObject([
      { level: "red", section_id: "fixed:3.1.1", target_id: "S20", remediation_step: "S-4.2" }
    ])
  })

  it("xoá actor thẳng tay ⇒ dead_reference ở §2.2.2, remediation S-3.2", () => {
    const flags = byRule(runDeterministicCheck(variant((s) => (s.actors = s.actors.filter((a) => a.id !== "A08")))), "dead_reference")
    expect(flags.map((f) => f.target_id).sort()).toEqual(["use_cases[id=UC01].actor_ids[=A08]", "use_cases[id=UC03].actor_ids[=A08]"])
    expect(flags.every((f) => f.section_id === "fixed:2.2.2" && f.remediation_step === "S-3.2")).toBe(true)
  })

  it("mảng bảo vệ rỗng ⇒ array_empty + section_empty", () => {
    const flags = runDeterministicCheck(variant((s) => (s.common_requirements = [])))
    expect(byRule(flags, "array_empty")).toMatchObject([{ section_id: "fixed:5.2", target_id: "common_requirements", remediation_step: "S-7.2" }])
    expect(byRule(flags, "section_empty")).toMatchObject([{ section_id: "fixed:5.2" }])
  })

  it("NFR reliability thiếu metric ⇒ nfr_missing_number", () => {
    const n = FIXTURE.nfrs.find((x) => x.category === "reliability")!
    const flags = byRule(runDeterministicCheck(variant((s) => delete s.nfrs.find((x) => x.id === n.id)!.metric)), "nfr_missing_number")
    expect(flags).toMatchObject([{ section_id: "fixed:4.2.2", target_id: n.id, remediation_step: "S-6.3" }])
  })

  it("render_error / diagram_stale (hash TBD bỏ qua, hash đúng không cờ)", () => {
    const d = FIXTURE.diagrams.find((x) => x.kind === "usecase")!
    const errored = runDeterministicCheck(variant((s) => Object.assign(s.diagrams.find((x) => x.id === d.id)!, { render_status: "error", error: "syntax" })))
    expect(byRule(errored, "render_error")).toMatchObject([{ section_id: "fixed:2.2.1", target_id: d.id, remediation_step: "S-3.6" }])

    const wrong = runDeterministicCheck(variant((s) => (s.diagrams.find((x) => x.id === d.id)!.source_hash = "0".repeat(64))))
    expect(byRule(wrong, "diagram_stale")).toMatchObject([{ target_id: d.id }])

    const fresh = variant((s) => (s.diagrams.find((x) => x.id === d.id)!.source_hash = computeSourceHash(FIXTURE, d)))
    expect(byRule(runDeterministicCheck(fresh), "diagram_stale")).toEqual([])
  })

  it("luật S-9 chỉ chạy khi atBaseline", () => {
    const spine = variant((s) => {
      s.screens.find((x) => x.id === "S02")!.detail_status = "pending"
      s.assumptions[0].status = "unconfirmed"
      s.steps.find((x) => x.id === "S-7.2")!.status = "revision_requested"
    })
    const changes: Change[] = [
      { projectId: "p", seq: 10_000, txn: "t", op: "set", path: "entities[id=E01].name", before: "a", value: "b", reason: null, at: "2026-09-14T08:00:00.000Z", by: "u", step_id: null }
    ]
    const normal = runDeterministicCheck(spine, changes)
    for (const rule of ["screen_pending_at_baseline", "unconfirmed_assumption", "section_stale_at_baseline", "section_awaiting_reaccept"]) {
      expect(byRule(normal, rule), rule).toEqual([])
    }

    const atBaseline = runDeterministicCheck(spine, changes, { atBaseline: true })
    expect(byRule(atBaseline, "screen_pending_at_baseline")).toMatchObject([{ target_id: "S02", section_id: "function:FN006", remediation_step: "S-5.1@S02" }])
    // L11c: `remediation_step` là step XỬ LÝ được cờ (S-9.2 Assumption Sweep), không phải step đã sinh ra giả
    // định — trỏ về nơi sinh thì chạy lại bao nhiêu lần cũng không đóng được cờ, chỉ đốt trần 8 lượt gọi model.
    expect(byRule(atBaseline, "unconfirmed_assumption")).toMatchObject([
      { target_id: "AS01", section_id: "fixed:4.2.2", remediation_step: "S-9.2" }
    ])
    expect(byRule(atBaseline, "unconfirmed_assumption")[0]?.message, "vẫn truy được nơi sinh qua message").toContain("S-6.3")
    expect(byRule(atBaseline, "section_stale_at_baseline").map((f) => f.section_id)).toContain("fixed:3.1.5")
    expect(byRule(atBaseline, "section_awaiting_reaccept")).toMatchObject([{ section_id: "fixed:5.2", remediation_step: "S-7.2" }])
  })

  it("luật vàng cardinality + non_english_content (bỏ qua addendum)", () => {
    const flags = runDeterministicCheck(
      variant((s) => {
        s.roles[0].actor_id = null
        s.actors.push({ id: "A99", name: "Auditor", kind: "human", description: "" })
        s.use_cases[0].function_ids = []
        s.features.push({ id: "F7", name: "Empty", order: 6 })
        s.screens.push({ ...s.screens[1], id: "S99", flow_to: [], primary_function_id: null })
        s.actors[1].description = "Người dùng cuối"
      })
    )
    expect(byRule(flags, "role_no_actor")).toMatchObject([{ target_id: FIXTURE.roles[0].id }])
    expect(byRule(flags, "orphan_actor")).toMatchObject([{ target_id: "A99", remediation_step: "S-3.2" }])
    expect(byRule(flags, "usecase_no_function")).toMatchObject([{ target_id: FIXTURE.use_cases[0].id }])
    expect(byRule(flags, "empty_feature")).toMatchObject([{ section_id: "feature:F7" }])
    expect(byRule(flags, "screen_no_function")).toMatchObject([{ target_id: "S99" }])
    expect(byRule(flags, "non_english_content")).toMatchObject([{ target_id: FIXTURE.actors[1].id }])
    expect(flags.every((f) => f.level === "yellow" || f.rule_id === "dead_reference")).toBe(true)
  })


  it("BUG-11: đã có system_name tiếng Anh ⇒ không quét project.name nữa", () => {
    const viName = (s: Spine) => (s.project.name = "Phòng khám Minh An")
    const withoutSystemName = variant((s) => {
      viName(s)
      s.project.system_name = null
    })
    expect(byRule(runDeterministicCheck(withoutSystemName), "non_english_content")).toMatchObject([
      { section_id: "fixed:1", remediation_step: "S-2.1" }
    ])

    const withSystemName = variant((s) => {
      viName(s)
      s.project.system_name = "Minh An Booking"
    })
    expect(byRule(runDeterministicCheck(withSystemName), "non_english_content").filter((f) => f.section_id === "fixed:1")).toEqual([])
  })

  it("quan hệ use case hỏng: tự tham chiếu, vòng, cùng cặp hai quan hệ ⇒ cờ đỏ", () => {
    const relation = (s: Spine) => byRule(runDeterministicCheck(s), "usecase_relation_invalid")
    const uc = (s: Spine, id: string) => s.use_cases.find((u) => u.id === id)!

    const self = relation(variant((s) => (uc(s, "UC01").includes = ["UC01"])))
    expect(self).toMatchObject([{ target_id: "UC01", level: "red", section_id: "fixed:2.2.2", remediation_step: "S-3.4" }])
    expect(self[0].message).toContain("tự tham chiếu")

    const cycle = relation(variant((s) => {
      uc(s, "UC01").includes = ["UC02"]
      uc(s, "UC02").includes = ["UC01"]
    }))
    // Mọi use case trên vòng đều bị cờ, không riêng use case đóng vòng
    expect(cycle.map((f) => f.target_id).sort()).toEqual(["UC01", "UC02"])
    expect(cycle.every((f) => f.message.includes("vòng"))).toBe(true)

    const cycle3 = relation(variant((s) => {
      uc(s, "UC04").extends = ["UC05"]
      uc(s, "UC05").extends = ["UC06"]
      uc(s, "UC06").extends = ["UC04"]
    }))
    expect(cycle3.map((f) => f.target_id).sort()).toEqual(["UC04", "UC05", "UC06"])

    // Vòng khép qua node đã duyệt xong (UC01→UC05→UC02→UC01 trong khi UC02 được thăm trước qua UC01→UC02)
    const crossEdge = relation(variant((s) => {
      uc(s, "UC01").includes = ["UC02", "UC05"]
      uc(s, "UC02").includes = ["UC01"]
      uc(s, "UC05").includes = ["UC02"]
    }))
    expect(crossEdge.map((f) => f.target_id).sort()).toEqual(["UC01", "UC02", "UC05"])

    const both = relation(variant((s) => {
      uc(s, "UC01").includes = ["UC02"]
      uc(s, "UC02").extends = ["UC01"]
    }))
    expect(both.map((f) => f.target_id).sort()).toEqual(["UC01", "UC02"])
    expect(both.every((f) => f.message.includes("vừa include vừa extend"))).toBe(true)
    expect(both.every((f) => f.message.includes("vòng"))).toBe(false)
  })

  it("use case không actor, không quan hệ ⇒ usecase_floating", () => {
    const flags = byRule(runDeterministicCheck(variant((s) => (s.use_cases.find((u) => u.id === "UC16")!.actor_ids = []))), "usecase_floating")
    expect(flags).toMatchObject([{ target_id: "UC16", level: "yellow", section_id: "fixed:2.2.2", remediation_step: "S-3.2" }])
    // UC14 extends UC15 và UC13 bị include ⇒ không lơ lửng dù gỡ hết actor
    for (const id of ["UC14", "UC13"]) {
      expect(byRule(runDeterministicCheck(variant((s) => (s.use_cases.find((u) => u.id === id)!.actor_ids = []))), "usecase_floating")).toEqual([])
    }
  })

  it("đặt tên: ngữ nghĩa và chính tả là hai rule_id khác nhau, cùng target vẫn ra hai cờ", () => {
    const named = (name: string, rule: string) =>
      byRule(runDeterministicCheck(variant((s) => (s.use_cases.find((u) => u.id === "UC05")!.name = name))), rule)

    expect(named("Manage Projects", "usecase_name_semantic")).toMatchObject([{ target_id: "UC05", remediation_step: "S-3.2" }])
    expect(named("Manage Projects", "usecase_name_style")).toEqual([])
    expect(named("manage projects", "usecase_name_semantic")).toHaveLength(1)
    expect(named("manage projects", "usecase_name_style")).toHaveLength(1)

    const actorFlags = byRule(runDeterministicCheck(variant((s) => (s.actors[0].name = "User"))), "actor_name_shape")
    expect(actorFlags).toMatchObject([{ target_id: FIXTURE.actors[0].id, level: "yellow", section_id: "fixed:2.1", remediation_step: "S-3.1" }])
  })

  it("U1 xét CHỮ CÁI đầu tiên, U3 bỏ dấu câu quanh từ đầu", () => {
    const codes = (name: string) => checkUseCaseName(name, ["Founder", "Scheduler"], [name])

    // Số hay dấu mở đầu từ không phải lỗi hoa thường — trước đây `/^[A-Z]/` bắn cả bốn tên này
    for (const name of ["Export 2FA Backup Codes", "Top 10 Projects", "Pay Invoice (Optional)", "e-Sign Document"]) {
      expect(codes(name).style, name).not.toContain("U1")
    }
    expect(codes("accept step at gate").style).toContain("U1")
    expect(codes("Accept Step.").style).toContain("U1")

    // Động từ thô còn bị bắt khi dính dấu câu
    for (const name of ["Manage Projects", "Manage: Projects", "Manage-Projects"]) {
      expect(codes(name).semantic, name).toContain("U3")
    }
    // `Scheduler` là actor nhưng `Scheduled` không phải ⇒ U4 khớp nguyên từ, không khớp tiền tố
    expect(codes("Run Scheduled Housekeeping").style).not.toContain("U4")
    expect(codes("Notify Founder").style).toContain("U4")
  })

  it("tên đúng chuẩn không sinh cờ: từ phụ viết hoa giữa tên, actor có định ngữ", () => {
    const naming = (s: Spine) => runDeterministicCheck(s).filter((f) => ["usecase_name_semantic", "usecase_name_style", "actor_name_shape"].includes(f.rule_id))
    expect(naming(variant((s) => (s.use_cases.find((u) => u.id === "UC10")!.name = "Accept Step At Gate")))).toEqual([])
    expect(naming(variant((s) => (s.actors[0].name = "Registered User")))).toEqual([])
  })

  it("U1 chấp nhận giới từ via/into/onto/per/vs viết thường giữa tên", () => {
    for (const name of ["Create SRS via Guided Interview", "Copy Item into Folder", "Report Usage per Branch", "Compare Plan vs Actual"]) {
      expect(checkUseCaseName(name, [], [name]).style, name).not.toContain("U1")
    }
  })

  it("use case truy cập tài khoản: nhận theo nguyên cụm từ, không theo chuỗi con", () => {
    for (const name of ["Log In", "Login", "Sign In with Google", "Sign Up", "Register", "Register Account", "Create an Account",
      "Reset Password", "Forgot Password", "Recover Account", "Authenticate", "Đăng nhập", "Đăng ký", "Quên mật khẩu"]) {
      expect(isAccountAccessUseCase(name), name).toBe(true)
    }
    // Chuẩn hoá NFC: tiếng Việt dạng tổ hợp (NFD) từ tài liệu nhập vẫn nhận ra
    expect(isAccountAccessUseCase("Đăng nhập".normalize("NFD"))).toBe(true)
    expect(isAccountAccessUseCase("Log In to Staff Portal")).toBe(true)
    expect(isAccountAccessUseCase("Đăng nhập bằng Google")).toBe(true)
    // Cụm phải đứng đầu tên, phần sau chỉ là bổ ngữ cách thức
    for (const name of ["Registered Book Loan", "Register Book Loan", "Change Delivery Address", "Place Order", "Blogin Feed",
      "View Login History", "Sign Up for Newsletter", "Export Login Report", "Xem lịch sử đăng nhập"]) {
      expect(isAccountAccessUseCase(name), name).toBe(false)
    }
  })

  it("use case truy cập tài khoản làm luồng con ⇒ usecase_auth_relation (vàng, S-3.4)", () => {
    const auth = (s: Spine) => byRule(runDeterministicCheck(s), "usecase_auth_relation")
    const uc = (s: Spine, id: string) => s.use_cases.find((u) => u.id === id)!

    // Log In (UC02) bị include
    const included = auth(variant((s) => (uc(s, "UC06").includes = ["UC02"])))
    expect(included).toMatchObject([{ target_id: "UC02", level: "yellow", section_id: "fixed:2.2.2", remediation_step: "S-3.4" }])
    expect(included[0].message).toContain("bị include bởi")

    // Reset Password (UC03) extend Log In
    const extending = auth(variant((s) => (uc(s, "UC03").extends = ["UC02"])))
    expect(extending).toMatchObject([{ target_id: "UC03" }])

    // Log In làm BASE của một extend là hợp lệ; include một use case thường không bắn
    expect(auth(variant((s) => (uc(s, "UC04").extends = ["UC02"])))).toEqual([])
    expect(auth(variant((s) => (uc(s, "UC06").includes = ["UC04"])))).toEqual([])
    expect(auth(FIXTURE)).toEqual([])
  })

  it("actor system/time không tham gia use case nào ⇒ orphan_actor (trước đây chỉ xét human)", () => {
    const systemActor = FIXTURE.actors.find((a) => a.kind === "system")!
    const orphan = byRule(
      runDeterministicCheck(variant((s) => s.use_cases.forEach((u) => (u.actor_ids = u.actor_ids.filter((id) => id !== systemActor.id))))),
      "orphan_actor"
    )
    expect(orphan).toMatchObject([{ target_id: systemActor.id, level: "yellow", section_id: "fixed:2.1", remediation_step: "S-3.2" }])

    const timeActor = FIXTURE.actors.find((a) => a.kind === "time")!
    const orphanTime = byRule(
      runDeterministicCheck(variant((s) => s.use_cases.forEach((u) => (u.actor_ids = u.actor_ids.filter((id) => id !== timeActor.id))))),
      "orphan_actor"
    )
    expect(orphanTime.map((f) => f.target_id)).toEqual([timeActor.id])
  })

  it("Spine rỗng: mọi cờ đỏ có remediation_step và section_id phân giải được", () => {
    for (const spine of [createEmptySpine(), variant((s) => (s.screens = []))]) {
      const flags = runDeterministicCheck(spine, [], { atBaseline: true })
      expect(red(flags).length).toBeGreaterThan(0)
      const index = buildIdIndex(spine)
      for (const f of flags) {
        expect(f.remediation_step, f.rule_id).toMatch(/^(S|B)-\d/)
        expect(sectionKeyExists(index, f.section_id), `${f.rule_id} ${f.section_id}`).toBe(true)
      }
    }
  })
})

describe("system_name_missing (FLF-177)", () => {
  const withSystemName = (name: string | null) => variant((s) => (s.project.system_name = name))

  it("đã vẽ sơ đồ ngữ cảnh/use case mà chưa có system_name ⇒ một cờ vàng, sửa ở B-0.1", () => {
    expect(byRule(runDeterministicCheck(withSystemName(null)), "system_name_missing")).toMatchObject([
      { level: "yellow", section_id: "fixed:1", target_id: null, remediation_step: "B-0.1" }
    ])
    expect(byRule(runDeterministicCheck(withSystemName("  ")), "system_name_missing")).toHaveLength(1)
  })

  it("đã có system_name, hoặc chưa tới bước vẽ sơ đồ ⇒ không cờ", () => {
    expect(byRule(runDeterministicCheck(withSystemName("FlintFlow Studio")), "system_name_missing")).toHaveLength(0)
    expect(byRule(runDeterministicCheck(createEmptySpine({ name: "Demo" })), "system_name_missing")).toHaveLength(0)
  })

  it("system_name tiếng Việt ⇒ non_english_content", () => {
    const flags = byRule(runDeterministicCheck(withSystemName("Giao hàng nhanh")), "non_english_content")
    expect(flags.some((f) => f.message.includes("project.system_name"))).toBe(true)
  })
})
