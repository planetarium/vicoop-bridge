import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Message } from '@vicoop-bridge/protocol';
import type { Registry, TaskRecord } from './registry.js';

const SendBody = z.object({
  message: Message,
  configuration: z
    .object({
      blocking: z.boolean().optional(),
    })
    .optional(),
});

function taskToA2A(task: TaskRecord) {
  return {
    id: task.id,
    contextId: task.contextId,
    status: task.status,
    history: task.history,
    artifacts: task.artifacts,
    kind: 'task' as const,
  };
}

export interface RelayHttpOptions {
  registry: Registry;
  publicUrl?: string;
  taskTimeoutMs?: number;
}

export function createHttpApp(opts: RelayHttpOptions): Hono {
  const app = new Hono();
  const timeoutMs = opts.taskTimeoutMs ?? 5 * 60_000;

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/.well-known/agent.json', (c) => {
    return c.json({
      name: 'vicoop-bridge',
      description: 'A2A relay for outbound-connected local agents',
      version: '0.0.0',
      protocolVersion: '0.3.0',
      url: opts.publicUrl,
      agents: opts.registry.listAgents().map((a) => ({
        id: a.agentId,
        url: opts.publicUrl ? `${opts.publicUrl}/agents/${a.agentId}` : undefined,
        card: a.agentCard,
      })),
    });
  });

  app.get('/agents/:id/agent.json', (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);
    const base = opts.publicUrl ? `${opts.publicUrl}/agents/${id}` : undefined;
    return c.json({ ...conn.agentCard, url: base });
  });

  app.post('/agents/:id/messages/send', async (c) => {
    const id = c.req.param('id');
    const conn = opts.registry.getAgent(id);
    if (!conn) return c.json({ error: 'agent not connected' }, 404);

    const parsed = SendBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.flatten() }, 400);
    }

    const taskId = randomUUID();
    const contextId = randomUUID();
    const task = opts.registry.createTask({
      id: taskId,
      contextId,
      agentId: id,
      initialMessage: parsed.data.message,
    });

    const sent = opts.registry.sendToAgent(id, {
      type: 'task.assign',
      taskId,
      contextId,
      message: parsed.data.message,
    });
    if (!sent) {
      opts.registry.failTask(taskId, 'agent_unreachable', 'could not reach adapter');
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('task timeout')), timeoutMs),
    );

    try {
      const settled = await Promise.race([task.done, timeout]);
      return c.json(taskToA2A(settled));
    } catch (err) {
      opts.registry.failTask(taskId, 'timeout', (err as Error).message);
      return c.json(taskToA2A(opts.registry.getTask(taskId)!), 504);
    }
  });

  app.post('/agents/:id/tasks/:taskId/cancel', (c) => {
    const id = c.req.param('id');
    const taskId = c.req.param('taskId');
    const task = opts.registry.getTask(taskId);
    if (!task || task.agentId !== id) {
      return c.json({ error: 'task not found' }, 404);
    }
    opts.registry.sendToAgent(id, { type: 'task.cancel', taskId });
    return c.json({ ok: true });
  });

  app.get('/agents/:id/tasks/:taskId', (c) => {
    const id = c.req.param('id');
    const taskId = c.req.param('taskId');
    const task = opts.registry.getTask(taskId);
    if (!task || task.agentId !== id) {
      return c.json({ error: 'task not found' }, 404);
    }
    return c.json(taskToA2A(task));
  });

  return app;
}
