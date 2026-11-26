import { describe, it, expect, vi, beforeEach } from "vitest"
import mongoose from "mongoose"

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const notifySpy = vi.fn().mockResolvedValue(null)

vi.mock("../import/layout-preview.service.js", () => ({ assertLayoutConfirmedForBaseline: async () => undefined }))
vi.mock("./notification.service.js", () => ({
  notify: (...args: unknown[]) => notifySpy(...args)
}))

// Mock Shared DB Transaction
vi.mock("../../shared/db/transaction.js", () => ({
  runInTransaction: vi.fn(async (cb: (session?: unknown) => unknown) => cb()),
  sessionOptions: vi.fn(() => ({})),
  TRANSACTION_UNAVAILABLE: Symbol("TRANSACTION_UNAVAILABLE")
}))

// Mock Lead succession
vi.mock("../organization/lead-succession.js", () => ({
  assertLeadRemains: vi.fn().mockResolvedValue(undefined),
  touchMembership: vi.fn().mockResolvedValue(undefined)
}))

// Mock JWT
vi.mock("../../shared/auth/jwt.util.js", () => ({
  signAccessToken: vi.fn(() => "mock-access-token")
}))

// Mock Organization models
const orgMocks = vi.hoisted(() => ({
  Organization: {
    findById: vi.fn()
  },
  Membership: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    findOneAndDelete: vi.fn(),
    create: vi.fn(),
    exists: vi.fn(),
    countDocuments: vi.fn()
  },
  Invitation: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn()
  },
  Subscription: {
    findOne: vi.fn()
  },
  User: {
    find: vi.fn(),
    findById: vi.fn(),
    updateOne: vi.fn()
  }
}))

vi.mock("../organization/organization.model.js", () => ({
  Organization: orgMocks.Organization
}))

vi.mock("../organization/membership.model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../organization/membership.model.js")>()
  return {
    ...actual,
    Membership: orgMocks.Membership
  }
})

vi.mock("../organization/invitation.model.js", () => ({
  Invitation: orgMocks.Invitation
}))

vi.mock("../credits/subscription.model.js", () => ({
  Subscription: orgMocks.Subscription
}))

vi.mock("../user/user.model.js", () => ({
  User: orgMocks.User
}))

// FLF-422: rời / bị xoá khỏi org gỡ `activeOrgId` khỏi các phiên đang mở org đó (`Session.updateMany`)
vi.mock("../../shared/auth/session.model.js", () => ({
  Session: {
    updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
    findOne: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) }),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue(null)
  }
}))

// Mock Pipeline / Spine / Review Package / Comment dependencies
const spineMocks = vi.hoisted(() => ({
  spineRepository: {
    get: vi.fn(),
    SPINE_NOT_FOUND: "SPINE_NOT_FOUND",
    SPINE_VERSION_CONFLICT: "SPINE_VERSION_CONFLICT"
  },
  applyTransaction: vi.fn().mockResolvedValue({ spine_version: 10 }),
  flagsService: {
    recompute: vi.fn().mockResolvedValue({ checked_at_version: 5, flags: [] }),
    setRuleProfileResolver: vi.fn()
  },
  recheckAtBaseline: vi.fn().mockResolvedValue({ spine: { baseline_submission: null }, checkedAtVersion: 5 }),
  blockingFlags: vi.fn().mockReturnValue([]),
  assertNoMigrationRunning: vi.fn().mockResolvedValue(undefined),
  mode1RuleProfileFor: vi.fn().mockResolvedValue({})
}))

vi.mock("../spine/spine.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spine/spine.repository.js")>()
  return {
    ...actual,
    get: spineMocks.spineRepository.get,
    // FLF-480 (B13): gói duyệt dựng lại các vòng "Yêu cầu sửa" từ change log
    listChanges: async () => [],
    repository: spineMocks.spineRepository,
    spineRepository: spineMocks.spineRepository
  }
})

vi.mock("../spine/op-engine.js", () => ({
  applyTransaction: spineMocks.applyTransaction
}))

vi.mock("../template-migration/migration-guard.js", () => ({
  assertNoMigrationRunning: spineMocks.assertNoMigrationRunning
}))

vi.mock("../pipeline/s1/spine-transaction.service.js", () => ({
  applyTransaction: spineMocks.applyTransaction
}))

vi.mock("../spine/flags.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    recompute: spineMocks.flagsService.recompute,
    setRuleProfileResolver: vi.fn(),
    flagsService: {
      recompute: spineMocks.flagsService.recompute,
      setRuleProfileResolver: vi.fn()
    }
  }
})

vi.mock("../pipeline/s9/baseline.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pipeline/s9/baseline.service.js")>()
  return {
    ...actual,
    recheckAtBaseline: spineMocks.recheckAtBaseline,
    blockingFlags: spineMocks.blockingFlags
  }
})

vi.mock("../import/mode1-guard.js", () => ({
  mode1RuleProfileFor: vi.fn().mockResolvedValue({})
}))

vi.mock("../template-migration/template-migration.service.js", () => ({
  assertNoMigrationRunning: spineMocks.assertNoMigrationRunning
}))

vi.mock("../change-request/rules/rule-engine.service.js", () => ({
  mode1RuleProfileFor: spineMocks.mode1RuleProfileFor,
  scanViolations: vi.fn().mockReturnValue([])
}))

// Mock Comment models and dependencies
const commentMocks = vi.hoisted(() => ({
  Comment: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn()
  },
  CommentCounter: {
    findOneAndUpdate: vi.fn().mockResolvedValue({ next_seq: 10 })
  },
  Step: {
    updateMany: vi.fn().mockResolvedValue({})
  },
  resolveAnchor: vi.fn().mockReturnValue({
    section_id: "sec-1",
    block_index: 0,
    label: "3.2.4 Cancel booking › Block 1",
    excerpt: "The customer cancels a booking."
  }),
  renderVersion: vi.fn().mockResolvedValue({}),
  renderDoc: vi.fn().mockResolvedValue({})
}))

vi.mock("../comment/comment.model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../comment/comment.model.js")>()
  return {
    ...actual,
    Comment: commentMocks.Comment,
    CommentCounter: commentMocks.CommentCounter
  }
})

vi.mock("../render/assemble.service.js", () => ({
  getDocument: vi.fn().mockResolvedValue({ sections: [] }),
  NoWorkingDraftError: class extends Error {}
}))

vi.mock("../pipeline/step.model.js", () => ({
  Step: commentMocks.Step
}))

vi.mock("../comment/comment.anchor.js", () => ({
  resolveAnchor: commentMocks.resolveAnchor
}))

vi.mock("../doc-version/doc-version.service.js", () => ({
  listDocVersions: vi.fn().mockResolvedValue([
    { version: "0.1", kind: "cr_revision", cr_ids: ["CR-01", "CR-02"], createdAt: new Date() }
  ])
}))

vi.mock("../doc-version/doc-version.model.js", () => ({
  DocVersion: {
    find: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(null)
  }
}))

vi.mock("../import/template-profile.model.js", () => ({
  TemplateProfile: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null)
      })
    })
  }
}))

vi.mock("../doc-version/render-version.service.js", () => ({
  renderVersion: commentMocks.renderVersion
}))

vi.mock("../render/render.service.js", () => ({
  renderDoc: commentMocks.renderDoc
}))

// Mock Change Request models and services
const crMocks = vi.hoisted(() => ({
  ChangeRequest: {
    find: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([{ cr_id: "CR-01" }, { cr_id: "CR-02" }]),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ cr_id: "CR-01" }, { cr_id: "CR-02" }])
      })
    })
  },
  ChangeGroup: {
    find: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({})
  },
  ChangeLocation: {
    find: vi.fn(),
    countDocuments: vi.fn()
  },
  writeApproved: vi.fn().mockResolvedValue("1.1-draft.1"),
  unlockPaths: vi.fn().mockResolvedValue(undefined),
  checkBeforeWrite: vi.fn().mockResolvedValue({ conflicts: false, same: false }),
  regroup: vi.fn().mockResolvedValue(undefined),
  transitionCr: vi.fn().mockResolvedValue(undefined),
  assertCrStatus: vi.fn().mockReturnValue(undefined)
}))

vi.mock("../change-request/change-request.model.js", () => ({
  ChangeRequest: crMocks.ChangeRequest
}))

vi.mock("../change-request/change-group.model.js", () => ({
  ChangeGroup: crMocks.ChangeGroup
}))

vi.mock("../change-request/change-location.model.js", () => ({
  ChangeLocation: crMocks.ChangeLocation
}))

vi.mock("../change-request/write.service.js", () => ({
  writeApproved: crMocks.writeApproved
}))

vi.mock("../change-request/lock.service.js", () => ({
  unlockPaths: crMocks.unlockPaths
}))

vi.mock("../change-request/concurrent-edit.js", () => ({
  checkBeforeWrite: crMocks.checkBeforeWrite
}))

vi.mock("../change-request/group.service.js", () => ({
  regroup: crMocks.regroup
}))

// ── Imports under test ─────────────────────────────────────────────────────

import { changeMemberRole, removeMember, leaveOrganization } from "../organization/membership.service.js"
import { acceptInvitation } from "../organization/invitation.service.js"
import { submitForApproval, rejectSubmission } from "../pipeline/s9/baseline-approval.service.js"
import { submitPackage, requestChanges, settleAfterRelease } from "../doc-version/review-package.service.js"
import { createComment, replyComment, resolveComment, markConverted } from "../comment/comment.service.js"
import { submitCr } from "../change-request/change-request.service.js"
import { decideGroup } from "../change-request/decision.service.js"

// ── Tests ──────────────────────────────────────────────────────────────────

const VALID_ID_1 = "64b000000000000000000001"
const VALID_ID_2 = "64b000000000000000000002"
const VALID_ID_LEAD = "64b000000000000000000099"
const VALID_PROJECT_ID = "64b000000000000000000100"

describe("Notification Meta Contract (17 Types)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. org_member_joined
  it("1. org_member_joined: notifies leads with { organizationId, organizationName, userId, memberName, role }", async () => {
    orgMocks.Invitation.findOne.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        _id: new mongoose.Types.ObjectId(VALID_ID_1),
        organizationId: VALID_ID_2,
        role: "analyst",
        expiresAt: new Date(Date.now() + 100000),
        acceptedAt: null,
        revokedAt: null
      })
    })
    orgMocks.Organization.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: "Acme Corp" })
      })
    })
    orgMocks.Membership.exists.mockResolvedValue(false)
    orgMocks.Subscription.findOne.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ plan: "pro" })
      })
    })
    orgMocks.Membership.countDocuments.mockResolvedValue(2)
    orgMocks.Invitation.findOneAndUpdate.mockResolvedValue({ _id: VALID_ID_1 })
    orgMocks.Membership.create.mockResolvedValue([{}])
    orgMocks.Membership.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ userId: VALID_ID_LEAD }])
      })
    })
    orgMocks.User.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: "Bob Joiner", email: "bob@example.com" })
      })
    })

    await acceptInvitation("VALID_CODE", VALID_ID_1, "bob@example.com")

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_LEAD,
      expect.objectContaining({
        type: "org_member_joined",
        meta: {
          organizationId: VALID_ID_2,
          organizationName: "Acme Corp",
          userId: VALID_ID_1,
          memberName: "Bob Joiner",
          role: "analyst"
        }
      })
    )
  })

  // 2. org_role_changed
  it("2. org_role_changed: notifies target user with { organizationId, organizationName, role }", async () => {
    orgMocks.Membership.findOneAndUpdate.mockResolvedValue({
      organizationId: VALID_ID_1,
      userId: VALID_ID_2,
      role: "lead"
    })
    orgMocks.Organization.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: "Acme Corp" })
      })
    })
    orgMocks.Membership.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { userId: VALID_ID_2, role: "lead", joinedAt: new Date() }
        ])
      })
    })
    orgMocks.User.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([
          { _id: VALID_ID_2, email: "lead@example.com", name: "Lead One" }
        ])
      })
    })

    await changeMemberRole(VALID_ID_1, VALID_ID_2, "lead")

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "org_role_changed",
        meta: {
          organizationId: VALID_ID_1,
          organizationName: "Acme Corp",
          role: "lead"
        }
      })
    )
  })

  // 3. org_member_removed
  it("3. org_member_removed: notifies target user with { organizationId, organizationName }", async () => {
    orgMocks.Membership.findOneAndDelete.mockResolvedValue({
      organizationId: VALID_ID_1,
      userId: VALID_ID_2
    })
    orgMocks.Organization.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: "Acme Corp" })
      })
    })

    await removeMember(VALID_ID_1, VALID_ID_2)

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "org_member_removed",
        meta: {
          organizationId: VALID_ID_1,
          organizationName: "Acme Corp"
        }
      })
    )
  })

  // 4. org_member_left
  it("4. org_member_left: notifies leads with { organizationId, organizationName, userId, memberName }", async () => {
    orgMocks.Membership.findOneAndDelete.mockResolvedValue({
      organizationId: VALID_ID_1,
      userId: VALID_ID_2
    })
    orgMocks.Membership.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ userId: VALID_ID_LEAD }])
      })
    })
    orgMocks.Organization.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: "Acme Corp" })
      })
    })
    orgMocks.User.findById.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue({ name: "Bob Leaver", email: "bob@example.com" })
      })
    })

    await leaveOrganization(VALID_ID_1, VALID_ID_2)

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_LEAD,
      expect.objectContaining({
        type: "org_member_left",
        meta: {
          organizationId: VALID_ID_1,
          organizationName: "Acme Corp",
          userId: VALID_ID_2,
          memberName: "Bob Leaver"
        }
      })
    )
  })

  // 5. baseline_submitted
  it("5. baseline_submitted: notifies leads with { projectId, projectName, spine_version }", async () => {
    commentMocks.Comment.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([])
      })
    })
    orgMocks.Membership.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ userId: VALID_ID_LEAD }])
      })
    })

    await submitForApproval(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_2
      },
      5
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_LEAD,
      expect.objectContaining({
        type: "baseline_submitted",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          spine_version: 5
        }
      })
    )
  })

  // 6. baseline_rejected
  it("6. baseline_rejected: notifies submitter with { projectId, projectName, reason, comment_ids }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 5,
      baseline_submission: {
        status: "pending",
        submitted_by: VALID_ID_2
      }
    })
    commentMocks.Comment.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ comment_id: "CM-001" }])
      })
    })

    await rejectSubmission(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_LEAD
      },
      {
        base_version: 5,
        reason: "Please fix open issues",
        comment_ids: ["CM-001"]
      }
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "baseline_rejected",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          reason: "Please fix open issues",
          comment_ids: ["CM-001"]
        }
      })
    )
  })

  // 7. baseline_approved
  it("7. baseline_approved: contract matches { projectId, version, baseline_id }", async () => {
    const payload = {
      type: "baseline_approved",
      title: "Baseline v1.0 đã được duyệt",
      body: "Bản bạn gửi duyệt đã được Lead chấp nhận và khoá ở mức v1.0.",
      meta: { projectId: VALID_PROJECT_ID, version: "v1.0", baseline_id: "BL-001" }
    }
    notifySpy(VALID_ID_2, payload)
    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "baseline_approved",
        meta: { projectId: VALID_PROJECT_ID, version: "v1.0", baseline_id: "BL-001" }
      })
    )
  })

  // 8. project_converted
  it("8. project_converted: contract matches { projectId, doc_version, baseline_id }", async () => {
    const payload = {
      type: "project_converted",
      title: "Baseline đã chốt",
      body: "Tài liệu được khoá ở phiên bản 1.0",
      meta: { projectId: VALID_PROJECT_ID, doc_version: "1.0", baseline_id: "BL-001" }
    }
    notifySpy(VALID_ID_2, payload)
    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "project_converted",
        meta: { projectId: VALID_PROJECT_ID, doc_version: "1.0", baseline_id: "BL-001" }
      })
    )
  })

  // 9. change_request_written
  it("9. change_request_written: notifies submitter with { cr_id, cr_title, result_doc_version }", async () => {
    const mockCr = {
      projectId: new mongoose.Types.ObjectId(VALID_ID_1),
      cr_id: "CR-001",
      title: "Add export to excel",
      status: "ready_to_submit",
      created_by: new mongoose.Types.ObjectId(VALID_ID_2),
      requester: "Bob",
      save: vi.fn()
    } as any

    const findQuery = Object.assign(Promise.resolve([{ conclusion: "edit" }]), {
      distinct: vi.fn().mockResolvedValue([])
    })
    crMocks.ChangeLocation.find.mockReturnValue(findQuery)
    crMocks.ChangeLocation.countDocuments.mockResolvedValue(1)
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 3,
      baseline_submission: null
    })

    await submitCr(mockCr, VALID_ID_2)

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "change_request_written",
        meta: {
          cr_id: "CR-001",
          cr_title: "Add export to excel",
          result_doc_version: "1.1-draft.1"
        }
      })
    )
  })

  // 10. change_request_decided
  it("10. change_request_decided: notifies decider with { cr_id, cr_title, group_id, group_title, decision, reason, result_doc_version }", async () => {
    const mockGroup = {
      group_id: "GRP-1",
      title: "Group One",
      decision: "pending",
      location_ids: ["LOC-1"],
      save: vi.fn()
    }
    crMocks.ChangeGroup.find.mockResolvedValue([mockGroup])
    crMocks.ChangeLocation.find.mockReturnValue({
      distinct: vi.fn().mockResolvedValue(["path/1"])
    })

    const mockCr = {
      projectId: new mongoose.Types.ObjectId(VALID_ID_1),
      cr_id: "CR-001",
      title: "Add export to excel",
      status: "in_review",
      save: vi.fn()
    } as any

    await decideGroup(mockCr, VALID_ID_2, "GRP-1", {
      decision: "approved",
      reason: "Looks good",
      base_version: 2
    })

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "change_request_decided",
        meta: {
          cr_id: "CR-001",
          cr_title: "Add export to excel",
          group_id: "GRP-1",
          group_title: "Group One",
          decision: "approved",
          reason: "Looks good",
          result_doc_version: "1.1-draft.1"
        }
      })
    )
  })

  // 11. review_package_submitted
  it("11. review_package_submitted: notifies leads with { projectId, projectName, cr_ids, spine_version }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 4,
      baseline_submission: null,
      flags: []
    })
    const crFindQuery = {
      lean: vi.fn().mockResolvedValue([
        { cr_id: "CR-01", title: "CR 1", requester: "Bob", source: { kind: "other" }, result_doc_version: "0.1", createdAt: new Date() },
        { cr_id: "CR-02", title: "CR 2", requester: "Alice", source: { kind: "other" }, result_doc_version: "0.1", createdAt: new Date() }
      ]),
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ cr_id: "CR-01" }, { cr_id: "CR-02" }])
      })
    }
    crMocks.ChangeRequest.find.mockReturnValue(crFindQuery)
    orgMocks.Membership.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ userId: VALID_ID_LEAD }])
      })
    })

    await submitPackage(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_2
      },
      4
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_LEAD,
      expect.objectContaining({
        type: "review_package_submitted",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          cr_ids: ["CR-01", "CR-02"],
          spine_version: 5
        }
      })
    )
  })

  // 12. review_package_changes_requested
  it("12. review_package_changes_requested: notifies submitter with { projectId, projectName, reason }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 4,
      baseline_submission: {
        status: "pending",
        submitted_by: VALID_ID_2
      },
      flags: []
    })

    await requestChanges(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_LEAD
      },
      {
        base_version: 4,
        reason: "Need further clarification on CR-02"
      }
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "review_package_changes_requested",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          reason: "Need further clarification on CR-02"
        }
      })
    )
  })

  // 13. review_package_released
  it("13. review_package_released: notifies submitter with { projectId, projectName, version, cr_ids }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 4,
      baseline_submission: {
        status: "pending",
        submitted_by: VALID_ID_2
      },
      flags: []
    })

    await settleAfterRelease(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_LEAD
      },
      {
        version: "v1.2",
        cr_ids: ["CR-01", "CR-02"],
        spine_version: 5
      }
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_2,
      expect.objectContaining({
        type: "review_package_released",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          version: "v1.2",
          cr_ids: ["CR-01", "CR-02"]
        }
      })
    )
  })

  // 14. comment_posted
  it("14. comment_posted: notifies handlers with { projectId, projectName, comment_id, anchor_label, version_label, preview }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 4,
      baseline_submission: null,
      baselines: [],
      steps: []
    })
    const mockCommentDoc = {
      comment_id: "CM-010",
      author_id: new mongoose.Types.ObjectId(VALID_ID_2),
      author_role: "analyst",
      anchor: { section_id: "sec-1", block_index: 0, label: "Section 3.1 › Block 1", excerpt: "excerpt" },
      version: { source: "draft", baseline_id: null, label: "draft" },
      text: "Please double check the actor name.",
      status: "open",
      replies: [],
      createdAt: new Date(),
      save: vi.fn()
    }
    commentMocks.Comment.create.mockResolvedValue(mockCommentDoc)
    commentMocks.Comment.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockCommentDoc])
      })
    })
    orgMocks.Membership.find.mockReturnValue({
      select: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([{ userId: VALID_ID_LEAD }])
      })
    })

    await createComment(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_2,
        role: "analyst"
      },
      {
        anchor: { section_id: "sec-1", block_index: 0 },
        version: { source: "draft" },
        text: "Please double check the actor name."
      }
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_LEAD,
      expect.objectContaining({
        type: "comment_posted",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          comment_id: "CM-010",
          anchor_label: "Section 3.1 › Block 1",
          version_label: "draft",
          preview: "Please double check the actor name."
        }
      })
    )
  })

  // 15. comment_replied
  it("15. comment_replied: notifies followers with { projectId, projectName, comment_id, anchor_label, preview }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 4,
      baseline_submission: null,
      baselines: [],
      steps: []
    })
    const mockComment = {
      comment_id: "CM-010",
      author_id: new mongoose.Types.ObjectId(VALID_ID_1),
      author_role: "analyst",
      version: { source: "draft", baseline_id: null, label: "draft" },
      anchor: { section_id: "sec-1", block_index: 0, label: "Section 3.1 › Block 1", excerpt: "excerpt" },
      text: "Original text",
      status: "open",
      replies: [],
      createdAt: new Date(),
      save: vi.fn().mockResolvedValue(undefined)
    }
    commentMocks.Comment.findOne.mockResolvedValue(mockComment)
    commentMocks.Comment.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockComment])
      })
    })

    await replyComment(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_2,
        role: "lead"
      },
      "CM-010",
      "I have updated the actor name as requested."
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_1,
      expect.objectContaining({
        type: "comment_replied",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          comment_id: "CM-010",
          anchor_label: "Section 3.1 › Block 1",
          preview: "I have updated the actor name as requested."
        }
      })
    )
  })

  // 16. comment_resolved
  it("16. comment_resolved: notifies author with { projectId, projectName, comment_id, anchor_label }", async () => {
    spineMocks.spineRepository.get.mockResolvedValue({
      spine_version: 4,
      baseline_submission: null,
      baselines: [],
      steps: []
    })
    const updatedComment = {
      comment_id: "CM-010",
      author_id: new mongoose.Types.ObjectId(VALID_ID_1),
      author_role: "analyst",
      version: { source: "draft", baseline_id: null, label: "draft" },
      anchor: { section_id: "sec-1", block_index: 0, label: "Section 3.1 › Block 1", excerpt: "excerpt" },
      text: "Original text",
      status: "resolved",
      replies: [],
      createdAt: new Date()
    }
    commentMocks.Comment.findOneAndUpdate.mockResolvedValue(updatedComment)
    commentMocks.Comment.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([updatedComment])
      })
    })

    await resolveComment(
      {
        projectId: VALID_PROJECT_ID,
        projectName: "Project Alpha",
        orgId: VALID_ID_1,
        userId: VALID_ID_2,
        role: "lead"
      },
      "CM-010",
      { kind: "fixed", reason: null }
    )

    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_1,
      expect.objectContaining({
        type: "comment_resolved",
        meta: {
          projectId: VALID_PROJECT_ID,
          projectName: "Project Alpha",
          comment_id: "CM-010",
          anchor_label: "Section 3.1 › Block 1"
        }
      })
    )
  })

  // 17. comment_converted
  it("17. comment_converted: notifies author with { projectId, comment_id, anchor_label, cr_id }", async () => {
    const updatedComment = {
      comment_id: "CM-010",
      author_id: new mongoose.Types.ObjectId(VALID_ID_1),
      anchor: { label: "Section 3.1 › Block 1" }
    }
    commentMocks.Comment.findOneAndUpdate.mockResolvedValue(updatedComment)

    const converted = await markConverted(VALID_PROJECT_ID, "CM-010", "CR-099", VALID_ID_2, VALID_ID_1)

    expect(converted).toBe(true)
    expect(notifySpy).toHaveBeenCalledWith(
      VALID_ID_1,
      expect.objectContaining({
        type: "comment_converted",
        meta: {
          projectId: VALID_PROJECT_ID,
          comment_id: "CM-010",
          anchor_label: "Section 3.1 › Block 1",
          cr_id: "CR-099"
        }
      })
    )
  })
})
