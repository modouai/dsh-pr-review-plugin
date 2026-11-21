平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}（{{headRef}} → {{baseRef}}）

正在审查文件：{{filePath}}（{{fileStatus}}，+{{additions}} / -{{deletions}}）{{focus}}

{{reportLine}}

## 该文件的 diff

{{diff}}

{{fileContentSection}}

{{baselineSection}}

分析要求：结合完整文件说明相关函数/类的职责、被谁调用、与周边代码的关系；不要只描述 diff 片段。

请输出严格 JSON。分析要详细、可读、面向要理解这次改动的人：

```json
{
  "summary": "一句话概括这个文件的改动",
  "logic": "整体逻辑分析（只写全局）：这个文件原来做什么 → 现在整体变成怎样 → 函数/模块的上下游调用关系 → 数据与状态怎么流动 → 关键边界条件与错误路径。不要复述 walkthrough 中各段落的具体改动细节。篇幅随改动规模自适应：大改动 400-800 字，小改动 200-400 字即可，不要为凑字数填充。",
  "walkthrough": [{ "title": "段落/函数名 + 一句话作用（如「cleanupInterruptedMacInstall：启动时清理中断残留」），不要写 hunk 编号", "detail": "用人话讲清：这段做了什么、为什么需要它、影响谁、有什么风险；2-5 句；不要复述 logic 的整体链路，不要把审查意见写进来", "hunk": 1, "context": { "label": "所属函数/类名", "startLine": 230, "endLine": 275 } }],
  "changes": "逐类说明具体变化：新增了什么、删除了什么、重命名/移动了什么",
{{previousVerdictsField}}
  "concerns": [{ "severity": "block | suggest", "point": "问题 + 影响（一条只写一个核心问题）", "suggestion": "具体修法（可选；没有明确修法就省略，不要把修法写进 point）", "line": 0 }],
  "evidenceNeeds": [{ "concern": 1, "kind": "callers | definition | callee | schema | test | file", "path": "文件路径", "symbol": "符号名", "reason": "为什么需要它" }],
  "verdict": "block | suggest | pass"
}
```

logic 只写全局、walkthrough 只写局部，两者不得互相复述；walkthrough 按 diff 规模 1-3 条（改动很小时 1 条即可）、按 diff 的 hunk 顺序覆盖主要改动；hunk 是该条分析对应的 diff hunk 序号（从 1 开始，按 @@ 出现顺序计数），不确定写 0；title 禁止出现「hunk」「第 N 段」这类编号；detail 面向第一次读这段代码的人，术语首次出现要顺带解释，问题与建议写到 concerns，不要写进 walkthrough；

context 用于在 diff 里展开这段改动所属的完整函数/类：label 写函数/类名，startLine/endLine 是它在上面「完整内容」里的起止行号（用给出的行号，1-based，跨语言通用）；该段改动不在任何函数/类内（如 Markdown、配置文件）或你不确定时，context 写 null。

同时看测试：这次改动需要补充或更新哪些测试；如果只给了实现、没有相关测试，在 summary 里点明这个测试空白。

如果这次改动引入重复分支、兼容回退或单次使用的包装层，在 concerns 里用 suggest 指出可化简之处；纯改进点（补测试、抽公共 helper 等没有具体缺陷的）也必须作为 severity 为 suggest 的 concern 输出，修法写进 suggestion。

纯改进点（不阻碍合并）的 point 以「可选：」或「nit：」开头，与真正的非阻塞缺陷区分开。

verdict 语义：block=存在应先修复的缺陷，不可合并；suggest=可合并但有保留意见或非阻塞问题；pass=可按原样合并（concerns 均为可选改进时用 pass）。

concerns 为空数组表示没有发现问题；point 只写问题与影响，不要把修法混进 point；line 用 diff 中的新文件行号，不确定写 0。

evidenceNeeds 必须覆盖每个 concern（concern 是 1-based 序号）：kind=file 指向本文件也算取证；无法核实的由复审放进未验证项，不要写进 point。
