import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  BridgePermissionDecision,
  BridgePermissionResolution,
} from "@bridge/protocol";
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export type PermissionDecision = BridgePermissionDecision;

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

export interface ExternalPermissionRequest {
  requestId: string;
  sessionId: string;
  toolUseId?: string;
  toolName: string;
  input?: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  title?: string;
  displayName?: string;
  description?: string;
  createdAt?: number;
}

interface PendingResolver {
  request: PendingPermission;
  resolve(result: PermissionResult, resolution: BridgePermissionResolution): void;
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
      const finish = (result: PermissionResult, resolution: BridgePermissionResolution) => {
        if (!this.pending.delete(request.requestId)) return;
        options.signal.removeEventListener("abort", abort);
        resolve(result);
        this.emit("resolved", request, result, resolution);
      };
      const abort = () => finish({
        behavior: "deny",
        message: "Bridge session ended before this request was answered.",
        toolUseID: request.toolUseId,
      }, {
        requestId: request.requestId,
        decision: "deny",
        resolvedByDeviceId: "system",
        resolvedByName: "Bridge",
        resolvedAt: Date.now(),
      });
      this.pending.set(request.requestId, { request, resolve: finish, abort });
      options.signal.addEventListener("abort", abort, { once: true });
      this.emit("requested", request);
    });
  }

  registerExternal(
    input: ExternalPermissionRequest,
    responder: (
      decision: PermissionDecision,
      updatedInput?: Record<string, unknown>,
    ) => Promise<void> | void,
  ): boolean {
    if (this.pending.has(input.requestId)) return false;
    const request: PendingPermission = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId ?? input.requestId,
      toolName: input.toolName,
      input: input.input ?? {},
      suggestions: input.suggestions ?? [],
      createdAt: input.createdAt ?? Date.now(),
      ...(input.title ? { title: input.title } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
    const finish = (result: PermissionResult, resolution: BridgePermissionResolution) => {
      if (!this.pending.delete(request.requestId)) return;
      const updatedInput = result.behavior === "allow" ? result.updatedInput : undefined;
      void Promise.resolve(responder(resolution.decision, updatedInput)).catch((error) => {
        this.emit("external-error", request, error);
      });
      this.emit("resolved", request, result, resolution);
    };
    const abort = () => finish({
      behavior: "deny",
      message: "Bridge session ended before this request was answered.",
      toolUseID: request.toolUseId,
    }, {
      requestId: request.requestId,
      decision: "deny",
      resolvedByDeviceId: "system",
      resolvedByName: "Bridge",
      resolvedAt: Date.now(),
    });
    this.pending.set(request.requestId, { request, resolve: finish, abort });
    this.emit("requested", request);
    return true;
  }

  resolveRequest(
    requestId: string,
    decision: PermissionDecision,
    message = "User denied this action.",
    updatedInput?: Record<string, unknown>,
    resolver: {
      deviceId: string;
      name: string;
    } = {
      deviceId: "desktop",
      name: "电脑端 Bridge",
    },
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    const canAllowAlways = pending.request.suggestions.some(
      (suggestion) => suggestion.destination === "localSettings",
    );
    const effectiveDecision = decision === "allow-always" && !canAllowAlways
      ? "allow-once"
      : decision;
    const resolution: BridgePermissionResolution = {
      requestId,
      decision: effectiveDecision,
      resolvedByDeviceId: resolver.deviceId,
      resolvedByName: resolver.name,
      resolvedAt: Date.now(),
    };
    if (effectiveDecision === "deny") {
      pending.resolve(
        { behavior: "deny", message, toolUseID: pending.request.toolUseId },
        resolution,
      );
      return true;
    }
    const updatedPermissions = effectiveDecision === "allow-always"
      ? pending.request.suggestions.filter((suggestion) => suggestion.destination === "localSettings")
      : [];
    pending.resolve(
      {
        behavior: "allow",
        updatedInput: updatedInput ?? pending.request.input,
        toolUseID: pending.request.toolUseId,
        ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}),
      },
      resolution,
    );
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId === sessionId) pending.abort();
    }
  }
}
