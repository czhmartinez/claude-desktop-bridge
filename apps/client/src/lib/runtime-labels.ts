import type { BridgeDesktopRuntimeId, BridgeSessionInfo } from "@bridge/protocol";

/** Runtime id of the observed Claude domain; every other runtime is bridge-driven. */
export function desktopRuntimeId(session: BridgeSessionInfo): BridgeDesktopRuntimeId {
  return session.runtimeId ?? "claude-desktop";
}

/** Short chip label, per the 0.9.6 desktopless naming pass. */
export function desktopRuntimeName(runtimeId: BridgeDesktopRuntimeId | undefined): string {
  if (runtimeId === "codex-desktop") return "Codex";
  if (runtimeId === "hermes-desktop") return "Hermes";
  if (runtimeId === "dsh-desktop") return "DSH";
  return "Claude";
}

/** Fuller provider-facing label for configuration surfaces. */
export function runtimeProviderLabel(runtimeId: BridgeDesktopRuntimeId | undefined): string {
  if (runtimeId === "codex-desktop") return "Codex（ChatGPT）";
  if (runtimeId === "hermes-desktop") return "Hermes";
  if (runtimeId === "dsh-desktop") return "DSH（DeepSeek Harness）";
  return "Claude";
}

/** Native bridge-driven runtimes (everything except the observed Claude domain). */
export function isNativeRuntimeId(runtimeId: BridgeDesktopRuntimeId | undefined): boolean {
  return runtimeId === "codex-desktop" || runtimeId === "hermes-desktop" || runtimeId === "dsh-desktop";
}
