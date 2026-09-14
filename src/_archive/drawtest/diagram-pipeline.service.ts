/**
 * diagram-pipeline.service.ts
 * ─────────────────────────────────────────────────────────────────
 * Multi-step AI Diagram Pipeline orchestrator.
 *
 * Step 1: Classify diagram type & plan layout (diagram_classify)
 * Step 2: Generate Excalidraw JSON elements using playbook context (diagram_generate)
 *
 * This service replaces the single-shot generate_diagram action with
 * a richer pipeline that leverages diagram-skill knowledge.
 */

import { executeAiAction, ExecuteAiActionOptions } from "../../shared/ai/ai-action.service.js"
import { ActionType, AiActionError } from "../../shared/ai/ai-action.types.js"
import { buildSystemReference, isDiagramSkillAvailable } from "./diagram-references.js"

// ─── Types ───────────────────────────────────────────────────────

export interface DiagramClassification {
  diagramType: "flowchart" | "architecture" | "sequence-timeline" | "hierarchy"
  depth: "simple" | "comprehensive"
  layoutDirection: "TD" | "LR" | "radial"
  planSummary: string
  elements?: string[]
  colorMapping?: Record<string, string>
}

export interface DiagramPipelineResult {
  success: boolean
  explanation: string
  excalidrawElements: any[]
  appState: {
    viewBackgroundColor: string
    gridSize: number
  }
  diagramType: string
  classification: DiagramClassification
  /** Combined token usage from all steps */
  tokensUsed: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  latencyMs: number
  /** Combined cost of all steps */
  totalCost: number
  /** Log IDs from each step */
  logIds: string[]
}

// ─── Main Pipeline ───────────────────────────────────────────────

export async function executeDiagramPipeline(
  userPrompt: string,
  projectId: string | undefined,
  userId: string,
  options: ExecuteAiActionOptions = {}
): Promise<DiagramPipelineResult> {
  const pipelineStart = Date.now()

  // Verify diagram-skill files exist
  if (!isDiagramSkillAvailable()) {
    throw new AiActionError(
      500,
      "Diagram skill reference files not found. Ensure diagram-skill directory exists in src/scripts/prompts/",
      "DIAGRAM_SKILL_MISSING"
    )
  }

  // ─── Step 1: Classify & Plan ─────────────────────────────────
  console.log("[DiagramPipeline] Step 1: Classifying diagram type...")

  const classifyResult = await executeAiAction<DiagramClassification>(
    ActionType.DIAGRAM_CLASSIFY,
    {
      promptVariables: { input_text: userPrompt }
    },
    projectId,
    userId,
    options
  )

  const classification = classifyResult.data
  console.log(
    `[DiagramPipeline] Classification: type=${classification.diagramType}, depth=${classification.depth}, layout=${classification.layoutDirection}`
  )

  // ─── Step 2: Build system reference from diagram-skill ───────
  console.log(`[DiagramPipeline] Step 2: Loading playbook for ${classification.diagramType}...`)

  const systemReference = buildSystemReference(classification.diagramType)

  // ─── Step 3: Generate Excalidraw JSON ────────────────────────
  console.log("[DiagramPipeline] Step 3: Generating Excalidraw JSON elements...")

  const generateResult = await executeAiAction<{
    explanation?: string
    excalidrawElements: any[]
    appState?: { viewBackgroundColor?: string; gridSize?: number }
  }>(
    ActionType.DIAGRAM_GENERATE,
    {
      promptVariables: {
        input_text: userPrompt,
        classification_plan: JSON.stringify(classification, null, 2),
        system_reference: systemReference
      }
    },
    projectId,
    userId,
    options
  )

  // ─── Step 4: Post-process & validate ─────────────────────────
  console.log("[DiagramPipeline] Step 4: Validating and post-processing...")

  const rawElements = generateResult.data.excalidrawElements || []
  const validatedElements = postProcessElements(rawElements)

  // ─── Aggregate results ───────────────────────────────────────
  const totalLatency = Date.now() - pipelineStart

  return {
    success: true,
    explanation: generateResult.data.explanation || classification.planSummary,
    excalidrawElements: validatedElements,
    appState: {
      viewBackgroundColor: generateResult.data.appState?.viewBackgroundColor || "#ffffff",
      gridSize: generateResult.data.appState?.gridSize || 20
    },
    diagramType: classification.diagramType,
    classification,
    tokensUsed: {
      promptTokens: classifyResult.tokensUsed.promptTokens + generateResult.tokensUsed.promptTokens,
      completionTokens: classifyResult.tokensUsed.completionTokens + generateResult.tokensUsed.completionTokens,
      totalTokens: classifyResult.tokensUsed.totalTokens + generateResult.tokensUsed.totalTokens
    },
    latencyMs: totalLatency,
    totalCost: classifyResult.cost + generateResult.cost,
    logIds: [classifyResult.logId, generateResult.logId]
  }
}

// ─── Post-processing helpers ─────────────────────────────────────

/**
 * Post-process Excalidraw elements:
 * 1. Ensure unique IDs
 * 2. Fill in missing default properties
 * 3. Basic binding validation (warn only, don't reject)
 */
function postProcessElements(elements: any[]): any[] {
  if (!Array.isArray(elements) || elements.length === 0) {
    return elements
  }

  const seenIds = new Set<string>()
  let seedCounter = 100000

  return elements.map((el, index) => {
    // Ensure unique ID
    if (!el.id || seenIds.has(el.id)) {
      el.id = `auto_${el.type || "elem"}_${index}_${Date.now()}`
    }
    seenIds.add(el.id)

    // Fill in missing defaults
    el.version = el.version ?? 1
    el.versionNonce = el.versionNonce ?? ++seedCounter
    el.isDeleted = el.isDeleted ?? false
    el.groupIds = el.groupIds ?? []
    el.link = el.link ?? null
    el.locked = el.locked ?? false
    el.angle = el.angle ?? 0
    el.seed = el.seed ?? ++seedCounter
    el.roughness = el.roughness ?? 0
    el.opacity = el.opacity ?? 100
    el.strokeWidth = el.strokeWidth ?? 1.5
    el.strokeStyle = el.strokeStyle ?? "solid"
    el.fillStyle = el.fillStyle ?? "solid"

    // Text-specific defaults
    if (el.type === "text") {
      el.fontFamily = el.fontFamily ?? 2
      el.fontSize = el.fontSize ?? 16
      el.textAlign = el.textAlign ?? "center"
      el.verticalAlign = el.verticalAlign ?? "middle"
      el.lineHeight = el.lineHeight ?? 1.25
      el.originalText = el.originalText ?? el.text ?? ""
    }

    // Arrow-specific defaults
    if (el.type === "arrow") {
      el.points = el.points ?? [[0, 0], [100, 0]]
      el.startArrowhead = el.startArrowhead ?? null
      el.endArrowhead = el.endArrowhead ?? "arrow"
    }

    return el
  })
}

/**
 * Validate two-way bindings between arrows and boxes.
 * Returns warnings but does not reject elements.
 * (Logging only — detached arrows still render, just don't stay attached on drag)
 */
export function validateBindings(elements: any[]): string[] {
  const warnings: string[] = []
  const elementMap = new Map<string, any>()

  for (const el of elements) {
    elementMap.set(el.id, el)
  }

  for (const el of elements) {
    if (el.type === "arrow") {
      // Check startBinding
      if (el.startBinding?.elementId) {
        const sourceBox = elementMap.get(el.startBinding.elementId)
        if (!sourceBox) {
          warnings.push(`Arrow "${el.id}": startBinding references non-existent element "${el.startBinding.elementId}"`)
        } else if (sourceBox.boundElements) {
          const hasBackRef = sourceBox.boundElements.some(
            (be: any) => be.id === el.id && be.type === "arrow"
          )
          if (!hasBackRef) {
            warnings.push(
              `Arrow "${el.id}": source box "${sourceBox.id}" missing back-reference in boundElements`
            )
          }
        }
      }

      // Check endBinding
      if (el.endBinding?.elementId) {
        const targetBox = elementMap.get(el.endBinding.elementId)
        if (!targetBox) {
          warnings.push(`Arrow "${el.id}": endBinding references non-existent element "${el.endBinding.elementId}"`)
        } else if (targetBox.boundElements) {
          const hasBackRef = targetBox.boundElements.some(
            (be: any) => be.id === el.id && be.type === "arrow"
          )
          if (!hasBackRef) {
            warnings.push(
              `Arrow "${el.id}": target box "${targetBox.id}" missing back-reference in boundElements`
            )
          }
        }
      }
    }
  }

  if (warnings.length > 0) {
    console.warn(`[DiagramPipeline] Binding warnings (${warnings.length}):`)
    for (const w of warnings) {
      console.warn(`  - ${w}`)
    }
  }

  return warnings
}
