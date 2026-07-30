import mongoose, { Schema, Document } from "mongoose"

export type SectionType =
  | "business_goals"
  | "stakeholders"
  | "vision_problem"
  | "value_proposition"
  | "user_journey"
  | "functional_requirements"
  | "non_functional_requirements"
  | "rbac"
  | "priority_ranking"
  | "scope_out_of_scope"
  | "assumptions_risks"
  | "acceptance_criteria"
  | "user_story"
  | "use_case_spec"
  | "success_metrics"

export type SectionStatus = "draft" | "accepted" | "edited_manually" | "regenerated"
export type SectionSourceType = "ai_generated" | "user_edited"

export interface ISection extends Document {
  projectId: mongoose.Types.ObjectId
  type: SectionType
  content: any // Schema.Types.Mixed
  status: SectionStatus
  sourceType: SectionSourceType
  order: number
  createdAt: Date
  updatedAt: Date
}

const sectionSchema = new Schema<ISection>(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
      index: true
    },
    type: {
      type: String,
      enum: [
        "business_goals",
        "stakeholders",
        "vision_problem",
        "value_proposition",
        "user_journey",
        "functional_requirements",
        "non_functional_requirements",
        "rbac",
        "priority_ranking",
        "scope_out_of_scope",
        "assumptions_risks",
        "acceptance_criteria",
        "user_story",
        "use_case_spec",
        "success_metrics"
      ],
      required: true
    },
    content: {
      type: Schema.Types.Mixed,
      required: true
    },
    status: {
      type: String,
      enum: ["draft", "accepted", "edited_manually", "regenerated"],
      default: "draft"
    },
    sourceType: {
      type: String,
      enum: ["ai_generated", "user_edited"],
      default: "ai_generated"
    },
    order: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
)

// Unique compound index per project and section type
sectionSchema.index({ projectId: 1, type: 1 }, { unique: true })

export const Section = mongoose.model<ISection>("Section", sectionSchema)
