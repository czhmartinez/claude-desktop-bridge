import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface CdpResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

interface PendingCall {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpPipeIo {
  reader: Readable;
  writer: Writable;
}

export interface ClaudeDesktopHandshake {
  appVersion: string;
  buildFingerprint: string;
  sessionCount: number;
  methods: string[];
}

const REQUIRED_METHODS = [
  "start",
  "getAll",
  "getSession",
  "getTranscript",
  "getTranscriptTail",
  "sendMessage",
  "interrupt",
  "setModel",
  "setEffort",
  "getContextUsage",
  "onOnEvent",
  "onOnToolPermissionRequest",
  "respondToToolPermission",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resultValue(result: Record<string, unknown>): unknown {
  const remote = record(result.result);
  return remote?.value;
}

export class CdpPipeClient extends EventEmitter {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(private readonly io: CdpPipeIo) {
    super();
    io.reader.on("data", (chunk: Buffer | string) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    io.reader.on("end", () => this.close(new Error("Claude Desktop debugging pipe closed")));
    io.reader.on("error", (error) => this.close(error));
    io.writer.on("error", (error) => this.close(error));
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("Claude Desktop debugging pipe is closed"));
    const id = this.nextId++;
    const message: CdpRequest = {
      id,
      method,
      ...(params ? { params } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Claude Desktop CDP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.io.writer.write(`${JSON.stringify(message)}\0`);
    });
  }

  shutdown(): void {
    this.close(new Error("Claude Desktop CDP client stopped"));
    this.io.writer.end();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let delimiter = this.buffer.indexOf(0);
    while (delimiter >= 0) {
      const raw = this.buffer.subarray(0, delimiter).toString("utf8");
      this.buffer = this.buffer.subarray(delimiter + 1);
      if (raw) this.handle(raw);
      delimiter = this.buffer.indexOf(0);
    }
  }

  private handle(raw: string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      this.emit("protocol-error", new Error("Claude Desktop returned invalid CDP JSON"));
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `CDP error ${message.error.code ?? "unknown"}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.emit("event", message);
  }

  private close(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("close", error);
  }
}

export class ClaudeDesktopCdpAdapter extends EventEmitter {
  private sessionId: string | undefined;
  private localSessionsObjectId: string | undefined;
  private readonly bindingName = `__bridgeManaged_${randomUUID().replaceAll("-", "")}`;
  private readonly cleanupName = `__bridgeManagedCleanup_${randomUUID().replaceAll("-", "")}`;
  private attaching: Promise<ClaudeDesktopHandshake> | undefined;

  constructor(
    private readonly client: CdpPipeClient,
    private readonly expectedAppVersion?: string,
  ) {
    super();
    client.on("event", (message: CdpResponse) => this.handleCdpEvent(message));
    client.on("close", (error) => this.emit("disconnected", error));
  }

  attach(): Promise<ClaudeDesktopHandshake> {
    this.attaching ??= this.attachInternal().finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }

  async call(method: string, args: unknown[] = []): Promise<unknown> {
    if (!this.sessionId || !this.localSessionsObjectId) await this.attach();
    const result = await this.client.request("Runtime.callFunctionOn", {
      objectId: this.localSessionsObjectId,
      functionDeclaration: "function(method, args) { return this[method](...args); }",
      arguments: [{ value: method }, { value: args }],
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    }, this.sessionId);
    const exception = record(result.exceptionDetails);
    if (exception) {
      const exceptionValue = record(exception.exception);
      throw new Error(
        typeof exception.text === "string"
          ? exception.text
          : typeof exceptionValue?.description === "string"
            ? exceptionValue.description
            : `Claude Desktop LocalSessions.${method} failed`,
      );
    }
    return resultValue(result);
  }

  async detach(): Promise<void> {
    if (!this.sessionId) return;
    await this.evaluate(`globalThis[${JSON.stringify(this.cleanupName)}]?.()`).catch(() => undefined);
    this.localSessionsObjectId = undefined;
    const sessionId = this.sessionId;
    this.sessionId = undefined;
    await this.client.request("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  private async attachInternal(): Promise<ClaudeDesktopHandshake> {
    await this.client.request("Target.setDiscoverTargets", { discover: true });
    const target = await this.waitForMainTarget();
    const attached = await this.client.request("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== "string") throw new Error("Claude Desktop renderer attach failed");
    this.sessionId = attached.sessionId;
    await this.client.request("Runtime.enable", undefined, this.sessionId);
    await this.client.request("Runtime.addBinding", { name: this.bindingName }, this.sessionId);

    const api = await this.client.request("Runtime.evaluate", {
      expression: "globalThis['claude.web']?.LocalSessions",
      returnByValue: false,
      awaitPromise: true,
    }, this.sessionId);
    const remote = record(api.result);
    if (remote?.type !== "object" || typeof remote.objectId !== "string") {
      throw new Error("Claude Desktop LocalSessions API is unavailable");
    }
    this.localSessionsObjectId = remote.objectId;

    const capabilities = await this.evaluate(`
      (() => {
        const api = globalThis["claude.web"]?.LocalSessions;
        const required = ${JSON.stringify(REQUIRED_METHODS)};
        return {
          appVersion: String(globalThis.process?.version ?? "unknown"),
          methods: required.filter((name) => typeof api?.[name] === "function"),
        };
      })()
    `);
    const capabilityRecord = record(capabilities);
    const methods = Array.isArray(capabilityRecord?.methods)
      ? capabilityRecord.methods.filter((value): value is string => typeof value === "string")
      : [];
    const missing = REQUIRED_METHODS.filter((method) => !methods.includes(method));
    if (missing.length) throw new Error(`Claude Desktop LocalSessions API is incompatible: ${missing.join(", ")}`);

    const sessions = await this.call("getAll");
    if (!Array.isArray(sessions)) throw new Error("Claude Desktop LocalSessions.getAll returned invalid data");
    for (const session of sessions) {
      const value = record(session);
      if (
        !value ||
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.isRunning !== "boolean"
      ) throw new Error("Claude Desktop session shape is incompatible");
    }
    await this.installEventBindings();
    const appVersion = this.expectedAppVersion
      ?? (typeof capabilityRecord?.appVersion === "string"
        ? capabilityRecord.appVersion
        : "unknown");
    return {
      appVersion,
      methods,
      sessionCount: sessions.length,
      buildFingerprint: createHash("sha256")
        .update(`${appVersion}\0${[...methods].sort().join("\0")}`)
        .digest("hex")
        .slice(0, 16),
    };
  }

  private async waitForMainTarget(): Promise<{ targetId: string }> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = await this.client.request("Target.getTargets");
      const targets = Array.isArray(result.targetInfos) ? result.targetInfos : [];
      const target = targets
        .map(record)
        .find((candidate) => (
          candidate?.type === "page" &&
          typeof candidate.targetId === "string" &&
          typeof candidate.url === "string" &&
          (
            candidate.url.startsWith("app://localhost") ||
            candidate.url.startsWith("https://claude.")
          )
        ));
      if (target && typeof target.targetId === "string") return { targetId: target.targetId };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Claude Desktop main renderer was not found");
  }

  private async installEventBindings(): Promise<void> {
    const script = `
      (() => {
        const api = globalThis["claude.web"]?.LocalSessions;
        const binding = globalThis[${JSON.stringify(this.bindingName)}];
        globalThis[${JSON.stringify(this.cleanupName)}]?.();
        const emit = (kind, payload) => {
          try { binding(JSON.stringify({ kind, payload })); } catch {}
        };
        const stops = [
          api.onOnEvent((payload) => emit("event", payload)),
          api.onOnToolPermissionRequest((payload) => emit("permission", payload)),
        ].filter((stop) => typeof stop === "function");
        globalThis[${JSON.stringify(this.cleanupName)}] = () => {
          for (const stop of stops) {
            try { stop(); } catch {}
          }
          delete globalThis[${JSON.stringify(this.cleanupName)}];
        };
        emit("binding-ready", { ok: true });
        return true;
      })()
    `;
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("binding-ready", ready);
        reject(new Error("Claude Desktop event binding did not respond"));
      }, 3_000);
      const ready = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once("binding-ready", ready);
    });
    await this.evaluate(script);
    await readyPromise;
  }

  private async evaluate(expression: string): Promise<unknown> {
    if (!this.sessionId) throw new Error("Claude Desktop renderer is not attached");
    const result = await this.client.request("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, this.sessionId);
    const exception = record(result.exceptionDetails);
    if (exception) throw new Error(typeof exception.text === "string" ? exception.text : "Claude Desktop evaluation failed");
    return resultValue(result);
  }

  private handleCdpEvent(message: CdpResponse): void {
    if (message.method === "Runtime.executionContextsCleared" && message.sessionId === this.sessionId) {
      this.localSessionsObjectId = undefined;
      this.sessionId = undefined;
      this.emit("renderer-reload");
      return;
    }
    if (message.method !== "Runtime.bindingCalled" || message.sessionId !== this.sessionId) return;
    const params = message.params ?? {};
    if (params.name !== this.bindingName || typeof params.payload !== "string") return;
    try {
      const value = JSON.parse(params.payload) as { kind?: unknown; payload?: unknown };
      if (value.kind === "binding-ready") this.emit("binding-ready");
      else if (value.kind === "event") this.emit("session-event", value.payload);
      else if (value.kind === "permission") this.emit("permission-request", value.payload);
    } catch {
      this.emit("protocol-error", new Error("Claude Desktop event binding returned invalid JSON"));
    }
  }
}
