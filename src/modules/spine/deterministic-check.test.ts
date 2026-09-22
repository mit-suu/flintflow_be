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
  it("11 luật đỏ + 11 luật vàng; 3 luật không waive được", () => {
    expect(RULES.filter((r) => r.level === "red")).toHaveLength(11)
    expect(RULES.filter((r) => r.level === "yellow")).toHaveLength(12)
    expect([...NON_WAIVABLE_RULES].sort()).toEqual(["array_empty", "dead_reference", "render_error"])
  })
})

describe("runDeterministicCheck", () => {
  it("fixture đầy đủ: 0 cờ đỏ (kể cả atBaseline), cờ vàng chỉ có thể là screen_no_function", () => {
    expect(red(runDeterministicCheck(FIXTURE))).toEqual([])
    expect(red(runDeterministicCheck(FIXTURE, [], { atBaseline: true }))).toEqual([])
    const yellowRules = new Set(runDeterministicCheck(FIXTURE).filter((f) => f.level === "yellow").map((f) => f.rule_id))
    for (const r of yellowRules) expect(["screen_no_function"]).toContain(r)
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
    expect(byRule(atBaseline, "unconfirmed_assumption")).toMatchObject([
      { target_id: "AS01", section_id: "fixed:4.2.2", remediation_step: "S-6.3" }
    ])
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
