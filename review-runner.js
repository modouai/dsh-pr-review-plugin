/**
 * One agent-driven review run: create a read-only agent, send the task, wait for idle,
 * and close coverage gaps with bounded follow-ups. No direct LLM calls.
 */

import { randomUUID } from 'node:crypto';

import { renderPrompt } from './prompts.js';

export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

function allFiles(record) {
  return (Array.isArray(record.files) ? record.files : []).map((file) => file.path);
}

function scopedFiles(record, paths) {
  const files = allFiles(record);
  if (!Array.isArray(paths) || paths.length === 0) return files;
  const wanted = new Set(paths);
  return files.filter((path) => wanted.has(path));
}

function taskPrompt(record, cwd, paths, analyzeFiles) {
  const files = scopedFiles(record, paths);
  const scope = Array.isArray(paths) && paths.length > 0
    ? `指定文件（${files.length} 个）：${files.slice(0, 50).join('、')}${files.length > 50 ? ' 等' : ''}`
    : `全部变更文件（${files.length} 个）`;
  return renderPrompt('review-task', {
    pullNumber: record.pull?.number ?? record.number,
    repo: record.pull?.repo ?? '',
    headSha: record.headSha ?? record.pull?.headSha ?? '',
    cwd,
    scope,
    fileAnalysisStep: analyzeFiles
      ? '对每个文件：`review_get_file` / `review_get_diff` 获取 PR head 内容；按需读取调用方、定义、测试；分析后调用 `review_update_analysis` 写回。'
      : '本轮只写总体报告，不逐文件分析；用户点开文件时再分析。',
  });
}

function continuePrompt(missing) {
  return renderPrompt('review-continue', {
    missingFiles: missing.map((path) => `- ${path}`).join('\n'),
  });
}

function missingFilesOf(record, paths, before) {
  return scopedFiles(record, paths).filter((path) => {
    const entry = record.explanations?.get(path);
    if (entry === undefined || entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) return true;
    // A file analyzed in an earlier round is not evidence for this run. Only a write that
    // lands after the run starts (updatedAt increased) satisfies coverage.
    const updated = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
    return updated <= (before.get(path) ?? 0);
  });
}

/** Global tools the review agent must never inherit, even when a preset or profile adds them. */
const DANGEROUS_GLOBAL_TOOLS = [
  'bash', 'write', 'edit', 'apply_patch',
  'create_worktree', 'working_directory', 'load_workspace_dependencies',
  'review_publish', 'review_conclude', 'review_run_agent', 'review_probe_agent',
];

/** Restrict the agent's global tool mask; scoped preset tools stay visible. */
function restrictAgentTools(agentCtx) {
  const schemas = agentCtx.tools.schemas(agentCtx);
  const known = new Set((Array.isArray(schemas) ? schemas : []).map((schema) => schema.name));
  const deny = DANGEROUS_GLOBAL_TOOLS.filter((name) => known.has(name));
  if (deny.length > 0) agentCtx.tools.restrict({ deny });
}

export function createReviewRunner({ ctx, settings, record, selection, cwd, paths, analyze = true, onChange }) {
  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
  const service = agents ?? ctx?.agents;
  let handle = null;
  let cancelled = false;

  const changed = () => {
    if (typeof onChange === 'function') onChange(record);
  };

  const dispose = async () => {
    const current = handle;
    handle = null;
    if (current !== null) await current.dispose();
  };

  const finish = (status, missing, error) => {
    record.run.status = status;
    record.run.missingFiles = missing;
    record.run.error = error ?? null;
    record.run.finishedAt = Date.now();
    changed();
  };

  const start = async () => {
    cancelled = false;
    record.run = {
      agentSessionId: null,
      startedAt: Date.now(),
      finishedAt: 0,
      status: 'running',
      missingFiles: [],
      error: null,
    };
    changed();
    if (service === undefined || service === null || typeof service.create !== 'function') {
      finish('error', [], '宿主没有提供 ctx.agents.create；无法启动 Agent 审查。');
      return;
    }
    try {
      handle = await service.create({
        sessionId: randomUUID(),
        meta: { cwd, agentPreset: settings.reviewAgentPreset ?? 'pr-review-readonly' },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: settings.reasoningEffort,
          maxTokens: settings.reviewAgentMaxTokens ?? 8000,
        },
        setup: (agentCtx) => restrictAgentTools(agentCtx),
      });
      const { agent } = handle;
      record.run.agentSessionId = agent.id;
      changed();
      // Snapshot before the first turn: only writes that land during this run count as coverage.
      const before = new Map(scopedFiles(record, paths).map((path) => [path, record.explanations?.get(path)?.updatedAt ?? 0]));
      agent.followup(userMessage(taskPrompt(record, cwd, paths, analyze)));
      await agent.whenIdle();
      if (cancelled) return;

      if (!analyze) {
        const complete = record.report !== null && record.report !== undefined;
        finish(complete ? 'done' : 'incomplete', complete ? [] : ['report'], complete ? null : '审查未完成：总体报告未生成');
        return;
      }

      let missing = missingFilesOf(record, paths, before);
      const retries = Number.isInteger(settings.reviewCoverageRetries) ? settings.reviewCoverageRetries : 2;
      for (let attempt = 0; attempt < retries && missing.length > 0; attempt += 1) {
        record.run.missingFiles = missing;
        changed();
        agent.followup(userMessage(continuePrompt(missing)));
        await agent.whenIdle();
        if (cancelled) return;
        missing = missingFilesOf(record, paths, before);
      }
      finish(
        missing.length > 0 ? 'incomplete' : 'done',
        missing,
        missing.length > 0 ? `审查未完成：${missing.length} 个文件未分析` : null,
      );
    } catch (error) {
      finish('error', record.run.missingFiles ?? [], error instanceof Error ? error.message : String(error));
    } finally {
      await dispose();
    }
  };

  const cancel = async () => {
    cancelled = true;
    await dispose();
  };

  return { start, cancel, dispose, changed };
}
