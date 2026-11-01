// Evidencias de /regreso/ (ruta desde la ubicación del visitante hasta San Rafael). Uso:
//   node tools/evidencias_regreso.mjs <url_regreso> <carpeta>
// La ubicación se simula con la geolocalización de Playwright (o se niega el permiso). WebGL por software: los fps
// aquí NO son un benchmark.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL_ = process.argv[2];
const OUT = process.argv[3] || "evidencias";
mkdirSync(OUT, { recursive: true });
const registro = [];
const log = (...a) => { const l = a.join(" "); console.log(l); registro.push(l); };
const nav = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });

const LUGARES = {
  banos: { latitude: -1.3958, longitude: -78.4231, accuracy: 30 },        // centro de Baños
  ambato: { latitude: -1.2412, longitude: -78.6285, accuracy: 25 },       // centro de Ambato
  guayaquil: { latitude: -2.1894, longitude: -79.8891, accuracy: 40 },    // fuera del corredor con datos
};

async function listo(p, extraMs = 1200) {
  await p.waitForFunction(() => window.__mapa && window.__mapa.loaded() && document.querySelector("#estado-carga")?.classList.contains("listo"), null, { timeout: 150000 });
  await p.waitForTimeout(extraMs);
  await p.waitForFunction(() => window.__mapa.areTilesLoaded(), null, { timeout: 90000 }).catch(() => log("aviso: teselas sin terminar"));
}

async function salida(p, hora) {
  return p.evaluate((h) => {
    const S = window.__corredor, loc = (t) => new Date(t - 5 * 3600e3);
    const ahora = Date.now();
    const fechas = [...new Set(S.salidas.filter((t) => t >= ahora).map((t) => loc(t).toISOString().slice(0, 10)))];
    const tiene = (f, hh) => S.salidas.some((t) => loc(t).toISOString().slice(0, 10) === f && loc(t).getUTCHours() === hh);
    const D = fechas.find((f) => tiene(f, 8) && tiene(f, 19));
    const k = S.salidas.findIndex((t) => loc(t).toISOString().slice(0, 10) === D && loc(t).getUTCHours() === h);
    const input = document.querySelector("#hora");
    input.value = k; input.dispatchEvent(new Event("input", { bubbles: true }));
    return { k, fecha: D };
  }, hora);
}

async function camara(p) {
  await p.evaluate(() => { window.__corredor.recorriendo = false; window.__mapa.stop(); window.__mapa.jumpTo(window.__vistaGeneral()); });
}

async function colisiones(p) {
  return p.evaluate(() => {
    const hojas = [];
    document.querySelectorAll(".maplibregl-marker").forEach((mk, i) => {
      if (getComputedStyle(mk).opacity === "0" || mk.hidden) return;
      mk.querySelectorAll("*").forEach((el) => {
        if (el.children.length || !el.textContent.trim()) return;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
        hojas.push({ i, r, t: el.textContent.trim().slice(0, 24) });
      });
    });
    const pares = [];
    for (let a = 0; a < hojas.length; a++) for (let b = a + 1; b < hojas.length; b++) {
      const A = hojas[a], B = hojas[b];
      if (A.i === B.i) continue;
      if (A.r.left < B.r.right && A.r.right > B.r.left && A.r.top < B.r.bottom && A.r.bottom > B.r.top) pares.push(`${A.t} × ${B.t}`);
    }
    return pares;
  });
}

/** Extremos de la ruta dentro de la zona libre (entre el título/mandos y la banda) y sin salirse de la pantalla. */
async function extremosVisibles(p) {
  return p.evaluate(() => {
    const S = window.__corredor, m = window.__mapa, C = S.ruta.coords;
    const arriba = Math.max(document.querySelector(".titulo").getBoundingClientRect().bottom, document.querySelector(".mandos").getBoundingClientRect().bottom);
    const abajo = document.querySelector(".tiempo").getBoundingClientRect().top;
    return [C[0], C[C.length - 1]].map((c) => { const q = m.project(c); return q.x >= 0 && q.x <= innerWidth && q.y >= arriba && q.y <= abajo; });
  });
}

async function resumen(p, nombre) {
  const r = await p.evaluate(() => {
    const S = window.__corredor, R = S.ruta;
    return {
      titulo: document.querySelector(".ruta-nombre").innerText.replace(/\s+/g, " "),
      sub: document.querySelector("#titulo-sub").innerText,
      aviso: document.querySelector("#ubicacion").hidden ? "(sin aviso de ubicación)" : document.querySelector("#ubicacion").innerText,
      origen: R.origen || "respaldo desde Baños", km: R.distancia_km, min: R.duracion_min,
      hitos: R.hitos.map((h) => `${h.nombre} km ${h.km} min ${h.min}`).join(" | "),
    };
  });
  log(`[${nombre}] título: ${r.titulo} — ${r.sub}`);
  log(`[${nombre}] ubicación: ${r.aviso}`);
  log(`[${nombre}] ruta: ${r.km} km, ${r.min} min; origen ${JSON.stringify(r.origen)}`);
  log(`[${nombre}] hitos: ${r.hitos}`);
}

async function sesion(nombre, ancho, alto, escala, { lugar = null, permiso = true, query = "" } = {}, fn) {
  const ctx = await nav.newContext({
    viewport: { width: ancho, height: alto }, deviceScaleFactor: escala, isMobile: ancho < 640, hasTouch: ancho < 640,
    ...(lugar ? { geolocation: LUGARES[lugar] } : {}), ...(permiso && lugar ? { permissions: ["geolocation"] } : {}),
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => log(`[${nombre}] pageerror: ${e.message}`));
  p.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/Failed to load resource|ERR_|WebGL|GPU/.test(m.text())) log(`[${nombre}] consola: ${m.text().slice(0, 160)}`); });
  const t0 = Date.now();
  await p.goto(URL_ + "?evidencia=1" + query, { waitUntil: "load" });
  try { await fn(p); } catch (e) { log(`[${nombre}] FALLO: ${e.message.slice(0, 200)}`); }
  log(`[${nombre}] ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await ctx.close();
}

async function capturar(p, nombre, horas = [8, 19]) {
  await listo(p, 6000);
  await resumen(p, nombre);
  for (const h of horas) {
    const s = await salida(p, h);
    await camara(p);
    await p.waitForTimeout(900); await listo(p, 400);
    const col = await colisiones(p);
    log(`[${nombre}] salida ${String(h).padStart(2, "0")}:00 del ${s.fecha}: ${col.length} colisiones${col.length ? " (" + col.slice(0, 6).join("; ") + ")" : ""}; extremos en la zona libre: ${JSON.stringify(await extremosVisibles(p))}`);
    log(`[${nombre}] decisión: ${(await p.evaluate(() => document.querySelector("#decision")?.innerText || "")).replace(/\s+/g, " ")}`);
    await p.screenshot({ path: `${OUT}/regreso-${nombre}-salida-${String(h).padStart(2, "0")}00.png` });
  }
}

// 1. Desde Ambato y desde Baños, en escritorio y teléfono.
await sesion("ambato-1440", 1440, 900, 1, { lugar: "ambato" }, (p) => capturar(p, "ambato-1440"));
await sesion("ambato-390", 390, 844, 2, { lugar: "ambato" }, (p) => capturar(p, "ambato-390"));
await sesion("banos-1920", 1920, 1080, 1, { lugar: "banos" }, (p) => capturar(p, "banos-1920", [19]));
await sesion("banos-360", 360, 800, 2, { lugar: "banos" }, (p) => capturar(p, "banos-360", [19]));
// 2. Permiso negado y ubicación fuera del corredor: respaldo desde Baños, con el motivo a la vista.
await sesion("sin-permiso-1440", 1440, 900, 1, { lugar: "ambato", permiso: false }, (p) => capturar(p, "sin-permiso-1440", [19]));
await sesion("fuera-390", 390, 844, 2, { lugar: "guayaquil" }, (p) => capturar(p, "fuera-390", [19]));
// 3. Punto fijado en la dirección (?desde=lat,lon): Latacunga.
await sesion("desde-latacunga-1440", 1440, 900, 1, { query: "&desde=-0.9352,-78.6155" }, (p) => capturar(p, "desde-latacunga-1440", [19]));

writeFileSync(`${OUT}/registro.txt`, registro.join("\n") + "\n");
await nav.close();
