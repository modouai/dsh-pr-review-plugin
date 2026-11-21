## 输出契约

严格输出 JSON（不要 JSON 之外的文字）：

```json
{
  "answer": "给你的回答正文",
  "suggestionOps": [
    { "op": "remove", "target": "risk", "index": 1 },
    { "op": "update", "target": "risk", "index": 1, "text": "改写后的风险描述" },
    { "op": "add", "target": "risk", "text": "新增风险", "file": "路径或空串", "severity": "block | suggest" },
    { "op": "remove", "target": "suggestion", "index": 2 },
    { "op": "update", "target": "blocker", "index": 1, "text": "改写后的阻塞项" },
    { "op": "add", "target": "nextStep", "text": "新增的下一步" }
  ]
}
```

suggestionOps 直接修改总览里已存在的内容：target 取 risk（总体初筛风险）、blocker（最终结论的阻塞项）、suggestion（最终结论的修改建议）、nextStep（下一步）。用户说某条不成立就 remove 对应编号；说要改写就 update；讨论出新内容就 add（add risk/suggestion 时用 file 标注涉及文件，未涉及写空串；add blocker/nextStep 不需要 file）。没有要改的就输出空数组。不要通过 answer 代替操作。
