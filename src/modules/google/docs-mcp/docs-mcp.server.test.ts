import { beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { OAuth2Client } from "google-auth-library"
import { ApiError } from "../../../shared/utils/api-error.js"
import { loadSampleDoc } from "./docs-test-fixture.js"

const h = vi.hoisted(() => ({ documents: { get: vi.fn(), batchUpdate: vi.fn() } }))
vi.mock("@googleapis/docs", () => ({ docs: vi.fn(() => ({ documents: h.documents })) }))

const { createDocsMcpServer, MAX_SEARCH_MATCHES } = await import("./docs-mcp.server.js")

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

const connect = async (getAuth: () => Promise<OAuth2Client> = async () => ({}) as OAuth2Client) => {
  const server = createDocsMcpServer(getAuth)
  const client = new Client({ name: "test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as TextResult
    return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) }
  }
  return { client, call }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.documents.get.mockResolvedValue({ data: loadSampleDoc() })
})

describe("docs MCP server", () => {
  it("liệt kê đủ 5 tool; tool đọc đánh dấu readOnly", async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(["get_outline", "insert_text", "read_section", "replace_text", "search_text"])
    expect(tools.find((t) => t.name === "get_outline")?.annotations?.readOnlyHint).toBe(true)
  })

  it("get_outline / read_section / search_text trả JSON gọn", async () => {
    const { call } = await connect()
    const outline = await call("get_outline", { documentId: "doc-srs-1" })
    expect(outline.data.revisionId).toBe("rev-1")
    expect(outline.data.headings).toHaveLength(6)
    expect(h.documents.get).toHaveBeenCalledWith({ documentId: "doc-srs-1" })

    const section = await call("read_section", { documentId: "doc-srs-1", heading: "use cases" })
    expect(section.data).toMatchObject({ heading: "2.1 Use cases", revisionId: "rev-1", truncated: false })
    expect(section.data.text).toContain("UC01")

    const found = await call("search_text", { documentId: "doc-srs-1", query: "dat ve" })
    expect(found.data.total).toBe(2)
    expect(MAX_SEARCH_MATCHES).toBe(20)
  })

  it("heading không thấy ⇒ isError HEADING_NOT_FOUND kèm danh sách mục", async () => {
    const { call } = await connect()
    const res = await call("read_section", { documentId: "doc-srs-1", heading: "Glossary" })
    expect(res.isError).toBe(true)
    expect(res.data.error.code).toBe("HEADING_NOT_FOUND")
    expect(res.data.error.meta.headings.length).toBe(6)
  })

  it("replace_text mặc định chỉ xem trước, không gọi batchUpdate", async () => {
    const { call } = await connect()
    const res = await call("replace_text", { documentId: "doc-srs-1", find: "Đặt vé", replace: "Mua vé" })
    expect(res.data).toMatchObject({ dryRun: true, revisionId: "rev-1", matches: 2 })
    expect(h.documents.batchUpdate).not.toHaveBeenCalled()
  })

  it("ghi thật: thiếu expectedRevisionId ⇒ REVISION_REQUIRED; đúng revision ⇒ batchUpdate kèm requiredRevisionId", async () => {
    const { call } = await connect()
    const missing = await call("replace_text", { documentId: "doc-srs-1", find: "Đặt vé", replace: "Mua vé", dryRun: false })
    expect(missing.data.error.code).toBe("REVISION_REQUIRED")

    h.documents.batchUpdate.mockResolvedValue({
      data: { replies: [{ replaceAllText: { occurrencesChanged: 2 } }], writeControl: { requiredRevisionId: "rev-2" } }
    })
    const res = await call("replace_text", { documentId: "doc-srs-1", find: "Đặt vé", replace: "Mua vé", dryRun: false, expectedRevisionId: "rev-1" })
    expect(res.data).toEqual({ dryRun: false, occurrencesChanged: 2, revisionId: "rev-2" })
    expect(h.documents.batchUpdate.mock.calls[0][0]).toMatchObject({
      documentId: "doc-srs-1",
      requestBody: { writeControl: { requiredRevisionId: "rev-1" } }
    })
  })

  it("tài liệu đã đổi (revision lệch lúc đọc, hoặc Docs API từ chối) ⇒ GOOGLE_DOC_CHANGED, không ghi chồng", async () => {
    const { call } = await connect()
    const stale = await call("insert_text", { documentId: "doc-srs-1", atEnd: true, text: "x", dryRun: false, expectedRevisionId: "rev-0" })
    expect(stale.data.error.code).toBe("GOOGLE_DOC_CHANGED")
    expect(h.documents.batchUpdate).not.toHaveBeenCalled()

    h.documents.batchUpdate.mockRejectedValue(
      Object.assign(new Error("bad"), { response: { status: 400, data: { error: { message: "The required revision ID does not match the latest revision." } } } })
    )
    const race = await call("insert_text", { documentId: "doc-srs-1", atEnd: true, text: "x", dryRun: false, expectedRevisionId: "rev-1" })
    expect(race.data.error.code).toBe("GOOGLE_DOC_CHANGED")
  })

  it("insert_text: xem trước nêu vị trí; thiếu / thừa đích ⇒ TARGET_REQUIRED", async () => {
    const { call } = await connect()
    const preview = await call("insert_text", { documentId: "doc-srs-1", afterHeading: "Business Rules", text: "BR02: Hoàn vé." })
    expect(preview.data).toMatchObject({ dryRun: true, location: "2.2 Business Rules", asHeading: false, text: "BR02: Hoàn vé." })

    for (const args of [{ text: "x" }, { text: "x", afterHeading: "Purpose", atEnd: true }]) {
      const res = await call("insert_text", { documentId: "doc-srs-1", ...args })
      expect(res.data.error.code).toBe("TARGET_REQUIRED")
    }
  })

  it("chưa nối Google ⇒ tool trả GOOGLE_RECONNECT_REQUIRED; Drive / Docs 403 ⇒ GOOGLE_FILE_FORBIDDEN", async () => {
    const { client, call } = await connect(async () => {
      throw new ApiError(401, "Cần kết nối lại tài khoản Google để tiếp tục.", "GOOGLE_RECONNECT_REQUIRED")
    })
    expect((await client.listTools()).tools).toHaveLength(5)
    expect((await call("get_outline", { documentId: "doc-srs-1" })).data.error.code).toBe("GOOGLE_RECONNECT_REQUIRED")

    const other = await connect()
    h.documents.get.mockRejectedValue(Object.assign(new Error("denied"), { response: { status: 403, data: { error: {} } } }))
    expect((await other.call("get_outline", { documentId: "doc-srs-1" })).data.error.code).toBe("GOOGLE_FILE_FORBIDDEN")
  })
})
