import { randomUUID } from 'node:crypto';
import type { AdapterBackend } from '../backend.js';

export const echoBackend: AdapterBackend = {
  name: 'echo',
  async handle(task, emit) {
    const text = task.message.parts
      .map((p) => (p.kind === 'text' ? p.text : ''))
      .join('');
    emit({
      type: 'task.status',
      taskId: task.taskId,
      status: { state: 'working', timestamp: new Date().toISOString() },
    });
    emit({
      type: 'task.artifact',
      taskId: task.taskId,
      artifact: {
        artifactId: randomUUID(),
        name: 'echo',
        parts: [{ kind: 'text', text: `echo: ${text}` }],
      },
    });
    emit({
      type: 'task.complete',
      taskId: task.taskId,
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          role: 'agent',
          messageId: randomUUID(),
          parts: [{ kind: 'text', text: `echo: ${text}` }],
        },
      },
    });
  },
  async cancel() {},
};
