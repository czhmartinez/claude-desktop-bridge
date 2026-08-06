import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { ClaudeDesktopCdpAdapter, CdpPipeClient } from "./claude-desktop-cdp.js";
import type {
  ManagedDesktopHelperEvent,
  ManagedDesktopHelperRequest,
  ManagedDesktopHelperResponse,
  ManagedDesktopHelperStatus,
} from "./claude-desktop-helper-protocol.js";

const ALLOWED_CALLS = new Set([
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
  "respondToToolPermission",
]);

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function isRequest(value: unknown): value is ManagedDesktopHelperRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<ManagedDesktopHelperRequest>;
  return typeof request.id === "string" &&
    typeof request.token === "string" &&
    typeof request.method === "string";
}

class ClaudeDesktopHelper {
  private statusValue: ManagedDesktopHelperStatus = {
    state: "disconnected",
    detail: "受管 Claude Desktop 尚未启动。",
  };
  private child: ChildProcess | undefined;
  private client: CdpPipeClient | undefined;
  private adapter: ClaudeDesktopCdpAdapter | undefined;
  private readonly subscribers = new Set<Socket>();
  private reattachTimer: ReturnType<typeof setTimeout> | undefined;
  private handshakeReady = false;
  private stoppingChild = false;
  private restoringOrdinaryClaude = false;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  async run(): Promise<void> {
    const windowsPipe = process.platform === "win32" && this.socketPath.startsWith("\\\\.\\pipe\\");
    if (!windowsPipe) {
      await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      await rm(this.socketPath, { force: true });
    }
    const server = createServer((socket) => this.accept(socket));
    server.on("error", (error) => {
      process.stderr.write(`Bridge Claude helper socket failed: ${error.message}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (!windowsPipe) await chmod(this.socketPath, 0o600);

    let cleaningUp = false;
    const cleanup = () => {
      if (cleaningUp) return;
      cleaningUp = true;
      if (this.reattachTimer) clearTimeout(this.reattachTimer);
      for (const socket of this.subscribers) socket.destroy();
      void this.adapter?.detach().catch(() => undefined);
      this.client?.shutdown();
      server.close();
      if (!windowsPipe) void rm(this.socketPath, { force: true });
    };
    process.once("SIGTERM", () => {
      cleanup();
      setTimeout(() => process.exit(0), 100).unref();
    });
    process.once("SIGINT", () => {
      cleanup();
      setTimeout(() => process.exit(0), 100).unref();
    });
    process.once("exit", cleanup);
  }

  private accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    let authenticated = false;
    socket.on("data", (chunk: string) => {
      if (authenticated) return;
      buffer += chunk;
      if (buffer.length > 12 * 1024 * 1024) {
        socket.destroy(new Error("Helper request is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      let request: ManagedDesktopHelperRequest;
      try {
        const value = JSON.parse(raw) as unknown;
        if (!isRequest(value)) throw new Error("Invalid helper request");
        request = value;
      } catch (error) {
        this.respond(socket, {
          id: "invalid",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (request.token !== this.token) {
        this.respond(socket, { id: request.id, ok: false, error: "Unauthorized helper request" });
        return;
      }
      authenticated = true;
      if (request.method === "subscribe") {
        this.subscribers.add(socket);
        socket.on("close", () => this.subscribers.delete(socket));
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result: this.statusValue })}\n`);
        return;
      }
      void this.handle(request).then(
        (result) => this.respond(socket, { id: request.id, ok: true, result }),
        (error) => this.respond(socket, {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  private async handle(request: ManagedDesktopHelperRequest): Promise<unknown> {
    if (request.method === "status") return this.statusValue;
    if (request.method === "launch") {
      return this.launch(request.params.executablePath, request.params.appVersion);
    }
    if (request.method === "stop") return this.stop();
    if (request.method === "call") {
      if (!ALLOWED_CALLS.has(request.params.name)) {
        throw new Error(`Unsupported Claude Desktop method: ${request.params.name}`);
      }
      if (this.statusValue.state !== "ready" || !this.adapter) {
        throw new Error("Claude Desktop managed channel is not ready");
      }
      return this.adapter.call(request.params.name, request.params.args);
    }
    throw new Error("Unsupported helper request");
  }

  private async launch(executablePath: string, appVersion: string): Promise<ManagedDesktopHelperStatus> {
    if (this.child?.exitCode === null && this.statusValue.state === "ready") return this.statusValue;
    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("当前平台不支持 Claude Desktop 受管通道");
    }
    if (process.platform === "darwin" && executablePath !== "/Applications/Claude.app/Contents/MacOS/Claude") {
      throw new Error("Claude Desktop must be installed in /Applications");
    }
    if (process.platform === "win32" && !/\\Claude\.exe$/iu.test(executablePath.replaceAll("/", "\\"))) {
      throw new Error("Claude Desktop must be installed as Claude.exe");
    }
    if (!appVersion.trim()) throw new Error("Claude Desktop version is required");
    this.updateStatus({ state: "starting", detail: "正在连接 Claude Desktop 私有会话通道。" });
    this.handshakeReady = false;
    this.stoppingChild = false;
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(executablePath, ["--remote-debugging-pipe"], {
      detached: false,
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: childEnv,
      windowsHide: true,
    });
    this.child = child;
    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
    });
    child.once("exit", (code, signal) => {
      const failedBeforeHandshake = !this.handshakeReady && !this.stoppingChild;
      this.client?.shutdown();
      this.client = undefined;
      this.adapter = undefined;
      this.child = undefined;
      this.handshakeReady = false;
      this.stoppingChild = false;
      if (failedBeforeHandshake) {
        this.updateStatus({
          state: "incompatible",
          detail: "Claude Desktop 在受管握手完成前退出。Bridge 已停止受管连接，并恢复普通 Claude Desktop。",
          lastError: stderrTail.trim()
            || `Claude Desktop exited before CDP handshake (${signal ?? `code ${code ?? "unknown"}`}).`,
        });
        this.restoreOrdinaryDesktop(executablePath);
      } else {
        this.updateStatus({
          state: "disconnected",
          detail: "受管 Claude Desktop 已退出。",
          ...(signal || code
            ? { lastError: `Claude Desktop exited with ${signal ?? `code ${code}`}` }
            : {}),
        });
      }
    });
    const writer = child.stdio[3] as Writable | null;
    const reader = child.stdio[4] as Readable | null;
    if (!writer || !reader) {
      child.kill("SIGTERM");
      throw new Error("Claude Desktop debugging pipe was not created");
    }
    const client = new CdpPipeClient({ reader, writer });
    const adapter = new ClaudeDesktopCdpAdapter(client, appVersion);
    this.client = client;
    this.adapter = adapter;
    adapter.on("session-event", (event) => this.broadcast({ type: "session-event", data: event }));
    adapter.on("permission-request", (request) => this.broadcast({ type: "permission-request", data: request }));
    adapter.on("renderer-reload", () => this.scheduleReattach());
    adapter.on("disconnected", (error) => {
      this.updateStatus({
        state: "disconnected",
        detail: "Claude Desktop 实时通道已断开。",
        lastError: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      const handshake = await adapter.attach();
      this.handshakeReady = true;
      this.updateStatus({
        state: "ready",
        detail: "Claude Desktop 同步控制已就绪。",
        ...(child.pid ? { claudePid: child.pid } : {}),
        appVersion: handshake.appVersion,
        buildFingerprint: handshake.buildFingerprint,
      });
    } catch (error) {
      // A live Desktop process with an incompatible renderer should remain
      // usable as an ordinary app. Only an early process exit is restored.
      if (child.exitCode === null) this.handshakeReady = true;
      this.updateStatus({
        state: "incompatible",
        detail: "当前 Claude Desktop 版本与实验接口不兼容。",
        ...(child.pid ? { claudePid: child.pid } : {}),
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    return this.statusValue;
  }

  private async stop(): Promise<ManagedDesktopHelperStatus> {
    if (!this.child || this.child.exitCode !== null) {
      this.updateStatus({ state: "disconnected", detail: "受管 Claude Desktop 未运行。" });
      return this.statusValue;
    }
    this.stoppingChild = true;
    this.child.kill("SIGTERM");
    const child = this.child;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
    ]);
    if (child.exitCode === null) {
      throw new Error("Claude Desktop 未能正常退出，请在电脑上手动关闭；Bridge 不会强制结束它。");
    }
    return this.statusValue;
  }

  private restoreOrdinaryDesktop(executablePath: string): void {
    if (this.restoringOrdinaryClaude) return;
    this.restoringOrdinaryClaude = true;
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    try {
      const ordinary = spawn(executablePath, [], {
        detached: true,
        stdio: "ignore",
        env: childEnv,
        windowsHide: true,
      });
      ordinary.unref();
    } finally {
      setTimeout(() => {
        this.restoringOrdinaryClaude = false;
      }, 5_000).unref();
    }
  }

  private scheduleReattach(): void {
    if (this.reattachTimer) clearTimeout(this.reattachTimer);
    this.updateStatus({
      state: "starting",
      detail: "Claude Desktop 页面已刷新，正在恢复实时通道。",
      ...(this.child?.pid ? { claudePid: this.child.pid } : {}),
    });
    this.reattachTimer = setTimeout(() => {
      void this.adapter?.attach().then((handshake) => {
        this.updateStatus({
          state: "ready",
          detail: "Claude Desktop 同步控制已恢复。",
          ...(this.child?.pid ? { claudePid: this.child.pid } : {}),
          appVersion: handshake.appVersion,
          buildFingerprint: handshake.buildFingerprint,
        });
      }).catch((error) => {
        this.updateStatus({
          state: "incompatible",
          detail: "Claude Desktop 页面刷新后无法恢复实验接口。",
          ...(this.child?.pid ? { claudePid: this.child.pid } : {}),
          lastError: error instanceof Error ? error.message : String(error),
        });
      });
    }, 500);
  }

  private updateStatus(status: ManagedDesktopHelperStatus): void {
    this.statusValue = status;
    this.broadcast({ type: "status", data: status });
  }

  private broadcast(event: ManagedDesktopHelperEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    for (const socket of this.subscribers) {
      if (!socket.destroyed) socket.write(line);
    }
  }

  private respond(socket: Socket, response: ManagedDesktopHelperResponse): void {
    if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
  }
}

const socketPath = argument("socket");
const token = argument("token");
if (!socketPath || !token) {
  process.stderr.write("Bridge Claude helper requires --socket and --token\n");
  process.exitCode = 2;
} else {
  void new ClaudeDesktopHelper(socketPath, token).run().catch((error) => {
    process.stderr.write(`Bridge Claude helper failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
