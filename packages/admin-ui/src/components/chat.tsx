import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, MessageSquare } from 'lucide-react';
import type { Client } from '@a2a-js/sdk/client';
import { useAuthToken } from '../lib/auth-token';
import { createA2AClient, type Message as A2AMessage } from '../lib/a2a-client';
import { Message } from './message';

function extractText(msg: A2AMessage): string {
  return msg.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
    .join('\n');
}

const EXAMPLE_PROMPTS = [
  'List all registered clients',
  'Show active agents',
  'Register a new client',
];

export function Chat() {
  const token = useAuthToken();
  const [messages, setMessages] = useState<{ role: 'user' | 'agent'; text: string }[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<Client | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [contextId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    clientRef.current = null;
  }, [token]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const getClient = useCallback(async () => {
    if (!clientRef.current) {
      clientRef.current = await createA2AClient(() => tokenRef.current);
    }
    return clientRef.current;
  }, []);

  const send = useCallback(async (text: string) => {
    if (!token || !text.trim()) return;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    setIsLoading(true);
    setError(null);

    try {
      const client = await getClient();
      const result = await client.sendMessage({
        message: {
          kind: 'message',
          messageId: crypto.randomUUID(),
          contextId,
          role: 'user',
          parts: [{ kind: 'text', text }],
        },
      });

      const agentMsg = 'status' in result ? result.status.message : result;
      if (agentMsg) {
        setMessages((prev) => [...prev, { role: 'agent', text: extractText(agentMsg) }]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [token, getClient]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    send(input);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <MessageSquare className="mb-4 h-12 w-12 text-zinc-600" />
            <p className="mb-6 text-zinc-400">Try one of these to get started</p>
            <div className="flex flex-col gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send(prompt)}
                  className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <Message key={i} role={msg.role} text={msg.text} />
          ))
        )}

        {isLoading && (
          <div className="flex justify-start">
            <div className="flex gap-1 px-4 py-3">
              <span className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
              <span className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
              <span className="inline-block h-2 w-2 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-zinc-800 px-6 py-4">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the admin agent..."
            className="flex-1 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-blue-500 transition-colors"
          />
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="rounded-xl bg-blue-600 px-4 py-3 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
