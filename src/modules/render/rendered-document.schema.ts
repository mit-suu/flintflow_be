import { z } from "zod"
import type { RenderedDocument } from "./rendered-document.types.js"

const inlineRunSchema = z.strictObject({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  code: z.boolean().optional()
})

const runsSchema = z.array(inlineRunSchema)
const levelSchema = z.number().int().min(1).max(6)

const blockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("paragraph"), runs: runsSchema }),
  z.strictObject({ type: z.literal("heading"), level: levelSchema, text: z.string() }),
  z.strictObject({ type: z.literal("bullet_list"), items: z.array(runsSchema) }),
  z.strictObject({ type: z.literal("numbered_list"), items: z.array(runsSchema) }),
  z.strictObject({
    type: z.literal("table"),
    header: z.array(runsSchema).min(1),
    rows: z.array(z.array(runsSchema))
  }),
  z.strictObject({
    type: z.literal("image"),
    png: z.union([z.string().min(1), z.custom<Buffer>((value) => Buffer.isBuffer(value))]),
    caption: z.string().optional()
  }),
  z.strictObject({ type: z.literal("page_break") })
])

const flagRowSchema = z.strictObject({
  id: z.string(),
  rule_id: z.string(),
  section: z.string(),
  message: z.string(),
  waive_reason: z.string().nullable().optional()
})

export const renderedDocumentSchema = z
  .strictObject({
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    version: z.string().min(1),
    source: z.enum(["draft", "baseline"]),
    watermark: z.literal("DRAFT").optional(),
    generatedAt: z.iso.datetime({ offset: true }),
    sections: z.array(
      z.strictObject({
        id: z.string().min(1),
        number: z.string(),
        heading: z.string().min(1),
        level: levelSchema,
        status: z.enum(["draft", "accepted", "stale", "derived"]).optional(),
        awaiting_reaccept: z.boolean().optional(),
        blocks: z.array(blockSchema)
      })
    ),
    recordOfChanges: z.array(
      z.strictObject({
        date: z.string(),
        version: z.string(),
        change_type: z.enum(["A", "M", "D"]),
        in_charge: z.string(),
        description: z.string()
      })
    ),
    flagsAppendix: z
      .strictObject({
        redOpen: z.array(flagRowSchema),
        staleCount: z.number().int().min(0),
        waived: z.array(flagRowSchema)
      })
      .optional()
  })
  .superRefine((doc, ctx) => {
    // Phases §6.5: Working Draft luôn có watermark, bản baseline là bản sạch
    if (doc.source === "draft" && doc.watermark !== "DRAFT") {
      ctx.addIssue({ code: "custom", path: ["watermark"], message: 'source "draft" requires watermark "DRAFT"' })
    }
    if (doc.source === "baseline" && doc.watermark !== undefined) {
      ctx.addIssue({ code: "custom", path: ["watermark"], message: 'source "baseline" must not have a watermark' })
    }
  })

// Kiểm compile-time: schema và types không được trôi khỏi nhau
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const schemaMatchesTypes: Equals<z.infer<typeof renderedDocumentSchema>, RenderedDocument> = true
void schemaMatchesTypes
