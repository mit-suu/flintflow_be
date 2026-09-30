# Task 20 — Discovery B-0 → B-2 + S-1 qua step runner (BE + FE)

**Wave:** 4 · **Người phụ trách:** D · **Effort:** 9 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Đưa Product Brief về đúng Phases §5: 13 step (B-0 4 step, B-1 6 step, B-2 3 step) + S-1 (4 step mềm) chạy qua step runner, ghi `project{}`, `addendum[]`, `assumptions[]`, `other_requirements[]` bằng op; gate do user, không do LLM tự đánh giá; approve mở S-2. FE refit chat pane theo mô hình step.

## Lệch hướng audit cần đóng
B2 (chỉ 6 step B-1, LLM tự quyết hoàn thành, Brief chỉ nằm trong JSON tin nhắn), B3 (không có S-1), E4 phần Discovery, một phần A8 (form_factor/stakes/working_mode).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/Product-Brief-to-SRS-Phases.md` §5.1–5.4, §6.4 (S-1.x); `assets/prompts/chat_discovery.md` (nội dung 6 step đúng, tái dùng); `modules/pipeline/*` (T11, T13); `assets/skills/content/project-classifier` (T14, S-1.2).
- Sửa: `flintflow_be/src/modules/project/chat-session.service.ts` (bỏ nhánh `CHAT_DISCOVERY` + `buildCompletedStepsSummary`; tin nhắn trong session pipeline khi step B-* đang Elicit chuyển vào `POST /steps/:id/answer`).
- Sửa: `flintflow_be/src/modules/pipeline/step-runner.service.ts` (Fast path B-*: gộp câu hỏi ≤ 2 lượt/phase; B-2.1 duyệt lô theo `target_section`, vẫn duyệt lẻ giả định chạm bất biến hoặc nuôi §4.2.2/§4.2.3).
- Gỡ khỏi route: `POST /specifications/projects/:id/advance-to-generation` (xoá file T21).
- Sửa FE: `flintflow_fe/app/projects/[projectId]/_components/{ChatPane.tsx, DiscoveryStepBar.tsx, SummaryReviewCard.tsx, StepTransitionBanner.tsx, ChatBubble.tsx}`: bỏ `lastEvaluation`, `latestAiQuestions` regex, `discoverySummaryData` map cứng, `completedSteps` parse transcript; dữ liệu từ `useProgress`/`useSpine`; DiscoveryStepBar thay bằng `StepProgressBar` (T12) cho B-*; SummaryReviewCard hiển thị `project{}` + addendum nhóm theo `target_section` từ Spine; StepTransitionBanner thay bằng GateCard; ChatBubble bỏ `parseAiMessage` 4 tầng (BE trả `reply` sạch qua SSE).
- Sửa FE: `flintflow_fe/lib/constants/section-types.ts` `DISCOVERY_STEPS` lấy từ step registry (giữ `sampleQuestions` chuyển vào skill).
### Tạo mới / điền
- `assets/skills/content/product-brief/` với `references/{b0-intake.md, b1-steps.md, b2-finalize.md, three-lens.md}` và `assets/brief-template.md` (BMAD, giữ notice): B-0.1 Brain Dump (đọc tài liệu upload qua `document-context`, bóc tách, tóm tắt xác nhận, ghi `addendum[]` ngay), B-0.2 `project.form_factor`, B-0.3 `project.stakes`, B-0.4 `project.working_mode`; B-1.1 ghi `project.vision`, `project.goals[]`, addendum problem; B-1.2 addendum personas/JTBD/stakeholders (`target_section: fixed:2.1`); B-1.3 addendum value prop (`fixed:1`); B-1.4 addendum MVP scope/feature hypotheses (`fixed:1`, `fixed:3.1.2`); B-1.5 addendum metrics (`fixed:4.2.x`); B-1.6 `other_requirements[kind=risk|assumption|open_question]` + `assumptions[]`; B-2.1 Assumption Sweep; B-2.2 Addendum Triage (giữ/để dành/bỏ); B-2.3 Three-Lens (Skeptic/Opportunity/Contextual, tự định nghĩa) rồi gate Approve (UC 2.5) mở S-1.
- `assets/skills/content/brief-analysis/` (S-1.1 Brief Extraction: B-1 thành `project` + addendum cấu trúc; S-1.3 Conflict & Assumption Review: trình `assumptions[]`/xung đột cho user; S-1.4 Gap List: addendum `kind=gap`).
- `fixtures/op-cases/b0-s1/*.json`; `flintflow_be/src/modules/pipeline/skills/brief.e2e.test.ts` (project trống đi B-0.1 … S-1.4).
- FE: `_components/AssumptionSweepPanel.tsx` (B-2.1 duyệt lẻ/lô), `_components/AddendumTriagePanel.tsx` (B-2.2), `_components/BriefSummaryCard.tsx` (thay SummaryReviewCard).

## Các bước implement
1. Skill product-brief (tái dùng nội dung chat_discovery) + brief-analysis.
2. Runner: Fast/Coaching cho B-*, B-2.1 duyệt lô, approve B-2.3 mở S-1.
3. Gỡ CHAT_DISCOVERY khỏi chat-session; gỡ advance-to-generation.
4. FE refit (xoá parse transcript), 3 panel mới.
5. E2E mock + `E2E_AI=1`; tạo project mới trên dev đi trọn B-0 đến S-1.4 rồi S-2.1.

## Dependency
- Phụ thuộc: T11, T13, T12, T14 (project-classifier).
- Chặn: T21, T23, M4.
- Chạy song song với: T17, T18, T19.

## Output kỳ vọng
- Discovery đúng 13 + 4 step, ghi Spine; FE không còn suy state từ JSON tin nhắn.

## Tiêu chí hoàn thành (DoD)
- [ ] Project mới đi B-0.1 … B-2.3 rồi S-1.4 chạy trọn; `project{vision,goals,form_factor,stakes,working_mode}` và `addendum[]` ≥ 5, `assumptions[]` ≥ 2 được ghi.
- [ ] Fast path: ≤ 2 lượt hỏi mỗi phase; Coaching: mỗi step ≥ 1 lượt và gate riêng.
- [ ] `grep -n "evaluation" flintflow_fe/app/projects` rỗng.
- [ ] Approve B-2.3 đặt `progress.current_phase=S-1`; S-1.4 accepted mở S-2.1.

## Ghi chú / rủi ro
- Câu trả lời Elicit giữ trong transcript session pipeline và tái dùng khi Regenerate (Phases §4.4).
