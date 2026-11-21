平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}（{{headRef}} → {{baseRef}}）

正在审查文件：{{filePath}}（{{fileStatus}}，+{{additions}} / -{{deletions}}）{{focus}}

{{reportLine}}

## 该文件的 diff

{{diff}}

{{fileContentSection}}

{{baselineSection}}

## 分析要求

结合完整文件说明相关函数/类的职责、被谁调用、与周边代码的关系；不要只描述 diff 片段。

如果这次改动引入重复分支、兼容回退或单次使用的包装层，确认后作为建议指出可化简之处；纯改进点（补测试、抽公共 helper 等）也可以提出，但同样必须先成为 claim 并由证据确认。不要提出无法证伪的担忧。

同时看测试：这次改动需要补充或更新哪些测试；如果只给了实现、没有相关测试，在 summary 里点明这个测试空白。

终稿的写法：

- summary：一句话概括这个文件的改动。
- logic：只写全局——原来做什么 → 现在整体变成怎样 → 上下游调用关系 → 数据与状态流动 → 关键边界与错误路径。不要复述 walkthrough 的局部细节，篇幅随改动规模自适应。
- walkthrough：只写局部，1-3 条，按 diff 的 hunk 顺序覆盖主要改动；title 写「段落/函数名 + 一句话作用」，不要写 hunk 编号；detail 讲清做了什么、为什么需要、影响谁、有什么风险；context 写所属函数/类与起止行号，不在任何函数内或不确定时写 null。
- changes：逐类说明新增、删除、重命名/移动。
- verdict：block=存在应先修复的缺陷，不可合并；suggest=可合并但有保留意见或非阻塞问题；pass=可按原样合并。

{{previousVerdictsField}}
