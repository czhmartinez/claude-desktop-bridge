import type { BridgeExecutionLane, BridgeProviderKind } from "@bridge/protocol";
import type { ClaudeRuntime } from "./claude-runtime-discovery.js";
import type { ProviderRegistry } from "./provider-registry.js";

export interface ProviderHostPlan {
  logicalSessionId: string;
  nativeSessionId: string;
  executablePath: string;
  environment: NodeJS.ProcessEnv;
  providerKind: BridgeProviderKind;
}

interface ProviderAdapter {
  readonly kind: BridgeProviderKind;
  hostPlan(
    logicalSessionId: string,
    lane: BridgeExecutionLane,
    runtime: ClaudeRuntime,
  ): Promise<ProviderHostPlan>;
}

function requiredExecutable(runtime: ClaudeRuntime): string {
  if (!runtime.executablePath) throw new Error("Claude Agent SDK 运行时不可用");
  return runtime.executablePath;
}

function requiredNativeSession(lane: BridgeExecutionLane): string {
  if (!lane.nativeSessionId) throw new Error("执行通道尚未绑定原生会话");
  return lane.nativeSessionId;
}

export class Claude3pProviderAdapter implements ProviderAdapter {
  readonly kind = "claude-3p" as const;

  async hostPlan(
    logicalSessionId: string,
    lane: BridgeExecutionLane,
    runtime: ClaudeRuntime,
  ): Promise<ProviderHostPlan> {
    if (!runtime.credentialPath) throw new Error("Claude-3p Host Credentials 不可用");
    return {
      logicalSessionId,
      nativeSessionId: requiredNativeSession(lane),
      executablePath: requiredExecutable(runtime),
      environment: { ...runtime.environment },
      providerKind: this.kind,
    };
  }
}

export class AnthropicApiProviderAdapter implements ProviderAdapter {
  readonly kind = "anthropic-api" as const;

  constructor(private readonly registry: ProviderRegistry) {}

  async hostPlan(
    logicalSessionId: string,
    lane: BridgeExecutionLane,
    runtime: ClaudeRuntime,
  ): Promise<ProviderHostPlan> {
    const environment = { ...runtime.environment };
    for (const key of [
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_HOST_CREDS_FILE",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
      "CLAUDE_CODE_HOST_SESSION_ID",
      "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
    ]) delete environment[key];
    environment.ANTHROPIC_API_KEY = await this.registry.anthropicApiKey();
    environment.CLAUDE_AGENT_SDK_CLIENT_APP = "claude-bridge/0.5.0";
    return {
      logicalSessionId,
      nativeSessionId: requiredNativeSession(lane),
      executablePath: requiredExecutable(runtime),
      environment,
      providerKind: this.kind,
    };
  }
}

export class ClaudeOfficialProviderAdapter implements ProviderAdapter {
  readonly kind = "claude-official" as const;

  async hostPlan(): Promise<ProviderHostPlan> {
    throw new Error("Claude 官方通道为只读，请在 Claude 官方继续");
  }

  deepLink(cwd: string, prompt: string): string {
    if (prompt.length > 12_000) throw new Error("Claude 官方接力消息超过 12,000 字符上限");
    const url = new URL("claude://code/new");
    url.searchParams.set("q", prompt);
    url.searchParams.set("folder", cwd);
    return url.toString();
  }
}

export class ProviderRuntimePool {
  readonly official = new ClaudeOfficialProviderAdapter();
  private readonly adapters: Map<BridgeProviderKind, ProviderAdapter>;

  constructor(registry: ProviderRegistry) {
    this.adapters = new Map<BridgeProviderKind, ProviderAdapter>([
      ["claude-3p", new Claude3pProviderAdapter()],
      ["anthropic-api", new AnthropicApiProviderAdapter(registry)],
      ["claude-official", this.official],
    ]);
  }

  hostPlan(
    logicalSessionId: string,
    lane: BridgeExecutionLane,
    runtime: ClaudeRuntime,
  ): Promise<ProviderHostPlan> {
    const adapter = this.adapters.get(lane.providerKind);
    if (!adapter) throw new Error("Unsupported provider lane");
    return adapter.hostPlan(logicalSessionId, lane, runtime);
  }
}
