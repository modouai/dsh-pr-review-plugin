/**
 * Temporary phase-0 probe: create a read-only review agent and let it write one analysis.
 * Delete this module and its tool after the host capability check passes.
 */

import { randomUUID } from 'node:crypto';

export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

export async function probeAgent({ agents, cwd, preset, provider, model, prompt }) {
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    throw new Error('宿主没有提供 ctx.agents.create；阶段 0 无法继续。');
  }
  const handle = await agents.create({
    sessionId: randomUUID(),
    meta: { cwd, agentPreset: preset },
    agentOptions: { provider, model, reasoningEffort: 'off', maxTokens: 8000 },
  });
  try {
    const { agent } = handle;
    agent.followup(userMessage(prompt));
    await agent.whenIdle();
    return { agentId: agent.id, status: agent.status };
  } finally {
    await handle.dispose();
  }
}
