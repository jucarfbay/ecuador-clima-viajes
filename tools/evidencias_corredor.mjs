// Evidencias de la Iteración 2 del corredor (rúbrica V2). Uso:
//   node tools/evidencias_corredor.mjs <url_despues> <carpeta> [url_antes]
// Antes y después se capturan en la MISMA ejecución, con los MISMOS datos, la MISMA cámara fija y las MISMAS salidas.
// Se ejecuta en GitHub Actions con WebGL por software: los fps aquí NO son un benchmark (ver ?medir=1 con GPU).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const DESPUES = process.argv[2];
const OUT = process.argv[3] || "evidencias";
const ANTES = process.argv[4] || null;
mkdirSync(OUT, { recursive: true });
const registro = [];
const log = (...a) => { const l = a.join(" "); console.log(l); registro.push(l); };
const nav = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });

const TAMANOS = [["1920", 1920, 1080, 1], ["1440", 1440, 900, 1], ["390", 390, 844, 2], ["360", 360, 800, 2]];
// Cámara fija común (la misma para antes y después).
const CAMARA = (ancho) => ({ center: [-78.585, -1.15], zoom: ancho < 640 ? 10.05 : 10.95, pitch: 73, bearing: 154 });

async function listo(p, extraMs = 1200) {
  await p.waitForFunction(() => window.__mapa && window.__mapa.loaded() && document.querySelector("#estado-carga")?.classList.contains("listo"), null, { timeout: 150000 });
  await p.waitForTimeout(extraMs);
  await p.waitForFunction(() => window.__mapa.areTilesLoaded(), null, { timeout: 90000 }).catch(() => log("aviso: teselas sin terminar"));
}

/** Elige la salida de una hora local dada, en la fecha D común (la primera fecha futura con 08:00 y 19:00). */
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

async function camaraFija(p, ancho) {
  await p.evaluate((c) => { window.__corredor.recorriendo = false; window.__mapa.stop(); window.__mapa.jumpTo(c); }, CAMARA(ancho));
}

/** Pares de etiquetas visibles de marcadores DISTINTOS que se pisan (evidencia de la dimensión D). */
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

/** Distancia (px) entre el punto de cada marca y la proyección de su coordenada: verifica que no haya desplazamientos. */
async function posicion(p) {
  return p.evaluate(() => {
    const m = window.__mapa, errs = [];
    document.querySelectorAll(".maplibregl-marker .punto").forEach((pt) => {
      const mk = pt.closest(".maplibregl-marker");
      const ll = mk.__ll; if (!ll) return;
      const r = pt.getBoundingClientRect(), q = m.project(ll);
      const rc = m.getCanvas().getBoundingClientRect();
      errs.push(Math.hypot(r.left + r.width / 2 - (rc.left + q.x), r.top + r.height / 2 - (rc.top + q.y)));
    });
    return errs.length ? { n: errs.length, max: +Math.max(...errs).toFixed(1) } : null;
  });
}

async function sesion(nombre, url, ancho, alto, escala, fn, opciones = {}) {
  const ctx = await nav.newContext({
    viewport: { width: ancho, height: alto }, deviceScaleFactor: escala, isMobile: ancho < 640, hasTouch: ancho < 640,
    reducedMotion: opciones.reducido ? "reduce" : "no-preference",
    ...(opciones.video ? { recordVideo: { dir: `${OUT}/video-tmp/${opciones.video}`, size: { width: ancho, height: alto } } } : {}),
  });
  const p = await ctx.newPage();
  if (opciones.bloquear) await p.route(opciones.bloquear, (r) => r.abort());
  p.on("pageerror", (e) => log(`[${nombre}] pageerror: ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) log(`[${nombre}] error: ${m.text().slice(0, 160)}`); });
  const t0 = Date.now();
  await p.goto(url + "?evidencia=1", { waitUntil: "load" });
  try { await fn(p); } catch (e) { log(`[${nombre}] FALLO: ${e.message.slice(0, 200)}`); }
  log(`[${nombre}] ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await ctx.close();
}

// 1. Antes / después: mismas salidas (08:00 y 19:00 de la fecha D), misma cámara, cuatro tamaños.
for (const [version, url] of [["despues", DESPUES], ...(ANTES ? [["antes", ANTES]] : [])]) {
  for (const [tag, ancho, alto, escala] of TAMANOS) {
    await sesion(`${version}-${tag}`, url, ancho, alto, escala, async (p) => {
      await listo(p, 6500);
      for (const h of [8, 19]) {
        const s = await salida(p, h);
        await camaraFija(p, ancho);
        await p.waitForTimeout(900); await listo(p, 400);
        const col = await colisiones(p);
        log(`[${version}-${tag}] salida ${String(h).padStart(2, "0")}:00 del ${s.fecha}: ${col.length} colisiones de etiquetas${col.length ? " (" + col.slice(0, 6).join("; ") + ")" : ""}`);
        if (version === "despues") {
          log(`[${version}-${tag}] posición de marcas: ${JSON.stringify(await posicion(p))}`);
          if (tag === "1440") log(`[${version}-${tag}] decisión ${String(h).padStart(2, "0")}:00: ${(await p.evaluate(() => document.querySelector("#decision")?.innerText || "")).replace(/\s+/g, " ")}`);
        }
        await p.screenshot({ path: `${OUT}/${version}-${tag}-salida-${String(h).padStart(2, "0")}00.png` });
      }
    });
  }
}

// 2. Foco de estación e instrumento (escritorio y teléfono), solo después.
for (const [tag, ancho, alto, escala] of [["1440", 1440, 900, 1], ["390", 390, 844, 2]]) {
  await sesion(`estacion-${tag}`, DESPUES, ancho, alto, escala, async (p) => {
    await listo(p, 6500);
    await salida(p, 19); await camaraFija(p, ancho); await listo(p, 300);
    const est = await p.$(".estacion");
    await est.click();
    await p.waitForTimeout(2600); await listo(p, 300);
    const texto = await p.evaluate(() => document.querySelector(".instrumento")?.innerText || "sin instrumento");
    log(`[estacion-${tag}] instrumento: ${texto.replace(/\s+/g, " ").slice(0, 400)}`);
    await p.screenshot({ path: `${OUT}/despues-${tag}-estacion.png` });
  });
}

// 3. T5: fallo del fondo satelital (se bloquean sus teselas).
await sesion("fallo-satelite", DESPUES, 1440, 900, 1, async (p) => {
  const t0 = Date.now();
  await p.waitForFunction(() => document.querySelector("#estado-carga")?.classList.contains("listo"), null, { timeout: 60000 });
  log(`[fallo-satelite] escena visible a los ${((Date.now() - t0) / 1000).toFixed(0)} s sin fondo satelital`);
  await p.waitForTimeout(6500);
  await salida(p, 19); await camaraFija(p, 1440); await p.waitForTimeout(1500);
  const aviso = await p.evaluate(() => { const a = document.querySelector("#aviso"); return a && !a.hidden ? a.textContent : "sin aviso"; });
  log(`[fallo-satelite] aviso: ${aviso}`);
  await p.screenshot({ path: `${OUT}/despues-1440-fallo-satelite.png` });
}, { bloquear: "**/tiles.maps.eox.at/**" });

// 4. Movimiento reducido: "Recorrer" salta por hitos, sin vuelo.
await sesion("movimiento-reducido", DESPUES, 1440, 900, 1, async (p) => {
  await listo(p, 2500);
  await p.click("#b-recorrer"); await p.waitForTimeout(5600); await listo(p, 300);
  log(`[movimiento-reducido] vista tras 2 saltos: ${JSON.stringify(await p.evaluate(() => ({ z: +window.__mapa.getZoom().toFixed(2), pitch: Math.round(window.__mapa.getPitch()) })))}`);
  await p.screenshot({ path: `${OUT}/despues-1440-movimiento-reducido.png` });
}, { reducido: true });

// 5. Teclado: Tab hasta la línea de tiempo y flechas.
await sesion("teclado", DESPUES, 1440, 900, 1, async (p) => {
  await listo(p, 6500);
  const k0 = await p.evaluate(() => window.__corredor.k);
  let llega = false;
  for (let i = 0; i < 12 && !llega; i++) { await p.keyboard.press("Tab"); llega = await p.evaluate(() => document.activeElement?.id === "hora"); }
  for (let i = 0; i < 3; i++) await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(500);
  const k1 = await p.evaluate(() => window.__corredor.k);
  log(`[teclado] línea de tiempo alcanzable con Tab: ${llega}; flecha derecha ×3: salida ${k0} → ${k1}`);
  await p.screenshot({ path: `${OUT}/despues-1440-teclado.png` });
});

// 6. Video: comparación 08:00 ↔ 19:00 (cambios simultáneos), solo después.
await sesion("comparacion", DESPUES, 1280, 720, 1, async (p) => {
  await listo(p, 6500);
  for (let r = 0; r < 3; r++) for (const h of [8, 19]) {
    await salida(p, h); await camaraFija(p, 1280); await p.waitForTimeout(2500);
  }
}, { video: "comparacion" });

// 7. Video: vuelo continuo de cámara, solo después.
await sesion("vuelo", DESPUES, 1280, 720, 1, async (p) => {
  await listo(p, 6500);
  await salida(p, 19); await p.waitForTimeout(800);
  await p.click("#b-recorrer");
  await p.waitForFunction(() => !window.__corredor.recorriendo, null, { timeout: 240000 });
  await p.waitForTimeout(3500);
  log(`[vuelo] fps por software (NO es benchmark): ${JSON.stringify((await p.evaluate(() => window.__corredor.fps)).slice(-30))}`);
}, { video: "vuelo" });

writeFileSync(`${OUT}/registro.txt`, registro.join("\n") + "\n");
await nav.close();
