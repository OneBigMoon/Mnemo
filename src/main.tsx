import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// PWA：仅在安全上下文注册最小透传 Service Worker（见 public/sw.js）。
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 非安全上下文（局域网 HTTP）或注册失败都不影响使用。
    });
  });
}
