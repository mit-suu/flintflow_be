/**
 * UC-90 — Administrator xem danh sách tổ chức (gói, số dư ví, số thành viên, số dự án) để mở một org và
 * điều chỉnh credit (UC-68).
 */
import { describe, it, expect, beforeEach } from "vitest"
import request from "supertest"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Project } from "../../src/modules/project/project.model.js"
import { CreditWallet } from "../../src/modules/credits/credit-wallet.model.js"
import { Subscription } from "../../src/modules/credits/subscription.model.js"
import { authAs } from "../setup.js"

const bearer = (token: string) => ({ Authorization: "Bearer " + token })

let admin: string
let leadA: { id: string; token: string }
let orgA: string
let orgB: string

const createUser = async (email: string) => {
  const user = await User.create({ email, password: "test-password-123", emailVerified: true })
  return { id: String(user._id), token: await authAs({ _id: user._id, email: user.email }) }
}

const createOrg = async (token: string, name: string): Promise<string> => {
  const res = await request(app).post("/api/v1/orgs").set(bearer(token)).send({ name })
  return res.body.data.id
}

const listOrgs = (query = "") => request(app).get("/api/v1/admin/orgs" + query).set(bearer(admin))

beforeEach(async () => {
  const adminUser = await User.create({
    email: "admin@flintflow.test",
    password: "test-password-123",
    role: "admin",
    emailVerified: true
  })
  admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })

  leadA = await createUser("alpha-lead@flintflow.test")
  const leadB = await createUser("beta-lead@flintflow.test")
  orgA = await createOrg(leadA.token, "Alpha Studio")
  orgB = await createOrg(leadB.token, "Beta Labs")

  await Subscription.updateOne({ organizationId: orgB }, { plan: "pro", status: "active" })
  await CreditWallet.updateOne({ organizationId: orgA }, { balance: 120, reserved: 20 })
  await Project.create([
    { userId: leadA.id, organizationId: orgA, name: "P1" },
    { userId: leadA.id, organizationId: orgA, name: "P2" },
    { userId: leadA.id, organizationId: orgA, name: "P3 đã xoá", status: "archived" }
  ])
})

describe("UC-90 — danh sách tổ chức", () => {
  it("mỗi org kèm gói, ví, số thành viên và số dự án chưa xoá", async () => {
    const res = await listOrgs("?q=Alpha")

    expect(res.status).toBe(200)
    expect(res.body.meta).toMatchObject({ page: 1, total: 1 })
    expect(res.body.data[0]).toMatchObject({
      id: orgA,
      name: "Alpha Studio",
      owner: { id: leadA.id, email: "alpha-lead@flintflow.test" },
      plan: "free",
      planLabel: "Free",
      wallet: { balance: 120, reserved: 20, available: 100 },
      membersCount: 1,
      projectsCount: 2
    })
  })

  it("lọc theo gói: free gồm cả org không có gói trả phí active", async () => {
    const pro = await listOrgs("?plan=pro")
    expect(pro.body.data.map((o: { id: string }) => o.id)).toEqual([orgB])

    const free = await listOrgs("?plan=free")
    const freeIds = free.body.data.map((o: { id: string }) => o.id)
    expect(freeIds).toContain(orgA)
    expect(freeIds).not.toContain(orgB)
  })

  it("tìm theo tên org hoặc email người tạo", async () => {
    const byEmail = await listOrgs("?q=beta-lead")
    expect(byEmail.body.data.map((o: { id: string }) => o.id)).toEqual([orgB])

    const none = await listOrgs("?q=không-tồn-tại")
    expect(none.body.data).toEqual([])
    expect(none.body.meta.total).toBe(0)
  })

  it("người dùng thường không xem được", async () => {
    const res = await request(app).get("/api/v1/admin/orgs").set(bearer(leadA.token))
    expect(res.status).toBe(403)
  })
})
