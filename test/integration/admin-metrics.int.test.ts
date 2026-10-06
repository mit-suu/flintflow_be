/**
 * UC-63 — thống kê hệ thống: số baseline đếm từ collection `baselines` (v0 khi import, 1.0 và mọi bản release),
 * không còn trả cứng 0.
 */
import { describe, it, expect } from "vitest"
import request from "supertest"
import mongoose from "mongoose"
import app from "../../src/app.js"
import { User } from "../../src/modules/user/user.model.js"
import { Baseline } from "../../src/modules/spine/baseline.model.js"
import { authAs } from "../setup.js"

describe("GET /admin/metrics — baselinesTotal", () => {
  it("đếm mọi baseline của mọi loại", async () => {
    const adminUser = await User.create({ email: "admin@flintflow.test", password: "test-password-123", role: "admin", emailVerified: true })
    const admin = await authAs({ _id: adminUser._id, email: adminUser.email, role: "admin" })
    const projectId = new mongoose.Types.ObjectId()
    const at = new Date()
    await Baseline.create([
      { projectId, version: "0.0", type: "imported", at, checked_at_version: 1, snapshot: {} },
      { projectId, version: "1.0", type: "release", at, checked_at_version: 2, snapshot: {} },
      { projectId: new mongoose.Types.ObjectId(), version: "1.0", type: "generated", at, checked_at_version: 1, snapshot: {} }
    ])

    const res = await request(app).get("/api/v1/admin/metrics").set({ Authorization: "Bearer " + admin })
    expect(res.status).toBe(200)
    expect(res.body.data.baselinesTotal).toBe(3)
  })
})
