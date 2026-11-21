平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}（{{headRef}} → {{baseRef}}）

规模：{{changedFiles}} 个文件，+{{additions}} / -{{deletions}}

{{reportLine}}

已逐文件分析（{{entryCount}} 个）：{{entries}}

{{coverageSection}}

{{previousItemsSection}}

{{humanItemIdsSection}}

{{feedbackSection}}

{{chatSection}}

{{currentConclusionSection}}

输出要求：沿用上一轮条目的 id（未变化的条目必须复用原 id）；人工锁定 id 必须原样保留；新增条目不要编造 id；只有本次逐文件分析或 diff 明确表明问题已消失时，才可以不输出旧条目——无法确认是否修复时必须保留。

line 为 PR head 新文件行号，可选：填整数（未知填 0）；文件路径必须与变更文件清单一致。

请输出严格 JSON，作为合并前的最终审查结论：

```json
{
  "verdict": "block | suggest | pass",
  "summary": "3-5 句最终结论：改动的价值、实现是否匹配 PR 描述、遗留风险与测试空白、是否可合并；没有阻塞项时明确写「未发现阻塞项」",
  "blockers": [{ "id": "可选：沿用上一轮条目的 id", "file": "路径", "line": 0, "point": "问题 + 影响 + 修法（一条只写一个核心问题）" }],
  "suggestions": [{ "id": "可选：沿用上一轮条目的 id", "file": "路径", "line": 0, "point": "问题 + 影响 + 修法（一条只写一个核心问题）" }],
  "nextSteps": ["合并前要做的事，按顺序；只写要执行的动作与要补的测试，不要写未验证项"]
}
```
