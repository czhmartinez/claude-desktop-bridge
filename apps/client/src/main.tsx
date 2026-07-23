import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);

if ("serviceWorker" in navigator && !window.bridgeDesktop) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
