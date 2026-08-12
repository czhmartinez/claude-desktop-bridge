import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { installSpecularHighlight } from "./lib/specular.js";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);

installSpecularHighlight();

if (
  "serviceWorker" in navigator &&
  !window.bridgeDesktop &&
  (window.location.protocol === "http:" || window.location.protocol === "https:")
) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
