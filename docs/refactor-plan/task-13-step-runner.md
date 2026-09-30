# Task 13 — Step runner / orchestrator + gate + meter + resume

**Wave:** 3 · **Người phụ trách:** A · **Effort:** 10 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [x] Xong (2026-09-15, nhánh `wave3/review`; 2 DoD chờ contract-change / XREQ T04 — xem `flintflow/plans/reports/t13-report-260915-step-runner.md`)

## Mục tiêu
Khung hành động dùng chung cho 12 phase (Phases §3): Intake, Elicit, Draft, Render, Review, Gate, Meter; trần 8 lượt/step, 3 Regenerate/step; Fast/Coaching; resume ở mức step; đúng một session pipeline; reserve credit theo lượt.

## Lệch hướng audit cần đóng
B1 (không có step), B4 (gate), B6 (sinh tuần tự trong khung step), B7 (khoá cứng section accepted, thay bằng quay lại step), E4 (session nào cũng generate được), E1 phần usage theo step.

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `modules/spine/op-engine.ts` (T08), `modules/spine/flags.service.ts`, `section-status.ts` (T09), `modules/pipeline/{context-projection.ts, draft-to-ops.ts}` (T11), `modules/pipeline/step-registry.ts` (T12), `modules/diagram/diagram.service.ts` (T10), `shared/ai/credit-reservation.service.ts` (T04), `modules/spine/usage.model.ts` (T01), `pipeline.dto.ts` (T08).
- Sửa: `flintflow_be/src/modules/project/chat-session.service.ts` (`createChatSession` không tắt session khác; giữ đúng một `is_pipeline`; `deleteChatSession` promote session gần nhất; `sendMessage*` với session không pipeline chỉ cho `CHAT` hỏi đáp và `/changes`).
- Sửa: `flintflow_be/src/modules/notification/notification.service.ts` (T04) — gọi `notify` khi phase accepted.
- Sửa: `flintflow_be/src/app.ts` mount `/api/v1/projects/:projectId/steps`.
### Tạo mới
- `flintflow_be/src/modules/pipeline/step-runner.service.ts` — `runStep(projectId, stepId, sessionId, userId, emit)`: kiểm `is_pipeline`; `steps[id].status=in_progress`, `first_seq=nextSeq`; Intake (lần đầu phase: skill `phase-intake` liệt kê field trống, đọc addendum; ghi `progress.current_phase`); Elicit (skill `elicit-loop`: Fast gom ≤ 2 lượt/phase, đếm `elicit_turns_this_phase`; Coaching mỗi step ≥ 1 lượt; câu hỏi phát sự kiện `answer_needed`, chờ `POST /answer`, câu trả lời lưu transcript session pipeline); Draft (T11 rồi `applyTransaction` với `base_version`, `step_id`); Render (mọi `renders[]` của step qua T10); Review (`flags.recompute`, LLM review tắt bằng `REVIEW_LLM_ENABLED=false`); phát `gate_ready`; Meter (mỗi lượt gọi model: `reserveCredit` trước, `usage[]` `state=reserved` rồi `deducted`/`refunded`; step `deterministic=true` không Meter). Đếm `calls_this_step` (trần 8: từ lượt 9 trả `CALL_LIMIT`, chỉ còn Accept/Accept as-is).
- `flintflow_be/src/modules/pipeline/gate.service.ts` — `gate(projectId, stepId, action, note, userId)`: `accept` (`status=accepted`, `accepted_at`, `last_seq`, reset counters, notify khi phase xong, S-5.5 đặt `detail_status=signed_off`), `revision` (ghi note vào transcript, chạy lại Draft với `{{revision_note}}`, ActionType `REVISION`), `regenerate` (đếm ≤ 3/step, S-5.4 theo function id; `revertRange(first_seq,last_seq)` rồi Draft lại), `accept_as_is` (chỉ khi hết Regenerate hoặc `revision` thất bại; ghi cờ vàng `accepted_as_is` với note). Quay lại step đã accepted: `status=revision_requested`, counters reset (B7).
- `flintflow_be/src/modules/pipeline/meter.service.ts` — wrap `reserve/deduct/release` + `usage[]`; conflict 409 thì refund không tiêu trần.
- `flintflow_be/src/modules/pipeline/resume.service.ts` — khi mở project: step `in_progress` thì `revertRange` và `status=pending`; trả `progress` để FE tiếp tục.
- `flintflow_be/src/modules/pipeline/pipeline.controller.ts` + `pipeline.route.ts` — `GET /steps`, `POST /steps/:stepId/run` (SSE), `POST /steps/:stepId/answer`, `POST /steps/:stepId/gate`, `GET /progress` (uỷ quyền T09 + `progress`), `POST /resume`.
- Điền `assets/skills/action/{srs-orchestrator, elicit-loop, gate-check, meter}/SKILL.md` phần còn thiếu.
- Test: `step-runner.test.ts` (mock provider trả op từ `fixtures/op-cases`), `gate.service.test.ts`, `resume.test.ts`.

## Các bước implement
1. `meter.service` + usage + test.
2. `step-runner` state machine với `emit` (SSE) và mock provider; test S-3.1 đến S-3.6 trên fixture minimal có actors sẵn.
3. `gate.service` 4 hành động + trần; test.
4. Resume + bất biến 7 trong chat-session.
5. Routes SSE (tái dùng cơ chế `sendMessageStream`), swagger.
6. Chạy qua FE mock-off với D (T12) trên môi trường dev.

## Dependency
- Phụ thuộc: T08, T09, T11, T12 (registry), T10, T04.
- Chặn: T14, T17, T18, T19, T20, T16 (nối thật).
- Chạy song song với: T14 (B bắt đầu bằng gọi service trực tiếp), T15, T16.

## Output kỳ vọng
- API pipeline hoạt động đúng contract với mock provider; FE T12 nối được.

## Tiêu chí hoàn thành (DoD)
- [x] S-3.1 đến S-3.6 chạy trọn qua API với mock provider; `steps[]`, `changes[]`, `usage[]` đúng. (`step-runner.test.ts`, `pipeline.controller.test.ts` — mức service + controller mock, chưa có supertest)
- [x] Regenerate lần 4 trả `REGENERATE_LIMIT`; lượt 9 trả `CALL_LIMIT`. (`gate.service.test.ts`)
- [ ] 2 tab: txn thứ hai 409, credit refund, không tiêu trần. (409 + không tiêu trần có test; ví thật chưa hoàn — chờ XREQ T04 `refundDeductedCredit`, `TODO(XREQ-local-1)` meter.service.ts)
- [x] Session không pipeline gọi `/run` trả 403 `NOT_PIPELINE_SESSION`.
- [ ] Đóng giữa Draft rồi `POST /resume` đưa Spine về trạng thái trước step. (`resume.test.ts` mức service; endpoint chưa mount — không có trong `pipeline-contract.md`, chờ PR contract-change)

## Ghi chú / rủi ro
- `[A]/[P]` Party Mode không làm (Phases §9.1).
- Giữ `chat.md` cho hỏi đáp tự do trong session không pipeline (audit §4 câu 8) — không sửa Spine.
