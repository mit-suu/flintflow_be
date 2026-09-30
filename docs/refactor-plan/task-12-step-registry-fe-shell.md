# Task 12 — Step registry (51 + 5×N) + FE workspace shell v2 theo contract (mock)

**Wave:** 2 · **Người phụ trách:** D · **Effort:** 13 điểm · **Trạng thái:** [ ] Chưa làm  [ ] Đang làm  [ ] Xong

## Mục tiêu
Khai báo toàn bộ step (Phases §6.4) làm nguồn sự thật chung BE/FE, và dựng lại workspace FE theo mô hình phase → step → gate trên hợp đồng API (T08) với mock server, để Wave 3 chỉ cần nối thật.

## Lệch hướng audit cần đóng
B1 (2 hệ phase, không có step), B4 (gate theo section, không Accept as-is, không giới hạn Regenerate), B6 phần FE (vòng lặp generate mọi section), C9 phần FE (progress theo section).

## File / module liên quan
### Hiện có (đọc / sửa / xoá)
- Đọc: `context/Product-Brief-to-SRS-Phases.md` §1.1, §3, §5, §6.4; `docs/api/pipeline-contract.md` (T08); `context/srs-spine.md` §4.
- Sửa: `flintflow_fe/app/projects/[projectId]/page.tsx` (tách state ra hooks; bỏ `handleGeneratePhase`, `handleStopGeneratePhase`, `completedBatchTypes`, `failedBatchTypes`, `PHASE_SECTION_MAP`, `handleApproveBaseline` cũ, `handleApproveSummary`; giữ chat, session, upload).
- Sửa: `flintflow_fe/app/projects/[projectId]/_components/{ChatPane.tsx, PhaseNavBar.tsx, WorkspaceHeader.tsx, DocumentPane.tsx}` (PhaseNavBar hiển thị 12 phase B-0…S-9 từ registry; ChatPane bỏ card batch-generate và card baseline; DocumentPane render từ `GET /spine` + section registry FE tạm bằng markdown do FE ghép, thay bằng `GET /document` ở T16).
- Ngừng dùng: `DraftReviewCard.tsx`, `GeneratingIndicator.tsx` (giữ file tới T21).
- Sửa: `flintflow_fe/lib/ai-stream.ts` thành `streamSse` dùng cho `POST /steps/:id/run`.
- Sửa: `flintflow_fe/lib/api/{pipeline.ts, spine.ts, flags.ts}` điền hàm theo contract.
### Tạo mới
- `flintflow_be/assets/step-registry.json` — mảng step: `{id, phase, phase_label_en, label_vi, label_en, kind: soft|fixed|loop|gate, reads[], writes[], renders[], uc[], deterministic, description}` cho B-0.1…B-2.3, S-1.1…S-9.5, mẫu `S-5.<n>@<screen_id>` và `S-5.<n>@nonscreen` (5 template).
- `flintflow_be/src/modules/pipeline/step-registry.ts` — load JSON, `getStep(id)`, `expandS5(spine)` (sinh step theo `screen_queue`), `phaseOf(stepId)`, `nextStep(spine)`, `totalSteps(spine)`; test đếm: N=1 cho 56, N=20 cho 151.
- `flintflow_fe/lib/constants/step-registry.ts` — import JSON qua script copy `npm run sync:registry` (copy file vào `flintflow_fe/lib/constants/step-registry.json`); test FE đếm giống BE.
- `flintflow_fe/mocks/{handlers.ts, browser.ts, server.ts}` — `msw` theo contract, dữ liệu từ fixture T02 (copy JSON vào `flintflow_fe/mocks/fixtures/`), bật bằng `NEXT_PUBLIC_API_MOCK=1`.
- `flintflow_fe/app/projects/[projectId]/hooks/{useWorkspace.ts, useStepRunner.ts, useSpine.ts, useProgress.ts}`.
- `flintflow_fe/app/projects/[projectId]/_components/{StepProgressBar.tsx, PhaseHeader.tsx, GateCard.tsx, ElicitPanel.tsx, ScreenQueuePanel.tsx, WorkingModeSelect.tsx, NamesGlossaryPanel.tsx, StepEventLog.tsx}`:
  - `StepProgressBar`: đếm step (`done/total`), ẩn % trước S-4.1, nhãn "Bước"; click step đã accepted để xem, không chạy.
  - `PhaseHeader`: phase hiện tại, menu `[C]` đổi `working_mode` (gọi `POST /changes` set `project.working_mode`), `[A]/[P]` disabled kèm tooltip "vòng sau".
  - `GateCard`: Accept · Request revision (ô ghi chú) · Regenerate (hiển thị `n/3`, tắt khi hết) · Accept as-is (chỉ hiện khi hết Regenerate hoặc revision không giải quyết, bắt buộc lý do); Fast path: một GateCard gộp cuối phase.
  - `ElicitPanel`: tái dùng `QuestionStepperInput`; gửi `POST /steps/:id/answer`.
  - `ScreenQueuePanel`: queue S-5, màn `pending/in_progress/signed_off/placeholder`, nút "Để lại (placeholder)".
  - `WorkingModeSelect`: B-0.4.
  - `NamesGlossaryPanel`: form sửa `actors[].name`, `entities[].name`, `screens[].name`, `glossary[]` gửi `POST /changes {ops}` (§2.3).
- `flintflow_fe/app/projects/[projectId]/_components/__tests__/{GateCard.test.tsx, StepProgressBar.test.tsx}`.

## Các bước implement
1. `step-registry.json` từ bảng §6.4 (đối chiếu số step); BE loader + test đếm; script sync sang FE.
2. `msw` handlers theo contract, dữ liệu fixture.
3. Hooks: `useSpine` (GET /spine, cache theo `spine_version`), `useProgress`, `useStepRunner` (SSE events thành máy trạng thái: idle, intake, eliciting, drafting, applied, rendering, gate_ready, needs_input, error).
4. Component mới; thay `page.tsx` bố cục: header · PhaseHeader · StepProgressBar · 3 pane (chat/elicit · document · verification).
5. Chạy trọn trên mock: chọn step, elicit, trả lời, draft stream, gate, progress đổi.
6. Test component; typecheck/lint.

## Dependency
- Phụ thuộc: T07, T08 (`pipeline-contract.md`, merge sớm).
- Chặn: T13 (dùng `step-registry.ts`), T11 (registry `reads/writes`), T16, T20.
- Chạy song song với: T08, T09, T10, T11.

## Output kỳ vọng
- `step-registry.json` được BE/FE dùng chung; workspace v2 chạy trên mock.

## Tiêu chí hoàn thành (DoD)
- [ ] Test đếm step: 56 với N=1, 151 với N=20 (BE và FE).
- [ ] Trên mock: đi từ S-3.1 đến S-3.6 với gate từng step; Regenerate lần 4 bị tắt; Accept as-is đòi lý do.
- [ ] Không còn gọi `POST /specifications/.../generate` trong FE.
- [ ] `npm run typecheck && lint && test` xanh.

## Ghi chú / rủi ro
- Contract có thể đổi trước M2; theo dõi PR `contract-change`.
- Merge `step-registry.json` sớm (ngày 1–3) vì T11 và T13 cần.
