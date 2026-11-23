import { z } from 'zod';
import type { ResponsesApiItem } from './codex-rpc.js';

// Keep references only. Read user-visible history from the app server when a
// verified conversation actually needs a different set of native tools.
export interface HostTurn {
  threadId: string;
  turnId: string;
}
export const MAX_HOST_HISTORY_TURNS = 128;
const MAX_INJECT_BYTES = 512 * 1024;
const threadView = z.object({
  thread: z.object({
    id: z.string(),
    turns: z.array(z.object({
      id: z.string(), status: z.string(), itemsView: z.string().optional(),
      items: z.array(z.object({ type: z.string() }).passthrough()),
    })),
  }),
});
const textInputs = z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1);
const proposalCall = z.object({
  id: z.string(), tool: z.literal('propose_operation'), arguments: z.unknown(),
  success: z.boolean(), contentItems: z.array(z.object({ type: z.literal('inputText'), text: z.string() })),
});

export async function readHostConversation(
  turns: readonly HostTurn[],
  readThread: (threadId: string) => Promise<unknown>,
): Promise<ResponsesApiItem[]> {
  const output: ResponsesApiItem[] = [];
  let bytes = 0;
  function append(item: ResponsesApiItem) {
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > MAX_INJECT_BYTES) throw new Error('History exceeds replay budget');
    output.push(item);
  }
  let source: z.infer<typeof threadView>['thread'] | undefined;
  for (const ref of turns) {
    if (source?.id !== ref.threadId) {
      source = threadView.parse(await readThread(ref.threadId)).thread;
      if (source.id !== ref.threadId) throw new Error('Unexpected history source');
    }
    const turn = source.turns.find(t => t.id === ref.turnId);
    if (!turn || turn.status !== 'completed' || (turn.itemsView && turn.itemsView !== 'full')) {
      throw new Error('Incomplete prior turn');
    }
    let sawUser = false;
    for (const item of turn.items) {
      switch (item.type) {
        case 'userMessage': {
          const input = textInputs.parse(item.content);
          if (sawUser) throw new Error('Ambiguous prior turn');
          sawUser = true;
          append({ type: 'message', role: 'user', content: input.map(p => ({ type: 'input_text', text: p.text })) });
          break;
        }
        case 'agentMessage':
          if (typeof item.text !== 'string') throw new Error('Incomplete assistant message');
          append({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] });
          break;
        case 'dynamicToolCall': {
          const call = proposalCall.parse(item);
          append({ type: 'function_call', call_id: call.id, name: call.tool, arguments: JSON.stringify(call.arguments) });
          append({ type: 'function_call_output', call_id: call.id, output: JSON.stringify({ success: call.success, contentItems: call.contentItems }) });
          break;
        }
        case 'reasoning':
          // Private model reasoning is not part of the caller-visible exchange.
          break;
        default:
          // Native file operations, local images, compaction and unknown item
          // types cannot be faithfully reconstructed as prior Responses items.
          throw new Error('Unsupported native history item');
      }
    }
    if (!sawUser) throw new Error('Missing user message');
  }
  return output;
}
