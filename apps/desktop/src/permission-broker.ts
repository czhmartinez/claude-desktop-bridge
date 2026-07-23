import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type PermissionDecision = "allow-once" | "allow-always" | "deny";

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions: PermissionUpdate[];
  createdAt: number;
}

interface PendingResolver {
  request: PendingPermission;
  resolve(result: PermissionResult): void;
  abort(): void;
}

export class PermissionBroker extends EventEmitter {
  private readonly pending = new Map<string, PendingResolver>();

  list(sessionId?: string): PendingPermission[] {
    return [...this.pending.values()]
      .map((entry) => entry.request)
      .filter((request) => !sessionId || request.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async request(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      toolUseId: string;
      suggestions?: PermissionUpdate[];
      title?: string;
      displayName?: string;
      description?: string;
    },
  ): Promise<PermissionResult> {
    const request: PendingPermission = {
      requestId: randomUUID(),
      sessionId,
      toolUseId: options.toolUseId,
      toolName,
      input,
      suggestions: options.suggestions ?? [],
      createdAt: Date.now(),
      ...(options.title ? { title: options.title } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.description ? { description: options.description } : {}),
    };
    return new Promise<PermissionResult>((resolve) => {
      const finish = (result: PermissionResult) => {
        if (!this.pending.delete(request.requestId)) return;
        options.signal.removeEventListener("abort", abort);
        resolve(result);
        this.emit("resolved", request, result);
      };
      const abort = () => finish({
        behavior: "deny",
        message: "Bridge session ended before this request was answered.",
        toolUseID: request.toolUseId,
      });
      this.pending.set(request.requestId, { request, resolve: finish, abort });
      options.signal.addEventListener("abort", abort, { once: true });
      this.emit("requested", request);
    });
  }

  resolveRequest(
    requestId: string,
    decision: PermissionDecision,
    message = "User denied this action.",
    updatedInput?: Record<string, unknown>,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (decision === "deny") {
      pending.resolve({ behavior: "deny", message, toolUseID: pending.request.toolUseId });
      return true;
    }
    const updatedPermissions = decision === "allow-always"
      ? pending.request.suggestions.filter((suggestion) => suggestion.destination === "localSettings")
      : [];
    pending.resolve({
      behavior: "allow",
      updatedInput: updatedInput ?? pending.request.input,
      toolUseID: pending.request.toolUseId,
      ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
    });
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId === sessionId) pending.abort();
    }
  }
}
