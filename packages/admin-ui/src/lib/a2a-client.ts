const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? '';

interface TextPart {
  kind: 'text';
  text: string;
}

export interface A2AMessage {
  kind: 'message';
  messageId: string;
  role: 'user' | 'agent';
  parts: TextPart[];
  taskId: string;
  contextId: string;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: {
    state: 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';
    message?: A2AMessage;
    timestamp: string;
  };
  history: A2AMessage[];
  artifacts: unknown[];
}

let rpcId = 0;

export async function sendMessage(
  text: string,
  token: string,
  taskId?: string,
  contextId?: string,
): Promise<A2ATask> {
  const msgTaskId = taskId ?? crypto.randomUUID();
  const msgContextId = contextId ?? crypto.randomUUID();

  const body = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text }],
        taskId: msgTaskId,
        contextId: msgContextId,
      },
    },
  };

  const res = await fetch(SERVER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }));
    throw new Error(err.error?.message ?? `HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message ?? 'JSON-RPC error');
  }

  return json.result as A2ATask;
}
