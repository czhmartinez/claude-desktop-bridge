import { useState } from "react";
import { useTheme } from "./hooks/useTheme.js";
import { useMobileBridge } from "./hooks/useMobileBridge.js";
import { DesktopDashboard } from "./components/DesktopDashboard.js";
import { HostBrowser } from "./components/HostBrowser.js";
import { MobileWorkspace } from "./components/MobileWorkspace.js";
import { PairingScreen } from "./components/PairingScreen.js";

export function App() {
  const [theme, toggleTheme] = useTheme();
  const mobile = useMobileBridge();
  const [pairingOpen, setPairingOpen] = useState(false);

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
      />
    );
  }
  return (
    <MobileWorkspace
      desktopName={mobile.state.desktopName ?? "我的电脑"}
      connection={mobile.state.connection}
      desktopOnline={mobile.state.desktopOnline}
      sessions={mobile.state.sessions}
      sessionCatalogReceived={mobile.state.sessionCatalogReceived}
      histories={mobile.state.histories}
      timeline={mobile.state.timeline}
      connectionIssue={mobile.state.connectionIssue}
      theme={theme}
      onToggleTheme={toggleTheme}
      onSend={mobile.sendCommand}
      onRequestHistory={mobile.requestHistory}
      onBackToHosts={mobile.backToHosts}
      onUnpair={mobile.unpair}
      onRetry={mobile.retryConnection}
    />
  );
}
