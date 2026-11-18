/**
 * docs-agent.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Trợ lý Google Docs (contract #48–#50): agent chat với một Google Doc, đọc qua tool của MCP server Google Docs
 * (`docs-mcp.server.ts`), còn mọi tool ghi chỉ tạo **đề xuất** chờ người dùng duyệt.
 *
 * - MCP client nối thẳng server trong bộ nhớ (`InMemoryTransport`): vẫn đúng giao thức MCP, không cần gọi HTTP vòng về
 *   chính BE hay chuyển tiếp JWT. Server dùng quyền Google của chính người dùng.
 * - Tool ghi được bọc: luôn gọi `dryRun: true`, model không thấy `dryRun` / `expectedRevisionId` trong schema nên không tự
 *   ghi được. Chỉ `applyPendingAction` (người dùng bấm Áp dụng) gửi `dryRun: false` kèm revision lúc xem trước.
 * - Mọi tool bị ghim vào `documentId` người dùng đang mở — model không đọc / sửa được tài liệu khác.
 */
import mongoose from "mongoose"
import { dynamicTool, jsonSchema, type JSONSchema7, type ModelMessage, type ToolSet } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { OAuth2Client } from "google-auth-library"
import { ApiError } from "../../../shared/utils/api-error.js"
import { ActionType } from "../../../shared/ai/ai-action.types.js"
import { executeAgentStream } from "../../../shared/ai/ai-action.service.js"
import { assertGoogleIntegrationEnabled, getAuthClient } from "../google-auth.service.js"
import { createDocsMcpServer } from "../docs-mcp/docs-mcp.server.js"
import {
  GooglePendingAction,
  PENDING_ACTION_TOOLS,
  PENDING_ACTION_TTL_MS,
  type IGooglePendingAction,
  type PendingActionTool
} from "./pending-action.model.js"

export const AGENT_MAX_STEPS = 8
export const HISTORY_MAX = 12

const WRITE_TOOLS = new Set<string>(PENDING_ACTION_TOOLS)

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export interface PendingActionView {
  id: string
  tool: PendingActionTool
  documentId: string
  args: Record<string, unknown>
  preview: Record<string, unknown>
  expiresAt: Date
}

export type AgentEvent =
  | { type: "tool-call"; name: string; args: Record<string, unknown> }
  | { type: "text-delta"; delta: string }

interface McpToolError {
  code: string
  message: string
  meta?: Record<string, unknown>
}

interface McpToolResult {
  isError: boolean
  data: Record<string, unknown> & { error?: McpToolError }
}

// ─── MCP client trong bộ nhớ ─────────────────────────────────────────

export interface DocsMcpConnection {
  client: Client
  close: () => Promise<void>
}

export const connectDocsMcp = async (getAuth: () => Promise<OAuth2Client>): Promise<DocsMcpConnection> => {
  const server = createDocsMcpServer(getAuth)
  const client = new Client({ name: "flintflow-docs-agent", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    close: async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  }
}

export const callMcpTool = async (client: Client, name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
  const result = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean }
  const text = result.content?.find((c) => c.type === "text")?.text ?? "{}"
  return { isError: Boolean(result.isError), data: JSON.parse(text) }
}

/** Mã lỗi tool ⇒ HTTP cho các endpoint ngoài luồng SSE (mở lượt chat, áp dụng đề xuất). */
const STATUS_BY_CODE: Record<string, number> = {
  GOOGLE_RECONNECT_REQUIRED: 401,
  GOOGLE_FILE_FORBIDDEN: 403,
  GOOGLE_FILE_NOT_FOUND: 404,
  GOOGLE_DOC_CHANGED: 409,
  // Lúc áp dụng mà mục không còn ⇒ tài liệu đã đổi so với lúc xem trước
  HEADING_NOT_FOUND: 409,
  HEADING_AMBIGUOUS: 409,
  GOOGLE_DRIVE_QUOTA_EXCEEDED: 503,
  GOOGLE_INTEGRATION_DISABLED: 503
}

const toApiError = (error: McpToolError | undefined): ApiError => {
  if (!error) return new ApiError(500, "Hệ thống gặp lỗi khi xử lý yêu cầu. Vui lòng thử lại sau.", "INTERNAL_ERROR")
  const status = STATUS_BY_CODE[error.code] ?? 500
  if (status === 409 && error.code !== "GOOGLE_DOC_CHANGED") {
    return new ApiError(409, "Tài liệu vừa được sửa ở nơi khác. Nhờ trợ lý xem lại rồi đề xuất lại.", "GOOGLE_DOC_CHANGED")
  }
  return new ApiError(status, error.message, error.code, error.meta)
}

// ─── Tool cho agent ──────────────────────────────────────────────────

/** Bỏ `dryRun`, `expectedRevisionId` khỏi schema tool ghi: model không có cách nào yêu cầu ghi thật. */
export const withoutWriteControl = (schema: Record<string, unknown>): Record<string, unknown> => {
  const properties = { ...((schema.properties as Record<string, unknown>) ?? {}) }
  delete properties.dryRun
  delete properties.expectedRevisionId
  const required = Array.isArray(schema.required) ? schema.required.filter((r) => r !== "dryRun" && r !== "expectedRevisionId") : undefined
  return { ...schema, properties, ...(required ? { required } : {}) }
}

const toView = (action: IGooglePendingAction): PendingActionView => ({
  id: String(action._id),
  tool: action.tool,
  documentId: action.documentId,
  args: action.args,
  preview: action.preview,
  expiresAt: action.expiresAt
})

interface ToolContext {
  client: Client
  projectId: string
  userId: string
  documentId: string
  pending: PendingActionView[]
}

const buildAgentTools = async (ctx: ToolContext): Promise<ToolSet> => {
  const { tools } = await ctx.client.listTools()
  const set: ToolSet = {}
  for (const t of tools) {
    const isWrite = WRITE_TOOLS.has(t.name)
    const schema = isWrite ? withoutWriteControl(t.inputSchema) : t.inputSchema
    set[t.name] = dynamicTool({
      description: t.description ?? t.name,
      inputSchema: jsonSchema(schema as JSONSchema7),
      execute: async (input) => {
        // Ghim vào tài liệu đang mở; bỏ mọi tham số điều khiển ghi model có thể tự thêm
        const { dryRun: _dryRun, expectedRevisionId: _revision, ...rest } = (input ?? {}) as Record<string, unknown>
        const args = { ...rest, documentId: ctx.documentId }
        if (!isWrite) return (await callMcpTool(ctx.client, t.name, args)).data

        const preview = await callMcpTool(ctx.client, t.name, { ...args, dryRun: true })
        if (preview.isError) return preview.data
        if (t.name === "replace_text" && preview.data.matches === 0) {
          return { status: "no_change", message: "No text matched, so no proposal was created." }
        }
        const { dryRun: _d, revisionId, ...previewData } = preview.data
        const action = await GooglePendingAction.create({
          projectId: ctx.projectId,
          userId: ctx.userId,
          documentId: ctx.documentId,
          tool: t.name as PendingActionTool,
          args: rest,
          preview: previewData,
          revisionId: String(revisionId),
          expiresAt: new Date(Date.now() + PENDING_ACTION_TTL_MS)
        })
        const view = toView(action)
        ctx.pending.push(view)
        return { status: "proposal_created", proposalId: view.id, note: "Not applied yet. The user reviews it and clicks Apply or Dismiss." }
      }
    })
  }
  return set
}

// ─── Lượt chat ───────────────────────────────────────────────────────

export interface AgentTurnRequest {
  projectId: string
  userId: string
  activeOrgId?: string | null
  documentId: string
  message: string
  history: ChatTurn[]
  signal?: AbortSignal
}

export interface AgentTurnResult {
  reply: string
  pendingActions: PendingActionView[]
  cost: number
  tokensUsed: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface AgentTurn {
  documentTitle: string
  run: (emit: (event: AgentEvent) => void) => Promise<AgentTurnResult>
  close: () => Promise<void>
}

/**
 * Mở một lượt: nối MCP, đọc mục lục để chắc user truy cập được tài liệu (chưa nối Google / không có quyền ⇒ ném `ApiError`
 * TRƯỚC khi mở SSE và trước khi giữ credit). Người gọi phải `close()` trong `finally`.
 */
export const openAgentTurn = async (req: AgentTurnRequest): Promise<AgentTurn> => {
  assertGoogleIntegrationEnabled()
  let auth: Promise<OAuth2Client> | null = null
  const mcp = await connectDocsMcp(() => (auth ??= getAuthClient(req.userId)))
  try {
    const outline = await callMcpTool(mcp.client, "get_outline", { documentId: req.documentId })
    if (outline.isError) throw toApiError(outline.data.error)
    const documentTitle = String(outline.data.title ?? "")

    const run = async (emit: (event: AgentEvent) => void): Promise<AgentTurnResult> => {
      const pending: PendingActionView[] = []
      const tools = await buildAgentTools({ client: mcp.client, projectId: req.projectId, userId: req.userId, documentId: req.documentId, pending })
      const messages: ModelMessage[] = [
        ...req.history.slice(-HISTORY_MAX).map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: req.message }
      ]
      const result = await executeAgentStream(
        ActionType.GOOGLE_DOCS_AGENT,
        { promptVariables: { documentTitle, documentId: req.documentId }, messages, tools, maxSteps: AGENT_MAX_STEPS },
        req.projectId,
        req.userId,
        {
          onTextDelta: (delta) => emit({ type: "text-delta", delta }),
          onToolCall: ({ toolName, input }) => {
            const args = (input ?? {}) as Record<string, unknown>
            // Chỉ gửi phần FE cần để hiện chip "Đang đọc mục …" — không gửi nguyên văn chữ đề xuất
            const shown = Object.fromEntries(Object.entries(args).filter(([k]) => k === "heading" || k === "query" || k === "afterHeading"))
            emit({ type: "tool-call", name: toolName, args: shown })
          }
        },
        { signal: req.signal, activeOrgId: req.activeOrgId }
      )
      return { reply: result.text, pendingActions: pending, cost: result.cost, tokensUsed: result.tokensUsed }
    }
    return { documentTitle, run, close: mcp.close }
  } catch (err) {
    await mcp.close()
    throw err
  }
}

// ─── Áp dụng / bỏ qua đề xuất ────────────────────────────────────────

const notFound = () =>
  new ApiError(404, "Đề xuất không còn (đã áp dụng, đã bỏ qua hoặc quá 1 giờ).", "PENDING_ACTION_NOT_FOUND")

const findOwn = async (projectId: string, userId: string, actionId: string) => {
  if (!mongoose.isValidObjectId(actionId)) return null
  return GooglePendingAction.findOne({ _id: actionId, projectId, userId, expiresAt: { $gt: new Date() } })
}

/** Ghi thật đề xuất vào Google Doc (miễn phí). Tài liệu đã đổi so với lúc xem trước ⇒ 409 `GOOGLE_DOC_CHANGED`. */
export const applyPendingAction = async (projectId: string, userId: string, actionId: string) => {
  assertGoogleIntegrationEnabled()
  const action = await findOwn(projectId, userId, actionId)
  if (!action) throw notFound()

  const mcp = await connectDocsMcp(() => getAuthClient(userId))
  try {
    const res = await callMcpTool(mcp.client, action.tool, {
      ...action.args,
      documentId: action.documentId,
      dryRun: false,
      expectedRevisionId: action.revisionId
    })
    if (res.isError) throw toApiError(res.data.error)
    await GooglePendingAction.deleteOne({ _id: action._id })
    return { applied: true, actionId, documentId: action.documentId, revisionId: (res.data.revisionId as string | null) ?? null }
  } finally {
    await mcp.close()
  }
}

/** Bỏ đề xuất (miễn phí, không đụng Google). */
export const dismissPendingAction = async (projectId: string, userId: string, actionId: string) => {
  if (!mongoose.isValidObjectId(actionId)) throw notFound()
  const { deletedCount } = await GooglePendingAction.deleteOne({ _id: actionId, projectId, userId })
  if (!deletedCount) throw notFound()
  return { dismissed: true, actionId }
}
