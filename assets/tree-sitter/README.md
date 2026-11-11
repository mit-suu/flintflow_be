# Tree-sitter grammar (FLF-375)

`tree-sitter-markdown.wasm` — grammar Markdown (khối: heading, đoạn, danh sách, bảng, code) của
[tree-sitter-grammars/tree-sitter-markdown](https://github.com/tree-sitter-grammars/tree-sitter-markdown) bản **0.3.2**
(MIT), dựng thành WASM để chạy bằng `web-tree-sitter` **0.25.10** (không cần build native, chạy được trên
`node:22-alpine`). Dùng ở `src/shared/search/md-chunks.ts` để cắt tài liệu đính kèm của CR theo cấu trúc.

Dựng lại (cần Docker — CLI tự kéo image `emscripten/emsdk`):

```sh
npm pack @tree-sitter-grammars/tree-sitter-markdown@0.3.2 && tar -xzf tree-sitter-grammars-tree-sitter-markdown-0.3.2.tgz
cd package
echo '{"grammars":[{"name":"markdown","camelcase":"Markdown","scope":"text.markdown","path":"tree-sitter-markdown","file-types":["md"]}],"metadata":{"version":"0.3.2","license":"MIT","description":"Markdown grammar","links":{"repository":"https://github.com/tree-sitter-grammars/tree-sitter-markdown"}}}' > tree-sitter.json
npx -y tree-sitter-cli@0.25.10 build --wasm -o tree-sitter-markdown.wasm tree-sitter-markdown
```

Đổi bản `web-tree-sitter` thì dựng lại file này bằng `tree-sitter-cli` cùng bản (ABI WASM phải khớp).
