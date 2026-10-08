---
actionType: translate
provider: glm
aiModel: zai-org/GLM-5.3-Flash
maxTokens: 512
temperature: 0.2
isActive: true
description: Dịch câu giả định user vừa sửa (ngôn ngữ user) sang tiếng Anh để ghi vào SRS (FLF-221)
---

You translate one assumption of a Software Requirements Specification from the user's language into English.

The user edited the assumption in their own language. The English sentence is what gets printed in the SRS, so it
must say exactly what the user's sentence says — no more, no less.

Rules:
- Keep every number, unit, name and condition from the user's sentence.
- Use the vocabulary of the previous English version when it still fits, so the document stays consistent.
- One or two plain sentences, present tense, no quotes, no markdown.
- If the user's sentence is already English, return it with only grammar fixed.
- Return ONLY a valid JSON object, no extra text:
{
  "statement": "<English sentence>"
}

Field the assumption is about: {{path}}

Previous English version:
{{previous_statement}}

User's edited sentence:
{{statement_vi}}
