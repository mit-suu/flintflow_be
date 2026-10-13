/**
 * UC-18 … UC-21 — không gian làm việc của dự án SRS, qua HTTP thật trên Mongo in-memory.
 * Spec: docs/report/actors-and-use-cases (1).md (UC-18 Rename, UC-19 Delete, UC-20 View Progress,
 * UC-21 Attach Reference Document) + quy tắc actor (Author = Analyst | Lead; Viewer chỉ đọc).
 *
 * Ca nào hành vi thật lệch spec được viết đúng theo spec và để `it.skip` kèm `// BUG(UC-xx)`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import request from "supertest"
import { Document as DocxDocument, Packer, Paragraph } from "docx"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
// Test không có Cloudinary: giả lập upload, phần parse/ghi DB vẫn là code thật
vi.mock("../../../src/shared/utils/cloudinary.js", () => ({
  uploadFileToCloudinary: vi.fn(async (file: { originalname?: string }) => ({
    public_id: "test/" + (file.originalname ?? "file"),
    secure_url: "https://example.test/" + (file.originalname ?? "file")
  }))
}))

import app from "../../../src/app.js"
import { User } from "../../../src/modules/user/user.model.js"
import { Membership, type OrgRole } from "../../../src/modules/organization/membership.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { ChatSession } from "../../../src/modules/project/chat-session.model.js"
import { ProjectDocument } from "../../../src/modules/project/project-document.model.js"
import { Spine } from "../../../src/modules/spine/spine.model.js"
import { progressResponseSchema } from "../../../src/modules/pipeline/pipeline.dto.js"
import { authAs, seedFixture, type SeededFixture } from "../../setup.js"

const joinOrg = async (orgId: string, email: string, role: OrgRole) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  await Membership.create({ organizationId: orgId, userId: user._id, role })
  return authAs({ _id: user._id, email, orgId })
}

const bearer = (token: string) => ({ Authorization: "Bearer " + token })
const projectUrl = (projectId: string, suffix = "") => "/api/v1/projects/" + projectId + suffix

let seeded: SeededFixture
let lead: string
let analyst: string
let viewer: string

beforeEach(async () => {
  seeded = await seedFixture("minimal")
  lead = seeded.token
  analyst = await joinOrg(seeded.orgId, "analyst@flintflow.test", "analyst")
  viewer = await joinOrg(seeded.orgId, "viewer@flintflow.test", "viewer")
})

// ─── UC-18 ──────────────────────────────────────────────────────────

describe("UC-18 — đổi tên dự án", () => {
  const rename = (token: string, name: unknown, projectId = seeded.projectId) =>
    request(app).patch(projectUrl(projectId, "/name")).set(bearer(token)).send({ name })

  it("Lead đổi tên ⇒ 200, tên mới được lưu", async () => {
    const res = await rename(lead, "Lumen — bản đổi tên")
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe("Lumen — bản đổi tên")
    expect((await Project.findById(seeded.projectId))?.name).toBe("Lumen — bản đổi tên")
  })

  it("Analyst (Author) cũng đổi tên được", async () => {
    const res = await rename(analyst, "Đổi bởi Analyst")
    expect(res.status).toBe(200)
    expect((await Project.findById(seeded.projectId))?.name).toBe("Đổi bởi Analyst")
  })

  it("Viewer đổi tên ⇒ 403 ORG_ROLE_FORBIDDEN, tên giữ nguyên", async () => {
    const before = (await Project.findById(seeded.projectId))?.name
    const res = await rename(viewer, "Viewer đổi tên")
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect((await Project.findById(seeded.projectId))?.name).toBe(before)
  })

  it("tên trống ⇒ 400 NAME_REQUIRED", async () => {
    const res = await rename(lead, "")
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("NAME_REQUIRED")
  })

  // BUG(UC-18): tên quá dài (>100, cùng giới hạn lúc tạo dự án) phải bị từ chối 400 vs code: route
  // PATCH /:projectId/name (src/modules/project/project.route.ts:272) không gắn `RenameProjectSchema`
  // (src/modules/project/project.validation.ts:17) ⇒ tên 101+ ký tự vẫn được lưu, trả 200.
  it.skip("tên dài quá 100 ký tự ⇒ 400 VALIDATION_ERROR", async () => {
    const res = await rename(lead, "x".repeat(101))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("VALIDATION_ERROR")
  })

  // BUG(UC-18): tên chỉ có khoảng trắng phải bị coi là trống vs code: controller chỉ kiểm `!name`
  // (src/modules/project/project.controller.ts:63), model trim thành "" mà findOneAndUpdate không chạy validator.
  it.skip("tên chỉ toàn khoảng trắng ⇒ 400", async () => {
    const res = await rename(lead, "    ")
    expect(res.status).toBe(400)
  })

  it("dự án của org khác ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const other = await seedFixture("minimal")
    const res = await rename(other.token, "Chiếm tên", seeded.projectId)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })
})

// ─── UC-19 ──────────────────────────────────────────────────────────

describe("UC-19 — xoá dự án", () => {
  const remove = (token: string, projectId = seeded.projectId, hard = true) =>
    request(app)
      .delete(projectUrl(projectId) + (hard ? "?hard=true" : ""))
      .set(bearer(token))

  it("Lead xoá vĩnh viễn ⇒ 200, dự án và dữ liệu đi kèm (Spine, phiên chat) biến mất", async () => {
    const res = await remove(lead)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ _id: seeded.projectId, status: "deleted" })

    expect(await Project.countDocuments({ _id: seeded.projectId })).toBe(0)
    expect(await Spine.countDocuments({ projectId: seeded.projectId })).toBe(0)
    expect(await ChatSession.countDocuments({ projectId: seeded.projectId })).toBe(0)

    const open = await request(app).get(projectUrl(seeded.projectId)).set(bearer(lead))
    expect(open.status).toBe(404)
    const list = await request(app).get("/api/v1/projects").set(bearer(lead))
    expect(list.body.data.map((p: { _id: string }) => p._id)).not.toContain(seeded.projectId)
  })

  it("không truyền hard ⇒ dự án chuyển sang archived, không còn ở trạng thái active", async () => {
    const res = await remove(lead, seeded.projectId, false)
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe("archived")
    expect((await Project.findById(seeded.projectId))?.status).toBe("archived")
  })

  it("Analyst xoá ⇒ 403 ORG_ROLE_FORBIDDEN, dự án còn nguyên", async () => {
    const res = await remove(analyst)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(await Project.countDocuments({ _id: seeded.projectId })).toBe(1)
  })

  it("Viewer xoá ⇒ 403 ORG_ROLE_FORBIDDEN", async () => {
    const res = await remove(viewer)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
    expect(await Project.countDocuments({ _id: seeded.projectId })).toBe(1)
  })

  it("Lead của org khác ⇒ 404 PROJECT_NOT_FOUND, dự án không bị xoá", async () => {
    const other = await seedFixture("minimal")
    const res = await remove(other.token)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
    expect(await Project.countDocuments({ _id: seeded.projectId })).toBe(1)
    expect(await Spine.countDocuments({ projectId: seeded.projectId })).toBe(1)
  })
})

// ─── UC-20 ──────────────────────────────────────────────────────────

describe("UC-20 — xem tiến độ SRS", () => {
  /** Fixture minimal ở lượt ký bản ⇒ mở cờ đỏ (xem flags.int.test.ts). */
  const openRedFlags = async (): Promise<number> => {
    const res = await request(app)
      .post(projectUrl(seeded.projectId, "/flags/recompute"))
      .set(bearer(lead))
      .send({ at_baseline: true })
    expect(res.status).toBe(200)
    const red = (res.body.data as Array<{ level: string }>).filter((f) => f.level === "red").length
    expect(red).toBeGreaterThan(0)
    return red
  }

  it("Lead xem tiến độ ⇒ 200, đúng shape readiness/progress/sections", async () => {
    const res = await request(app).get(projectUrl(seeded.projectId, "/progress")).set(bearer(lead))
    expect(res.status).toBe(200)
    const parsed = progressResponseSchema.parse(res.body.data)
    expect(parsed.progress.total).toBeGreaterThan(0)
    expect(parsed.sections.length).toBeGreaterThan(0)
  })

  it("Author thấy số cờ đỏ đang mở trong tiến độ", async () => {
    const red = await openRedFlags()
    for (const token of [lead, analyst]) {
      const res = await request(app).get(projectUrl(seeded.projectId, "/progress")).set(bearer(token))
      expect(res.status).toBe(200)
      expect(progressResponseSchema.parse(res.body.data).readiness.red_open).toBe(red)
    }
    const flags = await request(app).get(projectUrl(seeded.projectId, "/flags?level=red&open=true")).set(bearer(analyst))
    expect(flags.status).toBe(200)
    expect(flags.body.data).toHaveLength(red)
  })

  it("Viewer (Member) xem được tiến độ step", async () => {
    const res = await request(app).get(projectUrl(seeded.projectId, "/progress")).set(bearer(viewer))
    expect(res.status).toBe(200)
    expect(res.body.data.progress.total).toBeGreaterThan(0)
  })

  // BUG(UC-20): "Authors also see open red flags; a Viewer does not" vs code: GET /progress
  // (src/modules/spine/flags.controller.ts:92-96) trả cùng `readiness.red_open` cho mọi vai trò.
  it.skip("Viewer không thấy số cờ đỏ trong tiến độ", async () => {
    await openRedFlags()
    const res = await request(app).get(projectUrl(seeded.projectId, "/progress")).set(bearer(viewer))
    expect(res.status).toBe(200)
    expect(res.body.data.readiness?.red_open ?? 0).toBe(0)
  })

  // BUG(UC-20): Viewer không được thấy cờ đỏ đang mở vs code: GET /flags (src/modules/spine/flags.route.ts:37
  // + flags.controller.ts:56) không kiểm vai trò, Viewer đọc được toàn bộ cờ đỏ.
  it.skip("Viewer gọi danh sách cờ đỏ ⇒ không nhận được cờ đỏ nào", async () => {
    await openRedFlags()
    const res = await request(app).get(projectUrl(seeded.projectId, "/flags?level=red&open=true")).set(bearer(viewer))
    if (res.status === 200) expect(res.body.data).toHaveLength(0)
    else expect(res.status).toBe(403)
  })

  it("org khác xem tiến độ ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const other = await seedFixture("minimal")
    const res = await request(app).get(projectUrl(seeded.projectId, "/progress")).set(bearer(other.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })
})

// ─── UC-21 ──────────────────────────────────────────────────────────

describe("UC-21 — đính kèm tài liệu tham khảo", () => {
  const upload = (token: string, buffer: Buffer, filename: string, contentType?: string) =>
    request(app)
      .post(projectUrl(seeded.projectId, "/documents"))
      .set(bearer(token))
      .attach("file", buffer, contentType ? { filename, contentType } : filename)

  const docxBuffer = async (text: string): Promise<Buffer> =>
    Packer.toBuffer(new DocxDocument({ sections: [{ children: [new Paragraph(text)] }] }))

  it("Analyst đính kèm .txt ⇒ 201, đọc được chữ và đếm token; xuất hiện trong danh sách", async () => {
    const res = await upload(analyst, Buffer.from("Biên bản họp: khách hàng muốn thanh toán bằng ví điện tử."), "minutes.txt", "text/plain")
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ originalName: "minutes.txt", parseStatus: "success" })
    expect(res.body.data.tokenCount).toBeGreaterThan(0)

    const list = await request(app).get(projectUrl(seeded.projectId, "/documents")).set(bearer(analyst))
    expect(list.status).toBe(200)
    expect(list.body.data.map((d: { originalName: string }) => d.originalName)).toContain("minutes.txt")
  })

  it("Lead đính kèm .md và .docx ⇒ 201, đều đọc được chữ", async () => {
    const md = await upload(lead, Buffer.from("# Ghi chú\n- Người dùng đăng nhập bằng email"), "notes.md", "text/markdown")
    expect(md.status).toBe(201)
    expect(md.body.data.parseStatus).toBe("success")

    const docx = await upload(
      lead,
      await docxBuffer("Email khách hàng: cần xuất báo cáo PDF hằng tuần."),
      "email.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    expect(docx.status).toBe(201)
    expect(docx.body.data.parseStatus).toBe("success")
    const saved = await ProjectDocument.findById(docx.body.data._id)
    expect(saved?.extractedText).toContain("báo cáo PDF")
  })

  it("định dạng ảnh (.png) ⇒ 400 UNSUPPORTED_FILE_TYPE, không lưu tài liệu", async () => {
    const res = await upload(analyst, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "diagram.png", "image/png")
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("UNSUPPORTED_FILE_TYPE")
    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId })).toBe(0)
  })

  // BUG(UC-21): chỉ nhận .docx, .md, .txt (spec cũng loại PDF ở mục "dropped") vs code: allow-list gồm cả
  // application/pdf, .pdf, .doc (src/modules/project/project-document.service.ts:22-30).
  it.skip("file .pdf ⇒ 400 UNSUPPORTED_FILE_TYPE", async () => {
    const res = await upload(analyst, Buffer.from("%PDF-1.4\n%%EOF"), "spec.pdf", "application/pdf")
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("UNSUPPORTED_FILE_TYPE")
  })

  // BUG(UC-21): tài liệu vượt giới hạn token phải bị từ chối vs code: chỉ đếm `tokenCount`
  // (project-document.service.ts:59-65), không có ngưỡng token nào; chỉ có giới hạn 10 MB của multer.
  it.skip("tài liệu vượt giới hạn token ⇒ bị từ chối, không lưu", async () => {
    // ~2,5 triệu token theo heuristic 4 ký tự/token, vẫn dưới 10 MB
    const res = await upload(analyst, Buffer.alloc(9_900_000, "a"), "huge.txt", "text/plain")
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await ProjectDocument.countDocuments({ projectId: seeded.projectId })).toBe(0)
  })

  it("file vượt 10 MB ⇒ 413 FILE_TOO_LARGE", async () => {
    const res = await upload(analyst, Buffer.alloc(10 * 1024 * 1024 + 1, "a"), "big.txt", "text/plain")
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe("FILE_TOO_LARGE")
  })

  it("không gửi file ⇒ 400 FILE_REQUIRED", async () => {
    const res = await request(app).post(projectUrl(seeded.projectId, "/documents")).set(bearer(analyst))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("FILE_REQUIRED")
  })

  it("Viewer đính kèm ⇒ 403 ORG_ROLE_FORBIDDEN", async () => {
    const res = await upload(viewer, Buffer.from("ghi chú"), "notes.txt", "text/plain")
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  // BUG(UC-21): "Only Analysts and Leads can see reference documents" vs code: GET /:projectId/documents
  // (src/modules/project/project.route.ts:145) không có requireRole ⇒ Viewer nhận 200 kèm toàn bộ tài liệu.
  it.skip("Viewer xem danh sách tài liệu tham khảo ⇒ 403 ORG_ROLE_FORBIDDEN", async () => {
    expect((await upload(analyst, Buffer.from("ghi chú nội bộ"), "internal.txt", "text/plain")).status).toBe(201)
    const res = await request(app).get(projectUrl(seeded.projectId, "/documents")).set(bearer(viewer))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("org khác xem danh sách tài liệu ⇒ 404 PROJECT_NOT_FOUND", async () => {
    const other = await seedFixture("minimal")
    const res = await request(app).get(projectUrl(seeded.projectId, "/documents")).set(bearer(other.token))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND")
  })
})
