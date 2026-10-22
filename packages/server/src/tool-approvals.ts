import { APPROVAL_EXTENSION_URI, type ApprovalDecision, type ApprovalRequest } from '@vicoop-bridge/protocol';
import type { Registry, TaskBinding } from './registry.js';
import { logEvent } from './log.js';

export interface ToolApproval extends ApprovalRequest {
  agentId: string; taskId: string; executionId: string;
  state: 'pending' | 'decided' | 'received' | 'expired' | 'invalidated';
  decision?: ApprovalDecision; decidedBy?: string;
}
// Execution-scoped state: grants are invalid after a server restart, even
// if a client process is still alive. Audit events go to structured logs and
// A2A status messages to the task store. Never
// reconstruct executable permission grants from chat history or task artifacts.
export class ToolApprovals {
  private entries = new Map<string, ToolApproval>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private registry: Registry) {}
  private live(a: ToolApproval): boolean {
    const b = this.registry.getBinding(a.taskId);
    return b?.agentId === a.agentId && b.executionId === a.executionId;
  }
  request(binding: TaskBinding, request: ApprovalRequest): ToolApproval {
    if (!binding.executionId) throw new Error('Approval requires execution replay');
    if (Date.parse(request.expiresAt) <= Date.now() || Date.parse(request.expiresAt) > Date.now() + 11 * 60_000)
      throw new Error('Invalid approval expiry');
    if (JSON.stringify(request).length > 70_000) throw new Error('Approval request too large');
    if (this.entries.has(request.requestId) || this.waiting(binding)) throw new Error('Duplicate approval request');
    const a: ToolApproval = { ...structuredClone(request), agentId: binding.agentId, taskId: binding.taskId,
      executionId: binding.executionId, state: 'pending' };
    this.entries.set(a.requestId, a);
    this.audit(a, 'requested');
    this.tick(a);
    return a;
  }
  waiting(binding: TaskBinding): ToolApproval | undefined {
    return [...this.entries.values()].find(a => a.executionId === binding.executionId &&
      a.taskId === binding.taskId && (a.state === 'pending' || a.state === 'decided'));
  }
  list(): ToolApproval[] {
    return [...this.entries.values()].filter(a => this.live(a) && (a.state === 'pending' || a.state === 'decided'));
  }
  get(id: string): ToolApproval | undefined { return this.entries.get(id); }
  decide(id: string, decision: ApprovalDecision, principal: string): ToolApproval | undefined {
    const a = this.entries.get(id);
    if (!a || !this.live(a) || Date.parse(a.expiresAt) <= Date.now()) return undefined;
    if (a.state !== 'pending') {
      return (a.state === 'decided' || a.state === 'received') && a.decision === decision && a.decidedBy === principal ? a : undefined;
    }
    a.state = 'decided'; a.decision = decision; a.decidedBy = principal;
    this.audit(a, 'decided');
    this.deliver(a);
    return a;
  }
  received(binding: TaskBinding, id: string, decision: ApprovalDecision): ToolApproval | undefined {
    const a = this.entries.get(id);
    if (!a || a.executionId !== binding.executionId || a.taskId !== binding.taskId || a.agentId !== binding.agentId) return;
    if (a.state !== 'pending' && a.state !== 'decided') return;
    // A client may deny locally (expiry, cancellation, process exit), but
    // cannot acknowledge an allow that the server never granted.
    if (decision === 'allow_once' && (a.state !== 'decided' || a.decision !== decision)) return;
    a.state = 'received'; a.decision = decision;
    this.clear(a); this.audit(a, 'received');
    return a;
  }
  invalidate(binding: TaskBinding): void {
    for (const a of this.entries.values()) if (a.executionId === binding.executionId && a.taskId === binding.taskId) {
      this.clear(a);
      if (a.state === 'pending' || a.state === 'decided') { a.state = 'invalidated'; this.audit(a, 'invalidated'); }
      this.entries.delete(a.requestId);
    }
  }
  private deliver(a: ToolApproval): void {
    if (!this.live(a) || !a.decision) return;
    this.registry.sendToAgent(a.agentId, { type: 'approval.resolve', taskId: a.taskId,
      executionId: a.executionId, requestId: a.requestId, decision: a.decision });
  }
  private tick(a: ToolApproval): void {
    this.clear(a);
    const timer = setTimeout(() => {
      if (!this.live(a)) { this.entries.delete(a.requestId); this.clear(a); return; }
      if (a.state !== 'pending' && a.state !== 'decided') return;
      if (Date.now() >= Date.parse(a.expiresAt)) {
        a.state = 'expired'; a.decision = 'deny'; this.deliver(a); this.audit(a, 'expired');
        this.clear(a);
        // A dead backend must not leave a Task waiting indefinitely.
        const b = this.registry.getBinding(a.taskId);
        if (b) {
          this.registry.sendToAgent(a.agentId, { type: 'task.cancel', taskId: a.taskId, executionId: a.executionId });
          this.registry.failTaskBinding(b, 'approval_expired', 'Remote tool approval expired');
        }
        return;
      }
      if (a.state === 'decided') this.deliver(a);
      this.tick(a);
    }, 1000);
    timer.unref(); this.timers.set(a.requestId, timer);
  }
  private clear(a: ToolApproval): void { clearTimeout(this.timers.get(a.requestId)); this.timers.delete(a.requestId); }
  private audit(a: ToolApproval, event: string): void {
    logEvent(`tool_approval_${event}`, { agentId: a.agentId, taskId: a.taskId, executionId: a.executionId,
      requestId: a.requestId, toolName: a.toolName, decision: a.decision, decidedBy: a.decidedBy });
  }
}
export function approvalStatus(a: ToolApproval) {
  return { state: 'auth-required' as const, timestamp: new Date().toISOString(), message: {
    role: 'agent' as const, messageId: a.requestId,
    parts: [{ kind: 'text' as const, text: `Owner approval required for ${a.toolName}` }],
    metadata: { [APPROVAL_EXTENSION_URI]: { requestId: a.requestId, toolName: a.toolName, input: a.input,
      expiresAt: a.expiresAt, decisions: ['allow_once', 'deny'],
      decisionUrl: `/admin-api/agents/${encodeURIComponent(a.agentId)}/approvals/${a.requestId}` } },
    extensions: [APPROVAL_EXTENSION_URI],
  } };
}
