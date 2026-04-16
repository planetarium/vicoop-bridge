import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const markdownComponents: Components = {
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-zinc-700">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-zinc-800/80 text-zinc-300">{children}</thead>
  ),
  tbody: ({ children }) => (
    <tbody className="divide-y divide-zinc-700/50">{children}</tbody>
  ),
  tr: ({ children }) => (
    <tr className="hover:bg-zinc-800/40 transition-colors">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-400">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 whitespace-nowrap">{children}</td>
  ),
};

interface MessageProps {
  role: 'user' | 'agent';
  text: string;
}

export function Message({ role, text }: MessageProps) {
  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] px-4 py-3 rounded-2xl ${
          isUser
            ? 'bg-blue-600 text-white'
            : 'bg-zinc-800 text-zinc-100 border border-zinc-700'
        }`}
      >
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
