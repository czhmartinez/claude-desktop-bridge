import { EventEmitter } from "node:events";
import type {
  BridgeDesktopRuntime,
  BridgeDesktopRuntimeId,
  BridgeDesktopRuntimeState,
  BridgeEffort,
  BridgeHistoryItem,
  BridgeModelInfo,
  BridgePermissionDecision,
  BridgeRuntimeProviderInfo,
  BridgeRuntimeCapability,
  BridgeSessionTransport,
  BridgeTurnState,
} from "@bridge/protocol";

export interface RuntimeAdapterSession {
  nativeSessionId: string;
  cwd: string;
  title: string;
  source: "desktop" | "bridge";
  createdAt: number;
  lastActivityAt: number;
  turnState: BridgeTurnState;
  transport: BridgeSessionTransport;
  activeTurnId?: string;
  provider?: string;
  model?: string;
  effort?: BridgeEffort;
  reasoningEffort?: string;
  fast?: boolean;
}

export interface RuntimeAdapterConfiguration {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  fast?: boolean;
  availableModels: BridgeModelInfo[];
  availableProviders: BridgeRuntimeProviderInfo[];
  availableReasoningEfforts: string[];
  modelsComplete: boolean;
  supportsFastMode: boolean;
  appliesAfterTurn: boolean;
}

export interface RuntimeAdapterConfigurationChange {
  provider?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  fast?: boolean | null;
}

export interface RuntimeAdapterHistoryItem {
  id: string;
  turnId?: string;
  role: BridgeHistoryItem["role"];
  text: string;
  createdAt: number;
  toolName?: string;
  state?: BridgeTurnState;
}

export interface RuntimeAdapterTurnInput {
  nativeSessionId: string;
  text: string;
  commandId: string;
  requestId: string;
  sourceDeviceId?: string;
}

export interface RuntimeAdapterTurnResult {
  turnId?: string;
  state: "queued" | "running";
}

export interface RuntimeAdapterGoal {
  objective: string;
  status: "active" | "paused" | "blocked" | "complete";
  detail?: string;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  updatedAt: number;
}

export interface RuntimeAdapterPermission {
  requestId: string;
  nativeSessionId: string;
  toolUseId: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  input: Record<string, unknown>;
  createdAt: number;
  canAllowAlways: boolean;
  question?: boolean;
}

export type RuntimeAdapterEvent =
  | { type: "session.updated"; session: RuntimeAdapterSession }
  | { type: "turn.started"; nativeSessionId: string; turnId?: string; at: number }
  | { type: "turn.completed"; nativeSessionId: string; turnId?: string; at: number; result?: string }
  | { type: "turn.failed"; nativeSessionId: string; turnId?: string; at: number; error: string }
  | { type: "turn.interrupted"; nativeSessionId: string; turnId?: string; at: number }
  | { type: "user.accepted"; nativeSessionId: string; turnId?: string; itemId?: string; text: string; at: number }
  | { type: "assistant.delta"; nativeSessionId: string; turnId?: string; itemId?: string; text: string; at: number }
  | { type: "assistant.completed"; nativeSessionId: string; turnId?: string; itemId?: string; text: string; at: number }
  | { type: "tool.started"; nativeSessionId: string; turnId?: string; itemId: string; toolName: string; input?: unknown; at: number }
  | { type: "tool.progress"; nativeSessionId: string; turnId?: string; itemId: string; toolName: string; text?: string; at: number }
  | { type: "tool.completed"; nativeSessionId: string; turnId?: string; itemId: string; toolName: string; output?: unknown; at: number }
  | { type: "permission.requested"; permission: RuntimeAdapterPermission }
  | { type: "permission.resolved"; nativeSessionId: string; requestId: string; at: number; decision: BridgePermissionDecision }
  | { type: "goal.updated"; nativeSessionId: string; goal: RuntimeAdapterGoal }
  | { type: "goal.cleared"; nativeSessionId: string; at: number };

export abstract class DesktopRuntimeAdapter extends EventEmitter {
  private statusValue: BridgeDesktopRuntime;

  protected constructor(
    readonly id: BridgeDesktopRuntimeId,
    name: string,
    capabilities: BridgeRuntimeCapability[],
  ) {
    super();
    this.statusValue = {
      id,
      name,
      state: "starting",
      detail: "正在发现本机运行时。",
      capabilities,
      sessionIsolation: "independent",
      sessionCount: 0,
      updatedAt: Date.now(),
    };
  }

  status(): BridgeDesktopRuntime {
    return {
      ...this.statusValue,
      capabilities: [...this.statusValue.capabilities],
    };
  }

  protected setStatus(
    state: BridgeDesktopRuntimeState,
    detail: string,
    change: Partial<Pick<BridgeDesktopRuntime, "appVersion" | "sessionCount">> = {},
  ): void {
    this.statusValue = {
      ...this.statusValue,
      ...change,
      state,
      detail,
      updatedAt: Date.now(),
    };
    this.emit("changed", this.status());
  }

  protected setSessionCount(sessionCount: number): void {
    if (this.statusValue.sessionCount === sessionCount) return;
    this.statusValue = { ...this.statusValue, sessionCount, updatedAt: Date.now() };
    this.emit("changed", this.status());
  }

  protected emitRuntimeEvent(event: RuntimeAdapterEvent): void {
    this.emit("event", event);
  }

  abstract initialize(): Promise<void>;
  abstract refresh(): Promise<void>;
  abstract sessions(): RuntimeAdapterSession[];
  abstract createSession(input: { cwd: string; title?: string }): Promise<RuntimeAdapterSession>;
  abstract history(nativeSessionId: string): Promise<RuntimeAdapterHistoryItem[]>;
  abstract configuration(nativeSessionId: string): Promise<RuntimeAdapterConfiguration>;
  abstract configureSession(
    nativeSessionId: string,
    change: RuntimeAdapterConfigurationChange,
  ): Promise<RuntimeAdapterConfiguration>;
  abstract startTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult>;
  abstract steerTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult>;
  abstract interruptTurn(nativeSessionId: string): Promise<boolean>;
  abstract resolvePermission(
    requestId: string,
    decision: BridgePermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean>;
  abstract close(): Promise<void>;

  /**
   * Optional native plan/goal hooks (0.7). Only adapters declaring
   * "goal.native" implement them; other runtimes get Bridge-orchestrated
   * goal emulation instead. Returning false means the runtime rejected
   * the operation and the caller must fall back to prompt contracts.
   */
  async setCollaborationMode(_nativeSessionId: string, _mode: "plan" | "default"): Promise<boolean> {
    return false;
  }

  async goalSet(_nativeSessionId: string, _objective: string): Promise<boolean> {
    return false;
  }

  async goalGet(_nativeSessionId: string): Promise<RuntimeAdapterGoal | undefined> {
    return undefined;
  }

  async goalPause(_nativeSessionId: string): Promise<boolean> {
    return false;
  }

  async goalResume(_nativeSessionId: string): Promise<boolean> {
    return false;
  }
}

export class RuntimeAdapterRegistry extends EventEmitter {
  private initialized = false;

  constructor(private readonly adapters: DesktopRuntimeAdapter[]) {
    super();
    for (const adapter of adapters) {
      adapter.on("changed", () => this.emit("changed", adapter.status()));
      adapter.on("event", (event: RuntimeAdapterEvent) => this.emit("event", adapter.id, event));
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const adapter of this.adapters) {
      void this.initializeAdapter(adapter);
    }
  }

  runtimes(): BridgeDesktopRuntime[] {
    return this.adapters.map((adapter) => adapter.status());
  }

  adapter(id: BridgeDesktopRuntimeId): DesktopRuntimeAdapter | undefined {
    return this.adapters.find((adapter) => adapter.id === id);
  }

  async refresh(id?: BridgeDesktopRuntimeId): Promise<BridgeDesktopRuntime[]> {
    const targets = id ? [this.adapter(id)].filter((adapter): adapter is DesktopRuntimeAdapter => Boolean(adapter)) : this.adapters;
    await Promise.all(targets.map(async (adapter) => {
      const status = adapter.status();
      if (status.state === "starting") return;
      if (status.state === "ready") {
        try {
          await adapter.refresh();
        } catch (error) {
          this.emit("adapter-error", adapter.id, error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      await adapter.close().catch(() => undefined);
      void this.initializeAdapter(adapter);
    }));
    return this.runtimes();
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.adapters.map((adapter) => adapter.close()));
  }

  private async initializeAdapter(adapter: DesktopRuntimeAdapter): Promise<void> {
    try {
      await adapter.initialize();
    } catch (error) {
      this.emit("adapter-error", adapter.id, error instanceof Error ? error : new Error(String(error)));
    }
  }
}
