/* Uso sin conexión: datos con red primero (y copia guardada si no hay red); la página, primero desde la copia. */
"use strict";
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE_PAGINA = `pagina-${VERSION}`;
const CACHE_DATOS = "datos";
const PAGINA = [
  "./", "index.html", `estilos.css?v=${VERSION}`, `logica.js?v=${VERSION}`, `app.js?v=${VERSION}`,
  "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/leaflet/images/layers.png", "vendor/leaflet/images/layers-2x.png",
  "fuentes/overpass-latin-400-normal.woff2", "fuentes/overpass-latin-600-normal.woff2", "fuentes/overpass-latin-800-normal.woff2",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE_PAGINA).then((c) => c.addAll(PAGINA.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith("pagina-") && k !== CACHE_PAGINA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function redPrimero(req, cache) {
  const c = await caches.open(cache);
  try {
    const r = await fetch(req, { cache: "no-cache" }); // revalida con el servidor: una versión nueva llega al abrir
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch (e) {
    const guardada = await c.match(req, { ignoreSearch: true });
    if (!guardada) throw e;
    // Marca la respuesta para que la página avise que los datos son de la copia guardada.
    const h = new Headers(guardada.headers);
    h.set("x-desde-cache", "1");
    return new Response(await guardada.blob(), { status: 200, headers: h });
  }
}

async function copiaPrimero(req) {
  const c = await caches.open(CACHE_PAGINA);
  const guardada = await c.match(req); // coincidencia exacta: app.js?v=<commit> nuevo no usa la copia vieja
  if (guardada) return guardada;
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone());
  return r;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // mosaicos e imágenes satelitales: directo a la red
  if (/\/(corredor|regreso)\/|\/vendor\/maplibre\//.test(url.pathname)) return; // prototipos aparte, sin caché
  if (url.pathname.includes("/data/")) { ev.respondWith(redPrimero(req, CACHE_DATOS)); return; }
  if (req.mode === "navigate") { ev.respondWith(redPrimero(req, CACHE_PAGINA)); return; }
  ev.respondWith(copiaPrimero(req));
});
