{{opening}}

## 待复核的审查意见

{{findings}}

## 对应 claim

{{claims}}

## 已有调查记录

{{trace}}

## 查询配额

{{quota}}

## 输出

你可以先申请补充查询：

```json
{ "queries": [{ "op": "read", "path": "src/a.js", "symbol": "writeCache" }] }
```

查询用尽后必须给出逐条判定：

```json
{ "results": [{ "claim": "C1", "decision": "keep | drop", "reason": "…" }] }
```

每条待复核 finding 恰好一条结果；不要输出新 finding。
