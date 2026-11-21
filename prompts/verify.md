{{header}}

## 候选问题（index 从 1 开始）

{{candidates}}

## 宿主取回的证据

{{evidence}}

## 无法读取的证据

{{missing}}

{{diffSection}}

## 判定规则

对每条候选问题给出 confidence（0-100）：

- 80-100：证据确认问题存在，或高置信度会在实践中命中；写入 results，并给出最终的 severity、point、line。
- 25-79：只能部分验证；写入 results 并在 missing 里说明还缺哪份证据。
- 0-24：经不起推敲、属于既有问题或误报；写入 results 并给低分，不要写成高分。

每条候选都必须返回一条 result，index 用上面列表的编号（从 1 开始）；index 越界或缺失的结果会被丢弃。

证据块可能只显示文件的一部分（标题里标注了行范围）。只看到片段时，不要断言文件里不存在某段内容；需要完整文件才能判断的，按未验证处理。

{{verifyLanguageRule}}

只看候选与证据，不要引用第一轮的推理，也不要重新审查整个文件。

如果证据里发现了新的、可确认的问题，写进 extraIssues，带上 confidence 并确保能引用证据中的代码；否则不要输出。

规范类问题必须引用规范原文（如「CLAUDE.md 要求……」），没有原文就按未验证处理。

候选（含纯 suggest 改进点）已经由本次 diff 或现有代码实现、或只是复述现状的，confidence 打 24 以下直接丢弃；不要因为「有价值」而保留已实现的条目。

请输出严格 JSON（不要输出 JSON 以外的解释）：

```json
{
  "results": [{ "index": 1, "confidence": 85, "severity": "block | suggest", "point": "问题 + 影响", "suggestion": "具体修法（可选；沿用候选的修法或按证据修正）", "line": 0, "missing": "" }],
  "extraIssues": [{ "confidence": 90, "severity": "block | suggest", "point": "问题 + 影响", "suggestion": "具体修法（可选）", "line": 0 }]
}
```
