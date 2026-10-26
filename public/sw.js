// 最小 Service Worker：仅为满足 PWA 可安装性注册。
// 刻意不做任何缓存——包括 /api 在内的所有请求原样透传，
// 因此凭据、配置与媒体响应不会进入任何存储。
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
