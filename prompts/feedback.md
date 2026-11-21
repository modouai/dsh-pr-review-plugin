PR #{{pullNumber}}：{{title}}

## 我们已发布的审查意见（编号）

{{itemLines}}

## PR 实现者/其他人在评论区的回复（按时间）

{{commentLines}}

请判断每条审查意见在回复中的处置情况，严格输出 JSON：

```json
{
  "items": [{ "index": 1, "status": "fixed-claimed | disputed | accepted | question", "reason": "引用回复原话，简要说明" }],
  "notes": ["无法对应到具体编号的其他重要反馈"]
}
```

status 含义：fixed-claimed=作者表示已修复或已改；disputed=作者认为不成立/误报；accepted=作者认可但尚未修复；question=作者在询问澄清。只输出回复中确实提到的条目；没有提到的条目不要出现在 items 里。
