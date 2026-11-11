/**
 * Sơ đồ triển khai (UML 2.5 Deployment Diagram) của hệ thống — §4.1 External Interfaces (IEEE 830 §3.1 giao diện phần
 * cứng / phần mềm / truyền thông). source_fields: `deployment_nodes[]` · `deployment_links[]` (FLF-390). Dựng bằng
 * PlantUML (`format = puml`), theme Visual Paradigm viết thẳng trong nguồn như sequence.
 *
 * MỘT HÌNH CHO CẢ HỆ THỐNG (`owner_kind = null`, `section = fixed:4.1`). Không có nút ⇒ không có hình (không bịa hạ tầng).
 * Ký pháp (Visual Paradigm "Beginner's guide to deployment diagrams" + UML 2.5):
 * - Nút = khối hộp 3D (`node`); thiết bị phần cứng `<<device>>`, môi trường thực thi `<<executionEnvironment>>`.
 * - Nút con lồng trong nút cha (`parent_id`): môi trường thực thi nằm trong thiết bị.
 * - Mô tả nút (`description`) = dòng thứ hai in nghiêng dưới tên nút.
 * - Component chạy trên nút = `component` trong nút; artifact triển khai lên nút = `artifact` (biểu tượng tài liệu) trong nút.
 * - Đường truyền thông (communication path) = nét liền không mũi tên giữa hai nút, nhãn là giao thức.
 * Alias là id Spine (`DN01`), sắp theo id ⇒ cùng Spine ra cùng nguồn.
 */

import type { DeploymentNode, Spine } from "../../spine/spine.types.js"
import type { RenderedPart, Renderer } from "./common.js"
import { alias, byId, label, puml } from "./common.js"
import { DIAGRAM_LABELS } from "./labels.js"

export const DEPLOYMENT_SECTION = "fixed:4.1"

const THEME: readonly string[] = [
  "skinparam defaultFontName Arial",
  "skinparam defaultFontSize 13",
  "skinparam defaultFontColor #000000",
  "skinparam shadowing false",
  "skinparam roundCorner 0",
  "skinparam ArrowColor #000000",
  "skinparam ArrowThickness 1.2",
  "skinparam BackgroundColor #FFFFFF",
  "skinparam NodeBackgroundColor #7ACFF5",
  "skinparam NodeBorderColor #000000",
  "skinparam ComponentBackgroundColor #FFFFFF",
  "skinparam ComponentBorderColor #000000",
  "skinparam ComponentStyle uml2",
  "skinparam ArtifactBackgroundColor #FFFFFF",
  "skinparam ArtifactBorderColor #000000",
  "skinparam dpi 192",
  "skinparam nodesep 60",
  "skinparam ranksep 60",
  "left to right direction"
]

const STEREOTYPE: Readonly<Record<DeploymentNode["kind"], string>> = {
  device: " <<device>>",
  execution_environment: " <<executionEnvironment>>",
  node: ""
}

const clean = (text: string | undefined): string => label((text ?? "").replace(/\s+/g, " ").trim())

/** Nút có cha không tồn tại hoặc vòng cha ⇒ coi là nút gốc (không vẽ lồng sai). */
const rootsAndChildren = (nodes: readonly DeploymentNode[]): { roots: DeploymentNode[]; children: Map<string, DeploymentNode[]> } => {
  const byIdMap = new Map(nodes.map((n) => [n.id, n]))
  const validParent = (n: DeploymentNode): string | null => {
    const seen = new Set([n.id])
    let p = n.parent_id
    while (p !== null) {
      if (!byIdMap.has(p) || seen.has(p)) return null
      seen.add(p)
      p = byIdMap.get(p)!.parent_id
    }
    return n.parent_id
  }
  const children = new Map<string, DeploymentNode[]>()
  const roots: DeploymentNode[] = []
  for (const n of byId(nodes)) {
    const parent = validParent(n)
    if (parent === null) roots.push(n)
    else children.set(parent, [...(children.get(parent) ?? []), n])
  }
  return { roots, children }
}

export const deploymentSource = (spine: Pick<Spine, "deployment_nodes" | "deployment_links">): string => {
  const nodes = spine.deployment_nodes ?? []
  const { roots, children } = rootsAndChildren(nodes)
  const lines: string[] = []
  const emit = (n: DeploymentNode, depth: number): void => {
    const pad = "  ".repeat(depth)
    const inner = children.get(n.id) ?? []
    const components = n.components.map(clean).filter((c) => c !== "")
    const artifacts = n.artifacts.map(clean).filter((a) => a !== "")
    // QLHS 11/11 bug #14: mô tả nút (dòng chữ phụ dưới tên) = dòng thứ hai in nghiêng, không vẽ thành component
    const description = clean(n.description).replace(/[<>\\]/g, "")
    const title = `${clean(n.name) || n.id}${description ? `\\n<i>${description}</i>` : ""}`
    const head = `${pad}node "${title}"${STEREOTYPE[n.kind]} as ${alias(n.id)}`
    if (inner.length === 0 && components.length === 0 && artifacts.length === 0) {
      lines.push(head)
      return
    }
    lines.push(`${head} {`)
    components.forEach((c, i) => lines.push(`${pad}  component "${c}" as ${alias(n.id)}_C${i + 1}`))
    artifacts.forEach((a, i) => lines.push(`${pad}  artifact "${a}" as ${alias(n.id)}_A${i + 1}`))
    for (const child of inner) emit(child, depth + 1)
    lines.push(`${pad}}`)
  }
  for (const n of roots) emit(n, 0)
  const known = new Set(nodes.map((n) => n.id))
  const seen = new Set<string>()
  for (const l of spine.deployment_links ?? []) {
    const key = [l.from, l.to].sort().join("|")
    if (l.from === l.to || !known.has(l.from) || !known.has(l.to) || seen.has(key)) continue
    seen.add(key)
    const protocol = clean(l.protocol)
    lines.push(`${alias(l.from)} -- ${alias(l.to)}${protocol ? ` : ${protocol}` : ""}`)
  }
  return puml("@startuml", [...THEME, ...lines], "@enduml")
}

export const renderDeployment: Renderer = (spine, _ownerId, _labels = DIAGRAM_LABELS.en): RenderedPart[] =>
  (spine.deployment_nodes ?? []).length === 0
    ? []
    : [{ kind: "deployment", section: DEPLOYMENT_SECTION, owner_kind: null, owner_id: null, format: "puml", source: deploymentSource(spine) }]
