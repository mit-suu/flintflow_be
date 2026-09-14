import { describe, it, expect } from "vitest"
import { PathError, parentArrayPath, parsePath, resolve, tryResolve } from "./path-resolver.js"

const spine = {
  project: { name: "Lumen", release_scope: { in: ["Auth"], out: [] } },
  actors: [
    { id: "A01", name: "Student", kind: "human" },
    { id: "A03", name: "Admin", kind: "human" }
  ],
  permissions: [
    { id: "P1", screen_id: "S3", role_id: "R1", action: "create" },
    { id: "P2", screen_id: "S3", role_id: "R1", action: "view" }
  ],
  functions: [
    {
      id: "F1",
      validations: [
        { id: "V1", statement: "a" },
        { id: "V2", statement: "b" }
      ]
    }
  ],
  screens: [{ id: "S07", flow_to: ["S08", "S09"] }],
  sections: [{ id: "fixed:3.1.1" }, { id: "function:FN034" }],
  steps: [{ id: "S-5.1@S07" }],
  nfrs: [{ id: "N01" }]
}

const rejects = (path: string, rule: string) => {
  try {
    resolve(spine, path)
  } catch (err) {
    expect(err).toBeInstanceOf(PathError)
    expect((err as PathError).rule).toBe(rule)
    return
  }
  throw new Error(`"${path}" lẽ ra phải bị từ chối (${rule})`)
}

describe("parsePath", () => {
  it("parse đủ 4 dạng path của tài liệu", () => {
    expect(parsePath("actors[id=A03].name")).toEqual([{ key: "actors", selector: { kind: "match", pairs: [["id", "A03"]] } }, { key: "name" }])
    expect(parsePath("permissions[screen_id=S3,role_id=R1,action=create]")).toEqual([
      { key: "permissions", selector: { kind: "match", pairs: [["screen_id", "S3"], ["role_id", "R1"], ["action", "create"]] } }
    ])
    expect(parsePath("project.release_scope.in")).toEqual([{ key: "project" }, { key: "release_scope" }, { key: "in" }])
    expect(parsePath("functions[id=F1].validations[id=V2].statement")).toHaveLength(3)
  })

  it("giá trị selector được chứa . : @ -", () => {
    expect(parsePath("sections[id=fixed:3.1.1]")[0].selector).toEqual({ kind: "match", pairs: [["id", "fixed:3.1.1"]] })
    expect(parsePath("steps[id=S-5.1@S07]")[0].selector).toEqual({ kind: "match", pairs: [["id", "S-5.1@S07"]] })
  })

  it("từ chối chỉ số mảng và cú pháp sai", () => {
    expect(() => parsePath("actors[1]")).toThrow(expect.objectContaining({ rule: "index_selector_forbidden" }))
    expect(() => parsePath("actors[0].name")).toThrow(expect.objectContaining({ rule: "index_selector_forbidden" }))
    for (const bad of ["", "actors[", "actors[id]", "actors[=]", ".name", "actors..name", "actors[].name", "1abc"]) {
      expect(() => parsePath(bad), bad).toThrow(expect.objectContaining({ rule: "path_invalid" }))
    }
  })

  it("parentArrayPath", () => {
    expect(parentArrayPath("screens[id=S07].flow_to[=S08]")).toBe("screens[id=S07].flow_to[]")
    expect(parentArrayPath("actors[id=A01]")).toBe("actors[]")
    expect(parentArrayPath("actors[id=A01].name")).toBeNull()
  })
})

describe("resolve", () => {
  it("field của phần tử theo id", () => {
    const r = resolve(spine, "actors[id=A03].name")
    expect(r).toMatchObject({ kind: "field", key: "name", value: "Admin", exists: true, lockedKeys: ["id"] })
  })

  it("phần tử theo khoá tự nhiên nhiều trường, path chuẩn hoá về [id=]", () => {
    const r = resolve(spine, "permissions[screen_id=S3,role_id=R1,action=create]")
    expect(r).toMatchObject({ kind: "element", key: 0, canonical: "permissions[id=P1]" })
    expect(r.lockedKeys).toEqual(expect.arrayContaining(["id", "screen_id", "role_id", "action"]))
  })

  it("field lồng và field chưa tồn tại (optional)", () => {
    expect(resolve(spine, "project.release_scope.in")).toMatchObject({ kind: "field", value: ["Auth"], exists: true })
    expect(resolve(spine, "functions[id=F1].validations[id=V2].statement")).toMatchObject({ value: "b" })
    expect(resolve(spine, "nfrs[id=N01].metric")).toMatchObject({ kind: "field", exists: false })
  })

  it("selector vô hướng và append", () => {
    expect(resolve(spine, "screens[id=S07].flow_to[=S09]")).toMatchObject({ kind: "element", key: 1, value: "S09" })
    expect(resolve(spine, "actors[]")).toMatchObject({ kind: "append", key: 2 })
    expect(resolve(spine, "sections[id=fixed:3.1.1]")).toMatchObject({ kind: "element", key: 0 })
  })

  it("không phân giải / nhập nhằng", () => {
    rejects("actors[id=A99].name", "path_not_resolved")
    rejects("ghost.name", "path_not_resolved")
    rejects("project.name.x", "path_not_resolved")
    rejects("screens[id=S07].flow_to[=S99]", "path_not_resolved")
    rejects("permissions[screen_id=S3,role_id=R1]", "path_ambiguous")
    rejects("actors[1].name", "index_selector_forbidden")
    expect(tryResolve(spine, "actors[id=A99]")).toBeNull()
  })
})
