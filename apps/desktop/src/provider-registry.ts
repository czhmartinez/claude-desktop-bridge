import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BridgeProviderModel,
  BridgeProviderProfile,
  BridgeRuntimeStatus,
} from "@bridge/protocol";
import type { SafeStorageLike } from "./config.js";
import {
  ANTHROPIC_API_PROFILE_ID,
  CLAUDE_3P_PROFILE_ID,
  CLAUDE_OFFICIAL_PROFILE_ID,
  type ConversationStateStore,
} from "./conversation-state-store.js";
import { supportsClaudeDesktop } from "./platform.js";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";
const ANTHROPIC_VERSION = "2023-06-01";

interface StoredApiKey {
  version: 1;
  protectedKey: string;
  updatedAt: number;
}

interface AnthropicModelPayload {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
  capabilities?: unknown;
}

interface AnthropicModelsPayload {
  data?: unknown;
}

export interface ProviderRegistryOptions {
  state: ConversationStateStore;
  apiKeyPath: string;
  safeStorage: SafeStorageLike;
  claude3pStatus(): BridgeRuntimeStatus;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
}

function validApiKey(value: string): string {
  const key = value.trim();
  if (key.length < 20 || key.length > 512 || /[\u0000-\u0020\u007f]/u.test(key)) {
    throw new Error("Anthropic API Key 格式无效");
  }
  return key;
}

function modelCapability(value: unknown): BridgeProviderModel["capabilities"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const capabilities: BridgeProviderModel["capabilities"] = {};
  for (const [key, capability] of Object.entries(value)) {
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) continue;
    const supported = (capability as Record<string, unknown>).supported;
    capabilities[key] = typeof supported === "boolean"
      ? { supported }
      : capability as Record<string, unknown>;
  }
  return capabilities;
}

function parseModels(value: unknown): BridgeProviderModel[] {
  const payload = value as AnthropicModelsPayload;
  if (!Array.isArray(payload?.data)) throw new Error("Anthropic 模型响应格式无效");
  const models = payload.data.flatMap((candidate): BridgeProviderModel[] => {
    const model = candidate as AnthropicModelPayload;
    if (typeof model.id !== "string" || typeof model.display_name !== "string") return [];
    return [{
      id: model.id,
      displayName: model.display_name,
      ...(typeof model.created_at === "string" ? { createdAt: model.created_at } : {}),
      ...(typeof model.max_input_tokens === "number"
        ? { maxInputTokens: model.max_input_tokens }
        : {}),
      ...(typeof model.max_tokens === "number" ? { maxOutputTokens: model.max_tokens } : {}),
      capabilities: modelCapability(model.capabilities),
    }];
  });
  if (models.length === 0) throw new Error("Anthropic 账号未返回可用模型");
  return models;
}

export class AnthropicApiKeyRepository {
  constructor(
    private readonly path: string,
    private readonly storage: SafeStorageLike,
  ) {}

  available(): boolean {
    return this.storage.isEncryptionAvailable();
  }

  async get(): Promise<string | undefined> {
    let file: StoredApiKey;
    try {
      file = JSON.parse(await readFile(this.path, "utf8")) as StoredApiKey;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      file.version !== 1 ||
      typeof file.protectedKey !== "string" ||
      !file.protectedKey.startsWith("os:")
    ) {
      throw new Error("Anthropic API Key 存储格式无效，已拒绝明文或降级格式");
    }
    if (!this.available()) throw new Error("系统安全存储当前不可用");
    return this.storage.decryptString(Buffer.from(file.protectedKey.slice(3), "base64"));
  }

  async set(value: string): Promise<void> {
    if (!this.available()) throw new Error("系统安全存储不可用，不能保存 Anthropic API Key");
    const key = validApiKey(value);
    const file: StoredApiKey = {
      version: 1,
      protectedKey: `os:${this.storage.encryptString(key).toString("base64")}`,
      updatedAt: Date.now(),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }

  async remove(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

export class ProviderRegistry extends EventEmitter {
  readonly apiKeys: AnthropicApiKeyRepository;
  private readonly fetchImpl: typeof fetch;
  private readonly platform: NodeJS.Platform;
  private initialized = false;

  constructor(private readonly options: ProviderRegistryOptions) {
    super();
    this.apiKeys = new AnthropicApiKeyRepository(options.apiKeyPath, options.safeStorage);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.platform = options.platform ?? process.platform;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.options.state.initialize();
    await this.refresh();
  }

  list(): BridgeProviderProfile[] {
    return this.options.state.listProviderProfiles();
  }

  get(profileId: string): BridgeProviderProfile | undefined {
    return this.options.state.providerProfile(profileId);
  }

  async refresh(profileId?: string): Promise<BridgeProviderProfile[]> {
    const targetIds = profileId
      ? [profileId]
      : [CLAUDE_3P_PROFILE_ID, ANTHROPIC_API_PROFILE_ID, CLAUDE_OFFICIAL_PROFILE_ID];
    for (const id of targetIds) {
      if (id === CLAUDE_3P_PROFILE_ID) this.refreshClaude3p();
      else if (id === ANTHROPIC_API_PROFILE_ID) await this.refreshAnthropicApi();
      else if (id === CLAUDE_OFFICIAL_PROFILE_ID) this.refreshOfficial();
      else throw new Error("Provider profile not found");
    }
    return this.list();
  }

  async setAnthropicApiKey(value: string): Promise<BridgeProviderProfile> {
    const key = validApiKey(value);
    const models = await this.fetchModels(key);
    await this.apiKeys.set(key);
    return this.save({
      id: ANTHROPIC_API_PROFILE_ID,
      kind: "anthropic-api",
      name: "Anthropic API",
      status: "ready",
      detail: `API Key 已验证，可用模型 ${models.length} 个；调用费用由 Anthropic API 单独计费。`,
      configured: true,
      localOnlyConfiguration: true,
      readOnly: false,
      models,
      ...(models[0] ? { defaultModel: models[0].id } : {}),
      refreshedAt: Date.now(),
    });
  }

  async removeAnthropicApiKey(): Promise<BridgeProviderProfile> {
    await this.apiKeys.remove();
    return this.save({
      id: ANTHROPIC_API_PROFILE_ID,
      kind: "anthropic-api",
      name: "Anthropic API",
      status: "needs-configuration",
      detail: "需要在电脑端输入 Claude Console API Key。",
      configured: false,
      localOnlyConfiguration: true,
      readOnly: false,
      models: [],
      refreshedAt: Date.now(),
    });
  }

  async anthropicApiKey(): Promise<string> {
    const key = await this.apiKeys.get();
    if (!key) throw new Error("Anthropic API Key 尚未在电脑端配置");
    return key;
  }

  private refreshClaude3p(): BridgeProviderProfile {
    const status = this.options.claude3pStatus();
    const ready = status.state === "ready" || status.state === "working";
    return this.save({
      id: CLAUDE_3P_PROFILE_ID,
      kind: "claude-3p",
      name: "Claude-3p",
      status: ready ? "ready" : "unavailable",
      detail: ready ? "Agent SDK 与 Claude-3p Host Credentials 已就绪。" : status.detail,
      configured: ready,
      localOnlyConfiguration: false,
      readOnly: false,
      models: this.get(CLAUDE_3P_PROFILE_ID)?.models ?? [],
      refreshedAt: Date.now(),
    });
  }

  private async refreshAnthropicApi(): Promise<BridgeProviderProfile> {
    let key: string | undefined;
    try {
      key = await this.apiKeys.get();
    } catch (error) {
      return this.save({
        id: ANTHROPIC_API_PROFILE_ID,
        kind: "anthropic-api",
        name: "Anthropic API",
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
        configured: false,
        localOnlyConfiguration: true,
        readOnly: false,
        models: [],
        refreshedAt: Date.now(),
      });
    }
    if (!key) return this.removeAnthropicApiKey();
    try {
      const models = await this.fetchModels(key);
      return this.save({
        id: ANTHROPIC_API_PROFILE_ID,
        kind: "anthropic-api",
        name: "Anthropic API",
        status: "ready",
        detail: `API Key 已验证，可用模型 ${models.length} 个；调用费用由 Anthropic API 单独计费。`,
        configured: true,
      localOnlyConfiguration: true,
      readOnly: false,
      models,
      ...(this.get(ANTHROPIC_API_PROFILE_ID)?.defaultModel
        ? { defaultModel: this.get(ANTHROPIC_API_PROFILE_ID)!.defaultModel }
        : models[0]
          ? { defaultModel: models[0].id }
          : {}),
        refreshedAt: Date.now(),
      });
    } catch (error) {
      return this.save({
        id: ANTHROPIC_API_PROFILE_ID,
        kind: "anthropic-api",
        name: "Anthropic API",
        status: "error",
        detail: `API Key 验证失败：${error instanceof Error ? error.message : String(error)}`,
        configured: true,
        localOnlyConfiguration: true,
        readOnly: false,
        models: [],
        refreshedAt: Date.now(),
      });
    }
  }

  private refreshOfficial(): BridgeProviderProfile {
    const ready = supportsClaudeDesktop(this.platform);
    return this.save({
      id: CLAUDE_OFFICIAL_PROFILE_ID,
      kind: "claude-official",
      name: "Claude 官方订阅",
      status: ready ? "ready" : "unavailable",
      detail: ready
        ? "通过 Claude 官方 Deep Link 新建会话；激活后 Bridge 仅只读观察。"
        : "当前平台不支持 Claude 官方 Deep Link。",
      configured: ready,
      localOnlyConfiguration: false,
      readOnly: true,
      models: [],
      refreshedAt: Date.now(),
    });
  }

  private async fetchModels(key: string): Promise<BridgeProviderModel[]> {
    const response = await this.fetchImpl(ANTHROPIC_MODELS_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": key,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const requestId = response.headers.get("request-id");
      throw new Error(`Anthropic Models API 返回 ${response.status}${requestId ? ` (${requestId})` : ""}`);
    }
    return parseModels(await response.json());
  }

  private save(profile: BridgeProviderProfile): BridgeProviderProfile {
    this.options.state.saveProviderProfile(profile);
    this.emit("updated", profile);
    return profile;
  }
}
