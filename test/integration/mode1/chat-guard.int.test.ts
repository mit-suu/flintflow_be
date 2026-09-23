/**
 * Guard G9 / BR-03 qua HTTP (FLF-172, P4 §8.3 `chat-guard.test.ts`; plan §6 2G) — mode 1 v3 (BPMN Flow 1 ⇒ 3.1):
 * project mode 1 đã import (baseline v0) — chat ra lệnh sửa (JSON + stream), `/changes`, `/reconcile`, `/undo` ⇒
 * `409 CHANGE_REQUIRES_CR` kèm `meta.prefill` cho form 3.1, **không tự tạo CR**; Spine không đổi. `/changes/preview`
 * chỉ đọc ⇒ chạy, kèm `meta.requires_cr`. Project mode 2 không bị chặn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import request from "supertest"

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())

import app from "../../../src/app.js"
import { seedFixture, type SeededFixture } from "../../setup.js"
import { mockCalls, mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { createMode1Project, fakeMode1 } from "../../helpers/mode1.js"
import { importedProject } from "../../helpers/mode1-release-p4.js"
import { markBaselineV1 } from "../../helpers/mode1-v2.js"
import { changeRequiresCrMetaSchema } from "../../../src/modules/change-request/change-request.dto.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"

/** Project mode 1 chưa import nhưng đã có baseline — đủ điều kiện chặn (mode 1 v3: có baseline bất kỳ là chặn). */
const createBlocked = async (seeded: SeededFixture): Promise<string> => {
  const id = await createMode1Project(seeded)
  await markBaselineV1(id)
  return id
}

beforeEach(() => {
  resetMockLlm()
  // dựng project đã import cần output I-4 / I-1.11 đúng schema
  mockOverrides.next = (p) => fakeMode1(p)
})

const client = (seeded: SeededFixture, projectId: string) => {
  const auth = { Authorization: `Bearer ${seeded.token}` }
  const base = `/api/v1/projects/${projectId}`
  return {
    post: (suffix: string, body: object = {}) => request(app).post(`${base}${suffix}`).set(auth).send(body),
    spineVersion: async () => (await request(app).get(`${base}/spine`).set(auth)).body.data.spine_version as number,
    listCrs: async () => (await request(app).get(`${base}/change-requests`).set(auth)).body.data as unknown[],
    newChat: async () => {
      const res = await request(app).post(`${base}/chats`).set(auth).send({})
      expect(res.status, JSON.stringify(res.body.error)).toBe(201)
      return res.body.data._id as string
    }
  }
}

const expectBlocked = (res: request.Response, label: string) => {
  expect(res.status, label).toBe(409)
  expect(res.body.error?.code, label).toBe("CHANGE_REQUIRES_CR")
  return changeRequiresCrMetaSchema.parse(res.body.meta).prefill
}

/** Route có ghi — preview chỉ đọc nên không nằm đây. */
const SPINE_ROUTES = ["/changes", "/reconcile", "/undo"] as const
const VERBAL = { kind: "verbal", ref: null } as const

describe("chặn sửa ngoài CR — /changes, /reconcile, /undo (mode 1)", () => {
  it("project mode 1 vừa import (v0): mọi route ghi Spine ⇒ 409 kèm prefill (gợi ý nguồn yêu cầu miệng); Spine không đổi, không gọi AI", async () => {
    const { seeded, projectId } = await importedProject()
    const c = client(seeded, projectId)
    const version = await c.spineVersion()
    const before = (await spineRepository.get(projectId))!
    const calls = mockCalls.length
    for (const path of SPINE_ROUTES) {
      const prefill = expectBlocked(await c.post(path, { base_version: version, instruction: "Rename actor Learner to Student" }), path)
      expect(prefill, path).toEqual({ title: "Rename actor Learner to Student", description: "Rename actor Learner to Student", source: VERBAL })
    }
    const after = (await spineRepository.get(projectId))!
    expect(after.spine_version).toBe(before.spine_version)
    expect(JSON.stringify(after.actors)).toBe(JSON.stringify(before.actors))
    expect(mockCalls.length).toBe(calls)
  })

  it("không tự tạo CR (3.1 là việc của BA); /changes/preview chạy được kèm meta.requires_cr, không ghi", async () => {
    const { seeded, projectId } = await importedProject()
    const c = client(seeded, projectId)
    const version = await c.spineVersion()

    const preview = await c.post("/changes/preview", { base_version: version, ops: [{ op: "set", path: "project.vision", value: "Vision mới" }] })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    expect(preview.body.meta).toMatchObject({ requires_cr: true })
    expect(preview.body.data.ok).toBe(true)
    expect(await c.spineVersion()).toBe(version)

    expectBlocked(await c.post("/changes", { base_version: version, instruction: "Rename actor Learner to Student" }), "/changes")
    const undo = expectBlocked(await c.post("/undo", { base_version: version }), "/undo")
    expect(undo).toEqual({ title: "Hoàn tác thay đổi gần nhất", description: "Hoàn tác thay đổi gần nhất", source: VERBAL })
    expect(await c.listCrs()).toEqual([])
  })

  it("không có instruction (gửi ops / body rỗng) ⇒ vẫn 409 trước cả kiểm body, prefill mặc định", async () => {
    const seeded = await seedFixture("minimal")
    const c = client(seeded, await createBlocked(seeded))
    const version = await c.spineVersion()
    const withOps = expectBlocked(await c.post("/changes", { base_version: version, ops: [{ op: "set", path: "project.vision", value: "x" }] }), "ops")
    expect(withOps).toEqual({ title: "Sửa tài liệu", description: "Sửa tài liệu", source: VERBAL })
    for (const path of SPINE_ROUTES) expectBlocked(await c.post(path, {}), `${path} rỗng`)
    // instruction không phải chuỗi ⇒ bỏ qua, dùng mặc định
    expect(expectBlocked(await c.post("/changes", { instruction: 42 }), "số")).toEqual({ title: "Sửa tài liệu", description: "Sửa tài liệu", source: VERBAL })
  })

  it("instruction nhiều dòng / dài ⇒ title = dòng đầu cắt 80 ký tự, description nguyên văn", async () => {
    const seeded = await seedFixture("minimal")
    const c = client(seeded, await createBlocked(seeded))
    const first = `Update ${"very long screen description ".repeat(4)}`.trim()
    const instruction = `${first}\nand also the ERD`
    const prefill = expectBlocked(await c.post("/changes", { base_version: 1, instruction }), "dài")
    expect(prefill.title).toBe(`${first.slice(0, 77)}…`)
    expect(prefill.description).toBe(instruction)
  })

  it("project mode 1 của người khác ⇒ 404, không lộ 409", async () => {
    const owner = await seedFixture("minimal")
    const projectId = await createMode1Project(owner)
    const stranger = await seedFixture("minimal")
    const res = await client(stranger, projectId).post("/changes", { base_version: 1, instruction: "Delete UC-01" })
    expect(res.status).toBe(404)
  })
})

describe("chặn sửa ngoài CR — chat (mode 1)", () => {
  it("chat JSON ra lệnh sửa (v0) ⇒ 409 kèm prefill nguồn yêu cầu miệng ref chat, không tạo CR, không gọi AI; tin nhắn không được lưu", async () => {
    const { seeded, projectId } = await importedProject()
    const c = client(seeded, projectId)
    const chatId = await c.newChat()
    const calls = mockCalls.length
    const res = await c.post(`/chats/${chatId}/messages`, { content: "Rename actor Learner to Student", step: "B-1.1" })
    expect(expectBlocked(res, "chat")).toEqual({
      title: "Rename actor Learner to Student",
      description: "Rename actor Learner to Student",
      source: { kind: "verbal", ref: `chat:${chatId}` }
    })
    expect(mockCalls.length).toBe(calls)
    expect(await c.listCrs()).toEqual([])
    const history = await request(app).get(`/api/v1/projects/${projectId}/chats/${chatId}`).set("Authorization", `Bearer ${seeded.token}`)
    expect(history.status).toBe(200)
    expect(history.body.data.messages).toEqual([])
  })

  it("chat stream ra lệnh sửa ⇒ 409 JSON (không mở SSE) + prefill", async () => {
    const seeded = await seedFixture("minimal")
    const projectId = await createBlocked(seeded)
    const c = client(seeded, projectId)
    const chatId = await c.newChat()
    const res = await c.post(`/chats/${chatId}/messages/stream`, { content: "Delete use case UC-01\nvì trùng UC-02", step: "B-1.1" })
    expect(String(res.headers["content-type"])).toContain("application/json")
    expect(expectBlocked(res, "stream")).toEqual({
      title: "Delete use case UC-01",
      description: "Delete use case UC-01\nvì trùng UC-02",
      source: { kind: "verbal", ref: `chat:${chatId}` }
    })
  })

  it("câu hỏi (không phải lệnh sửa) ở project mode 1 ⇒ không bị chặn", async () => {
    const seeded = await seedFixture("minimal")
    const c = client(seeded, await createBlocked(seeded))
    const chatId = await c.newChat()
    for (const content of ["What does UC-01 do?", "Tại sao actor Learner cần đăng nhập"]) {
      const res = await c.post(`/chats/${chatId}/messages`, { content, step: "B-1.1" })
      expect(res.body.error?.code, content).not.toBe("CHANGE_REQUIRES_CR")
      expect(res.status, content).not.toBe(409)
    }
  })
})

describe("project mode 2 (fpt) không bị chặn", () => {
  it("/changes/preview, /undo, /reconcile, chat lệnh sửa (JSON + stream) ⇒ không có CHANGE_REQUIRES_CR", async () => {
    const seeded = await seedFixture("minimal")
    const c = client(seeded, seeded.projectId)
    const preview = await c.post("/changes/preview", { base_version: seeded.spineVersion, ops: [{ op: "set", path: "project.vision", value: "x" }] })
    expect(preview.status, JSON.stringify(preview.body.error)).toBe(200)
    expect(preview.body.meta?.requires_cr).toBeUndefined()
    for (const path of ["/undo", "/reconcile"]) {
      const res = await c.post(path, { base_version: seeded.spineVersion })
      expect(res.body.error?.code, path).not.toBe("CHANGE_REQUIRES_CR")
    }
    const applied = await c.post("/changes", { base_version: seeded.spineVersion, ops: [{ op: "set", path: "project.vision", value: "Vision mới" }] })
    expect(applied.status, JSON.stringify(applied.body.error)).toBe(200)
    expect((await spineRepository.get(seeded.projectId))!.spine_version).toBeGreaterThan(seeded.spineVersion)

    const chatId = await c.newChat()
    const chat = await c.post(`/chats/${chatId}/messages`, { content: "Rename actor Learner to Student", step: "B-1.1" })
    expect(chat.body.error?.code).not.toBe("CHANGE_REQUIRES_CR")
    const stream = await c.post(`/chats/${chatId}/messages/stream`, { content: "Delete use case UC-01", step: "B-1.1" })
    expect(stream.status).not.toBe(409)
  })
})
