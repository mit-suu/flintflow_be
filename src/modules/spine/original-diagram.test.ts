import { describe, expect, it } from "vitest"
import { inferDiagramKind } from "./original-diagram.js"

describe("FLF-361 inferDiagramKind — ảnh sơ đồ gốc chưa đọc được", () => {
  it("caption nói loại sơ đồ ⇒ loại đó, ở bất kỳ mục nào", () => {
    expect(inferDiagramKind("fixed:2.2.1", "Use Cases — Student")).toBe("usecase")
    expect(inferDiagramKind("fixed:3.1.1", "Figure 2 Screens flow")).toBe("screen_flow")
    expect(inferDiagramKind("custom:x", "Figure 5 Entity Relationship Diagram")).toBe("erd")
    expect(inferDiagramKind("fixed:1", "Figure 1 System Context")).toBe("context")
  })

  it("caption không rõ loại ⇒ theo mục FPT in sơ đồ đó", () => {
    expect(inferDiagramKind("fixed:2.2.1", "(none)")).toBe("usecase")
    expect(inferDiagramKind("fixed:3.1.1", "Figure 3")).toBe("screen_flow")
    expect(inferDiagramKind("fixed:3.1.5", "Figure —")).toBe("erd")
    expect(inferDiagramKind("fixed:1", "Figure —")).toBe("context")
  })

  it("ảnh màn hình / sequence, hoặc mục không có sơ đồ ⇒ không suy", () => {
    expect(inferDiagramKind("fixed:2.2.1", "Screen layout — Login")).toBeNull()
    expect(inferDiagramKind("fixed:3.1.5", "Sequence diagram")).toBeNull()
    expect(inferDiagramKind("fixed:2.1", "(none)")).toBeNull()
    expect(inferDiagramKind(null, "(none)")).toBeNull()
  })
})
