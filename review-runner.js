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

function taskPrompt(record, cwd, analyzeFiles, cwdNote) {
  const files = allFiles(record);
  const scope = `全部变更文件（${files.length} 个）`;
  return renderPrompt('review-task', {
    pullNumber: record.pull?.number ?? record.number,
    repo: record.pull?.repo ?? '',
    headSha: record.headSha ?? record.pull?.headSha ?? '',
    cwd,
    cwdNote: typeof cwdNote === 'string' ? cwdNote : '',
    scope,
    fileAnalysisStep: analyzeFiles
      ? '对每个文件：`review_get_file` / `review_get_diff` 获取 PR head 内容；按需读取调用方、定义、测试；分析后调用 `review_update_analysis` 写回。'
      : '本轮只写总体报告，不逐文件分析；用户点开文件时再分析。',
    fileAnalysisRules: analyzeFiles
      ? [
          '   - 每分析完一个文件立即调用 `review_update_analysis` 写回，不要攒到最后；上下文压缩可能丢失未写回的内容。',
          '   - path 必须是变更文件清单中的路径，revision 用最近一次 `review_get` 返回的值。',
          '   - issues 每条只写一个核心问题，写清影响与修法；severity 只有 block / suggest。',
          '   - 没有发现问题时 issues 写空数组，并在 summary 里说明依据。',
        ].join('\n')
      : '   - 本轮跳过逐文件分析，不需要调用 `review_update_analysis`。',
    coverageRequirement: analyzeFiles
      ? '上面范围内的每个文件都必须有 `review_update_analysis`。无法读取的文件写进 summary；不要猜测。'
      : '本轮只要求 `review_update_report` 与 `review_update_conclusion` 写回；逐文件分析由用户后续触发。',
  });
}

/** The two terminal writes a round needs besides per-file analyses. */
function missingSectionsOf(record, beforeReportAt, beforeConclusionAt) {
  const missing = [];
  if (record.report === null || record.report === undefined || (record.reportUpdatedAt ?? 0) <= beforeReportAt) {
    missing.push('总体报告（review_update_report）');
  }
  if (record.conclusion === null || record.conclusion === undefined || (record.conclusionAt ?? 0) <= beforeConclusionAt) {
    missing.push('最终结论（review_update_conclusion）');
  }
  return missing;
}

function gapPrompt(files, sections) {
  const lines = [];
  if (files.length > 0) {
    lines.push('以下文件还没有 `review_update_analysis`：');
    for (const path of files) lines.push(`- ${path}`);
  }
  if (sections.length > 0) {
    lines.push('本轮终稿还缺少：');
    for (const item of sections) lines.push(`- ${item}`);
    lines.push('请先重新调用 `review_get` 取最新 revision，再写回终稿；首次写结论必须带 summary。');
  }
  lines.push('不要修改代码、不要发布评论。');
  return lines.join('\n');
}

function missingFilesOf(record, before) {
  return allFiles(record).filter((path) => {
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
  'create_worktree', 'working_directory', 'load_workspace_dependencies', 'arch_map',
  'review_publish', 'review_conclude', 'review_run_agent',
];

/** Prompt clarification for the read-only agent: the global review-data section names
 * publish/conclude, but this agent has neither. Keep its self-description aligned with the
 * actual tool set. */
export const READONLY_AGENT_PROMPT = [
  '你是通过 pr-review-readonly 预设运行的只读审查 Agent。',
  '可用的写回工具只有 review_update_analysis、review_update_report、review_update_conclusion、review_update_overview。',
  '你的工具集里没有 review_publish、review_conclude、write、bash、create_worktree。',
  '不要建议或尝试发布评论、重新生成结论，也不要在最终答复里声称这些工具可用。',
].join('\n');

/** Where the read-only clarification sits relative to other prompt sections: just after the
 * plugin's global review-data section (`order: 60`), before the tool sections start at 1000. */
export const READONLY_PROMPT_ORDER = 70;

export function registerReadOnlyPrompt(agentCtx) {
  if (agentCtx?.systemPrompt !== undefined && agentCtx?.systemPrompt !== null && typeof agentCtx.systemPrompt.section === 'function') {
    agentCtx.systemPrompt.section({ name: 'pr-review: readonly-agent', order: READONLY_PROMPT_ORDER, text: READONLY_AGENT_PROMPT });
  }
}

/** Restrict the agent's global tool mask; scoped preset tools stay visible. */
export function restrictAgentTools(agentCtx) {
  const tools = agentCtx?.tools;
  if (tools === undefined || tools === null || typeof tools.schemas !== 'function' || typeof tools.restrict !== 'function') {
    // Without the global mask, a Host profile could expose bash/write/review_publish to the
    // review agent. Fail the run instead of relying on the prompt for a security boundary.
    throw new Error('审查 Agent 的工具面不可用（缺少 tools.schemas/tools.restrict），为避免只读边界失效已停止。');
  }
  const schemas = tools.schemas(agentCtx);
  const known = new Set((Array.isArray(schemas) ? schemas : []).map((schema) => schema.name));
  const deny = DANGEROUS_GLOBAL_TOOLS.filter((name) => known.has(name));
  if (deny.length > 0) tools.restrict({ deny });
}

export function createReviewRunner({ ctx, settings, record, selection, cwd, analyze = true, cwdNote = '', headIsolated = false, runToken = null, onAgent, onChange }) {
  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined;
  const service = agents ?? ctx?.agents;
  let handle = null;
  let cancelled = false;
  let cancelPromise = null;
  let cancelResolve = null;

  const changed = () => {
    if (typeof onChange === 'function') onChange(record);
  };

  const dispose = async () => {
    const current = handle;
    handle = null;
    if (current !== null) {
      try {
        await current.dispose();
      } catch (error) {
        // A failed dispose must not turn a completed review into an error.
        console.warn('[pr-review] 释放审查 Agent 失败', error);
      }
    }
  };

  let activeRun = null;

  const finish = (status, missing, sections, error) => {
    if (activeRun === null) return;
    activeRun.status = status;
    activeRun.missingFiles = missing;
    activeRun.missingSections = sections;
    activeRun.error = error ?? null;
    activeRun.finishedAt = Date.now();
    changed();
  };

  /** Wait for idle, but never hang past a cancel: cancellation is a terminal outcome. */
  const waitIdle = async (agent) => {
    const idle = Promise.resolve(agent.whenIdle());
    if (cancelPromise === null) {
      await idle;
      return;
    }
    await Promise.race([idle, cancelPromise]);
  };

  const start = async () => {
    cancelled = false;
    cancelPromise = new Promise((resolve) => {
      cancelResolve = resolve;
    });
    // A prior run in the same round (e.g. a retry after error) already wrote analyses for
    // this head; those writes belong to the round, not to this attempt. Counting them avoids
    // re-reviewing every file while still requiring a fresh report/conclusion. Requiring the
    // same head prevents an error retry after new commits from reusing old-code analyses.
    const priorRun = record.run;
    const headSha = record.headSha ?? record.pull?.headSha ?? '';
    const sameRoundRetry = priorRun !== null && priorRun !== undefined
      && priorRun.round === record.round
      && priorRun.headSha === headSha;
    activeRun = {
      token: runToken,
      round: record.round ?? 0,
      headSha,
      agentSessionId: null,
      startedAt: Date.now(),
      finishedAt: 0,
      status: 'running',
      missingFiles: [],
      missingSections: [],
      headIsolated: headIsolated === true,
      error: null,
    };
    record.run = activeRun;
    changed();
    if (service === undefined || service === null || typeof service.create !== 'function') {
      finish('error', [], [], '宿主没有提供 ctx.agents.create；无法启动 Agent 审查。');
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
        // meta.agentPreset only records the selection; the preset composition must be
        // mounted onto the new agent's scoped context before any turn starts.
        setup: async (agentCtx) => {
          const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined;
          if (presets !== undefined && presets !== null && typeof presets.mount === 'function') {
            await presets.mount(agentCtx, settings.reviewAgentPreset ?? 'pr-review-readonly');
          }
          restrictAgentTools(agentCtx);
          registerReadOnlyPrompt(agentCtx);
        },
      });
      const { agent } = handle;
      const sessionId = typeof agent?.session?.id === 'string' && agent.session.id !== '' ? agent.session.id : agent.id;
      activeRun.agentSessionId = sessionId;
      changed();
      if (typeof onAgent === 'function') onAgent(agent, sessionId);
      // Snapshot before the first turn: unless this is a same-round retry, only writes that
      // land during this run count as coverage.
      const before = sameRoundRetry
        ? new Map()
        : new Map(allFiles(record).map((path) => [path, record.explanations?.get(path)?.updatedAt ?? 0]));
      const beforeReportAt = record.reportUpdatedAt ?? 0;
      const beforeConclusionAt = record.conclusionAt ?? 0;
      agent.followup(userMessage(taskPrompt(record, cwd, analyze, cwdNote)));
      await waitIdle(agent);
      if (cancelled) return;

      const retries = Number.isInteger(settings.reviewCoverageRetries) ? settings.reviewCoverageRetries : 2;
      if (!analyze) {
        let sections = missingSectionsOf(record, beforeReportAt, beforeConclusionAt);
        for (let attempt = 0; attempt < retries && sections.length > 0; attempt += 1) {
          activeRun.missingSections = sections;
          changed();
          agent.followup(userMessage(gapPrompt([], sections)));
          await waitIdle(agent);
          if (cancelled) return;
          sections = missingSectionsOf(record, beforeReportAt, beforeConclusionAt);
        }
        finish(
          sections.length === 0 ? 'done' : 'incomplete',
          [],
          sections,
          sections.length === 0 ? null : `审查未完成：${sections.join('、')}未写回`,
        );
        return;
      }

      let files = missingFilesOf(record, before);
      let sections = missingSectionsOf(record, beforeReportAt, beforeConclusionAt);
      for (let attempt = 0; attempt < retries && (files.length > 0 || sections.length > 0); attempt += 1) {
        activeRun.missingFiles = files;
        activeRun.missingSections = sections;
        changed();
        agent.followup(userMessage(gapPrompt(files, sections)));
        await waitIdle(agent);
        if (cancelled) return;
        files = missingFilesOf(record, before);
        sections = missingSectionsOf(record, beforeReportAt, beforeConclusionAt);
      }
      const complete = files.length === 0 && sections.length === 0;
      finish(
        complete ? 'done' : 'incomplete',
        files,
        sections,
        complete ? null : `审查未完成：${files.length} 个文件、${sections.length} 个收口项缺失`,
      );
    } catch (error) {
      finish('error', activeRun?.missingFiles ?? [], activeRun?.missingSections ?? [], error instanceof Error ? error.message : String(error));
    } finally {
      await dispose();
    }
  };

  const cancel = async () => {
    cancelled = true;
    if (cancelResolve !== null) {
      const resolve = cancelResolve;
      cancelResolve = null;
      resolve();
    }
    if (activeRun !== null && activeRun !== undefined && activeRun.status === 'running') {
      activeRun.status = 'cancelled';
      activeRun.error = '审查已取消';
      activeRun.finishedAt = Date.now();
      changed();
    }
    await dispose();
  };

  return { start, cancel, dispose, changed };
}
