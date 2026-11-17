/**
 * Xoá tổ chức (yêu cầu 2026-09-26) — chỉ khi Lead là thành viên duy nhất; xoá cả dự án, thư mục, ví, gói;
 * giữ sổ giao dịch credit làm hồ sơ tài chính.
 */
import { describe, it, expect, beforeEach } from "vitest"
import mongoose from "mongoose"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Organization } from "../../src/modules/organization/organization.model.js"
import { Membership } from "../../src/modules/organization/membership.model.js"
import { Invitation } from "../../src/modules/organization/invitation.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { Folder } from "../../src/modules/folder/folder.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { CreditTransaction } from "../../src/modules/credits/credit-transaction.model.js"
import { CreditTopupRequest } from "../../src/modules/billing/credit-topup-request.model.js"
import { PaymentIntent } from "../../src/modules/billing/payment-intent.model.js"
import { OrgTemplate, OrgTemplateVersion } from "../../src/modules/import/org-library.model.js"
import { TemplateMigration } from "../../src/modules/template-migration/template-migration.model.js"
import { Comment, CommentCounter } from "../../src/modules/comment/comment.model.js"
import { DocFileNotFoundError, docFileStore } from "../../src/modules/doc-version/doc-file.store.js"
import { Session } from "../../src/shared/auth/session.model.js"
import { projectScopedModels } from "../../src/modules/project/project-scoped-models.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let lead: { id: string; email: string; token: string }
let orgId: string

beforeEach(async () => {
  const user = await User.create({ email: "lead@flintflow.test", password: "test-password-123", emailVerified: true })
  const token = await authAs({ _id: user._id, email: user.email })
  const res = await request(app).post("/api/v1/orgs").set(bearer(token)).send({ name: "Org Một Mình" })
  orgId = res.body.data.id
  lead = { id: String(user._id), email: user.email, token: await authAs({ _id: user._id, email: user.email, orgId }) }
})

const del = (confirmName = "Org Một Mình", token = lead.token) =>
  request(app).delete("/api/v1/orgs/" + orgId).set(bearer(token)).send({ confirmName })

describe("xoá tổ chức", () => {
  it("Lead duy nhất xoá được - dự án, thư mục, ví, gói, thành viên đều biến mất", async () => {
    await request(app).post("/api/v1/projects").set(bearer(lead.token)).send({ name: "Dự án 1" })
    await request(app).post("/api/v1/projects").set(bearer(lead.token)).send({ name: "Dự án 2" })
    await Folder.create({ organizationId: orgId, userId: lead.id, name: "Thư mục" })
    expect(await Project.countDocuments({ organizationId: orgId })).toBe(2)

    const res = await del()
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ deleted: true, projectsDeleted: 2 })

    expect(await Organization.countDocuments({ _id: orgId })).toBe(0)
    expect(await Membership.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Project.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Folder.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await CreditWallet.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Subscription.countDocuments({ organizationId: orgId })).toBe(0)
  })

  it("giữ lại sổ giao dịch credit làm hồ sơ tài chính", async () => {
    await CreditTransaction.create({
      userId: lead.id,
      organizationId: orgId,
      actionType: "purchase",
      amount: 100,
      type: "purchase",
      balanceAfter: 200
    })

    expect((await del()).status).toBe(200)
    expect(await CreditTransaction.countDocuments({ organizationId: orgId })).toBe(1)
  })

  it("QLHS #1-#2: dự án có Spine cũ sai schema + lượt chạy bước, khoá CR, vector ⇒ xoá org thành công, không còn bản ghi nào theo projectId", async () => {
    const created = await request(app).post("/api/v1/projects").set(bearer(lead.token)).send({ name: "Dự án Spine cũ" })
    expect(created.status).toBe(201)
    const projectId = new mongoose.Types.ObjectId(created.body.data._id as string)
    const db = mongoose.connection
    // Spine cũ: giả định có `statement_vi` > 200 ký tự (schema hiện tại từ chối) — ghi thẳng collection, không qua repository
    await db.collection("spines").updateOne(
      { projectId },
      { $set: { assumptions: [{ id: "AS01", statement_vi: "x".repeat(400) }], diagrams: [{ id: "D01" }] } }
    )
    await db.collection("stepruns").insertOne({ projectId, step_id: "B-0", status: "done" })
    await db.collection("spinelocks").insertOne({ projectId, path: "actors[id=A01]", cr_id: "CR-1" })
    await db.collection("spineembeddings").insertOne({ projectId, kind: "actor", ref: "A01", embedding: [] })

    const res = await del()
    expect(res.status).toBe(200)
    expect(await Project.countDocuments({ _id: projectId }).setOptions({ withDeleted: true })).toBe(0)
    for (const model of projectScopedModels()) {
      expect({ model: model.modelName, left: await model.countDocuments({ projectId }) }).toEqual({ model: model.modelName, left: 0 })
    }
  })

  it("gõ sai tên thì không xoá gì", async () => {
    const res = await del("Tên khác")
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe("ORG_NAME_MISMATCH")
    expect(await Organization.countDocuments({ _id: orgId })).toBe(1)
  })

  it("còn thành viên khác thì từ chối", async () => {
    const other = await User.create({ email: "other@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: orgId, userId: other._id, role: "viewer" })

    const res = await del()
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ORG_HAS_OTHER_MEMBERS")
    expect(await Organization.countDocuments({ _id: orgId })).toBe(1)
  })

  it("thành viên không phải Lead không gọi được", async () => {
    const other = await User.create({ email: "an@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: orgId, userId: other._id, role: "analyst" })
    const token = await authAs({ _id: other._id, email: other.email, orgId })

    const res = await del("Org Một Mình", token)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("ORG_ROLE_FORBIDDEN")
  })

  it("đang có lượt gọi AI giữ credit thì từ chối", async () => {
    await CreditWallet.updateOne({ organizationId: orgId }, { reserved: 5 })
    const res = await del()
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ORG_BUSY")
  })

  it("đang có thanh toán chờ thì từ chối - webhook về sau sẽ không có ví để cộng", async () => {
    await PaymentIntent.create({
      userId: lead.id,
      organizationId: orgId,
      packageId: "pack_100",
      credits: 100,
      amount: 4000,
      currency: "VND",
      provider: "payment_service",
      status: "pending"
    })
    const res = await del()
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe("ORG_PAYMENT_PENDING")
  })

  it("mã mời của org bị huỷ, phiên đang mở org được gỡ org đang mở", async () => {
    await request(app).post("/api/v1/orgs/" + orgId + "/invitations").set(bearer(lead.token)).send({ role: "viewer", email: "x@flintflow.test" })
    await Session.create({
      userId: lead.id,
      tokenHash: "hash-" + Date.now(),
      expiresAt: new Date(Date.now() + 60_000),
      activeOrgId: orgId
    })

    expect((await del()).status).toBe(200)
    expect(await Invitation.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await Session.countDocuments({ activeOrgId: orgId })).toBe(0)
  })

  it("xoá org cuối cùng thì tài khoản quay về trạng thái cần onboarding", async () => {
    expect((await del()).status).toBe(200)
    const orgs = await request(app).get("/api/v1/orgs").set(bearer(lead.token))
    expect(orgs.body.data).toEqual([])
  })

  it("xoá bị từ chối (còn thành viên / giữ credit / thanh toán chờ) thì mã mời đang có KHÔNG bị mất", async () => {
    const invitee = await User.create({ email: "invitee@flintflow.test", password: "test-password-123", emailVerified: true })
    const inviteeToken = await authAs({ _id: invitee._id, email: invitee.email })

    const inviteRes = await request(app)
      .post("/api/v1/orgs/" + orgId + "/invitations")
      .set(bearer(lead.token))
      .send({ role: "viewer", email: invitee.email })
    expect(inviteRes.status).toBe(201)
    const code = inviteRes.body.data.code as string

    // 1. ORG_HAS_OTHER_MEMBERS
    const other = await User.create({ email: "member@flintflow.test", password: "test-password-123", emailVerified: true })
    await Membership.create({ organizationId: orgId, userId: other._id, role: "viewer" })
    const blockedByMember = await del()
    expect(blockedByMember.status).toBe(409)
    expect(blockedByMember.body.error.code).toBe("ORG_HAS_OTHER_MEMBERS")
    expect(await Invitation.countDocuments({ organizationId: orgId })).toBe(1)
    expect((await request(app).get("/api/v1/invitations/" + code).set(bearer(inviteeToken))).status).toBe(200)
    await Membership.deleteOne({ organizationId: orgId, userId: other._id })

    // 2. ORG_BUSY
    await CreditWallet.updateOne({ organizationId: orgId }, { reserved: 5 })
    const blockedByCredit = await del()
    expect(blockedByCredit.status).toBe(409)
    expect(blockedByCredit.body.error.code).toBe("ORG_BUSY")
    expect(await Invitation.countDocuments({ organizationId: orgId })).toBe(1)
    expect((await request(app).get("/api/v1/invitations/" + code).set(bearer(inviteeToken))).status).toBe(200)
    await CreditWallet.updateOne({ organizationId: orgId }, { reserved: 0 })

    // 3. ORG_PAYMENT_PENDING
    await PaymentIntent.create({
      userId: lead.id,
      organizationId: orgId,
      packageId: "pack_100",
      credits: 100,
      amount: 4000,
      currency: "VND",
      provider: "payment_service",
      status: "pending"
    })
    const blockedByPayment = await del()
    expect(blockedByPayment.status).toBe(409)
    expect(blockedByPayment.body.error.code).toBe("ORG_PAYMENT_PENDING")
    expect(await Invitation.countDocuments({ organizationId: orgId })).toBe(1)
    expect((await request(app).get("/api/v1/invitations/" + code).set(bearer(inviteeToken))).status).toBe(200)
  })

  it("xoá thành công thì dọn sạch OrgTemplate, OrgTemplateVersion (+ file mẫu), TemplateMigration, Comment, CommentCounter và CreditTopupRequest", async () => {
    const projectRes = await request(app).post("/api/v1/projects").set(bearer(lead.token)).send({ name: "Dự án có mẫu" })
    expect(projectRes.status).toBe(201)
    const projectId = projectRes.body.data._id as string
    const orphanProjectId = new mongoose.Types.ObjectId()
    const sha256 = "a".repeat(64)

    const templateFileRef = await docFileStore().save(Buffer.from("docx"), {
      projectId: `org-${orgId}`,
      kind: "upload",
      name: "v1.docx"
    })
    const skeletonSourceRef = await docFileStore().save(Buffer.from("skeleton-src"), {
      projectId: `org-${orgId}`,
      kind: "version",
      name: "1.0.docx"
    })
    const legacyTemplateFileRef = await docFileStore().save(Buffer.from("legacy-docx"), {
      projectId: `org-${orgId}`,
      kind: "upload",
      name: "legacy.docx"
    })
    const migrationBaseRef = await docFileStore().save(Buffer.from("new-base"), {
      projectId,
      kind: "upload",
      name: "migration-base.docx"
    })
    const migrationOpsRef = await docFileStore().save(Buffer.from("[]"), {
      projectId: String(orphanProjectId),
      kind: "upload",
      name: "migration-ops.json"
    })
    const orphanMigrationBaseRef = await docFileStore().save(Buffer.from("orphan-base"), {
      projectId: String(orphanProjectId),
      kind: "upload",
      name: "orphan-base.docx"
    })

    const orgTemplate = await OrgTemplate.create({
      orgId,
      name: "Mẫu tổ chức",
      created_by: lead.id,
      file_ref: legacyTemplateFileRef
    })
    await OrgTemplateVersion.create({
      template_id: orgTemplate._id,
      orgId,
      version: 1,
      status: "published",
      visibility: "org",
      source_file: { name: "v1.docx", size: 4, sha256 },
      file_ref: templateFileRef,
      skeleton_source_ref: skeletonSourceRef,
      headings: [{ heading_text: "1. Intro", section_id: "S01" }],
      created_by: lead.id
    })

    const migrationBase = {
      orgId,
      direction: "forward" as const,
      from: { language: "vi" },
      to: {
        template_id: orgTemplate._id,
        version: 1,
        name: "Mẫu tổ chức",
        visibility: "org" as const,
        file_ref: templateFileRef,
        sha256,
        language: "vi"
      },
      pairing: { matched: [] },
      analysis: { old_tables: {}, new_tables: {}, edited: null },
      groups: { auto: [] },
      base_spine_version: 1,
      base_content_seq: 0,
      created_by: lead.id
    }
    await TemplateMigration.create({
      ...migrationBase,
      projectId,
      state: "applied",
      open: false,
      new_base_file_ref: migrationBaseRef
    })
    await TemplateMigration.create({
      ...migrationBase,
      projectId: orphanProjectId,
      state: "applied",
      open: false,
      new_base_file_ref: orphanMigrationBaseRef,
      spine_plan: { ops: null, ops_file_ref: migrationOpsRef, revert_seqs: [], base_version: 1 }
    })

    await Comment.create({
      projectId,
      organizationId: orgId,
      comment_id: "CM-001",
      version: { source: "draft", baseline_id: null, label: "draft" },
      anchor: { section_id: "S01", block_index: null, label: "1. Intro", excerpt: null },
      author_id: lead.id,
      author_role: "lead",
      text: "Comment trên dự án"
    })
    await Comment.create({
      projectId: orphanProjectId,
      organizationId: orgId,
      comment_id: "CM-001",
      version: { source: "draft", baseline_id: null, label: "draft" },
      anchor: { section_id: "S01", block_index: null, label: "1. Intro", excerpt: null },
      author_id: lead.id,
      author_role: "lead",
      text: "Comment mồ côi cấp org"
    })
    await CommentCounter.create([{ projectId, seq: 1 }, { projectId: orphanProjectId, seq: 1 }])

    await CreditTopupRequest.create({
      organizationId: orgId,
      userId: lead.id,
      projectId,
      step: "S-5.4",
      needed: 50
    })
    await PaymentIntent.create({
      userId: lead.id,
      organizationId: orgId,
      packageId: "pack_100",
      credits: 100,
      amount: 4000,
      currency: "VND",
      provider: "payment_service",
      status: "succeeded"
    })

    const res = await del()
    expect(res.status).toBe(200)

    expect(await OrgTemplate.countDocuments({ orgId })).toBe(0)
    expect(await OrgTemplateVersion.countDocuments({ orgId })).toBe(0)
    expect(await TemplateMigration.countDocuments({ orgId })).toBe(0)
    expect(await Comment.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await CommentCounter.countDocuments({ projectId: { $in: [projectId, orphanProjectId] } })).toBe(0)
    expect(await CreditTopupRequest.countDocuments({ organizationId: orgId })).toBe(0)
    expect(await PaymentIntent.countDocuments({ organizationId: orgId })).toBe(1)

    for (const ref of [
      templateFileRef,
      skeletonSourceRef,
      legacyTemplateFileRef,
      migrationBaseRef,
      migrationOpsRef,
      orphanMigrationBaseRef
    ]) {
      await expect(docFileStore().load(ref)).rejects.toThrow(DocFileNotFoundError)
    }
  })
})
