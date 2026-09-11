/**
 * diagram-references.ts
 * ─────────────────────────────────────────────────────────────────
 * Helper module that reads diagram-skill reference files from disk
 * and formats them for injection into LLM prompts.
 *
 * Files are read from: assets/diagram-skill/diagram/
 */

import fs from "node:fs"
import path from "node:path"
import { getDiagramSkillDir } from "../../config/paths.js"

// Resolve qua getAssetsRoot() thay vì __dirname: `tsc` không emit file .md/.png,
// nên đường dẫn theo __dirname trỏ vào dist/ — một thư mục chưa bao giờ tồn tại.
// Đây là cùng một lớp bug với prompt asset (xem src/config/paths.ts).
const DIAGRAM_SKILL_DIR = getDiagramSkillDir()

// ─── Diagram type → playbook file mapping ────────────────────────

const PLAYBOOK_MAP: Record<string, string> = {
  flowchart: "playbooks/flowchart.md",
  architecture: "playbooks/architecture.md",
  "sequence-timeline": "playbooks/sequence-timeline.md",
  hierarchy: "playbooks/hierarchy.md"
}

// ─── Diagram type → example file mapping ─────────────────────────

const EXAMPLE_MAP: Record<string, string> = {
  flowchart: "examples/flowchart-approval.excalidraw",
  architecture: "examples/architecture-pipeline.excalidraw",
  "sequence-timeline": "examples/timeline-protocol.excalidraw",
  hierarchy: "examples/mindmap-hierarchy.excalidraw"
}

// ─── Reference files always included ─────────────────────────────

const CORE_REFERENCES = [
  "references/json-schema.md",
  "references/element-templates.md",
  "references/color-palette.md",
  "references/binding.md"
]

// ─── File reading helpers ────────────────────────────────────────

function readSkillFile(relativePath: string): string {
  const fullPath = path.join(DIAGRAM_SKILL_DIR, relativePath)
  if (!fs.existsSync(fullPath)) {
    console.warn(`[DiagramReferences] File not found: ${fullPath}`)
    return ""
  }
  return fs.readFileSync(fullPath, "utf-8")
}

/**
 * Load the playbook content for a specific diagram type
 */
export function loadPlaybookContent(diagramType: string): string {
  const playbookFile = PLAYBOOK_MAP[diagramType]
  if (!playbookFile) {
    console.warn(`[DiagramReferences] Unknown diagram type: ${diagramType}, using flowchart`)
    return readSkillFile(PLAYBOOK_MAP.flowchart)
  }
  return readSkillFile(playbookFile)
}

/**
 * Load a worked example JSON for a specific diagram type.
 * Truncates to first ~50 elements to keep token count manageable.
 */
export function loadExampleJson(diagramType: string): string {
  const exampleFile = EXAMPLE_MAP[diagramType]
  if (!exampleFile) return ""

  const content = readSkillFile(exampleFile)
  if (!content) return ""

  try {
    const parsed = JSON.parse(content)
    // Take only first 8 elements as a representative sample to save tokens
    const sampleElements = (parsed.elements || []).slice(0, 8)
    const sample = {
      type: parsed.type,
      version: parsed.version,
      appState: parsed.appState,
      elements: sampleElements,
      _note: `(Showing ${sampleElements.length} of ${(parsed.elements || []).length} elements as reference)`
    }
    return JSON.stringify(sample, null, 2)
  } catch {
    // If JSON parse fails, return first 2000 chars as-is
    return content.substring(0, 2000) + "\n...(truncated)"
  }
}

/**
 * Load a specific reference file by name
 */
export function loadReferenceContent(name: string): string {
  return readSkillFile(`references/${name}`)
}

/**
 * Build the complete system reference string to inject into the diagram_generate prompt.
 * Combines the selected playbook + core reference files.
 *
 * This is injected via the {{system_reference}} placeholder.
 */
export function buildSystemReference(diagramType: string): string {
  const sections: string[] = []

  // 1. Playbook for the specific diagram type
  const playbook = loadPlaybookContent(diagramType)
  if (playbook) {
    sections.push(`### PLAYBOOK CHO LOẠI SƠ ĐỒ: ${diagramType.toUpperCase()}\n\n${playbook}`)
  }

  // 2. Core references (condensed)
  for (const refFile of CORE_REFERENCES) {
    const content = readSkillFile(refFile)
    if (content) {
      const fileName = path.basename(refFile, ".md")
      sections.push(`### REFERENCE: ${fileName.toUpperCase()}\n\n${content}`)
    }
  }

  // 3. Worked example (small sample)
  const example = loadExampleJson(diagramType)
  if (example) {
    sections.push(`### WORKED EXAMPLE JSON (mẫu tham khảo — cấu trúc đúng format):\n\n\`\`\`json\n${example}\n\`\`\``)
  }

  return sections.join("\n\n---\n\n")
}

/**
 * Check if the diagram-skill directory exists and has required files
 */
export function isDiagramSkillAvailable(): boolean {
  return fs.existsSync(DIAGRAM_SKILL_DIR) && fs.existsSync(path.join(DIAGRAM_SKILL_DIR, "SKILL.md"))
}
