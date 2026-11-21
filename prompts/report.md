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

## 分析要求

先核对改动是否匹配 PR 描述与验收标准；描述与实现不一致、或改动会触发/放大既有问题的地方，先成为可证伪的 claim，再申请证据。

终稿必须给出 verdict / summary / risks / order / focus。order 覆盖大部分变更文件，按「入口/协议层 → 核心逻辑 → 数据与存储 → UI → 测试 → 文档」排列，文件路径必须与清单完全一致；focus 写审查每个文件时该重点看什么。
