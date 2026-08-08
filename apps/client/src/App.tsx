import { useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.js";
import { useMobileBridge } from "./hooks/useMobileBridge.js";
import {
  installMobileBackNavigation,
  registerMobileBackHandler,
} from "./lib/mobile-back-navigation.js";
import { DesktopDashboard } from "./components/DesktopDashboard.js";
import { HostBrowser } from "./components/HostBrowser.js";
import { MobileWorkspace } from "./components/MobileWorkspace.js";
import { PairingScreen } from "./components/PairingScreen.js";

export function App() {
  const [theme, toggleTheme] = useTheme();
  const mobile = useMobileBridge();
  const [pairingOpen, setPairingOpen] = useState(false);

  useEffect(() => installMobileBackNavigation(), []);

  useEffect(() => registerMobileBackHandler(() => {
    if (window.bridgeDesktop) return false;
    if (pairingOpen && mobile.state.hosts.length > 0) {
      setPairingOpen(false);
      return true;
    }
    if (mobile.state.activeHostId) {
      mobile.backToHosts();
      return true;
    }
    // The host list is the mobile root. A back gesture there stays in Bridge
    // instead of dropping the user onto the phone home screen.
    return true;
  }, -100), [
    mobile.backToHosts,
    mobile.state.activeHostId,
    mobile.state.hosts.length,
    pairingOpen,
  ]);

  if (window.bridgeDesktop) return <DesktopDashboard theme={theme} onToggleTheme={toggleTheme} />;
  if (mobile.state.loading && mobile.state.hosts.length === 0 && !pairingOpen) {
    return <main className="mobile-loading"><span className="spinner" /><span>正在读取已配对电脑</span></main>;
  }
  if (pairingOpen || mobile.state.hosts.length === 0) {
    return (
      <PairingScreen
        loading={mobile.state.loading}
        error={mobile.state.error}
        onPair={async (pairing) => {
          if (await mobile.pair(pairing)) setPairingOpen(false);
        }}
        {...(mobile.state.hosts.length > 0 ? { onCancel: () => setPairingOpen(false) } : {})}
      />
    );
  }
  if (!mobile.state.activeHostId) {
    return (
      <HostBrowser
        hosts={mobile.state.hosts}
        error={mobile.state.error}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSelect={mobile.selectHost}
        onRemove={mobile.forgetHost}
        onAdd={() => setPairingOpen(true)}
        onRepair={() => setPairingOpen(true)}
      />
    );
  }
  return (
    <MobileWorkspace
      key={mobile.state.activeHostId}
      activeHostId={mobile.state.activeHostId}
      desktopName={mobile.state.desktopName ?? "我的电脑"}
      connection={mobile.state.connection}
      desktopOnline={mobile.state.desktopOnline}
      snapshot={mobile.state.snapshot}
      permissions={mobile.state.permissions}
      focusSessionId={mobile.state.focusSessionId}
      histories={mobile.state.histories}
      evidence={mobile.state.evidence}
      artifactPreviews={mobile.state.artifactPreviews}
      artifactTransfers={mobile.state.artifactTransfers}
      events={mobile.state.events}
      localTurns={mobile.state.localTurns}
      connectionIssue={mobile.state.connectionIssue}
      transportMetrics={mobile.state.transportMetrics}
      pendingOutbound={mobile.state.pendingOutbound}
      theme={theme}
      onToggleTheme={toggleTheme}
      onOpenSession={mobile.openSession}
      onLoadOlderHistory={mobile.loadOlderHistory}
      onLoadOlderEvidence={mobile.loadOlderEvidence}
      onPreviewArtifact={mobile.previewArtifact}
      onDownloadArtifact={mobile.downloadArtifact}
      onSendTurn={mobile.sendTurn}
      onInterruptTurn={mobile.interruptTurn}
      onResolveUncertain={mobile.resolveUncertainDelivery}
      onResolvePermission={mobile.resolvePermission}
      onCreateSession={mobile.createSession}
      onLoadSessionConfiguration={mobile.loadSessionConfiguration}
      onConfigureSession={mobile.configureSession}
      {...(mobile.state.snapshot?.host.capabilities.includes("permission.policy.v1")
        ? { onConfigurePermissionPolicy: mobile.configurePermissionPolicy }
        : {})}
      onPreviewProviderSwitch={mobile.previewProviderSwitch}
      onCommitProviderSwitch={mobile.commitProviderSwitch}
      onCancelProviderSwitch={mobile.cancelProviderSwitch}
      onRefreshProviders={mobile.refreshProviders}
      onDesktopAppAction={mobile.controlDesktopApp}
      onRefresh={mobile.refresh}
      onBackToHosts={mobile.backToHosts}
      onRetry={mobile.retryConnection}
    />
  );
}
