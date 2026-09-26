import { Request, Response } from "express"
import * as organizationService from "./organization.service.js"
import * as membershipService from "./membership.service.js"
import * as invitationService from "./invitation.service.js"
import { sendSuccess } from "../../shared/types/api-response.js"
import { catchAsync } from "../../shared/utils/catch-async.js"
import { ApiError } from "../../shared/utils/api-error.js"
import type {
  ChangeRoleDTO,
  CreateInvitationDTO,
  CreateOrganizationDTO,
  DeleteOrganizationDTO,
  RenameOrganizationDTO
} from "./organization.validation.js"

const requireUserId = (req: Request): string => {
  const userId = req.user?.userId
  if (!userId) throw new ApiError(401, "Chưa xác thực người dùng", "UNAUTHORIZED")
  return userId
}

/** Các route dưới `/orgs/:orgId` đều đi qua `orgContextFromParam`, nên `req.orgContext` luôn có. */
const requireOrg = (req: Request) => {
  if (!req.orgContext) throw new ApiError(500, "Thiếu orgContext trên route", "ORG_CONTEXT_MISSING")
  return req.orgContext
}

export const createOrganization = catchAsync(async (req: Request, res: Response) => {
  const { name } = req.body as CreateOrganizationDTO
  const org = await organizationService.createOrganization(requireUserId(req), name)
  return sendSuccess(res, 201, org)
})

export const listMyOrganizations = catchAsync(async (req: Request, res: Response) => {
  const orgs = await organizationService.listMyOrganizations(requireUserId(req))
  return sendSuccess(res, 200, orgs)
})

export const getOrganization = catchAsync(async (req: Request, res: Response) => {
  const { orgId, role } = requireOrg(req)
  return sendSuccess(res, 200, await organizationService.getOrganization(orgId, role))
})

export const renameOrganization = catchAsync(async (req: Request, res: Response) => {
  const { orgId, role } = requireOrg(req)
  const { name } = req.body as RenameOrganizationDTO
  return sendSuccess(res, 200, await organizationService.renameOrganization(orgId, name, role))
})

export const deleteOrganization = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  const { confirmName } = req.body as DeleteOrganizationDTO
  return sendSuccess(res, 200, await organizationService.deleteOrganization(orgId, requireUserId(req), confirmName))
})

export const switchOrganization = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  const result = await organizationService.switchOrganization(
    requireUserId(req),
    req.user?.email ?? "",
    req.user?.role,
    orgId,
    req.cookies?.refreshToken
  )
  return sendSuccess(res, 200, result)
})

export const listMembers = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  return sendSuccess(res, 200, await membershipService.listMembers(orgId))
})

export const changeMemberRole = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  const { role } = req.body as ChangeRoleDTO
  const member = await membershipService.changeMemberRole(orgId, req.params.userId as string, role)
  return sendSuccess(res, 200, member)
})

export const removeMember = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  return sendSuccess(res, 200, await membershipService.removeMember(orgId, req.params.userId as string))
})

export const leaveOrganization = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  return sendSuccess(res, 200, await membershipService.leaveOrganization(orgId, requireUserId(req)))
})

export const createInvitation = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  const { role, email } = req.body as CreateInvitationDTO
  const invitation = await invitationService.createInvitation(orgId, requireUserId(req), role, email)
  return sendSuccess(res, 201, invitation)
})

export const listInvitations = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  return sendSuccess(res, 200, await invitationService.listInvitations(orgId))
})

export const revokeInvitation = catchAsync(async (req: Request, res: Response) => {
  const { orgId } = requireOrg(req)
  const invitation = await invitationService.revokeInvitation(orgId, req.params.invitationId as string)
  return sendSuccess(res, 200, invitation)
})

export const previewInvitation = catchAsync(async (req: Request, res: Response) => {
  return sendSuccess(res, 200, await invitationService.previewInvitation(req.params.code as string))
})

export const acceptInvitation = catchAsync(async (req: Request, res: Response) => {
  const result = await invitationService.acceptInvitation(
    req.params.code as string,
    requireUserId(req),
    req.user?.email ?? "",
    req.user?.role
  )
  return sendSuccess(res, 200, result)
})
