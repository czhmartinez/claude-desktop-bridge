import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.localbridge.mobile",
  appName: "Bridge",
  webDir: "dist",
  backgroundColor: "#f5f6f7",
  ios: {
    contentInset: "always",
    preferredContentMode: "mobile",
    scheme: "Bridge",
  },
  android: {
    backgroundColor: "#f5f6f7",
  },
};

export default config;
