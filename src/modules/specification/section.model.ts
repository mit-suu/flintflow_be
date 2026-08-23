import mongoose, { Schema, Document } from "mongoose"

export type SectionType =
  // Phase 2
  | "vision_problem"
  | "business_goals"
  | "value_proposition"
  | "high_level_business_rules"
  | "stakeholders"
  | "user_journey"
  | "use_case_spec"
  // Phase 3
  | "screen_flow"
  | "screen_description"
  | "rbac"
  | "non_screen_functions"
  | "erd"
  | "functional_requirements"
  | "user_story"
  | "acceptance_criteria"
  | "priority_ranking"
  | "scope_out_of_scope"
  // Phase 4
  | "external_interfaces"
  | "non_functional_requirements"
  | "common_business_rules"
  | "common_requirements"
  | "application_messages"
  | "assumptions_risks"
  | "glossary"
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
        // Phase 2
        "vision_problem",
        "business_goals",
        "value_proposition",
        "high_level_business_rules",
        "stakeholders",
        "user_journey",
        "use_case_spec",
        // Phase 3
        "screen_flow",
        "screen_description",
        "rbac",
        "non_screen_functions",
        "erd",
        "functional_requirements",
        "user_story",
        "acceptance_criteria",
        "priority_ranking",
        "scope_out_of_scope",
        // Phase 4
        "external_interfaces",
        "non_functional_requirements",
        "common_business_rules",
        "common_requirements",
        "application_messages",
        "assumptions_risks",
        "glossary",
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
