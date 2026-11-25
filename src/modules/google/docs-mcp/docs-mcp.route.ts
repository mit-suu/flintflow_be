import { Router, type Request, type Response } from "express"
import type { OAuth2Client } from "google-auth-library"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { authMiddleware } from "../../../shared/auth/auth.middleware.js"
import { requireDocsAgentEnabled } from "../docs-agent/docs-agent.guard.js"
import { catchAsync } from "../../../shared/utils/catch-async.js"
import { ApiError } from "../../../shared/utils/api-error.js"
import { assertGoogleIntegrationEnabled, getAuthClient } from "../google-auth.service.js"
import { createDocsMcpServer } from "./docs-mcp.server.js"

/**
 * `POST /api/v1/mcp/google-docs` (contract #47) — MCP Streamable HTTP, stateless: mỗi request một server + transport mới,
 * trả JSON (không mở SSE). Mount sau `authMiddleware → requireActiveAccount`; quyền Google là của chính người gọi.
 *
 * Thử bằng MCP Inspector: transport "Streamable HTTP", URL `http://localhost:5000/api/v1/mcp/google-docs`, header
 * `Authorization: Bearer <access token FlintFlow>`.
 */
const router = Router()

/**
 * @swagger
 * /api/v1/mcp/google-docs:
 *   post:
 *     summary: MCP server Google Docs (JSON-RPC, Streamable HTTP stateless) — tool get_outline, read_section, search_text, replace_text, insert_text
 *     tags: [Google integration]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: "Phản hồi JSON-RPC; lỗi Google nằm trong kết quả tool isError: true với mã GOOGLE_*"
 *       401:
 *         description: UNAUTHORIZED
 *       503:
 *         description: "GOOGLE_INTEGRATION_DISABLED | GOOGLE_DOCS_AGENT_DISABLED"
 */
router.post(
  "/",
  authMiddleware,
  requireDocsAgentEnabled,
  catchAsync(async (req: Request, res: Response) => {
    const userId = req.user?.userId
    if (!userId) throw new ApiError(401, "Bạn chưa đăng nhập hoặc phiên đăng nhập đã hết hạn.", "UNAUTHORIZED")
    assertGoogleIntegrationEnabled()

    let auth: Promise<OAuth2Client> | null = null
    const server = createDocsMcpServer(() => (auth ??= getAuthClient(userId)))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on("close", () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  })
)

/** Stateless ⇒ không có luồng SSE (GET) hay phiên để huỷ (DELETE). */
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
router.get("/", methodNotAllowed)
router.delete("/", methodNotAllowed)

export default router
