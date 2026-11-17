/**
 * docs-mcp.server.ts
 * ─────────────────────────────────────────────────────────────────
 * MCP server Google Docs (contract #47): 5 tool đọc / sửa một Google Doc bằng quyền Google của chính người gọi.
 *
 * - Kết quả là JSON gọn (mục lục, chữ một mục, đoạn khớp) — không bao giờ trả nguyên cấu trúc tài liệu.
 * - Tool ghi mặc định `dryRun: true` (chỉ xem trước). Ghi thật bắt buộc `expectedRevisionId` lấy từ lần đọc trước; tài liệu
 *   đã đổi ⇒ `GOOGLE_DOC_CHANGED`, không ghi chồng.
 * - Lỗi trả dạng `isError: true` với `{ error: { code, message, meta? } }` để model đọc được và hỏi lại người dùng.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { docs as createDocs, type docs_v1 } from "@googleapis/docs"
import type { OAuth2Client } from "google-auth-library"
import { z } from "zod"
import { ApiError } from "../../../shared/utils/api-error.js"
import { GENERIC_SERVER_MESSAGE } from "../../../shared/utils/client-error.js"
import { googleErrorStatus, toGoogleApiError } from "../google-api-error.js"
import { DocsToolError, findHeading, outlineOf, parseDocument, searchText, sectionText, type DocStructure } from "./docs-structure.js"
import { planInsert, planReplace } from "./docs-edits.js"

export const MAX_SECTION_CHARS = 8000
export const MAX_SEARCH_MATCHES = 20

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] })
const fail = (code: string, message: string, meta?: Record<string, unknown>): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...(meta ? { meta } : {}) } }) }]
})

const docChanged = () =>
  fail("GOOGLE_DOC_CHANGED", "Tài liệu vừa được sửa ở nơi khác. Đọc lại tài liệu rồi xem trước thay đổi lần nữa.")

/** `writeControl.requiredRevisionId` lệch ⇒ Docs API trả 400 với câu nhắc tới revision. */
const isRevisionMismatch = (err: unknown): boolean => {
  const e = err as { message?: unknown; response?: { data?: { error?: { message?: unknown } } } }
  const message = String(e?.response?.data?.error?.message ?? e?.message ?? "")
  return googleErrorStatus(err) === 400 && /revision/i.test(message)
}

const toToolError = (err: unknown): ToolResult => {
  if (err instanceof DocsToolError) return fail(err.code, err.message, err.meta)
  if (isRevisionMismatch(err)) return docChanged()
  const mapped = toGoogleApiError(err)
  if (mapped instanceof ApiError) return fail(mapped.code, mapped.message, mapped.meta)
  console.error("[docs-mcp] lỗi không xác định:", err)
  return fail("INTERNAL_ERROR", GENERIC_SERVER_MESSAGE)
}

const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn()
  } catch (err) {
    return toToolError(err)
  }
}

const documentId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w-]+$/)
  .describe("ID Google Doc (đoạn giữa /d/ và /edit trong link)")
const dryRun = z.boolean().default(true).describe("true (mặc định): chỉ xem trước, không ghi. false: ghi thật, cần expectedRevisionId")
const expectedRevisionId = z.string().min(1).optional().describe("revisionId từ get_outline / lần xem trước; bắt buộc khi dryRun = false")

/**
 * Tạo server mới (stateless — mỗi request HTTP một server). `getAuth` chỉ được gọi khi một tool cần Google, nên
 * `initialize` / `tools/list` chạy được cả khi user chưa nối Google; tool thì trả `GOOGLE_RECONNECT_REQUIRED`.
 */
export const createDocsMcpServer = (getAuth: () => Promise<OAuth2Client>): McpServer => {
  const server = new McpServer({ name: "flintflow-google-docs", version: "1.0.0" })

  let client: docs_v1.Docs | null = null
  const docsClient = async (): Promise<docs_v1.Docs> => (client ??= createDocs({ version: "v1", auth: await getAuth() }))
  const load = async (id: string): Promise<DocStructure> =>
    parseDocument((await (await docsClient()).documents.get({ documentId: id })).data)

  /** Ghi thật: kiểm revision ngay trên bản vừa đọc, rồi gửi kèm `requiredRevisionId` để chặn lượt sửa chen giữa. */
  const write = async (id: string, structure: DocStructure, expected: string | undefined, requests: docs_v1.Schema$Request[]) => {
    if (!expected) {
      throw new DocsToolError("REVISION_REQUIRED", "Ghi thật cần expectedRevisionId lấy từ get_outline hoặc lần xem trước.")
    }
    if (structure.revisionId !== expected) return null
    const { data } = await (await docsClient()).documents.batchUpdate({
      documentId: id,
      requestBody: { requests, writeControl: { requiredRevisionId: expected } }
    })
    return data
  }

  server.registerTool(
    "get_outline",
    {
      title: "Mục lục tài liệu",
      description: "Tiêu đề, revisionId và danh sách heading (cấp, chữ, số ký tự của mục). Gọi đầu tiên để biết tài liệu có những mục nào.",
      inputSchema: { documentId },
      annotations: { readOnlyHint: true }
    },
    ({ documentId: id }) => run(async () => ok(outlineOf(await load(id))))
  )

  server.registerTool(
    "read_section",
    {
      title: "Đọc một mục",
      description: `Chữ của một mục (gồm cả mục con), tìm theo chữ heading — không phân biệt hoa thường / dấu, bỏ qua số mục. Cắt ở ${MAX_SECTION_CHARS} ký tự.`,
      inputSchema: { documentId, heading: z.string().min(1).max(300).describe("Chữ heading, ví dụ \"Use cases\"") },
      annotations: { readOnlyHint: true }
    },
    ({ documentId: id, heading }) =>
      run(async () => {
        const structure = await load(id)
        return ok({ revisionId: structure.revisionId, ...sectionText(structure, findHeading(structure, heading), MAX_SECTION_CHARS) })
      })
  )

  server.registerTool(
    "search_text",
    {
      title: "Tìm chữ",
      description: `Tối đa ${MAX_SEARCH_MATCHES} đoạn chứa chuỗi tìm (không phân biệt hoa thường / dấu), kèm heading của mục chứa nó.`,
      inputSchema: { documentId, query: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true }
    },
    ({ documentId: id, query }) => run(async () => ok(searchText(await load(id), query, MAX_SEARCH_MATCHES)))
  )

  server.registerTool(
    "replace_text",
    {
      title: "Thay chữ",
      description:
        "Thay mọi chỗ khớp đúng chuỗi `find` bằng `replace`. Mặc định chỉ xem trước (số chỗ khớp, mẫu trước / sau). Luôn xem trước và để người dùng duyệt trước khi ghi thật.",
      inputSchema: {
        documentId,
        find: z.string().min(1).max(1000),
        replace: z.string().max(5000),
        matchCase: z.boolean().default(true),
        dryRun,
        expectedRevisionId
      },
      annotations: { destructiveHint: true }
    },
    (input) =>
      run(async () => {
        const structure = await load(input.documentId)
        const plan = planReplace(structure, input.find, input.replace, input.matchCase)
        if (input.dryRun) {
          return ok({ dryRun: true, revisionId: structure.revisionId, matches: plan.matches, samples: plan.samples })
        }
        const result = await write(input.documentId, structure, input.expectedRevisionId, plan.requests)
        if (!result) return docChanged()
        return ok({
          dryRun: false,
          occurrencesChanged: result.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0,
          revisionId: result.writeControl?.requiredRevisionId ?? null
        })
      })
  )

  server.registerTool(
    "insert_text",
    {
      title: "Chèn chữ",
      description:
        "Chèn đoạn văn vào cuối một mục (afterHeading) hoặc cuối tài liệu (atEnd). asHeading: dòng đầu thành heading cấp con của mục. Mặc định chỉ xem trước.",
      inputSchema: {
        documentId,
        afterHeading: z.string().min(1).max(300).optional().describe("Chữ heading của mục cần chèn vào cuối"),
        atEnd: z.boolean().optional().describe("true: chèn vào cuối tài liệu"),
        text: z.string().min(1).max(20000),
        asHeading: z.boolean().default(false),
        dryRun,
        expectedRevisionId
      },
      annotations: { destructiveHint: false }
    },
    (input) =>
      run(async () => {
        if (Boolean(input.afterHeading) === Boolean(input.atEnd)) {
          throw new DocsToolError("TARGET_REQUIRED", "Truyền đúng một trong hai: afterHeading hoặc atEnd = true.")
        }
        const structure = await load(input.documentId)
        const target = input.afterHeading ? { afterHeading: input.afterHeading } : { atEnd: true as const }
        const plan = planInsert(structure, target, input.text, input.asHeading)
        const summary = { location: plan.location, asHeading: plan.asHeading, headingLevel: plan.headingLevel, text: plan.text }
        if (input.dryRun) return ok({ dryRun: true, revisionId: structure.revisionId, ...summary })
        const result = await write(input.documentId, structure, input.expectedRevisionId, plan.requests)
        if (!result) return docChanged()
        return ok({ dryRun: false, revisionId: result.writeControl?.requiredRevisionId ?? null, ...summary })
      })
  )

  return server
}
