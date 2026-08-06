import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  BridgeConversationRoute,
  BridgeEvent,
  BridgeExecutionLane,
  BridgeHandoff,
  BridgeHistoryItem,
  BridgeProviderProfile,
} from "@bridge/protocol";
import {
  CLAUDE_OFFICIAL_PROFILE_ID,
  type ConversationStateStore,
} from "./conversation-state-store.js";
import type { EvidenceManager } from "./evidence-manager.js";
import { readClaudeSessionHistory } from "./claude-history.js";
import type { ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { ProviderRuntimePool } from "./provider-runtime-pool.js";
import type { SessionBroker } from "./session-broker.js";
import type { SessionEventLog } from "./session-event-log.js";

const execFileAsync = promisify(execFile);
const EXECUTABLE_PROMPT_LIMIT = 48_000;
const OFFICIAL_PROMPT_LIMIT = 12_000;
const OFFICIAL_ASSOCIATION_WINDOW_MS = 10 * 60 * 1_000;
const HISTORY_ITEM_LIMIT = 24;
const HISTORY_TEXT_LIMIT = 2_000;

interface HandoffObserver {
  readonly catalog: ClaudeCatalogSnapshot;
  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void;
  setSessionAlias?(nativeSessionId: string, logicalSessionId: string): void;
}

export interface LocalHandoffPackage {
  version: 1;
  handoffId: string;
  conversationId: string;
  sourceLaneId: string;
  targetProviderProfileId: string;
  targetModel?: string;
  latestGoal: string;
  recentConversation: Array<{
    role: BridgeHistoryItem["role"];
    text: string;
    createdAt: number;
  }>;
  constraints: string[];
  incompleteItems: string[];
  toolsAndCommands: string[];
  artifacts: Array<{
    path: string;
    change: string;
    size: number;
    sha256?: string;
  }>;
  workspace: {
    cwd: string;
    gitHead?: string;
    gitBranch?: string;
    dirty: boolean;
    changedFiles: string[];
  };
  sourceEventSeq: number;
  integrityHash: string;
  officialMessageHash?: string;
  activationCommandId?: string;
}

export interface HandoffPreview {
  handoff: BridgeHandoff;
  route: BridgeConversationRoute;
  target: BridgeProviderProfile;
  summary: string;
}

export interface HandoffServiceOptions {
  state: ConversationStateStore;
  broker: SessionBroker;
  eventLog: SessionEventLog;
  evidence: EvidenceManager;
  providers: ProviderRegistry;
  runtimePool: ProviderRuntimePool;
  observer: HandoffObserver;
  paths: ClaudeRuntimePaths;
  openExternal(url: string): Promise<void>;
  now?: () => number;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function redact(value: string, cwd?: string): string {
  let result = value
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}\b/giu, "Bearer [REDACTED]")
    .replace(/\b(?:api[_ -]?key|authorization|oauth|access[_ -]?token)\s*[:=]\s*\S+/giu, "$1=[REDACTED]");
  const pathIsWithinProject = (path: string): boolean => {
    if (!cwd) return false;
    const normalizeForCompare = (candidate: string) => candidate
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "")
      .toLocaleLowerCase();
    const candidate = normalizeForCompare(path);
    const project = normalizeForCompare(cwd);
    return candidate === project || candidate.startsWith(`${project}/`);
  };
  result = result.replace(
    /\/(?:Users|private|Volumes|etc|var|tmp)\/[^\s"'`]+/gu,
    (path) => pathIsWithinProject(path) ? path : "[OUTSIDE_PROJECT_PATH]",
  );
  result = result.replace(
    /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|;&]+/gu,
    (path) => pathIsWithinProject(path) ? path : "[OUTSIDE_PROJECT_PATH]",
  );
  return result;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function gitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function changedPaths(status: string | undefined): string[] {
  if (!status) return [];
  return status.split("\n").flatMap((line) => {
    const path = line.slice(3).trim();
    if (!path) return [];
    const renamed = path.includes(" -> ") ? path.split(" -> ").at(-1)! : path;
    return [renamed];
  }).slice(0, 200);
}

export class HandoffService {
  private readonly now: () => number;
  private eventQueue: Promise<void> = Promise.resolve();
  private catalogQueue: Promise<void> = Promise.resolve();
  private stopCatalog: (() => void) | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private initialized = false;

  constructor(private readonly options: HandoffServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const lane of this.options.state.listAllLanes("claude-official")) {
      if (lane.nativeSessionId) {
        this.options.observer.setSessionAlias?.(lane.nativeSessionId, lane.conversationId);
      }
    }
    for (const handoff of this.options.state.listPendingHandoffs()) {
      if (handoff.state === "activating" || handoff.state === "preparing") {
        const local = this.localPackage(handoff.handoffId);
        if (local?.activationCommandId) {
          await this.options.broker.interruptTurn(
            handoff.conversationId,
            local.activationCommandId,
            true,
          ).catch(() => false);
        }
        await this.fail(
          handoff,
          "Bridge 在接力首条消息确认前重新启动；为避免重复发送，本次接力已停止。",
        );
      }
    }
    this.options.eventLog.on("event", this.handleEvent);
    this.stopCatalog = this.options.observer.onCatalog(() => {
      this.catalogQueue = this.catalogQueue
        .catch(() => undefined)
        .then(() => this.reconcileOfficialHandoffs());
    });
    this.expiryTimer = setInterval(() => {
      void this.reconcileOfficialHandoffs();
    }, 15_000);
    this.expiryTimer.unref?.();
    await this.reconcileOfficialHandoffs();
  }

  async close(): Promise<void> {
    this.options.eventLog.off("event", this.handleEvent);
    this.stopCatalog?.();
    this.stopCatalog = undefined;
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    await Promise.all([
      this.catalogQueue.catch(() => undefined),
      this.eventQueue.catch(() => undefined),
    ]);
  }

  get(handoffId: string): BridgeHandoff {
    const handoff = this.options.state.handoff(handoffId);
    if (!handoff) throw new Error("Handoff not found");
    return handoff;
  }

  async preview(input: {
    sessionId: string;
    targetProviderProfileId: string;
    model?: string;
  }): Promise<HandoffPreview> {
    if (this.options.broker.hasActiveOrPending(input.sessionId)) {
      throw new Error("当前对话仍有运行中或待发送任务，请先完成或停止");
    }
    const route = this.options.broker.conversationRoute(input.sessionId);
    if (route.pendingHandoff) throw new Error("当前对话已有未完成的提供方接力");
    if (route.activeProviderProfileId === input.targetProviderProfileId) {
      throw new Error("目标提供方已经是当前活动通道");
    }
    const target = this.readyTarget(input.targetProviderProfileId, input.model);
    const handoffId = randomUUID();
    const localPackage = await this.buildPackage(
      handoffId,
      route,
      target,
      input.model,
    );
    const summary = compact(localPackage.latestGoal || "继续当前可见任务", 240);
    const executablePrompt = this.executablePrompt(localPackage, target.kind);
    let saved = this.options.state.saveHandoff({
      handoffId,
      conversationId: input.sessionId,
      sourceLaneId: route.activeLaneId,
      targetProviderProfileId: target.id,
      state: "previewed",
      summary,
      requiresUserConfirmation: target.kind === "claude-official",
      ...(target.kind === "claude-official"
        ? { expiresAt: this.now() + OFFICIAL_ASSOCIATION_WINDOW_MS }
        : {}),
      package: localPackage,
      executablePrompt,
    });
    this.options.state.setRouteState(input.sessionId, "switching");
    await this.emit("handoff.started", saved);
    await this.emit("handoff.ready", saved);
    await this.emitRoute(input.sessionId);
    saved = this.get(handoffId);
    return {
      handoff: saved,
      route: this.options.state.route(input.sessionId)!,
      target,
      summary,
    };
  }

  async commit(input: {
    handoffId: string;
    targetNativeSessionId?: string;
    model?: string;
  }): Promise<{ handoff: BridgeHandoff; route: BridgeConversationRoute; deepLink?: string }> {
    let handoff = this.get(input.handoffId);
    if (handoff.state === "applied") {
      return {
        handoff,
        route: this.options.state.route(handoff.conversationId)!,
      };
    }
    if (
      handoff.state === "failed" ||
      handoff.state === "cancelled" ||
      handoff.state === "expired"
    ) throw new Error(`Handoff is ${handoff.state}`);
    if (handoff.state === "activating" || handoff.state === "awaiting_user_confirmation") {
      return {
        handoff,
        route: this.options.state.route(handoff.conversationId)!,
      };
    }
    if (this.options.broker.hasActiveOrPending(handoff.conversationId)) {
      throw new Error("当前对话仍有运行中或待发送任务，请先完成或停止");
    }
    const target = this.readyTarget(handoff.targetProviderProfileId, input.model);
    if (target.kind === "claude-official") {
      if (input.targetNativeSessionId) {
        await this.activateOfficial(handoff, input.targetNativeSessionId);
        handoff = this.get(input.handoffId);
        return {
          handoff,
          route: this.options.state.route(handoff.conversationId)!,
        };
      }
      if (handoff.state === "awaiting_target") {
        return {
          handoff,
          route: this.options.state.route(handoff.conversationId)!,
        };
      }
      const stored = this.options.state.handoffPackage(handoff.handoffId);
      if (!stored?.executablePrompt) throw new Error("Handoff prompt is unavailable");
      handoff = this.saveState(handoff, "awaiting_user_confirmation");
      this.options.state.setRouteState(handoff.conversationId, "awaiting-user-confirmation");
      const session = this.options.broker.session(handoff.conversationId);
      if (!session) throw new Error("Session not found");
      const cwd = await realpath(session.cwd);
      const deepLink = this.options.runtimePool.official.deepLink(cwd, stored.executablePrompt);
      await this.options.openExternal(deepLink);
      await this.emit("handoff.ready", handoff, {
        awaitingUserConfirmation: true,
        expiresAt: handoff.expiresAt,
      });
      await this.emitRoute(handoff.conversationId);
      return {
        handoff,
        route: this.options.state.route(handoff.conversationId)!,
        deepLink,
      };
    }
    return this.commitExecutable(handoff, target, input.model);
  }

  async cancel(handoffId: string): Promise<{ handoff: BridgeHandoff; route: BridgeConversationRoute }> {
    const handoff = this.get(handoffId);
    const local = this.localPackage(handoffId);
    if (local?.activationCommandId) {
      await this.options.broker.interruptTurn(
        handoff.conversationId,
        local.activationCommandId,
        true,
      ).catch(() => false);
    }
    const cancelled = this.options.state.cancelHandoff(handoffId);
    await this.emitRoute(cancelled.conversationId);
    return {
      handoff: cancelled,
      route: this.options.state.route(cancelled.conversationId)!,
    };
  }

  private async commitExecutable(
    initial: BridgeHandoff,
    target: BridgeProviderProfile,
    selectedModel?: string,
  ): Promise<{ handoff: BridgeHandoff; route: BridgeConversationRoute }> {
    let handoff = this.saveState(initial, "preparing");
    this.options.state.setRouteState(handoff.conversationId, "switching");
    let lane = this.reusableLane(handoff, target.id);
    const model = selectedModel ?? this.localPackage(handoff.handoffId)?.targetModel ?? target.defaultModel;
    if (!lane) {
      lane = this.options.state.createLane({
        conversationId: handoff.conversationId,
        providerProfileId: target.id,
        providerKind: target.kind,
        nativeSessionId: randomUUID(),
        access: "read-write",
        status: "preparing",
        ...(model ? { model } : {}),
      });
      await this.emitLane("lane.created", lane);
    } else {
      lane = this.options.state.updateLane(lane.laneId, {
        status: "preparing",
        ...(model ? { model } : {}),
      });
      await this.emitLane("lane.updated", lane);
    }
    const stored = this.options.state.handoffPackage(handoff.handoffId);
    if (!stored?.executablePrompt || !stored.package) throw new Error("Handoff package is unavailable");
    handoff = this.options.state.saveHandoff({
      ...handoff,
      targetLaneId: lane.laneId,
      state: "activating",
      updatedAt: this.now(),
      package: stored.package,
      executablePrompt: stored.executablePrompt,
    });
    const turn = await this.options.broker.startHandoffTurn({
      handoffId: handoff.handoffId,
      sessionId: handoff.conversationId,
      laneId: lane.laneId,
      text: stored.executablePrompt,
    });
    if (!("attempts" in turn)) throw new Error("Handoff activation was already completed");
    const local = stored.package as LocalHandoffPackage;
    const withCommand: LocalHandoffPackage = {
      ...local,
      activationCommandId: turn.commandId,
    };
    handoff = this.options.state.saveHandoff({
      ...handoff,
      package: withCommand,
      executablePrompt: stored.executablePrompt,
      updatedAt: this.now(),
    });
    await this.emit("handoff.ready", handoff, {
      targetLaneId: lane.laneId,
      delivery: "host-received",
    });
    await this.emitRoute(handoff.conversationId);
    return {
      handoff,
      route: this.options.state.route(handoff.conversationId)!,
    };
  }

  private readonly handleEvent = (event: BridgeEvent): void => {
    this.eventQueue = this.eventQueue
      .catch(() => undefined)
      .then(() => this.acceptEvent(event));
  };

  private async acceptEvent(event: BridgeEvent): Promise<void> {
    const commandId = typeof event.data.commandId === "string" ? event.data.commandId : undefined;
    if (!commandId) return;
    const handoff = this.options.state.listPendingHandoffs().find((candidate) => (
      this.localPackage(candidate.handoffId)?.activationCommandId === commandId
    ));
    if (!handoff) return;
    if (event.type === "user.message.accepted") {
      if (!handoff.targetLaneId || handoff.state !== "activating") return;
      const route = this.options.state.applyHandoff(handoff.handoffId, handoff.targetLaneId);
      await this.emitLane("lane.updated", this.options.state.lane(handoff.targetLaneId)!);
      await this.emit("handoff.applied", this.get(handoff.handoffId));
      await this.emitRoute(route.conversationId);
      return;
    }
    if (event.type === "turn.failed" || event.type === "runtime.error") {
      await this.fail(
        handoff,
        typeof event.data.error === "string" ? event.data.error : "接力首条消息未被目标通道确认",
      );
    }
  }

  private async reconcileOfficialHandoffs(): Promise<void> {
    const pending = this.options.state.listPendingHandoffs().filter((handoff) => (
      handoff.targetProviderProfileId === CLAUDE_OFFICIAL_PROFILE_ID &&
      (
        handoff.state === "awaiting_user_confirmation" ||
        handoff.state === "awaiting_target"
      )
    ));
    for (const handoff of pending) {
      if (handoff.expiresAt && this.now() > handoff.expiresAt) {
        const expired = this.options.state.expireHandoff(handoff.handoffId);
        await this.emit("handoff.failed", expired, { expired: true });
        await this.emitRoute(handoff.conversationId);
        continue;
      }
      const matches = await this.officialMatches(handoff);
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        const updated = this.options.state.saveHandoff({
          ...handoff,
          state: "awaiting_target",
          candidateNativeSessionIds: matches,
          updatedAt: this.now(),
        });
        this.options.state.setRouteState(handoff.conversationId, "awaiting-target-selection");
        await this.emit("handoff.ready", updated, { candidateNativeSessionIds: matches });
        await this.emitRoute(handoff.conversationId);
        continue;
      }
      await this.activateOfficial(handoff, matches[0]!);
    }
  }

  private async officialMatches(handoff: BridgeHandoff): Promise<string[]> {
    const session = this.options.broker.session(handoff.conversationId);
    const stored = this.options.state.handoffPackage(handoff.handoffId);
    const local = stored?.package as LocalHandoffPackage | undefined;
    if (!session || !stored?.executablePrompt || !local?.officialMessageHash) return [];
    const expectedCwd = await realpath(session.cwd).catch(() => undefined);
    if (!expectedCwd) return [];
    const candidates = this.options.observer.catalog.sessions.filter((candidate) => (
      candidate.sourceProfile === "claude" &&
      candidate.lastActivityAt >= handoff.createdAt &&
      candidate.lastActivityAt <= (handoff.expiresAt ?? handoff.createdAt + OFFICIAL_ASSOCIATION_WINDOW_MS)
    ));
    const matches: string[] = [];
    for (const candidate of candidates) {
      const candidateCwd = await realpath(candidate.cwd).catch(() => undefined);
      if (candidateCwd !== expectedCwd) continue;
      const history = await readClaudeSessionHistory(
        this.options.paths.projects,
        candidate.sessionId,
        expectedCwd,
        { limit: 10_000 },
      );
      const firstUser = history.messages.find((message) => message.role === "user");
      if (!firstUser || !firstUser.text.includes(handoff.handoffId)) continue;
      if (hash(firstUser.text.trim()) !== local.officialMessageHash) continue;
      matches.push(candidate.sessionId);
    }
    return [...new Set(matches)];
  }

  private async activateOfficial(handoff: BridgeHandoff, nativeSessionId: string): Promise<void> {
    if (
      handoff.candidateNativeSessionIds?.length &&
      !handoff.candidateNativeSessionIds.includes(nativeSessionId)
    ) throw new Error("Official session is not an approved association candidate");
    const matches = await this.officialMatches(handoff);
    if (!matches.includes(nativeSessionId)) {
      throw new Error("Official session no longer satisfies the handoff association checks");
    }
    let lane = this.options.state.findLane(CLAUDE_OFFICIAL_PROFILE_ID, nativeSessionId);
    if (lane && lane.conversationId !== handoff.conversationId) {
      throw new Error("Official session is already associated with another Bridge conversation");
    }
    if (!lane) {
      lane = this.options.state.createLane({
        conversationId: handoff.conversationId,
        providerProfileId: CLAUDE_OFFICIAL_PROFILE_ID,
        providerKind: "claude-official",
        nativeSessionId,
        access: "read-only",
        status: "preparing",
      });
      await this.emitLane("lane.created", lane);
    }
    const activating = this.options.state.saveHandoff({
      ...handoff,
      targetLaneId: lane.laneId,
      state: "activating",
      candidateNativeSessionIds: [nativeSessionId],
      updatedAt: this.now(),
    });
    this.options.observer.setSessionAlias?.(nativeSessionId, handoff.conversationId);
    const route = this.options.state.applyHandoff(activating.handoffId, lane.laneId);
    await this.emitLane("lane.updated", this.options.state.lane(lane.laneId)!);
    await this.emit("handoff.applied", this.get(handoff.handoffId), { nativeSessionId });
    await this.emitRoute(route.conversationId);
  }

  private reusableLane(handoff: BridgeHandoff, profileId: string): BridgeExecutionLane | undefined {
    return this.options.state.listLanes(handoff.conversationId)
      .filter((lane) => (
        lane.providerProfileId === profileId &&
        lane.laneId !== handoff.sourceLaneId &&
        lane.access === "read-write" &&
        lane.status !== "failed" &&
        Boolean(lane.nativeSessionId)
      ))
      .sort((left, right) => (right.lastUsedAt ?? right.updatedAt) - (left.lastUsedAt ?? left.updatedAt))[0];
  }

  private readyTarget(profileId: string, model?: string): BridgeProviderProfile {
    const profile = this.options.providers.get(profileId);
    if (!profile) throw new Error("Provider profile not found");
    if (profile.status !== "ready") throw new Error(profile.detail || "Provider is unavailable");
    if (model && profile.models.length && !profile.models.some((candidate) => candidate.id === model)) {
      throw new Error("Selected model is not available for this provider");
    }
    return profile;
  }

  private saveState(handoff: BridgeHandoff, state: BridgeHandoff["state"]): BridgeHandoff {
    return this.options.state.saveHandoff({
      ...handoff,
      state,
      updatedAt: this.now(),
    });
  }

  private localPackage(handoffId: string): LocalHandoffPackage | undefined {
    return this.options.state.handoffPackage(handoffId)?.package as LocalHandoffPackage | undefined;
  }

  private async buildPackage(
    handoffId: string,
    route: BridgeConversationRoute,
    target: BridgeProviderProfile,
    targetModel?: string,
  ): Promise<LocalHandoffPackage> {
    const session = this.options.broker.session(route.conversationId);
    if (!session) throw new Error("Session not found");
    const cwd = await realpath(session.cwd);
    const history = await this.options.broker.history(route.conversationId, undefined, HISTORY_ITEM_LIMIT);
    const recentConversation = history.items
      .filter((item) => item.role === "user" || item.role === "assistant")
      .slice(-HISTORY_ITEM_LIMIT)
      .map((item) => ({
        role: item.role,
        text: redact(compact(item.text, HISTORY_TEXT_LIMIT), cwd),
        createdAt: item.createdAt,
      }));
    const latestGoal = [...recentConversation].reverse().find((item) => item.role === "user")?.text
      ?? session.currentSummary
      ?? session.title;
    const constraints = recentConversation
      .filter((item) => item.role === "user" && /(?:必须|不要|禁止|只能|保留|不得|must|never|only)/iu.test(item.text))
      .slice(-8)
      .map((item) => compact(item.text, 500));
    const incompleteItems = [
      ...(session.pendingCount ? [`仍有 ${session.pendingCount} 个待处理任务`] : []),
      ...(session.currentSummary ? [redact(compact(session.currentSummary, 500), cwd)] : []),
    ];
    const evidence = this.options.evidence.list(route.conversationId, undefined, 12).items;
    const toolsAndCommands = evidence
      .flatMap((bundle) => bundle.tools.map((tool) => redact(compact(tool.summary, 300), cwd)))
      .slice(0, 100);
    const artifacts = evidence
      .flatMap((bundle) => bundle.artifacts.map((artifact) => ({
        path: artifact.relativePath,
        change: artifact.changeKind,
        size: artifact.size,
        ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      })))
      .filter((artifact, index, all) => all.findIndex((candidate) => candidate.path === artifact.path) === index)
      .slice(0, 200);
    const [gitHead, gitBranch, status] = await Promise.all([
      gitValue(cwd, ["rev-parse", "HEAD"]),
      gitValue(cwd, ["branch", "--show-current"]),
      gitValue(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    ]);
    const sourceEventSeq = this.options.eventLog.latestSeq();
    const unsigned = {
      version: 1 as const,
      handoffId,
      conversationId: route.conversationId,
      sourceLaneId: route.activeLaneId,
      targetProviderProfileId: target.id,
      ...(targetModel ? { targetModel } : {}),
      latestGoal: redact(compact(latestGoal, 2_000), cwd),
      recentConversation,
      constraints,
      incompleteItems,
      toolsAndCommands,
      artifacts,
      workspace: {
        cwd,
        ...(gitHead ? { gitHead } : {}),
        ...(gitBranch ? { gitBranch } : {}),
        dirty: Boolean(status),
        changedFiles: changedPaths(status),
      },
      sourceEventSeq,
    };
    return {
      ...unsigned,
      integrityHash: hash(JSON.stringify(unsigned)),
    };
  }

  private executablePrompt(
    input: LocalHandoffPackage,
    providerKind: BridgeProviderProfile["kind"],
  ): string {
    const history = input.recentConversation
      .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.text}`)
      .join("\n\n");
    const artifacts = input.artifacts
      .map((artifact) => `- ${artifact.change}: ${artifact.path}${artifact.sha256 ? ` sha256=${artifact.sha256}` : ""}`)
      .join("\n");
    const prompt = [
      `[Bridge 接力 ${input.handoffId}]`,
      "这是 Bridge 生成的结构化可见上下文接力，不包含隐藏思维、OAuth、API Key 或服务端运行态。",
      "",
      `当前目标：${input.latestGoal}`,
      input.constraints.length ? `约束：\n${input.constraints.map((value) => `- ${value}`).join("\n")}` : "",
      input.incompleteItems.length
        ? `未完成事项：\n${input.incompleteItems.map((value) => `- ${value}`).join("\n")}`
        : "",
      history ? `近期可见对话：\n${history}` : "",
      input.toolsAndCommands.length
        ? `工具与命令摘要：\n${input.toolsAndCommands.map((value) => `- ${value}`).join("\n")}`
        : "",
      artifacts ? `成果与变更：\n${artifacts}` : "",
      `工作区：${input.workspace.cwd}`,
      `Git：${input.workspace.gitBranch ?? "detached/unknown"} @ ${input.workspace.gitHead ?? "unknown"}，`
        + `${input.workspace.dirty ? "有未提交改动" : "工作区干净"}`,
      `源事件序号：${input.sourceEventSeq}`,
      `完整性哈希：${input.integrityHash}`,
      "",
      "请先确认当前工作区和目标，再基于以上可见上下文继续；不要声称继承了隐藏思维或原生运行态。",
    ].filter(Boolean).join("\n\n");
    const limit = providerKind === "claude-official"
      ? OFFICIAL_PROMPT_LIMIT
      : EXECUTABLE_PROMPT_LIMIT;
    const bounded = prompt.length <= limit ? prompt : prompt.slice(0, limit);
    if (providerKind === "claude-official") {
      input.officialMessageHash = hash(bounded.trim());
    }
    return bounded;
  }

  private async fail(handoff: BridgeHandoff, error: string): Promise<void> {
    const failed = this.options.state.failHandoff(handoff.handoffId, compact(error, 1_000));
    if (failed.targetLaneId) {
      const lane = this.options.state.lane(failed.targetLaneId);
      if (lane?.status === "preparing") {
        await this.emitLane(
          "lane.updated",
          this.options.state.updateLane(lane.laneId, { status: "failed" }),
        );
      }
    }
    await this.emit("handoff.failed", failed, { error: failed.error });
    await this.emitRoute(failed.conversationId);
  }

  private async emit(
    type: "handoff.started" | "handoff.ready" | "handoff.applied" | "handoff.failed",
    handoff: BridgeHandoff,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.eventLog.append({
      sessionId: handoff.conversationId,
      itemId: handoff.handoffId,
      origin: "system",
      type,
      data: { handoff, ...data },
    });
  }

  private async emitLane(
    type: "lane.created" | "lane.updated",
    lane: BridgeExecutionLane,
  ): Promise<void> {
    await this.options.eventLog.append({
      sessionId: lane.conversationId,
      itemId: lane.laneId,
      origin: "system",
      type,
      data: { lane },
    });
  }

  private async emitRoute(conversationId: string): Promise<void> {
    const route = this.options.state.route(conversationId);
    if (!route) return;
    await this.options.eventLog.append({
      sessionId: conversationId,
      itemId: conversationId,
      origin: "system",
      type: "conversation.route.changed",
      data: { route },
    });
  }
}
