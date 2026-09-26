import type { ClientSession } from "mongoose"
import { Membership, type OrgRole } from "./membership.model.js"
import { Organization } from "./organization.model.js"
import { ApiError } from "../../shared/utils/api-error.js"
import { sessionOptions } from "../../shared/db/transaction.js"

/**
 * BR-02 Lead succession — BPMN Flow 9.8: "the organization must keep at least one Lead".
 * Gác ba đường: rời org (UC-72), hạ vai trò (UC-73), xoá thành viên (UC-74).
 *
 * Chống đua: mọi thao tác đổi thành viên phải gọi `touchMembership` TRƯỚC khi đọc số Lead, trong cùng
 * transaction. Hai request hạ hai Lead cuối cùng chạy song song đều ghi vào `Organization` ⇒ Mongo báo
 * WriteConflict, `withTransaction` chạy lại cái thua, lần này nó đếm được đúng 1 Lead và bị chặn.
 * Không có bước này thì cả hai cùng đếm thấy 2 Lead và org mất sạch Lead.
 */

export const LAST_LEAD_MESSAGE =
  "Tổ chức phải còn ít nhất một Lead — hãy chỉ định người khác làm Lead trước"

/** Điểm ghi chung để serialize các thao tác đổi thành viên của cùng một org. */
export const touchMembership = async (
  organizationId: string,
  session?: ClientSession
): Promise<void> => {
  const result = await Organization.updateOne(
    { _id: organizationId },
    { $inc: { membershipVersion: 1 } },
    sessionOptions(session)
  )
  if (result.matchedCount === 0) {
    throw new ApiError(404, "Không tìm thấy tổ chức", "ORG_NOT_FOUND")
  }
}

/**
 * Chặn thao tác làm org mất Lead cuối cùng. Chỉ quan tâm khi đối tượng ĐANG là Lead — hạ một Analyst
 * hay xoá một Viewer không bao giờ đụng BR-02.
 *
 * `nextRole` là vai trò sau thao tác: `null` nghĩa là rời đi / bị xoá.
 */
export const assertLeadRemains = async (
  organizationId: string,
  targetUserId: string,
  nextRole: OrgRole | null,
  session?: ClientSession
): Promise<void> => {
  if (nextRole === "lead") return

  const target = await Membership.findOne(
    { organizationId, userId: targetUserId },
    null,
    sessionOptions(session)
  ).lean()
  if (!target || target.role !== "lead") return

  const leadCount = await Membership.countDocuments(
    { organizationId, role: "lead" },
    sessionOptions(session)
  )
  if (leadCount <= 1) {
    throw new ApiError(409, LAST_LEAD_MESSAGE, "LAST_LEAD")
  }
}
