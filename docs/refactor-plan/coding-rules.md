# FlintFlow — Coding Rules cho refactor theo plan (áp dụng cho người và AI agent)

> Mục đích: 4 người (hoặc 4 agent) làm song song trên cùng repo mà không dẫm lên nhau. Mọi task trong `task-XX-*.md` phải tuân thủ file này. Vi phạm = PR bị từ chối.
> Sau khi xong task, **bắt buộc** xuất báo cáo theo mẫu `task-report-template.md` và dán vào PR + cập nhật `plan-overview.md` mục 8.

## 0. Ba luật tối thượng

1. **Chỉ đụng file trong "vùng sở hữu" của task mình** (mục 2). File ngoài vùng: chỉ được đọc. Cần sửa thì đi theo mục 4 (yêu cầu chéo), không tự sửa.
2. **Không đổi hợp đồng đã đóng băng** (`spine.schema.ts`, `op.types.ts`, `pipeline.dto.ts`, `docs/api/pipeline-contract.md`, `assets/step-registry.json`, `rendered-document.types.ts`, `section-registry.ts` bảng §4) ngoài PR nhãn `contract-change` được 4/4 duyệt.
3. **Mọi thay đổi phải để lại dấu vết kiểm được**: test cho code mới, DoD tick trong file task, báo cáo theo mẫu. Không có báo cáo = task chưa xong.

## 1. Quy ước chung

- Nhánh: `develop` là gốc. Mỗi task một nhánh `feat/tXX-<slug>` (vd `feat/t08-op-engine`). Không commit thẳng vào `develop`/`main`.
- Commit nhỏ, message dạng `tXX: <việc làm>` (vd `t09: add deterministic-check rules 1-10`). Không gộp nhiều task vào một commit.
- PR: tiêu đề `[TXX][Wave N] <tên task>`; mô tả = báo cáo theo mẫu; CI xanh; 1 reviewer **khác người**; PR ≤ ~600 dòng diff, task lớn tách nhiều PR theo bước trong file task.
- Không xoá, đổi tên, di chuyển file ngoài vùng sở hữu. Việc xoá legacy tập trung ở T21 (Wave 5).
- Không thêm dependency npm ngoài danh sách đã ghi trong file task của mình. Cần thêm: ghi vào báo cáo mục "Đề xuất", chờ duyệt.
- Không sửa `package.json` scripts, `tsconfig*.json`, `eslint.config.mjs`, `vitest.config.ts`, `.github/workflows/*`, `docker-compose.yml`, `Dockerfile*`, `.env.example` trừ khi file task của mình liệt kê rõ. (T04, T07, T22, T24 có quyền theo file task.)
- Không format lại toàn file (prettier/eslint --fix trên file không thuộc mình). Diff chỉ chứa dòng thực sự đổi.
- Không đổi hành vi endpoint cũ đang chạy ở wave hiện tại nếu file task không yêu cầu; endpoint cũ chỉ bị gỡ ở task ghi rõ "gỡ khỏi route".
- Mọi file mới phải có 1 test đi kèm (unit tối thiểu). Mock provider AI là mặc định trong test; gọi provider thật chỉ sau `E2E_AI=1`.
- Tiếng Anh cho: tên field Spine (snake_case như tài liệu), nội dung render vào SRS, nhãn `.puml`. Tiếng Việt cho: nhãn UI, thông báo lỗi cho user, comment nội bộ tuỳ chọn.
- Tuyệt đối không commit secret/API key/`.env.local`.

## 2. Vùng sở hữu theo task (ai được sửa gì)

Ký hiệu: **S** = sửa/tạo/xoá tự do trong vùng; **R** = chỉ đọc; **X** = yêu cầu chéo (mục 4).
Quy tắc mặc định: thư mục không được liệt kê cho task = **R**.

### Backend `flintflow_be/`

| Vùng | T01 | T02 | T03 | T04 | T05 | T06 | T08 | T09 | T10 | T11 | T12 | T13 | T14 | T15 | T17 | T18 | T19 | T20 | T21 | T22 | T24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `src/modules/spine/` (schema, model, repo, types) | S | R | R | R | R | R | S* | S* | R | R | R | R | R | R | S* | R | R | R | S | R | R |
| `src/modules/spine/{op-engine,path-resolver,invariants,cascade,reference-fields,op.types}.ts` | — | R | R | R | R | R | S | R | R | R | R | R | R | R | S | R | R | R | S | R | R |
| `src/modules/spine/{section-registry,section-status,source-hash,deterministic-check,flags.*}.ts` | — | R | R | R | R | R | R | S | R | R | R | R | R | R | R | R | S* | R | S | R | R |
| `src/modules/spine/{impact,change,reconcile,undo,traceability}.service.ts` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | S | R | R | R | S | R | R |
| `src/modules/pipeline/pipeline.dto.ts`, `docs/api/pipeline-contract.md` | — | — | — | — | — | — | S | R | R | R | R | R | R | R | R | R | R | R | R | R | R |
| `src/modules/pipeline/{context-projection,draft-to-ops,op-validator}.ts` | — | — | R | — | — | — | R | R | R | S | R | R | R | R | R | R | R | R | S | R | R |
| `src/modules/pipeline/step-registry.ts`, `assets/step-registry.json` | — | — | — | — | — | — | — | R | R | R | S | R | X | R | R | X | R | R | S | R | R |
| `src/modules/pipeline/{step-runner,gate,meter,resume}.service.ts`, `pipeline.controller/route` | — | — | — | — | — | — | — | — | — | — | — | S | R | R | R | S* | S* | S* | S | R | R |
| `src/modules/pipeline/s9/` | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | S | — | S | R | R |
| `src/modules/pipeline/skills/*.e2e.test.ts` | — | — | — | — | — | — | — | — | — | — | — | — | S | — | — | S | S | S | R | S | R |
| `src/modules/diagram/` | — | — | — | — | — | — | — | — | S | — | — | R | R | R | R | R | R | R | S | R | R |
| `src/modules/render/` | — | — | — | — | S | — | — | — | — | — | — | — | — | S | R | R | S* | R | S | R | R |
| `src/modules/notification/`, `src/modules/billing/` | — | — | — | S | — | — | — | — | — | — | — | X | — | — | — | — | X | — | S | R | R |
| `src/modules/admin/` (admin.* mới) | — | — | X | — | — | S | — | — | — | — | — | — | — | — | — | — | — | — | S | R | R |
| `src/modules/admin/prompt-template.*` | — | — | S | — | — | R | — | — | — | — | — | — | — | — | — | — | — | — | S | R | R |
| `src/modules/credits/` | — | — | — | S | — | R | — | — | — | — | — | R | — | — | — | — | — | — | S | R | R |
| `src/modules/project/project.model.ts` | S | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | S | R | R |
| `src/modules/project/chat-session.*` | S* | R | R | R | R | R | R | R | R | R | R | S | R | R | S* | R | R | S* | S | R | R |
| `src/modules/project/project.service.ts` | S* | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | S | R | R |
| `src/modules/project/project-document.*` | — | — | — | — | — | — | — | — | — | R | — | — | — | — | — | — | — | R | S | R | R |
| `src/modules/specification/`, `src/modules/verification/` (legacy) | R | R | R | R | R | R | R | R | R | R | R | R | R | R | X | R | X | X | S (xoá) | — | — |
| `src/modules/user/`, `src/modules/auth/` | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R |
| `src/shared/ai/{prompt-assets,prompt-registry.service}.ts` | — | — | S | — | — | — | — | — | — | R | — | R | R | — | — | R | — | R | S | R | R |
| `src/shared/ai/{ai-action.types,response-parser}.ts` | — | — | S | — | — | — | — | — | — | R | — | R | R | — | R | R | R | R | S | R | R |
| `src/shared/ai/{ai-action.service,ai-action.route,credit-reservation.service}.ts` | — | — | X | S | — | — | — | — | — | — | — | X | — | — | — | — | — | — | S | R | R |
| `src/shared/ai/document-context.service.ts` | — | — | — | — | — | — | — | — | — | S | — | — | — | — | — | — | — | — | S | — | — |
| `src/shared/ai/providers/` | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | S* |
| `src/shared/diagram/` | — | — | — | — | — | — | — | — | S | — | — | — | — | — | — | — | — | — | — | — | — |
| `src/shared/email/`, `src/shared/auth/`, `src/shared/middlewares/`, `src/shared/utils/` | R | R | R | X | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R |
| `src/app.ts` (mount route) | S* | — | — | S* | S* | S* | S* | S* | S* | — | — | S* | — | S* | S* | — | S* | — | S | — | S* |
| `src/server.ts` | — | — | — | S* | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | S* |
| `src/config/` | — | — | — | S* (env) | — | — | — | — | — | — | — | — | — | — | — | — | — | — | S* (swagger) | — | S |
| `src/scripts/` | S* (export-schema) | S* (seed-fixture) | S* (seed-from-md) | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | S | S* (measure-tokens) | — |
| `assets/skills/action/` | — | — | S | — | — | — | — | S* (deterministic-check refs) | S* (plantuml-conventions) | S* (draft-to-ops, phase-intake) | — | S* (orchestrator, elicit, gate, meter) | — | — | S* (apply-change-op) | — | — | — | R | — | — |
| `assets/skills/content/` | — | — | S (stub) | — | — | — | — | — | — | — | — | — | S* | — | — | S* | S* (prioritization) | S* (product-brief, brief-analysis) | R | — | — |
| `assets/skills/renderer/` | — | — | S (stub) | — | — | — | — | — | S | — | — | — | — | — | — | — | — | — | — | — | — |
| `assets/skills/output/` | — | — | S (stub) | — | — | — | — | — | — | — | — | — | — | S* (assemble-srs) | — | — | S* (completeness-score) | — | — | — | — |
| `assets/prompts/` (cũ) | — | — | S | — | — | — | — | — | — | — | — | — | — | — | — | — | R | R | S (xoá) | — | — |
| `assets/schema/` | S | R | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `fixtures/` | R | S | — | — | S* (rendered-document-sample) | — | R | R | R | R | R | R | S* (op-cases/s2-s3) | R | R | S* (op-cases/s4-s8) | R | S* (op-cases/b0-s1) | R | S* | — |
| `test/` (setup, integration) | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | S | — |
| `package.json`, `vitest.config.ts`, CI, Docker, compose, `.env.example` | R | R | R | S* (env) | S* (dep docx) | R | R | R | R | R | R | R | R | R | R | R | R | R | S* | S | S |

`S*` = chỉ phần được nêu đích danh trong file task (thường là thêm một dòng mount/route/dep). Không sửa gì khác trong file đó.

### Frontend `flintflow_fe/`

| Vùng | T04 | T06 | T07 | T12 | T16 | T20 | T21 | T23 |
|---|---|---|---|---|---|---|---|---|
| `lib/api/client.ts`, `lib/api/token-store.ts`, `lib/api/index.ts` | R | R | S | R | R | R | S | S* |
| `lib/api/{notifications,billing}.ts` | S | R | S (khung) | R | R | R | R | S* |
| `lib/api/admin.ts` | R | S | S (khung) | R | R | R | R | S* |
| `lib/api/{projects,chat,documents}.ts` | R | R | S | R | R | S* | S | S* |
| `lib/api/{spine,pipeline,flags,export}.ts` | R | R | S (chữ ký) | S | S | R | R | S* |
| `lib/ai-stream.ts`, `lib/auth.ts` | R | R | S | S* (streamSse) | R | R | S | S* |
| `lib/constants/section-types.ts` (legacy) | R | R | R | R | R | S* (DISCOVERY_STEPS) | S (xoá) | — |
| `lib/constants/step-registry.*`, `lib/i18n.ts` | — | — | — | S | R | R | R | S |
| `types/` | R | R | S | S* (pipeline, spine sync) | S* (flags, document) | R | S | S* |
| `mocks/` | — | — | — | S | S* (handlers thêm) | S* | R | S (dọn) |
| `app/projects/[projectId]/page.tsx` | R | R | S* (bỏ save/rollback) | S | S* | S* | S | S* |
| `app/projects/[projectId]/hooks/` | — | — | — | S | S* | S* | R | S* |
| `_components/{StepProgressBar,PhaseHeader,GateCard,ElicitPanel,ScreenQueuePanel,WorkingModeSelect,NamesGlossaryPanel,StepEventLog}.tsx` | — | — | — | S | R | R | R | S* |
| `_components/{FlagsPanel,ReadinessSummary,ChangePanel,DiffPreviewModal,TraceabilityMap,ExportPanel}.tsx`, `view/page.tsx` | — | — | — | — | S | R | R | S* |
| `_components/{AssumptionSweepPanel,AddendumTriagePanel,BriefSummaryCard}.tsx` | — | — | — | — | — | S | R | S* |
| `_components/{ChatPane,ChatBubble,ChatInput,ChatSessionSidebar}.tsx` | R | R | S* | S* | S* | S | S | S* |
| `_components/{DocumentPane,VerificationPane,PhaseNavBar,WorkspaceHeader}.tsx` | R | R | S | S* | S | R | S | S* |
| `_components/{DraftReviewCard,GeneratingIndicator,ConfirmRollbackModal,DiscoveryStepBar,SummaryReviewCard,StepTransitionBanner,QuestionStepperInput}.tsx` (legacy/tái dùng) | R | R | S* | R | R | S* | S (xoá) | — |
| `app/home/page.tsx`, `components/Sidebar.tsx`, `components/ProjectCard.tsx` | S* (badge/plan) | R | S* (search, links) | R | S* (onboarding redirect) | R | R | S |
| `app/home/{notifications,billing}/`, `components/NotificationBell.tsx` | S | R | R | R | R | R | R | S* |
| `app/home/onboarding/` | — | — | — | — | S | — | — | S* |
| `app/admin/` | R | S | R | R | R | R | R | S* |
| `app/(auth)/`, `components/{AuthGuard,GoogleButton,Logo,Modal}.tsx`, `proxy.ts` | R | S* (proxy redirect) | R | R | R | R | R | R |
| `app/draw-test/`, `components/diagram/`, `types/excalidraw.d.ts`, `packages/` | R | R | S (xoá) | — | — | — | — | — |
| `e2e/`, `playwright.config.ts` | — | — | — | — | — | — | — | S |
| `package.json`, `next.config.ts`, `vitest.config.ts`, `test/setup.ts`, `.env.*` | R | R | S* (theo file task) | S* (msw) | R | R | S* | S* (playwright) |

### Tài liệu `docs/`, `claude_output/`

| Vùng | Ai |
|---|---|
| `docs/api/pipeline-contract.md` | T08 tạo; sau M2 chỉ PR `contract-change` |
| `docs/measurements.md` | T14, T18, T22 ghi thêm mục; không xoá mục người khác |
| `docs/spec-gaps.md` | Ai cũng được **thêm dòng**; không sửa dòng người khác |
| `docs/{architecture,testing,ops,fe-architecture}.md`, `docs/migration-report.md` | Task tương ứng (T21, T22, T24, T23) |
| `claude_output/task-XX-*.md` | Chỉ người phụ trách task đó (tick checkbox, ghi chú) |
| `claude_output/plan-overview.md` mục 8 | Mỗi người sửa **dòng của task mình**; merge point do người được ghi |
| `claude_output/{audit,coding-rules,task-report-template}.md` | Không sửa; góp ý qua issue |

## 3. Điều cấm tuyệt đối (PR bị từ chối ngay)

1. Sửa file có trạng thái **R** hoặc **—** với task của mình.
2. Đổi tên/ý nghĩa field Spine, path selector, mã lỗi, tên sự kiện SSE, tên `skill_id`, `ActionType` đã đóng băng mà không có PR `contract-change`.
3. Ghi thẳng vào Spine bằng `Model.updateOne/save` ngoài `spine.repository`/`op-engine` (từ Wave 2 trở đi mọi ghi phải qua `applyTransaction`, trừ T01 repository và T10 khi T08 chưa merge có ghi chú).
4. Lưu `status` của section, `progressPercent`, hoặc bất kỳ giá trị suy diễn nào vào DB (chúng là hàm tính).
5. Ghi raw text của model vào Spine khi parse thất bại.
6. Nạp toàn transcript hoặc toàn Spine vào prompt (context phải là projection).
7. Bỏ qua bất biến, bỏ qua `base_version`, nới trần 8 lượt/3 regenerate, thêm ngưỡng phần trăm cho baseline.
8. Thêm endpoint không có trong `pipeline-contract.md` (sau M2) mà không cập nhật contract trước.
9. Xoá test đang xanh của người khác để PR mình pass; skip test không có lý do ghi trong báo cáo.
10. Đụng `node_modules`, `dist`, `.git`, file `.env` thật.
11. Dùng `any` mới trong `modules/spine`, `modules/pipeline` (trừ `Schema.Types.Mixed` ở model đã nêu).
12. Hard-code URL provider, secret, client ID, dữ liệu demo trong JSX.

## 4. Khi cần đụng phần của người khác (yêu cầu chéo)

1. **Không sửa.** Mở issue tiêu đề `[XREQ][TXX→TYY] <cần gì>` mô tả: file, thay đổi mong muốn, lý do, mức khẩn.
2. Chủ vùng (TYY) quyết trong ≤ 1 ngày làm việc: tự làm trong nhánh của họ, hoặc cho phép bạn làm bằng comment `granted` kèm giới hạn file/dòng.
3. Nếu được `granted`: tạo commit riêng `tXX(xreq→tYY): …`, PR ghi rõ trong mục "Thay đổi ngoài vùng" của báo cáo, chủ vùng là reviewer bắt buộc.
4. Nếu thay đổi chạm hợp đồng đóng băng: chuyển thành PR `contract-change` (4/4 approve), kèm cập nhật mọi nơi phụ thuộc trong cùng PR (BE + FE + mock + test).
5. Trong lúc chờ: làm việc với bản tạm cục bộ (stub/adapter trong vùng của mình), đánh dấu `// TODO(XREQ-<số issue>)`, và liệt kê trong báo cáo. Mọi `TODO(XREQ-…)` phải được dọn trước merge point của wave.

## 5. Quy ước riêng cho AI agent thực thi task

- Bắt đầu bằng đọc: `coding-rules.md` (file này), file task của mình, `plan-overview.md` mục 1 và 5, và **chỉ** các file ghi ở mục "File / module liên quan" của task. Không quét/đọc rộng hơn nếu không cần.
- Trước khi sửa một file, tự kiểm: file có trong bảng mục 2 với trạng thái S/S* cho task này không. Không có thì dừng, ghi vào mục "Bị chặn" của báo cáo.
- Không tự "tiện tay" sửa lỗi ở nơi khác dù thấy rõ; ghi vào mục "Phát hiện ngoài phạm vi" của báo cáo.
- Không chạy lệnh ghi ngoài repo (không `rm -rf`, không `git push --force`, không đổi config máy). Không chạy `npm install` package mới ngoài danh sách task.
- Chạy `npm run typecheck`, `npm run lint` (FE), `npm test` trước khi báo cáo; dán kết quả thật (pass/fail, số test) vào báo cáo. Không được nói "đã test" mà không có output.
- Kết thúc mỗi phiên làm việc (dù chưa xong) phải xuất báo cáo theo `task-report-template.md`, trạng thái `Đang làm`, ghi rõ bước tiếp theo.

## 6. Checklist trước khi mở PR

- [ ] Diff chỉ chứa file S/S* của task (chạy `git diff --name-only develop...HEAD` và đối chiếu bảng mục 2).
- [ ] Không có thay đổi contract, hoặc PR mang nhãn `contract-change`.
- [ ] Test mới cho code mới; toàn bộ test xanh; output dán vào báo cáo.
- [ ] DoD trong file task đã tick đúng thực tế.
- [ ] `plan-overview.md` mục 8 cập nhật dòng của task.
- [ ] Báo cáo theo mẫu `task-report-template.md` đầy đủ 9 mục, dán vào mô tả PR.
- [ ] Không còn `TODO(XREQ-…)` chưa xử lý nếu PR là PR cuối của task.
