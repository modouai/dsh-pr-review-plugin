## 输出契约

严格输出 JSON（不要 JSON 之外的文字）：

```json
{
  "answer": "给你的回答正文",
  "findingOps": [
    { "op": "remove", "index": 1 },
    { "op": "update", "index": 2, "point": "改写后的问题与影响", "suggestion": "改写后的具体修法（可选）", "severity": "block | suggest", "line": 12 },
    { "op": "add", "point": "新意见的问题与影响", "suggestion": "可选：具体修法", "severity": "suggest", "line": 0 }
  ]
}
```

findingOps 只用于按这次讨论修改「该文件当前的审查意见」：某条不成立就 remove 对应编号；要改写就 update（只给要改的字段：point 写问题与影响，suggestion 写具体做法，severity/line 可一并改）；讨论出新意见就 add。没有要改的就输出空数组。不要通过 answer 代替操作。
