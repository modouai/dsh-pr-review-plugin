平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}

作者：{{author}}；分支：{{headRef}} → {{baseRef}}

规模：{{changedFiles}} 个文件，+{{additions}} / -{{deletions}}

{{bodySection}}

## 变更文件清单

{{fileLines}}

## 启发式入口排序（可修正）

{{order}}

## 变更内容（每文件截断，用于判断入口与总体风险）

{{excerpts}}

请输出严格 JSON（不要输出 JSON 以外的解释）：

```json
{
  "verdict": "block | suggest | pass",
  "summary": "2-4 句总体评价：这个 PR 做了什么、实现是否匹配 PR 描述、风险在哪、能否合并；没有阻塞项时明确写「未发现阻塞项」",
  "concerns": [{ "severity": "block | suggest", "file": "路径", "point": "问题 + 影响 + 修法（一条只写一个核心问题）", "line": 0 }],
  "evidenceNeeds": [{ "concern": 1, "kind": "callers | definition | callee | schema | test | file", "path": "文件路径", "symbol": "符号名", "reason": "为什么需要它" }],
  "order": [{ "file": "路径", "reason": "为什么先看它（它是什么入口、被谁调用、为什么值得先读）" }],
  "focus": [{ "file": "路径", "point": "审查这个文件时重点看什么" }]
}
```

concerns 是候选问题，不是最终结论：每条都会经过取证复审；没有问题就输出空数组。

evidenceNeeds 必须覆盖每个 concern（concern 是 1-based 序号）：kind=file 指向改动文件本身也算取证；仍然无法核实的，复审会把它放进未验证项。

先核对改动是否匹配 PR 描述与验收标准；描述与实现不一致时写进 concerns。

order 必须覆盖大部分变更文件，按「入口/协议层 → 核心逻辑 → 数据与存储 → UI → 测试 → 文档」排列；文件路径必须与清单完全一致。
