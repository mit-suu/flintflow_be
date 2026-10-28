/**
 * FLF-318 — Lead ký baseline dự án tạo SRS (`fpt`) ⇒ tự chuyển sang mode 1 (import, `delivered`), version gốc 1.0 = bản
 * Lead ký (mẫu FPT, không DRAFT), tạo CR được ngay: CR ⇒ 1.1, release ⇒ 2.0. Lỗi giữa chừng ⇒ vẫn `fpt` đã ký, mở dự án
 * chạy lại không trùng bản ghi; script migrate dùng cùng service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import JSZip from "jszip"

const failVersion = vi.hoisted(() => ({ on: false }))

vi.mock("../../../src/shared/ai/providers/llm.router.js", async () => (await import("../../helpers/mock-llm.js")).mockLlmRouterModule())
vi.mock("../../../src/modules/doc-version/doc-version.model.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../../src/modules/doc-version/doc-version.model.js")>()
  const create = orig.DocVersion.create.bind(orig.DocVersion)
  orig.DocVersion.create = (async (...args: Parameters<typeof create>) => {
    if (failVersion.on) throw new Error("doc version boom")
    return create(...args)
  }) as typeof create
  return orig
})

import { readFixtureJson, seedFixture, type SeededFixture } from "../../setup.js"
import { mockOverrides, resetMockLlm } from "../../helpers/mock-llm.js"
import { fakeCrClarify, fakeMode1, mode1Api, promptLocations } from "../../helpers/mode1.js"
import { ChangeLocation } from "../../../src/modules/change-request/change-location.model.js"
import { ChatSession } from "../../../src/modules/project/chat-session.model.js"
import { ADD_USE_CASE_REASON, EDIT_USE_CASE_REASON, REMOVE_USE_CASE_REASON } from "../../../src/modules/change-request/add-use-case.service.js"
import * as spineRepository from "../../../src/modules/spine/spine.repository.js"
import { binary, documentXml, releaseNow, routeReplaceCr, writeCr } from "../../helpers/mode1-release-p4.js"
import { versionsResponseSchema } from "../../../src/modules/doc-version/doc-version.dto.js"
import { DocVersion } from "../../../src/modules/doc-version/doc-version.model.js"
import { gridFsDiagramStore } from "../../../src/modules/diagram/diagram-file.store.js"
import { ImportedDocument } from "../../../src/modules/import/imported-document.model.js"
import { TemplateProfile } from "../../../src/modules/import/template-profile.model.js"
import { Project } from "../../../src/modules/project/project.model.js"
import { Baseline } from "../../../src/modules/spine/baseline.model.js"
import { Notification } from "../../../src/modules/notification/notification.model.js"
import { findCandidates } from "../../../src/scripts/migrate-convert-fpt-baselined.js"
import { convertFromFpt } from "../../../src/modules/import/convert-from-fpt.service.js"

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

const seedPngs = async (seeded: SeededFixture): Promise<void> => {
  const spine = readFixtureJson<{ diagrams: Array<{ id: string; render_status: string }> }>("spine-fixture-19-screens.json")
  for (const d of spine.diagrams.filter((x) => x.render_status === "ok")) {
    await gridFsDiagramStore.save(seeded.projectId, d.id, "png", { data: PNG_1X1, contentType: "image/png" })
  }
}

const fptProject = async () => {
  const seeded = await seedFixture("full")
  await seedPngs(seeded)
  return { seeded, c: mode1Api(seeded, seeded.projectId) }
}

const signOff = async (c: ReturnType<typeof mode1Api>) => c.post("/baseline", { base_version: await c.spineVersion() })

beforeEach(() => {
  resetMockLlm()
  failVersion.on = false
  routeReplaceCr("99.5%", "99.9%")
})

describe("FLF-318 — chuyển dự án tạo SRS sang mode 1 khi Lead ký baseline", () => {
  it("ký ⇒ mode import / delivered, ImportedDocument + TemplateProfile + DocVersion 1.0 trỏ baseline vừa ký; Spine không thêm lô", async () => {
    const { seeded, c } = await fptProject()
    const signed = await signOff(c)
    expect(signed.status, JSON.stringify(signed.body.error)).toBe(201)
    expect(signed.body.data.id).toBe("BL001")
    expect(signed.body.meta.project_mode).toBe("import")
    const versionAfterSign = signed.body.meta.spine_version as number

    const project = (await c.get("")).body.data
    expect(project).toMatchObject({ mode: "import", import_state: "delivered", converted_from: "fpt" })
    expect(project.converted_at).toBeTruthy()

    const imported = await ImportedDocument.find({ projectId: seeded.projectId }).lean()
    expect(imported).toHaveLength(1)
    expect(imported[0]).toMatchObject({ status: "delivered", preflight: { status: "accepted" }, file_ref: null })
    expect(imported[0].sha256).toMatch(/^[0-9a-f]{64}$/)

    const profile = await TemplateProfile.findOne({ projectId: seeded.projectId }).lean()
    expect(profile?.layout ?? []).toEqual([])
    expect(profile?.heading_map ?? []).toEqual([])
    expect(profile?.language).toBe("en")

    const versions = versionsResponseSchema.parse((await c.get("/versions")).body.data)
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ version: "1.0", kind: "imported", baseline_id: "BL001", has_original_file: false })
    expect((await Baseline.findById(signed.body.data.snapshot_ref).lean())?.doc_version).toBe("1.0")

    // Dùng lại baseline vừa ký: không snapshot thêm, không ghi Spine (§I không thêm dòng)
    expect(await Baseline.countDocuments({ projectId: seeded.projectId })).toBe(1)
    expect(await c.spineVersion()).toBe(versionAfterSign)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "project_converted" })).toBe(1)
  })

  it("file 1.0 là bản đã ký: không DRAFT, cùng nội dung bản Word baseline xuất từ dự án fpt", async () => {
    const { c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)
    const dl = await binary(c.get("/versions/1.0/download"))
    expect(dl.status).toBe(200)
    expect(dl.headers["content-disposition"]).not.toContain("DRAFT")
    const versionXml = await documentXml(dl.body as Buffer)
    // Watermark DRAFT nằm ở header (`addDraftWatermark`) — chữ "DRAFT" trong nội dung fixture không tính
    const zip = await JSZip.loadAsync(dl.body as Buffer)
    const headers = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/header\d*\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")))
    expect(headers.join("")).not.toContain("DRAFT")
    const exported = await binary(c.get("/export/word?source=baseline&baseline_id=BL001"))
    expect(exported.status).toBe(200)
    // Cùng mẫu FPT: §3.x.y theo khung FPT, mọi tiêu đề mục giống nhau
    const headings = (xml: string) => [...xml.matchAll(/<w:pStyle w:val="Heading\d"\/>.*?<w:t[^>]*>([^<]*)</g)].map((m) => m[1])
    expect(headings(versionXml)).toEqual(headings(await documentXml(exported.body as Buffer)))
    expect(versionXml).toContain("99.5%")
  })

  it("sau chuyển đổi: sửa thẳng ⇒ CHANGE_REQUIRES_CR; CR ⇒ 1.1 (có file tracked); release ⇒ 2.0", async () => {
    const { c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)

    const direct = await c.post("/changes", { base_version: await c.spineVersion(), ops: [{ op: "set", path: "nfrs[id=N05].statement", value: "x" }] })
    expect(direct.status).toBe(409)
    expect(direct.body.error.code).toBe("CHANGE_REQUIRES_CR")

    const first = await writeCr(c, "Higher availability", "Availability must be 99.9% instead of 99.5%")
    expect(first).toEqual({ crId: "CR-001", version: "1.1" })
    const v11 = versionsResponseSchema.parse((await c.get("/versions")).body.data).find((v) => v.version === "1.1")
    expect(v11).toMatchObject({ kind: "cr_revision", based_on: "1.0", has_tracked_file: true })
    expect(await documentXml((await binary(c.get("/versions/1.1/download"))).body as Buffer)).toContain("99.9%")

    const released = await releaseNow(c)
    expect(released.status, JSON.stringify(released.body.error)).toBe(201)
    expect(versionsResponseSchema.parse((await c.get("/versions")).body.data).map((v) => v.version)).toEqual(["2.0", "1.1", "1.0"])
    // Record of Changes khớp số version tài liệu
    const xml = await documentXml((await binary(c.get("/versions/2.0/download"))).body as Buffer)
    const printed = [...xml.matchAll(/>(v\d+\.\d+(?:\.\d+)?)</g)].map((m) => m[1])
    // Business-flow §5.1: dòng CR mang số bản phát hành chứa nó (v2.0), không số phụ nội bộ 1.1 (FLF-330)
    expect(printed).toEqual(expect.arrayContaining(["v1.0", "v2.0"]))
    expect(printed).not.toContain("v1.1")
    expect(printed).not.toContain("v1.0.1")
  })

  it("chuyển đổi lỗi ⇒ vẫn fpt đã ký, không bản ghi dở; mở dự án ⇒ chạy lại thành công, không trùng", async () => {
    const { seeded, c } = await fptProject()
    failVersion.on = true
    const signed = await signOff(c)
    expect(signed.status).toBe(201)
    expect(signed.body.meta.project_mode).toBe("fpt")
    expect(await Project.findById(seeded.projectId).lean()).toMatchObject({ mode: "fpt", converted_from: null })
    expect(await ImportedDocument.countDocuments({ projectId: seeded.projectId })).toBe(0)
    expect(await DocVersion.countDocuments({ projectId: seeded.projectId })).toBe(0)

    failVersion.on = false
    const opened = (await c.get("")).body.data
    expect(opened).toMatchObject({ mode: "import", import_state: "delivered", converted_from: "fpt" })
    expect(await ImportedDocument.countDocuments({ projectId: seeded.projectId })).toBe(1)
    expect(await DocVersion.countDocuments({ projectId: seeded.projectId })).toBe(1)
    expect(await TemplateProfile.countDocuments({ projectId: seeded.projectId })).toBe(1)

    // Gọi lại khi đã chuyển ⇒ không làm gì
    expect(await convertFromFpt(seeded.projectId, seeded.userId)).toBeNull()
    expect(await DocVersion.countDocuments({ projectId: seeded.projectId })).toBe(1)
  })

  it("dự án vi: TemplateProfile theo ngôn ngữ tài liệu, chữ gốc vẫn en ⇒ bản dịch không mất", async () => {
    const { seeded, c } = await fptProject()
    expect((await c.patch("/document-language", { documentLanguage: "vi" })).status).toBe(200)
    expect((await signOff(c)).status).toBe(201)
    expect((await TemplateProfile.findOne({ projectId: seeded.projectId }).lean())?.language).toBe("vi")
    const status = await c.get("/translations/status")
    expect(status.status, JSON.stringify(status.body.error)).toBe(200)
    expect(status.body.data).toMatchObject({ locale: "vi", source_locale: "en" })
    expect(status.body.data.total).toBeGreaterThan(0)
  })

  it("business-flow nguyên tắc 7: dự án tạo SRS đã chuyển vẫn đổi được ngôn ngữ tài liệu (chỉ dự án tải file lên bị khoá)", async () => {
    const { seeded, c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)
    const res = await c.patch("/document-language", { documentLanguage: "vi" })
    expect(res.status, JSON.stringify(res.body.error)).toBe(200)
    expect(res.body.data).toMatchObject({ documentLanguage: "vi", mode: "import", converted_from: "fpt" })
    expect((await TemplateProfile.findOne({ projectId: seeded.projectId }).lean())?.language).toBe("vi")
    expect((await c.get("/translations/status")).body.data).toMatchObject({ locale: "vi", source_locale: "en" })
  })

  it("migrate: dự án fpt đã ký trước khi deploy được tìm thấy và chuyển; chạy lại không còn ứng viên", async () => {
    const { seeded, c } = await fptProject()
    failVersion.on = true
    expect((await signOff(c)).status).toBe(201)
    failVersion.on = false
    expect((await findCandidates()).map((p) => String(p._id))).toContain(seeded.projectId)
    expect(await convertFromFpt(seeded.projectId, seeded.userId, { quiet: true })).toMatchObject({ doc_version: "1.0", baseline_id: "BL001" })
    expect((await findCandidates()).map((p) => String(p._id))).not.toContain(seeded.projectId)
    expect(await Notification.countDocuments({ userId: seeded.userId, type: "project_converted" })).toBe(0)
  })

  /** Lô model soạn cho "Thêm use case Send Absence Warning cho Lecturer" (cùng khuôn lô FLF-311 của chat). */
  const fullBatch = [
    { op: "add", path: "use_cases[]", value: { name: "Send Absence Warning", actor_ids: ["A02"], function_ids: ["$newFn"], description: "The lecturer warns students over the absence limit." } },
    { op: "add", path: "screens[]", value: { id: "$newScreen", name: "Absence Warning", description: "Lists students over the absence limit.", feature_id: "F3", flow_to: ["S07"], tabs: [] } },
    {
      op: "add",
      path: "functions[]",
      value: {
        id: "$newFn",
        name: "Send Absence Warning",
        screen_id: "$newScreen",
        feature_id: "F3",
        trigger: "Lecturer clicks Send warning.",
        description: "Sends a warning to each student whose absence rate is above 20%.",
        normal: ["Lecturer selects the students.", "System sends the warning."],
        abnormal: ["No student selected: system shows an error."],
        validations: [{ kind: "required", statement: "At least one student must be selected." }],
        business_rule_ids: []
      }
    },
    { op: "set", path: "screens[id=S07].flow_to", value: ["S08", "S09", "S10", "$newScreen"] },
    { op: "add", path: "permissions[]", value: { screen_id: "$newScreen", role_id: "R2", action: "view" } },
    { op: "add", path: "messages[]", value: { code: "E-WARN-001", text: "Select at least one student, then send the warning again.", function_ids: ["$newFn"] } }
  ]

  it("sau baseline: CR thêm use case ⇒ một lượt soạn đủ UC + chức năng + màn + luồng + phân quyền; ghi ra 1.1 đủ phần, không cờ đỏ mới", async () => {
    const { seeded, c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)
    let changeCalls = 0
    mockOverrides.next = (p) =>
      fakeMode1(p) ??
      fakeCrClarify({ entity_paths: ["fixed:2.2.2"], keywords: ["Absence"] })(p) ??
      (p.includes("# Apply Change Op") ? (changeCalls++, JSON.stringify({ ops: fullBatch, notes: "Thêm chức năng, màn, luồng và phân quyền." })) : undefined) ??
      (p.includes("# CR Propose")
        ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] })) })
        : undefined)

    const written = await writeCr(c, "Absence warning", "Thêm use case Send Absence Warning cho Lecturer")
    expect(written).toEqual({ crId: "CR-001", version: "1.1" })
    expect(changeCalls).toBe(1)

    const bundle = await ChangeLocation.find({ projectId: seeded.projectId, cr_id: "CR-001", reason: ADD_USE_CASE_REASON }).lean()
    expect(bundle.map((l) => l.path).sort()).toEqual(["functions[]", "messages[]", "permissions[]", "screens[]", "screens[id=S07]", "use_cases[]"])
    // Người duyệt thấy đủ các mục kéo theo: §2.2.x, Functional Requirements (feature), §3.1.1, §3.1.3, §5.3
    expect([...new Set(bundle.map((l) => l.section_id))]).toEqual(expect.arrayContaining(["fixed:2.2.2", "feature:F3", "fixed:3.1.1", "fixed:3.1.3", "fixed:5.3"]))

    const spine = (await spineRepository.get(seeded.projectId))!
    const uc = spine.use_cases.find((u) => u.name === "Send Absence Warning")!
    const fn = spine.functions.find((f) => f.id === uc.function_ids[0])!
    const screen = spine.screens.find((s) => s.id === fn.screen_id)!
    expect(fn.abnormal).toHaveLength(1)
    expect(fn.validations[0].id).toBe(`${fn.id}-V1`)
    expect(screen).toMatchObject({ detail_status: "signed_off", primary_function_id: fn.id, feature_id: "F3" })
    expect(spine.screens.find((s) => s.id === "S07")?.flow_to).toContain(screen.id)
    expect(spine.permissions.some((p) => p.screen_id === screen.id && p.role_id === "R2")).toBe(true)
    expect(spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && f.rule_id !== "diagram_stale")).toEqual([])

    const xml = await documentXml((await binary(c.get("/versions/1.1/download"))).body as Buffer)
    for (const text of ["Send Absence Warning", "Absence Warning", "At least one student must be selected."]) expect(xml).toContain(text)
  })

  it("sau baseline: CR xoá use case ⇒ một lượt soạn xoá luôn chức năng, màn, thông báo chỉ thuộc nó (luật 3g); ghi ra 1.2, không sót", async () => {
    const { seeded, c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)
    mockOverrides.next = (p) =>
      fakeMode1(p) ??
      fakeCrClarify({ entity_paths: ["fixed:2.2.2"], keywords: ["Absence"] })(p) ??
      (p.includes("# Apply Change Op") ? JSON.stringify({ ops: fullBatch, notes: "Thêm chức năng, màn, luồng và phân quyền." }) : undefined) ??
      (p.includes("# CR Propose")
        ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] })) })
        : undefined)
    expect((await writeCr(c, "Absence warning", "Thêm use case Send Absence Warning cho Lecturer")).version).toBe("1.1")

    const added = (await spineRepository.get(seeded.projectId))!
    const uc = added.use_cases.find((u) => u.name === "Send Absence Warning")!
    const fn = added.functions.find((f) => f.id === uc.function_ids[0])!
    const msg = added.messages.find((m) => m.code === "E-WARN-001")!
    const removal = [
      { op: "remove", path: `use_cases[id=${uc.id}]` },
      { op: "remove", path: `functions[id=${fn.id}]` },
      { op: "remove", path: `screens[id=${fn.screen_id}]` },
      { op: "remove", path: `messages[id=${msg.id}]` }
    ]
    const changePrompts: string[] = []
    mockOverrides.next = (p) =>
      fakeMode1(p) ??
      fakeCrClarify({ entity_paths: [`use_cases[id=${uc.id}]`], keywords: ["Absence"] })(p) ??
      (p.includes("# Apply Change Op") ? (changePrompts.push(p), JSON.stringify({ ops: removal, notes: "Xoá use case, chức năng, màn và thông báo của nó." })) : undefined) ??
      (p.includes("# CR Propose")
        ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] })) })
        : undefined)

    const written = await writeCr(c, "Bỏ cảnh báo vắng", "Xoá use case Send Absence Warning")
    expect(written).toEqual({ crId: "CR-002", version: "1.2" })
    expect(changePrompts.length).toBe(1)
    expect(changePrompts[0]).toContain("3g. **Removing a use case")

    const bundle = await ChangeLocation.find({ projectId: seeded.projectId, cr_id: "CR-002", reason: REMOVE_USE_CASE_REASON }).lean()
    expect(bundle.map((l) => l.path).sort()).toEqual(removal.map((o) => o.path).sort())

    const spine = (await spineRepository.get(seeded.projectId))!
    expect(spine.use_cases.some((u) => u.id === uc.id)).toBe(false)
    expect(spine.functions.some((f) => f.id === fn.id)).toBe(false)
    expect(spine.screens.some((s) => s.id === fn.screen_id)).toBe(false)
    expect(spine.permissions.some((p) => p.screen_id === fn.screen_id)).toBe(false)
    expect(spine.screens.find((s) => s.id === "S07")?.flow_to).not.toContain(fn.screen_id)
    expect(spine.flags.filter((f) => f.level === "red" && f.resolved_at === null && f.rule_id !== "diagram_stale")).toEqual([])
  })

  it("sau baseline: CR sửa use case (đổi actor) ⇒ một lượt soạn theo luật 3h: actor + quyền trên màn của nó; ghi ra 1.1", async () => {
    const { seeded, c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)
    const before = (await spineRepository.get(seeded.projectId))!
    const uc = before.use_cases.find((u) => u.id === "UC01")!
    const newActors = uc.actor_ids.map((a) => (a === "A04" ? "A03" : a))
    const screens = [...new Set(before.functions.filter((f) => uc.function_ids.includes(f.id) && f.screen_id).map((f) => f.screen_id as string))]
    const edit = [
      { op: "set", path: "use_cases[id=UC01].actor_ids", value: newActors },
      ...screens.map((screen) => ({ op: "add", path: "permissions[]", value: { screen_id: screen, role_id: "R3", action: "view" } })),
      // Guest (R4) không còn use case nào trên màn ⇒ gỡ quyền cũ cùng lô (luật 3h)
      ...before.permissions.filter((p) => screens.includes(p.screen_id) && p.role_id === "R4").map((p) => ({ op: "remove", path: `permissions[id=${p.id}]` }))
    ]
    const changePrompts: string[] = []
    mockOverrides.next = (p) =>
      fakeMode1(p) ??
      fakeCrClarify({ entity_paths: ["use_cases[id=UC01]"], keywords: [uc.name] })(p) ??
      (p.includes("# Apply Change Op") ? (changePrompts.push(p), JSON.stringify({ ops: edit, notes: "Đổi actor và cấp quyền xem màn." })) : undefined) ??
      (p.includes("# CR Propose")
        ? JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] })) })
        : undefined)

    const written = await writeCr(c, "Đổi actor UC01", "Sửa use case UC01: đổi actor Guest sang Administrator")
    expect(written).toEqual({ crId: "CR-001", version: "1.1" })
    expect(changePrompts.length).toBe(1)
    expect(changePrompts[0]).toContain("3h. **Editing a use case")
    expect(await ChangeLocation.countDocuments({ projectId: seeded.projectId, cr_id: "CR-001", reason: EDIT_USE_CASE_REASON })).toBeGreaterThan(0)

    const spine = (await spineRepository.get(seeded.projectId))!
    expect(spine.use_cases.find((u) => u.id === "UC01")?.actor_ids).toEqual(newActors)
    for (const screen of screens) expect(spine.permissions.some((p) => p.screen_id === screen && p.role_id === "R3" && p.action === "view")).toBe(true)
    expect(spine.permissions.some((p) => screens.includes(p.screen_id) && p.role_id === "R4")).toBe(false)
  })

  it("sau baseline: CR tạo từ bản xem trước trong chat (vòng hỏi đáp như trước baseline) ⇒ bước đề xuất dùng đúng lô đã duyệt, không soạn lại; ra 1.1", async () => {
    const { seeded, c } = await fptProject()
    expect((await signOff(c)).status).toBe(201)
    let changeCalls = 0
    const crCalls = { clarify: 0, propose: 0 }
    mockOverrides.next = (p) =>
      fakeMode1(p) ??
      (p.includes("# CR Clarify") ? (crCalls.clarify++, fakeCrClarify({ entity_paths: ["fixed:2.2.2"], keywords: ["Absence"] })(p)) : undefined) ??
      (p.includes("# Apply Change Op") ? (changeCalls++, JSON.stringify({ ops: fullBatch, notes: "Thêm chức năng, màn, luồng và phân quyền." })) : undefined) ??
      (p.includes("# CR Propose")
        ? (crCalls.propose++, JSON.stringify({ locations: promptLocations(p).map((l) => ({ location_id: l.location_id, conclusion: "not_related", reason: "Khác", spine_ops: [] })) }))
        : undefined)

    // Chat mode 1: bản xem trước chỉ đọc (meta.requires_cr), đúng vòng hỏi đáp của trước baseline
    const instruction = "Thêm use case Send Absence Warning cho Lecturer, màn hình riêng"
    const shown = await c.post("/changes/preview", { base_version: await c.spineVersion(), instruction, session_id: seeded.sessionId })
    expect(shown.status, JSON.stringify(shown.body.error)).toBe(200)
    expect(shown.body.meta.requires_cr).toBe(true)
    expect(shown.body.data.ok, JSON.stringify(shown.body.data.violations)).toBe(true)
    expect(changeCalls).toBe(1)

    const created = await c.post("/change-requests", {
      title: instruction,
      description: `${instruction}

Trả lời làm rõ:
- Màn hình riêng`,
      source: { kind: "verbal", ref: null, note: "Tạo từ bản xem trước trong khung chat" },
      requester: "PM",
      preview_id: shown.body.data.preview_id
    })
    expect(created.status, JSON.stringify(created.body.error)).toBe(201)
    const crId = created.body.data.change_request.cr_id as string
    // Tin bản xem trước trong chat: trước khi tạo nói "Tạo change request"; tạo xong đổi thành "đã tạo CR-…"
    const aiMessages = async () =>
      ((await ChatSession.findById(seeded.sessionId).lean())!.messages as { role: string; content: string }[])
        .filter((m) => m.role === "ai" && m.content.includes(shown.body.data.preview_id))
        .map((m) => JSON.parse(m.content) as { kind: string; reply: string; cr_id?: string })
    expect(await aiMessages()).toEqual([expect.objectContaining({ kind: "change_cr", cr_id: crId })])
    expect((await aiMessages())[0].reply).toContain(`Đã tạo ${crId}`)
    const cr = `/change-requests/${crId}`
    // FLF-330: BA xác nhận (submit) là ghi ngay vào bản nháp — không còn Lead duyệt từng CR
    let last: { change_request: { status: string; result_doc_version: string | null } } | null = null
    for (const step of ["clarify", "impact", "propose", "verify", "submit"]) {
      const r = await c.post(`${cr}/${step}`)
      expect(r.status, `${step}: ${JSON.stringify(r.body.error)}`).toBe(200)
      last = r.body.data
      // Bước đề xuất không gọi model soạn lại lô thêm use case — dùng đúng bản xem trước
      if (step === "propose") expect(changeCalls).toBe(1)
    }
    const bundle = await ChangeLocation.find({ projectId: seeded.projectId, cr_id: crId, reason: ADD_USE_CASE_REASON }).lean()
    expect(bundle.map((l) => l.path)).toEqual(expect.arrayContaining(["use_cases[]", "functions[]", "screens[]", "permissions[]"]))
    // Như trước baseline: không hỏi thêm (đã hỏi trong chat), vị trí chỉ là phần lô chạm tới, không gọi AI đề xuất thêm
    expect(crCalls).toEqual({ clarify: 0, propose: 0 })
    const all = await ChangeLocation.find({ projectId: seeded.projectId, cr_id: crId }).lean()
    expect(all.filter((l) => !l.found_by.includes("diagram")).map((l) => l.reason)).toEqual(all.filter((l) => !l.found_by.includes("diagram")).map(() => ADD_USE_CASE_REASON))
    expect(last?.change_request).toMatchObject({ status: "written", result_doc_version: "1.1" })
    const spine = (await spineRepository.get(seeded.projectId))!
    const uc = spine.use_cases.find((u) => u.name === "Send Absence Warning")!
    const fn = spine.functions.find((f) => f.id === uc.function_ids[0])!
    expect(spine.screens.find((s) => s.id === fn.screen_id)?.name).toBe("Absence Warning")
    expect(spine.permissions.some((p) => p.screen_id === fn.screen_id && p.role_id === "R2")).toBe(true)
  })
})
