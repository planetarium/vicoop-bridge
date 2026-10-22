import { useEffect, useState } from 'react';
import { useAuthSession } from '../lib/auth-token';

type Approval = { requestId: string; agentId: string; taskId: string; toolName: string;
  input: Record<string, unknown>; expiresAt: string; state: string };
export function Approvals() {
  const session = useAuthSession();
  const [items, setItems] = useState<Approval[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!session) return;
    const ac = new AbortController();
    const refresh = async () => {
      try {
        const r = await fetch('/admin-api/approvals', { headers: { Authorization: `Bearer ${session.token}` }, signal: ac.signal });
        if (!r.ok) throw new Error(`Approval list unavailable (${r.status})`);
        const body = await r.json();
        if (!ac.signal.aborted) setItems(body.approvals);
      } catch (e) { if (!ac.signal.aborted) setError(String(e)); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { ac.abort(); clearInterval(timer); };
  }, [session]);
  async function decide(a: Approval, decision: 'allow_once' | 'deny') {
    if (!session) return;
    setBusy(a.requestId); setError('');
    try {
      const r = await fetch(`/admin-api/agents/${encodeURIComponent(a.agentId)}/approvals/${a.requestId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `Approval failed (${r.status})`);
      setItems(old => old.map(item => item.requestId === a.requestId ? { ...item, state: 'decided' } : item));
    } catch (e) { setError(String(e)); }
    finally { setBusy(null); }
  }
  return <section className="shrink-0 max-h-96 overflow-y-auto border-b border-zinc-800 px-6 py-3" aria-label="Tool approvals">
    <h2 className="text-sm font-semibold text-zinc-100">Tool approvals {items.length ? `(${items.length})` : ''}</h2>
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {items.length === 0 && <p className="text-xs text-zinc-500">No tools waiting for approval.</p>}
    {items.map(a => <article key={a.requestId} className="mt-3 rounded border border-zinc-700 p-3">
      <p className="text-sm text-zinc-100">{a.agentId} · {a.toolName}</p>
      <p className="text-xs text-zinc-400">Task {a.taskId} · Expires {new Date(a.expiresAt).toLocaleString()}</p>
      <pre className="my-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-zinc-200">{JSON.stringify(a.input, null, 2)}</pre>
      {a.state === 'pending' ? <div className="flex gap-2">
        <button disabled={busy !== null || Date.parse(a.expiresAt) <= Date.now()} onClick={() => void decide(a, 'allow_once')} className="rounded bg-emerald-800 px-3 py-1 text-sm text-white disabled:opacity-50">Allow once</button>
        <button disabled={busy !== null} onClick={() => void decide(a, 'deny')} className="rounded bg-zinc-700 px-3 py-1 text-sm text-white disabled:opacity-50">Deny</button>
      </div> : <p className="text-xs text-zinc-400">Decision recorded; waiting for the agent to receive it.</p>}
    </article>)}
  </section>;
}
