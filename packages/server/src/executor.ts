import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Registry } from './registry.js';

export class ServerAgentExecutor implements AgentExecutor {
  constructor(
    private readonly agentId: string,
    private readonly registry: Registry,
  ) {}

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = ctx;

    this.registry.bindTask({ agentId: this.agentId, taskId, contextId, eventBus: bus });

    bus.publish({
      kind: 'task',
      id: taskId,
      contextId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      history: [userMessage],
      artifacts: [],
    });

    const sent = this.registry.sendToAgent(this.agentId, {
      type: 'task.assign',
      taskId,
      contextId,
      message: {
        role: userMessage.role,
        parts: userMessage.parts as never,
        messageId: userMessage.messageId,
      },
    });

    if (!sent) {
      console.log(JSON.stringify({
        event: 'task_unreachable',
        agentId: this.agentId,
        taskId,
        contextId,
        ts: new Date().toISOString(),
      }));
      bus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        final: true,
        status: {
          state: 'failed',
          timestamp: new Date().toISOString(),
          message: {
            kind: 'message',
            role: 'agent',
            messageId: `${taskId}-unreach`,
            parts: [{ kind: 'text', text: 'client not connected' }],
            taskId,
            contextId,
          },
        },
      });
      bus.finished();
      this.registry.unbindTask(taskId);
    }
  }

  async cancelTask(taskId: string, _bus: ExecutionEventBus): Promise<void> {
    this.registry.sendToAgent(this.agentId, { type: 'task.cancel', taskId });
  }
}
