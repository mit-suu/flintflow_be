import mongoose from "mongoose"
import { describe, it, expect } from "vitest"
import {
  answersRequestSchema,
  changeRequestDetailSchema,
  changeRequiresCrMetaSchema,
  closeRequestSchema,
  createChangeRequestSchema,
  groupDecisionRequestSchema,
  patchLocationRequestSchema
} from "./change-request.dto.js"
import { formatCrId } from "./change-request.constants.js"
import { ChangeRequest, CrCounter } from "./change-request.model.js"
import { ChangeLocation } from "./change-location.model.js"
import { ChangeGroup } from "./change-group.model.js"

const AT = "2026-09-18T08:00:00.000Z"
const oid = () => new mongoose.Types.ObjectId()

describe("change-request DTO — request", () => {
  const create = {
    title: "Đăng xuất mọi thiết bị",
    description: "Logging out must sign the user out of all devices.",
    source: { kind: "stakeholder_email", ref: "Email PM 2026-09-17" },
    requester: "PM Lan"
  }

  it("tạo CR: source + requester bắt buộc; ref/note mặc định null", () => {
    const parsed = createChangeRequestSchema.parse(create)
    expect(parsed.source).toEqual({ kind: "stakeholder_email", ref: "Email PM 2026-09-17", note: null })
    const { source: _s, ...noSource } = create
    expect(createChangeRequestSchema.safeParse(noSource).success).toBe(false)
    expect(createChangeRequestSchema.safeParse({ ...create, requester: "  " }).success).toBe(false)
    expect(createChangeRequestSchema.safeParse({ ...create, source: { kind: "rumor" } }).success).toBe(false)
  })

  it("mode 1 v3: tạo CR chỉ nhận 6 nguồn BPMN 3.1 — `chat` bị từ chối (lệnh trong chat là yêu cầu miệng); preview_id tuỳ chọn", () => {
    expect(createChangeRequestSchema.safeParse({ ...create, source: { kind: "chat", ref: "chat-session 66f0…" } }).success).toBe(false)
    expect(createChangeRequestSchema.parse({ ...create, source: { kind: "verbal", ref: "chat:66f0" } }).source.kind).toBe("verbal")
    expect(createChangeRequestSchema.parse({ ...create, preview_id: "p-1" }).preview_id).toBe("p-1")
    expect(createChangeRequestSchema.safeParse({ ...create, requester: "  " }).success).toBe(false)
  })

  it("trả lời làm rõ: 1–20 câu, không rỗng", () => {
    expect(answersRequestSchema.safeParse({ answers: ["Mọi phiên, kể cả mobile"] }).success).toBe(true)
    expect(answersRequestSchema.safeParse({ answers: [] }).success).toBe(false)
    expect(answersRequestSchema.safeParse({ answers: [""] }).success).toBe(false)
  })

  it("sửa vị trí: kết luận nào cần field đó", () => {
    expect(patchLocationRequestSchema.safeParse({}).success).toBe(false)
    // FLF-186: edit bằng giá trị mới của phần tử hoặc op Spine; new_text (bản theo block) không còn
    expect(patchLocationRequestSchema.safeParse({ conclusion: "edit", new_value: { id: "UC-2.4", name: "Sign out of all devices" } }).success).toBe(true)
    expect(patchLocationRequestSchema.safeParse({ conclusion: "edit", spine_ops: [{ op: "set", path: "use_cases[id=UC-2.4].name", value: "Sign out" }] }).success).toBe(true)
    expect(patchLocationRequestSchema.safeParse({ conclusion: "edit" }).success).toBe(false)
    expect(patchLocationRequestSchema.safeParse({ conclusion: "edit", new_text: "3.2.4 Sign out of all devices" }).success).toBe(false)
    expect(patchLocationRequestSchema.safeParse({ conclusion: "comment" }).success).toBe(false)
    expect(patchLocationRequestSchema.safeParse({ conclusion: "not_related" }).success).toBe(false)
    expect(patchLocationRequestSchema.safeParse({ conclusion: "not_related", reason: "Chỉ nói về đăng nhập" }).success).toBe(true)
  })

  it("duyệt group: duyệt lẫn từ chối đều cần lý do ≥ 10 ký tự (BPMN 3.12); luôn mang base_version", () => {
    expect(groupDecisionRequestSchema.safeParse({ decision: "approved", base_version: 7 }).success).toBe(false)
    expect(groupDecisionRequestSchema.safeParse({ decision: "approved", reason: "ok", base_version: 7 }).success).toBe(false)
    expect(groupDecisionRequestSchema.safeParse({ decision: "approved", reason: "Đúng yêu cầu của khách", base_version: 7 }).success).toBe(true)
    expect(groupDecisionRequestSchema.safeParse({ decision: "rejected", base_version: 7 }).success).toBe(false)
    expect(groupDecisionRequestSchema.safeParse({ decision: "rejected", reason: "không", base_version: 7 }).success).toBe(false)
    expect(groupDecisionRequestSchema.safeParse({ decision: "rejected", reason: "Ngoài phạm vi bản 1.0", base_version: 7 }).success).toBe(true)
    expect(groupDecisionRequestSchema.safeParse({ decision: "approved", reason: "Đúng yêu cầu của khách" }).success).toBe(false)
  })

  it("đóng / huỷ cần lý do", () => {
    expect(closeRequestSchema.safeParse({ reason: "Khách rút yêu cầu" }).success).toBe(true)
    expect(closeRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe("change-request DTO — response", () => {
  it("chi tiết CR: CR + vị trí + group + câu hỏi đang chờ", () => {
    const detail = {
      change_request: {
        cr_id: "CR-001",
        project_id: "66f000000000000000000002",
        title: "Đăng xuất mọi thiết bị",
        description: "…",
        source: { kind: "stakeholder_email", ref: null, note: null },
        requester: "PM Lan",
        status: "in_review",
        paused: null,
        clarifications: [{ round: 1, questions: ["Có tính cả mobile?"], answers: ["Có"] }],
        base_doc_version: "0.0",
        result_doc_version: null,
        created_by: "66f000000000000000000001",
        submitted_at: AT,
        decided_by: null,
        closed_reason: null,
        seed: null,
        created_at: AT,
        updated_at: AT
      },
      locations: [
        {
          location_id: "L001",
          path: "use_cases[id=UC-2.4]",
          section_id: "fixed:2.2.2",
          section_title: "Use Case Descriptions",
          current_text: JSON.stringify({ id: "UC-2.4", name: "Log out of system" }, null, 2),
          found_by: ["spine_link", "keyword"],
          entity_paths: ["use_cases[id=UC-2.4]"],
          owner_step: "S-3.2",
          conclusion: "edit",
          reason: "UC đăng xuất phải nói rõ mọi thiết bị",
          proposal: { old_text: "{…Log out…}", new_text: "{…Sign out…}", comment_text: null, spine_ops: [{ op: "set", path: "use_cases[id=UC-2.4].name", value: "Sign out of all devices" }] },
          manual: false,
          redo_count: 0,
          verify: { code_ok: true, violations: [], ai_flags: [], at: AT },
          group_id: "G01"
        }
      ],
      groups: [{ group_id: "G01", title: "UC-2.4 Log out", location_ids: ["L001"], decision: "pending", reason: null, decided_by: null, decided_at: null }],
      pending_questions: []
    }
    expect(changeRequestDetailSchema.safeParse(detail).success).toBe(true)
    expect(changeRequestDetailSchema.safeParse({ ...detail, locations: [{ ...detail.locations[0], redo_count: 3 }] }).success).toBe(false)
  })

  it("409 CHANGE_REQUIRES_CR mang prefill cho form CR", () => {
    expect(changeRequiresCrMetaSchema.safeParse({ prefill: { title: "Đổi tên actor", description: "Rename Learner to Student" } }).success).toBe(true)
  })
})

describe("change-request model", () => {
  it("cr_id theo dạng CR-001, unique theo project; bộ đếm unique theo project", () => {
    expect(formatCrId(1)).toBe("CR-001")
    expect(formatCrId(42)).toBe("CR-042")
    expect(formatCrId(1234)).toBe("CR-1234")
    expect(ChangeRequest.schema.indexes()).toContainEqual([{ projectId: 1, cr_id: 1 }, { unique: true }])
    expect(CrCounter.schema.indexes()).toContainEqual([{ projectId: 1 }, { unique: true }])
  })

  it("CR mới: draft, không pause; từ chối cr_id sai dạng và nguồn lạ", () => {
    const base = { projectId: oid(), cr_id: "CR-001", title: "T", description: "D", source: { kind: "verbal" }, requester: "PM", base_doc_version: "0.0", created_by: oid() }
    const cr = new ChangeRequest(base)
    expect(cr.validateSync()).toBeUndefined()
    expect(cr.status).toBe("draft")
    expect(cr.paused).toBeNull()
    expect(new ChangeRequest({ ...base, cr_id: "CR1" }).validateSync()?.errors.cr_id).toBeDefined()
    expect(new ChangeRequest({ ...base, source: { kind: "rumor" } }).validateSync()).toBeDefined()
  })

  it("vị trí: một phần tử Spine một lần mỗi CR; redo_count ≤ 2; kết luận thuộc edit | comment | not_related", () => {
    expect(ChangeLocation.schema.indexes()).toContainEqual([{ projectId: 1, cr_id: 1, path: 1 }, { unique: true }])
    const base = { projectId: oid(), cr_id: "CR-001", location_id: "L001", path: "use_cases[id=UC-2.4]", section_id: "fixed:2.2.2", found_by: ["mention"] }
    expect(new ChangeLocation({ ...base, path: undefined }).validateSync()?.errors.path).toBeDefined()
    expect(new ChangeLocation(base).validateSync()).toBeUndefined()
    expect(new ChangeLocation({ ...base, redo_count: 3 }).validateSync()?.errors.redo_count).toBeDefined()
    expect(new ChangeLocation({ ...base, conclusion: "delete" }).validateSync()?.errors.conclusion).toBeDefined()
    expect(new ChangeLocation({ ...base, found_by: ["guess"] }).validateSync()).toBeDefined()
  })

  it("group mặc định pending", () => {
    const g = new ChangeGroup({ projectId: oid(), cr_id: "CR-001", group_id: "G01", title: "UC-2.4", location_ids: ["L001"] })
    expect(g.validateSync()).toBeUndefined()
    expect(g.decision).toBe("pending")
    expect(new ChangeGroup({ projectId: oid(), cr_id: "CR-001", group_id: "1", title: "x" }).validateSync()?.errors.group_id).toBeDefined()
  })
})
