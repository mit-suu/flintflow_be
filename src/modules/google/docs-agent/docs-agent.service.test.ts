import { describe, expect, it } from "vitest"
import { withoutWriteControl } from "./docs-agent.service.js"

describe("withoutWriteControl", () => {
  it("gỡ dryRun và expectedRevisionId khỏi schema tool ghi — model không có tham số nào để đòi ghi thật", () => {
    const schema = {
      type: "object",
      properties: {
        documentId: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        dryRun: { type: "boolean", default: true },
        expectedRevisionId: { type: "string" }
      },
      required: ["documentId", "find", "replace", "dryRun"]
    }
    const stripped = withoutWriteControl(schema)
    expect(Object.keys(stripped.properties as object)).toEqual(["documentId", "find", "replace"])
    expect(stripped.required).toEqual(["documentId", "find", "replace"])
    expect(stripped.type).toBe("object")
    // Không sửa schema gốc của MCP server
    expect(Object.keys(schema.properties)).toContain("dryRun")
  })

  it("schema không có required vẫn giữ nguyên dạng", () => {
    expect(withoutWriteControl({ type: "object", properties: { dryRun: {} } })).toEqual({ type: "object", properties: {} })
  })
})
