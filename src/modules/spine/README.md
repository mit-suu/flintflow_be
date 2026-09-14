# modules/spine

Nền dữ liệu Spine theo `context/srs-spine.md`. Step ghi field vào Spine; section SRS chỉ là kết quả render.

## File

| File | Vai trò |
| --- | --- |
| `spine.types.ts` | Kiểu TS, chép §2. Field giữ **snake_case y như tài liệu** |
| `spine.schema.ts` | Zod (hợp đồng đóng băng sau M1), `toJsonSchema()`; kiểm compile-time zod ⇔ types |
| `spine.model.ts` | Collection `spines`, một document mỗi project (`projectId` unique) |
| `change.model.ts` | Collection `changes` — `changes[]`, unique `(projectId, seq)` |
| `baseline.model.ts` | Collection `baselines` — snapshot; `Spine.baselines[].snapshot_ref` = `_id` |
| `usage.model.ts` | Collection `usages` — `usage[]` theo lượt gọi model |
| `spine.repository.ts` | Cửa ghi/đọc duy nhất: `getOrCreate`, `get`, `saveWithVersion`, `nextSeq`, `appendChanges`, `listChanges` |
| `spine.controller.ts`, `spine.route.ts` | `GET /api/v1/projects/:projectId/spine` |

JSON Schema: `assets/schema/srs-spine.schema.json`, sinh bằng `npm run schema:export`. Đổi `spine.schema.ts` mà quên export thì `spine.schema.test.ts` fail.

## Nằm ngoài document Spine

Mongo giới hạn 16MB/document nên tách:

- `changes[]` → collection `changes`
- `usage[]` → collection `usages`
- snapshot của `baselines[]` → collection `baselines` (trong Spine chỉ còn metadata + `snapshot_ref`)
- `sessions[]` → collection `chatsessions`, cờ `is_pipeline` (đúng một mỗi project — partial unique index)

## Quy ước path

Path selector (T08) phân giải **qua khoá, không qua chỉ số mảng** (srs-spine.md §1):

```text
actors[id=A03].name
permissions[screen_id=S3,role_id=R1,action=create]
functions[id=FN2].validations[id=V1].statement
```

Mọi mảng thực thể có `id` riêng; op không được đổi `id`.

## Dữ liệu

- Thời điểm: Mongo lưu `Date`; repository trả **chuỗi ISO 8601**. Id Mongo trả chuỗi hex.
- Mọi object zod là strict: key lạ bị từ chối.
- Không lưu giá trị suy diễn: `sections[]` chỉ có `{id, asset_version}` — `status` và % sẵn sàng là hàm tính (T09).

## Versioning

- `spine_version` bắt đầu từ 1, tăng **đúng một lần mỗi transaction**.
- Khoá lạc quan: caller đọc Spine, giữ `spine_version` làm `base_version`, rồi gọi `saveWithVersion(spine, baseVersion)`.
  Repository ghi bằng `findOneAndUpdate({ projectId, spine_version: baseVersion }, { $set: { ...spine, spine_version: baseVersion + 1 } })`.
  Không khớp ⇒ `409 SPINE_VERSION_CONFLICT` (Phases §4.1: từ chối, refund credit, giữ câu trả lời Elicit).
- Nội dung được validate bằng `spineSchema` trước khi ghi ⇒ sai thì `422 SPINE_SCHEMA_INVALID`.
- `changes[].seq` liên tục từ 1 mỗi project. `nextSeq` đọc seq lớn nhất + 1; trùng `seq` ⇒ `409 CHANGE_SEQ_CONFLICT` (unique index).
  Thứ tự dự kiến ở T08: `saveWithVersion` thành công rồi mới `appendChanges`, nên chỉ một writer giữ một version.
- Từ Wave 2, mọi ghi Spine đi qua op engine (`applyTransaction`, T08); không gọi `Model.updateOne/save` trực tiếp.

## Mã lỗi

| HTTP | code | Khi |
| --- | --- | --- |
| 404 | `PROJECT_NOT_FOUND` | GET spine của project không tồn tại / không thuộc user / id sai định dạng |
| 404 | `SPINE_NOT_FOUND` | `saveWithVersion` cho project chưa có Spine |
| 409 | `SPINE_VERSION_CONFLICT` | `baseVersion` lệch `spine_version` hiện tại |
| 409 | `CHANGE_SEQ_CONFLICT` | `seq` đã tồn tại |
| 422 | `SPINE_SCHEMA_INVALID` / `CHANGE_INVALID` | Dữ liệu sai schema, hoặc `seq` trong lô không liên tục |
