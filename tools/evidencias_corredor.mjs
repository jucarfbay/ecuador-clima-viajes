// Evidencias de la prueba técnica del corredor: capturas a 1920, 1440 y 390 px, control temporal y video del recorrido.
// Uso: node tools/evidencias_corredor.mjs <url> <carpeta>
// Se ejecuta en GitHub Actions (WebGL por software: los tiempos aquí NO sirven para medir rendimiento).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const URL_BASE = process.argv[2] || "https://jucarfbay.github.io/ecuador-clima-viajes/corredor/";
const OUT = process.argv[3] || "evidencias";
mkdirSync(OUT, { recursive: true });
const registro = [];
const log = (...a) => { const l = a.join(" "); console.log(l); registro.push(l); };

const nav = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--enable-webgl"] });

async function listo(p, extraMs = 1500) {
  await p.waitForFunction(() => window.__mapa && window.__mapa.loaded() && window.__mapa.areTilesLoaded() &&
    document.querySelector("#estado-carga")?.classList.contains("listo"), null, { timeout: 120000 });
  await p.waitForTimeout(extraMs);
  await p.waitForFunction(() => window.__mapa.areTilesLoaded(), null, { timeout: 60000 });
}

async function sesion(nombre, ancho, alto, escala, fn, video = false) {
  const ctx = await nav.newContext({
    viewport: { width: ancho, height: alto }, deviceScaleFactor: escala, isMobile: ancho < 640, hasTouch: ancho < 640,
    ...(video ? { recordVideo: { dir: `${OUT}/video-tmp`, size: { width: ancho, height: alto } } } : {}),
  });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") log(`[${nombre}] ${m.type()}: ${m.text().slice(0, 200)}`); });
  p.on("pageerror", (e) => log(`[${nombre}] pageerror: ${e.message}`));
  const t0 = Date.now();
  await p.goto(URL_BASE + "?evidencia=1", { waitUntil: "load" });
  await fn(p);
  log(`[${nombre}] listo en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await ctx.close();
  return p;
}

/** Salida con más lluvia media en el camino dentro de las 72 h (para mostrar el campo y la trayectoria con datos). */
async function salidaLluviosa(p) {
  return p.evaluate(() => {
    const S = window.__corredor;
    let k = -1, max = -1;
    S.exposiciones.forEach((x, i) => { if ((x.media ?? -1) > max) { max = x.media; k = i; } });
    const input = document.querySelector("#hora");
    input.value = k; input.dispatchEvent(new Event("input", { bubbles: true }));
    const t = S.salidas[k];
    return { k, media: max, hora: new Date(t - 5 * 3600e3).toISOString().slice(0, 16) };
  });
}

async function salida(p, hora) {
  return p.evaluate((h) => {
    const S = window.__corredor;
    const k = S.salidas.findIndex((t) => new Date(t - 5 * 3600e3).getUTCHours() === h && t > Date.now());
    if (k < 0) return null;
    const input = document.querySelector("#hora");
    input.value = k; input.dispatchEvent(new Event("input", { bubbles: true }));
    return k;
  }, hora);
}

// 1920 y 1440: vista del valle, salida 08:00 y 10:00, y vista cenital.
for (const [ancho, alto] of [[1920, 1080], [1440, 900]]) {
  await sesion(`${ancho}`, ancho, alto, 1, async (p) => {
    await listo(p, 6500); // la entrada de cámara dura ~5 s
    await salida(p, 8); await p.waitForTimeout(800); await listo(p, 300);
    await p.screenshot({ path: `${OUT}/corredor-${ancho}-salida-0800.png` });
    await salida(p, 10); await p.waitForTimeout(800); await listo(p, 300);
    await p.screenshot({ path: `${OUT}/corredor-${ancho}-salida-1000.png` });
    const ll = await salidaLluviosa(p); await p.waitForTimeout(800); await listo(p, 300);
    log(`[${ancho}] salida con más lluvia en el camino: ${ll.hora} (media ${ll.media?.toFixed(2)} mm/h)`);
    await p.screenshot({ path: `${OUT}/corredor-${ancho}-salida-lluviosa.png` });
    if (ancho === 1440) {
      await p.click("[data-vista=cenital]"); await p.waitForTimeout(3500); await listo(p, 500);
      await p.screenshot({ path: `${OUT}/corredor-1440-cenital.png` });
      // instrumento de estación abierto
      await p.click("[data-vista=general]"); await p.waitForTimeout(3500); await listo(p, 500);
      const est = await p.$(".estacion");
      if (est) { await est.click(); await p.waitForTimeout(600); await p.screenshot({ path: `${OUT}/corredor-1440-estacion.png` }); }
    }
  });
}

// 390 px (teléfono).
await sesion("390", 390, 844, 2, async (p) => {
  await listo(p, 6500);
  await salida(p, 8); await p.waitForTimeout(800); await listo(p, 300);
  await p.screenshot({ path: `${OUT}/corredor-390-salida-0800.png` });
  await salidaLluviosa(p); await p.waitForTimeout(800); await listo(p, 300);
  await p.screenshot({ path: `${OUT}/corredor-390-salida-lluviosa.png` });
  await p.click("#b-info"); await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/corredor-390-fuentes.png` });
});

// Video: entrada de cámara y recorrido completo con salida 08:00 (1280x720).
await sesion("video", 1280, 720, 1, async (p) => {
  await listo(p, 6000);
  await salida(p, 8); await p.waitForTimeout(800);
  await p.click("#b-recorrer");
  await p.waitForFunction(() => !window.__corredor.recorriendo, null, { timeout: 180000 });
  const fps = await p.evaluate(() => window.__corredor.fps.slice());
  log(`[video] fps del recorrido por software (cota inferior, sin GPU): ${JSON.stringify(fps.slice(-40))}`);
  await p.waitForTimeout(3800);
}, true);

// Video 2: control temporal. La hora de salida avanza de hora en hora; cambian a la vez la banda, la trayectoria,
// el campo de lluvia, las horas de paso y la lectura.
await sesion("tiempo", 1280, 720, 1, async (p) => {
  await listo(p, 6000);
  const n = await p.evaluate(() => window.__corredor.salidas.length);
  for (let k = 0; k < Math.min(n, 48); k++) {
    await p.evaluate((i) => { const el = document.querySelector("#hora"); el.value = i; el.dispatchEvent(new Event("input", { bubbles: true })); }, k);
    await p.waitForTimeout(450);
  }
  const fps = await p.evaluate(() => window.__corredor.fps.slice());
  log(`[tiempo] fps por software (cota inferior, sin GPU): ${JSON.stringify(fps.slice(-20))}`);
}, true);

writeFileSync(`${OUT}/registro.txt`, registro.join("\n") + "\n");
await nav.close();
