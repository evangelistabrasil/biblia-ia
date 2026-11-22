// Guarda o app inteiro no aparelho (texto, dados da IA e modelo) para abrir sem internet.
// Só funciona em HTTPS ou em localhost (ex.: servidor do Termux no próprio celular).
// O download é feito pela própria página (aba Mais); aqui só servimos o que está guardado.
const CACHE = "biblia-ia-app";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 1º o que está guardado no aparelho; se não tiver, busca no servidor
    const guardado = await cache.match(req, { ignoreSearch: true }) ||
      (req.mode === "navigate" ? await cache.match("./") : undefined);
    if (guardado) return guardado;
    return fetch(req);
  })());
});
