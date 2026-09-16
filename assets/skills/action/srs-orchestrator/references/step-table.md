# Step table — source: Product-Brief-to-SRS-Phases.md §6.4

Count: Brief 13 · SRS 38 fixed + 5 × N = **51 fixed + 5 × N**. N = 1 → 56 · N = 20 → 151.

## Brief

| Step | Name | Content skill |
| --- | --- | --- |
| B-0.1 | Brain Dump | product-brief |
| B-0.2 | Form-Factor | product-brief |
| B-0.3 | Stakes | product-brief |
| B-0.4 | Working Mode | product-brief |
| B-1.1 | Product Vision, Problem & Opportunity | product-brief |
| B-1.2 | Target Users & Jobs-to-be-Done | product-brief |
| B-1.3 | Value Proposition & Differentiation | product-brief |
| B-1.4 | MVP Scope & Feature Hypotheses | product-brief |
| B-1.5 | Success Metrics & Learning Goals | product-brief |
| B-1.6 | Risks, Assumptions & Open Questions | product-brief |
| B-2.1 | Assumption Sweep | product-brief |
| B-2.2 | Addendum Triage | product-brief |
| B-2.3 | Three-Lens Review → Approve (UC 2.5) | product-brief |

## SRS

| Step | Name | Section | Content / renderer skill | Model call |
| --- | --- | --- | --- | :---: |
| S-1.1 | Brief Extraction | — | project-classifier | ✔ |
| S-1.2 | Project Classification | — | project-classifier | ✔ |
| S-1.3 | Conflict & Assumption Review | — | project-classifier | ✔ |
| S-1.4 | Gap List | — | project-classifier | ✔ |
| S-2.1 | Product Overview | fixed:1 | product-overview | ✔ |
| S-2.2 | Release 1.0 Scope | fixed:1 | product-overview | ✔ |
| S-2.3 | External Systems | fixed:1 | product-overview | ✔ |
| S-2.4 | High-Level Business Rules | fixed:1 | high-level-rules | ✔ |
| S-2.5 | System Context Diagram | fixed:1 | renderer/context | ✔ |
| S-3.1 | Actors | fixed:2.1 | actors-and-usecases | ✔ |
| S-3.2 | Actor–Goal List | fixed:2.2.2 | actors-and-usecases | ✔ |
| S-3.3 | Missing Use Case Sweep | fixed:2.2.2 | actors-and-usecases | ✔ |
| S-3.4 | Use Case Relationships | fixed:2.2.2 | actors-and-usecases | ✔ |
| S-3.5 | Use Case Descriptions | fixed:2.2.2 | actors-and-usecases | ✔ |
| S-3.6 | Use Case Diagram | fixed:2.2.1 | renderer/usecase | ✔ |
| S-4.1 | Screen Inventory — fixes N and screen_queue | fixed:3.1.2 | screens-and-flow | ✔ |
| S-4.2 | Screens Flow | fixed:3.1.1 | screens-and-flow + renderer/screen-flow | ✔ |
| S-4.3 | Screen Authorization | fixed:3.1.3 | authorization-matrix | ✔ |
| S-4.4 | Non-Screen Functions | fixed:3.1.4 | non-screen-functions | ✔ |
| S-4.5 | Entity Relationship Diagram | fixed:3.1.5 | entities-erd + renderer/erd | ✔ |
| S-5.1@X | Screen Queue | — | (orchestrator) | ✘ |
| S-5.2@X | Trigger & Description | function:* | function-detail | ✔ |
| S-5.3@X | Screen Layout (core screens only) | function:<primary> | renderer/screen-layout | ✔ |
| S-5.4@X | Function Details (≤ 6 functions per call) | function:* | function-detail | ✔ |
| S-5.5@X | Screen Sign-off | — | (gate-check) | ✘ |
| S-6.1 | External Interfaces | fixed:4.1 | nfr-quality-attributes | ✔ |
| S-6.2 | Usability | fixed:4.2.1 | nfr-quality-attributes | ✔ |
| S-6.3 | Reliability — must have numbers | fixed:4.2.2 | nfr-quality-attributes | ✔ |
| S-6.4 | Performance — must have numbers | fixed:4.2.3 | nfr-quality-attributes | ✔ |
| S-6.5 | Domain-Specific Attributes | fixed:4.2.4 | nfr-quality-attributes | ✔ |
| S-7.1 | Business Rules (from validations[kind=business]) | fixed:5.1 | appendix-content | ✔ |
| S-7.2 | Common Requirements | fixed:5.2 | appendix-content | ✔ |
| S-7.3 | Application Messages (from abnormal[]) | fixed:5.3 | appendix-content | ✔ |
| S-7.4 | Other Requirements | fixed:5.4 | appendix-content | ✔ |
| S-8.1 | Glossary | fixed:5.5 | glossary (glossary_scan) | ✔ |
| S-8.2 | Document Assembly | all | output/assemble-srs | ✘ |
| S-8.3 | Record of Changes | fixed:I | output/assemble-srs | ✘ |
| S-8.4 | Consistency Pass | all | deterministic-check + review-section (consistency_pass) | ✔ |
| S-9.1 | Completeness & Assumption Sweep | — | output/srs-completeness-score | ✘ |
| S-9.2 | Quality Lens Run → yellow flags | — | review-section | ✔ |
| S-9.3 | Business Goal Validation | — | review-section | ✔ |
| S-9.4 | Requirement Prioritization | — | (T19) | ✔ |
| S-9.5 | Baseline Sign-off | — | deterministic-check | ✘ |
