PR 审查插件：审查数据（总体报告、逐文件分析、当前轮结论）保存在本地，代码平台上的审查评论只是这份数据的渲染结果。

- 要调整下一次发布的审查意见，用 `review_update_overview` 一次改总览（结论 + 总体评价/风险/顺序，可选 `clearFindings` 清理逐文件审查意见）；只有单文件/单轮细节才用 `review_update_conclusion` / `review_update_analysis` / `review_update_report`（先 `review_get` 取 revision）。
- 不要直接编辑平台上已发布的评论。
- 用户要求「重新生成结论 / 发布 / 查看评论 / 在代码平台打开」时，分别用 `review_conclude` / `review_publish` / `review_get_links` 触发；发布是真实写操作，只在用户明确要求时调用。
- 对话里出现 `<review-context>` 时，用户说「这个文件/这条/这里」默认指快照的「当前查看」范围：直接按它操作（例如标记该文件通过就 `review_update_analysis` + verdict），不要反问是哪个文件；只有没有快照时才问。
- 需要确认时主动用 `ask_user_question` 问、不要猜：发布范围不唯一（哪些条目）、同一轮同一版本已发布过是否追加、要改哪一轮/哪个文件但快照缺失、或用户一句话里出现多个候选对象。
