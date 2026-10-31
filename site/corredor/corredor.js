/* El corredor vivo — Iteración 2 (San Rafael, Quito → Machachi → Latacunga → Ambato → Pelileo → Baños).
 *
 * Reglas de datos (no negociables):
 *  - Relieve: elevaciones reales (Terrarium/AWS). Ruta: geometría OSRM sobre OpenStreetMap, versionada; tiempos
 *    conciliados con la duración total de OSRM (una sola cifra: la de datos/ruta.json).
 *  - Lluvia: ECMWF IFS HRES en sus celdas nativas (~8 km), sin interpolar. Sobre la ruta, la "cortina" toma la celda
 *    que contiene cada tramo a la hora en que pasarías; su altura es proporcional a esa cifra, no a más detalle.
 *  - Estaciones: metadatos y lecturas del visor del INAMHI; mover la hora de salida NUNCA cambia una medición.
 *  - Cielo, bruma y luz son ambientación; la dirección de la luz sigue al sol (astronomía), no indica nubosidad.
 */
"use strict";

const ML = window.maplibregl;
const H = 3600e3;
const UTC5 = 5 * H; // Ecuador continental: local = UTC - 5 h
const MOV = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOVIL = window.matchMedia("(max-width: 640px)").matches;
const PARAM = new URLSearchParams(location.search);

// Escala de intensidad (mm en la hora). La misma en la cortina, el velo de celdas, la matriz y la leyenda.
const ESCALA = [
  [0.1, [156, 200, 236]], [0.5, [111, 168, 224]], [1, [75, 143, 214]],
  [2.5, [47, 95, 184]], [5, [107, 63, 179]], [10, [142, 44, 158]],
];
const CORREDOR_KM = 14; // el velo de lluvia se muestra solo en celdas cuyo centro está a esta distancia de la vía
const FILAS = 36; // filas de la matriz distancia × salida (~4,5 km cada una)
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const S = {
  ruta: null, lluvia: null, obs: null, pron: null, mapa: null,
  celdaDeVertice: null, salidas: [], k: 0, valida: -1, matriz: null,
  progreso: 0, recorriendo: false, anim: null, marcadores: {}, etiquetas: [], fps: [], fallos: 0,
};

// ------------------------------------------------------------------ utilidades

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 1 });
const num = (x) => (x == null || Number.isNaN(x) ? "—" : fmt.format(x));
/** "2026-10-30T20:00" (hora local de Ecuador, sin zona) -> ms UTC. */
const localAMs = (s) => { const [d, t = "00:00"] = s.slice(0, 16).split("T"); const [y, m, dd] = d.split("-").map(Number); const [hh, mi] = t.split(":").map(Number); return Date.UTC(y, m - 1, dd, hh, mi) + UTC5; };
const local = (ms) => new Date(ms - UTC5); // campos UTC = hora local
const hhmm = (ms) => local(ms).toISOString().slice(11, 16);
const diaTxt = (ms) => { const d = local(ms); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`; };
const fechaTxt = (ms) => { const d = local(ms); return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; };
const deCada10 = (p) => `${Math.round(p * 10)} de cada 10`;
function distKm(a, b) {
  const R = 6371, r = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function rumbo(a, b) {
  const r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function colorDe(mm) {
  if (mm == null || mm < ESCALA[0][0]) return null;
  let c = ESCALA[0][1];
  for (const [u, col] of ESCALA) if (mm >= u) c = col;
  return c;
}
const pasoColor = () => ["step", ["get", "mm"], "rgba(0,0,0,0)", ...ESCALA.flatMap(([u, c]) => [u, `rgb(${c.join(",")})`])];
async function json(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

// ------------------------------------------------------------------ geometría de la ruta

function enKm(km) {
  const K = S.ruta.km;
  if (km <= 0) return { i: 0, f: 0 };
  if (km >= K[K.length - 1]) return { i: K.length - 2, f: 1 };
  let lo = 0, hi = K.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (K[m] <= km) lo = m; else hi = m; }
  return { i: lo, f: (km - K[lo]) / Math.max(1e-9, K[lo + 1] - K[lo]) };
}
function puntoEnKm(km) {
  const { i, f } = enKm(km), C = S.ruta.coords;
  return [C[i][0] + (C[i + 1][0] - C[i][0]) * f, C[i][1] + (C[i + 1][1] - C[i][1]) * f];
}
function segundosEnKm(km) { const { i, f } = enKm(km), s = S.ruta.s; return s[i] + (s[i + 1] - s[i]) * f; }
function kmEnSegundos(seg) {
  const s = S.ruta.s;
  if (seg <= 0) return 0;
  if (seg >= s[s.length - 1]) return S.ruta.km[s.length - 1];
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= seg) lo = m; else hi = m; }
  const f = (seg - s[lo]) / Math.max(1e-9, s[lo + 1] - s[lo]);
  return S.ruta.km[lo] + (S.ruta.km[lo + 1] - S.ruta.km[lo]) * f;
}
const duracionMs = () => S.ruta.s[S.ruta.s.length - 1] * 1000;
const totalKm = () => S.ruta.km[S.ruta.km.length - 1];
const hitoCercano = (km) => S.ruta.hitos.reduce((a, h) => (Math.abs(h.km - km) < Math.abs(a.km - km) ? h : a));

// ------------------------------------------------------------------ lluvia (celdas nativas)

/** Índice de la hora del pronóstico que contiene el instante t (cada valor cubre la hora que termina en tiempos[i]). */
function horaDe(t) {
  const T = S.lluvia._fin;
  for (let i = 0; i < T.length; i++) if (t < T[i] && t >= T[i] - H) return i;
  return -1;
}
function mmEn(celda, i) { const v = i < 0 ? null : S.lluvia.valores_dmm[i][celda]; return v == null ? null : v / 10; }

function prepararLluvia() {
  const L = S.lluvia;
  L._fin = L.tiempos.map(localAMs);
  const dlat = L.paso_lat || 0.07;
  const filas = {};
  L.celdas.forEach((c) => (filas[c.lat] ||= []).push(c.lon));
  const dlonFila = {};
  for (const [lat, lons] of Object.entries(filas)) {
    const v = lons.sort((a, b) => a - b), d = v.slice(1).map((x, i) => x - v[i]).sort((a, b) => a - b);
    dlonFila[lat] = d.length ? d[d.length >> 1] : dlat;
  }
  const muestra = S.ruta.coords.filter((_, i) => i % 6 === 0);
  L._geo = {
    type: "FeatureCollection",
    features: L.celdas.map((c, i) => {
      const dlon = dlonFila[c.lat];
      const cerca = Math.min(...muestra.map((p) => distKm([c.lon, c.lat], p))) <= CORREDOR_KM;
      return {
        type: "Feature", id: i, properties: { mm: 0, cerca },
        geometry: { type: "Polygon", coordinates: [[
          [c.lon - dlon / 2, c.lat - dlat / 2], [c.lon + dlon / 2, c.lat - dlat / 2],
          [c.lon + dlon / 2, c.lat + dlat / 2], [c.lon - dlon / 2, c.lat + dlat / 2], [c.lon - dlon / 2, c.lat - dlat / 2]]] },
      };
    }),
  };
  // Celda nativa de cada vértice: la de centro más cercano (misma regla que usa Open-Meteo para elegirla).
  S.celdaDeVertice = S.ruta.coords.map(([lon, lat]) => {
    let mejor = 0, dmin = Infinity;
    L.celdas.forEach((c, j) => { const d = (c.lat - lat) ** 2 + ((c.lon - lon) * Math.cos(lat * Math.PI / 180)) ** 2; if (d < dmin) { dmin = d; mejor = j; } });
    return mejor;
  });
}

/** Lluvia (mm en la hora) que encontraría el viajero en cada vértice, saliendo en `salida` (ms UTC). */
function lluviaEnRuta(salida) {
  return S.ruta.s.map((seg, v) => mmEn(S.celdaDeVertice[v], horaDe(salida + seg * 1000)));
}

/** Exposición de una salida: intensidad media ponderada por tiempo en el camino, y el peor punto. */
function exposicion(salida) {
  const mm = lluviaEnRuta(salida), s = S.ruta.s;
  let suma = 0, pesos = 0, peor = { mm: 0, v: -1 }, faltan = false;
  for (let v = 1; v < s.length; v++) {
    const dt = s[v] - s[v - 1];
    if (mm[v] == null) { faltan = true; continue; }
    suma += mm[v] * dt; pesos += dt;
    if (mm[v] > peor.mm) peor = { mm: mm[v], v };
  }
  return { media: pesos && !faltan ? suma / pesos : null, peor, faltan };
}

/** Confianza del punto más lluvioso: fracción de los 51 escenarios del ensamble ECMWF que dan ≥ 1 mm en esa hora,
 *  en la localidad del pronóstico por ensamble más cercana (solo existen para las localidades de la ruta). */
function confianza(t, km) {
  const hor = S.pron?.horaria;
  if (!hor) return null;
  // Hito más cercano que tenga serie del ensamble (San Rafael usa la de Quito, declarada en datos/ruta.json).
  const conSerie = S.ruta.hitos.filter((x) => hor[x.serie_ensamble || x.id]);
  if (!conSerie.length) return null;
  const h = conSerie.reduce((a, x) => (Math.abs(x.km - km) < Math.abs(a.km - km) ? x : a));
  const id = h.serie_ensamble || h.id, serie = hor[id];
  const lugar = id === h.id ? h.nombre : (S.pron?.puntos?.find((p) => p.id === id)?.nombre || id);
  const i = serie.tiempos.findIndex((x) => { const fin = localAMs(x); return t < fin && t >= fin - H; });
  if (i < 0) return null;
  const vals = serie.miembros_dmm.map((m) => m[i]).filter((v) => v != null);
  if (!vals.length) return null;
  return { p: vals.filter((v) => v >= 10).length / vals.length, n: vals.length, lugar };
}

// ------------------------------------------------------------------ escena

function estilo() {
  return {
    version: 8,
    sources: {
      satelite: {
        type: "raster", tileSize: 256, maxzoom: 13,
        tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg"],
        attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2024 by EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0',
      },
      dem: {
        type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 14,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
        attribution: 'Relieve: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen/AWS; SRTM y otras fuentes)',
      },
      sombras: {
        type: "raster-dem", encoding: "terrarium", tileSize: 256, maxzoom: 14,
        tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      },
    },
    layers: [
      { id: "fondo", type: "background", paint: { "background-color": "#0B1218" } },
      // El mosaico Sentinel-2 trae la luz cenital de mediodía: se baja y se contrasta para que mande el sombreado.
      { id: "satelite", type: "raster", source: "satelite",
        paint: { "raster-saturation": 0.08, "raster-contrast": 0.28, "raster-brightness-max": 0.72, "raster-brightness-min": 0.02 } },
      { id: "sombras", type: "hillshade", source: "sombras",
        paint: {
          "hillshade-method": "combined",
          "hillshade-illumination-direction": 292, "hillshade-illumination-altitude": 16, "hillshade-illumination-anchor": "map",
          "hillshade-exaggeration": 0.9, "hillshade-shadow-color": "rgba(3,9,20,0.96)", "hillshade-highlight-color": "rgba(255,196,128,0.42)",
          "hillshade-accent-color": "rgba(6,14,28,0.75)",
        } },
    ],
    terrain: { source: "dem", exaggeration: 1.0 },
    sky: {
      "sky-color": "#081522", "horizon-color": "#c9976a", "fog-color": "#4a5d6c",
      "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.65, "fog-ground-blend": 0.42,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 0.9, 12, 0.45],
    },
  };
}

const VISTAS = {
  // Panorama: desde el valle de Machachi hacia el sur, por la avenida de los volcanes: el Cotopaxi a la izquierda,
  // el valle de Latacunga y Ambato al fondo y el Tungurahua cerrando el corredor.
  general: () => ({ center: [-78.57, -0.86], zoom: MOVIL ? 9.05 : 9.75, pitch: 72, bearing: 172 }),
  cenital: () => ({ center: [-78.52, -0.86], zoom: MOVIL ? 8.25 : 8.85, pitch: 0, bearing: 0 }),
  intro: () => ({ center: [-78.5, -0.5], zoom: MOVIL ? 8.0 : 8.6, pitch: 50, bearing: 176 }),
};

async function iniciar() {
  try {
    const [ruta, lluvia, obs, pron] = await Promise.all([
      json("datos/ruta.json"), json("../data/corredor_lluvia.json"),
      json("../data/estaciones.json").catch(() => null), json("../data/pronostico.json").catch(() => null)]);
    Object.assign(S, { ruta, lluvia, obs, pron });
  } catch (e) {
    const el = $("#estado-carga");
    el.classList.add("error");
    el.textContent = `No se pudieron cargar los datos del corredor (${e.message}). La escena no se muestra con datos incompletos.`;
    return;
  }
  pintarTitulo();
  prepararLluvia();
  prepararSalidas();

  const mapa = new ML.Map({
    container: "escena", style: estilo(), ...VISTAS.intro(), maxPitch: 78, attributionControl: { compact: MOVIL },
    // ?captura=1 conserva el búfer de dibujo para poder capturar la escena desde herramientas de revisión
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: PARAM.has("captura") }, fadeDuration: 0,
  });
  S.mapa = mapa;
  window.__mapa = mapa;
  mapa.on("error", (ev) => {
    console.warn("mapa", ev?.error?.message || ev);
    if (["satelite", "dem", "sombras"].includes(ev?.sourceId) || /Failed to fetch|AJAXError/.test(ev?.error?.message || "")) avisarFallo();
  });
  // La escena arranca con "load" o, si las teselas del fondo/relieve no llegan, en cuanto el estilo esté listo:
  // la ruta, las horas y la lluvia no dependen de esas teselas.
  let arrancado = false;
  const arrancar = () => {
    if (arrancado) return;
    arrancado = true;
    capas();
    marcadores();
    estaciones();
    controles();
    elegirSalida(S.k, { mover: false });
    $("#estado-carga").classList.add("listo");
    // En teléfono la atribución compacta arranca abierta y tapa la escena: se cierra (sigue a un toque).
    if (MOVIL) document.querySelectorAll(".maplibregl-ctrl-attrib.maplibregl-compact-show").forEach((el) => el.classList.remove("maplibregl-compact-show"));
    if (MOV) dibujarEntrada(); else mapa.jumpTo(VISTAS.general());
    medirFps();
    if (PARAM.has("medir")) medicion();
  };
  mapa.on("load", arrancar);
  const espera = setInterval(() => {
    if (arrancado) { clearInterval(espera); return; }
    if (mapa.isStyleLoaded() && performance.now() > 12000) { clearInterval(espera); avisarFallo(true); arrancar(); }
  }, 1000);
  mapa.on("dragstart", detener);
  mapa.on("rotatestart", (e) => { if (e.originalEvent) detener(); });
  // Las etiquetas se reacomodan cuando la cámara cambia (y durante el vuelo, con pausa).
  let pendiente = 0;
  mapa.on("render", () => { const ahora = performance.now(); if (ahora - pendiente > 160) { pendiente = ahora; acomodar(); } });
  mapa.on("moveend", acomodar);
}

/** Aviso único y discreto si el fondo o el relieve no cargan: los datos siguen siendo válidos. */
function avisarFallo(forzar = false) {
  S.fallos++;
  if (S.fallos < 3 && !forzar) return; // un mosaico perdido aislado no amerita aviso
  const el = $("#aviso");
  if (!el.hidden) return;
  el.hidden = false;
  el.textContent = "Parte del relieve o del fondo satelital no cargó. La ruta, las horas de paso y la lluvia prevista siguen siendo válidas.";
}

function capas() {
  const m = S.mapa, R = S.ruta;
  // 1. Velo del campo de lluvia: solo en el corredor y tenue. Cada bloque es una celda nativa (~8 km): su borde
  //    recto ya muestra la resolución real, sin dibujar una rejilla encima. Desde 0,5 mm/h: la llovizna solo se ve en
  //    la cortina y en la matriz, para que el velo no cubra todo el valle.
  m.addSource("lluvia", { type: "geojson", data: S.lluvia._geo });
  m.addLayer({ id: "lluvia", type: "fill", source: "lluvia", filter: ["all", ["get", "cerca"], [">=", ["get", "mm"], 0.5]],
    paint: { "fill-color": pasoColor(), "fill-antialias": false,
      "fill-opacity": ["interpolate", ["linear"], ["get", "mm"], 0.5, 0.05, 1, 0.09, 5, 0.15, 10, 0.19] } });


  // 2. La vía y su sombra (tramos de ~0,4 km para marcar lo recorrido).
  S.tramos = [];
  let ini = 0;
  for (let v = 1; v < R.coords.length; v++) {
    if (R.km[v] - R.km[ini] >= 0.4 || v === R.coords.length - 1) { S.tramos.push([ini, v]); ini = v; }
  }
  m.addSource("tramos", { type: "geojson", data: geoTramos(null, 0, null) });
  const ancho = (base) => ["interpolate", ["linear"], ["zoom"], 8, base * 0.45, 13, base];
  m.addLayer({ id: "ruta-sombra", type: "line", source: "tramos", layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "rgba(4,9,14,0.9)", "line-width": ancho(9), "line-opacity": ["get", "visible"], "line-blur": 1 } });
  m.addLayer({ id: "ruta", type: "line", source: "tramos", layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": ["case", ["get", "recorrido"], "rgba(243,227,191,0.45)", "rgb(243,227,191)"],
      "line-width": ancho(4), "line-opacity": ["get", "visible"],
    } });

  // 3. La cortina: la lluvia que encontrarías en cada tramo a tu hora de paso, levantada sobre la vía.
  //    Altura proporcional a los mm/h de la celda; en una celda de ~8 km la altura es constante (no hay más detalle).
  m.addSource("cortina", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  m.addLayer({ id: "cortina", type: "fill-extrusion", source: "cortina",
    paint: {
      "fill-extrusion-color": pasoColor(), "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 0.72, "fill-extrusion-vertical-gradient": true,
    } });
}

/** Altura de la cortina (m) para una intensidad (mm/h). Lineal hasta 10 mm/h; la leyenda dice la escala. */
const ALTO_MM = 260; // metros por cada mm/h
const altura = (mm) => (mm == null || mm < 0.1 ? 0 : Math.min(2900, 90 + mm * ALTO_MM));

function geoTramos(mm, hasta, vehiculoKm) {
  const R = S.ruta, total = totalKm();
  return {
    type: "FeatureCollection",
    features: S.tramos.map(([a, b]) => ({
      type: "Feature",
      properties: { visible: R.km[a] / total <= hasta ? 1 : 0, recorrido: vehiculoKm != null && R.km[b] <= vehiculoKm },
      geometry: { type: "LineString", coordinates: R.coords.slice(a, b + 1) },
    })),
  };
}

/** Polígonos finos (≈70 m) a lo largo de cada tramo, con la lluvia del tramo (la mayor entre sus vértices). */
function geoCortina(mm, hasta = 1) {
  const R = S.ruta, total = totalKm(), feats = [];
  for (const [a, b] of S.tramos) {
    if (R.km[a] / total > hasta) break;
    let v = null;
    for (let i = a; i <= b; i++) if (mm[i] != null) v = Math.max(v ?? 0, mm[i]);
    if (v == null || v < 0.1) continue;
    const izq = [], der = [];
    for (let i = a; i <= b; i++) {
      const p = R.coords[i], q = R.coords[Math.min(R.coords.length - 1, i + 1)], o = R.coords[Math.max(0, i - 1)];
      const dx = (q[0] - o[0]) * Math.cos(p[1] * Math.PI / 180), dy = q[1] - o[1], n = Math.hypot(dx, dy) || 1;
      const off = 35 / 111320; // 35 m a cada lado
      const ox = (-dy / n) * off / Math.cos(p[1] * Math.PI / 180), oy = (dx / n) * off;
      izq.push([p[0] + ox, p[1] + oy]); der.push([p[0] - ox, p[1] - oy]);
    }
    feats.push({ type: "Feature", properties: { mm: v, h: altura(v) },
      geometry: { type: "Polygon", coordinates: [[...izq, ...der.reverse(), izq[0]]] } });
  }
  return { type: "FeatureCollection", features: feats };
}

function pintarRuta(hasta = 1, vehiculoKm = null) {
  const mm = lluviaEnRuta(S.salidas[S.k]);
  S.mapa.getSource("tramos").setData(geoTramos(mm, hasta, vehiculoKm));
  S.mapa.getSource("cortina").setData(geoCortina(mm, hasta));
}

function pintarCampo(i) {
  if (i === S.valida) return;
  S.valida = i;
  const L = S.lluvia;
  L._geo.features.forEach((f, j) => { f.properties.mm = mmEn(j, i) ?? 0; });
  S.mapa.getSource("lluvia").setData(L._geo);
  if (i >= 0) luz(L._fin[i] - H / 2);
  pintarPie();
}

// ------------------------------------------------------------------ luz según la hora (astronomía, no meteorología)

/** Sol aproximado en el corredor (0,3° a 1,4° S; la diferencia de latitud no cambia el sombreado) a fines de octubre: sale ~06:00 por el este-sureste, se pone ~18:15 por el
 *  oeste-suroeste. Solo orienta el sombreado y el tono; no representa nubosidad. */
function sol(tMs) {
  const d = local(tMs), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const fr = (h - 6.05) / 12.2;
  return { dia: fr > 0 && fr < 1, fr, azimut: 105 + fr * 150, altura: Math.sin(Math.max(0, Math.min(1, fr)) * Math.PI) * 76 };
}
let ultimaLuz = null;
function luz(tMs) {
  const m = S.mapa, s0 = sol(tMs);
  const crep = s0.dia ? Math.min(1, Math.min(s0.fr, 1 - s0.fr) * 12.2) : 0; // 0 noche … 1 pleno día
  const clave = Math.round(crep * 10) + ":" + Math.round(s0.azimut / 10);
  if (clave === ultimaLuz) return;
  ultimaLuz = clave;
  const mezcla = (a, b) => a.map((x, i) => Math.round(x + (b[i] - x) * crep));
  const rgb = (c) => `rgb(${c.join(",")})`;
  m.setPaintProperty("satelite", "raster-brightness-max", 0.38 + 0.34 * crep);
  m.setPaintProperty("satelite", "raster-saturation", -0.35 + 0.43 * crep);
  m.setPaintProperty("sombras", "hillshade-illumination-direction", s0.dia ? s0.azimut : 292);
  m.setPaintProperty("sombras", "hillshade-illumination-altitude", s0.dia ? Math.max(14, Math.min(42, s0.altura)) : 30);
  m.setPaintProperty("sombras", "hillshade-highlight-color", crep > 0.05 ? `rgba(255,196,128,${0.18 + 0.24 * crep})` : "rgba(160,190,230,0.24)");
  // de noche la cortina y la vía mandan: se aclaran un poco para mantener la lectura
  m.setPaintProperty("cortina", "fill-extrusion-opacity", 0.72 + 0.14 * (1 - crep));
  m.setSky({
    "sky-color": rgb(mezcla([3, 8, 16], [8, 21, 34])),
    "horizon-color": rgb(mezcla([28, 38, 56], [201, 151, 106])),
    "fog-color": rgb(mezcla([14, 22, 32], [74, 93, 108])),
    "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.65, "fog-ground-blend": 0.42,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 0.9, 12, 0.45],
  });
  document.documentElement.dataset.luz = crep < 0.15 ? "noche" : crep < 0.85 ? "crepusculo" : "dia";
}

// ------------------------------------------------------------------ marcadores y jerarquía de etiquetas

/** Marcador anclado al relieve: un punto (posición exacta) y una etiqueta que puede moverse para no encimarse. */
function marcador(html, lngLat, clase, { prioridad = 5, variantes = ["arriba", "der", "izq"], plegable = true, boton = false } = {}) {
  const el = document.createElement(boton ? "button" : "div");
  if (boton) el.type = "button";
  el.className = `marca ${clase}`;
  el.innerHTML = `<span class="punto" aria-hidden="true"></span><span class="etq">${html}</span>`;
  const mk = new ML.Marker({ element: el, anchor: "center", opacityWhenCovered: "0.75" }).setLngLat(lngLat).addTo(S.mapa);
  el.__ll = lngLat; // para verificar su posición en las evidencias
  const fijar = mk.setLngLat.bind(mk);
  mk.setLngLat = (ll) => { el.__ll = ll; return fijar(ll); };
  S.etiquetas.push({ el, prioridad, variantes, plegable });
  return mk;
}

/** Edición de etiquetas: por prioridad, cada una prueba sus posiciones y, si todas chocan, se pliega (queda el punto). */
function acomodar() {
  if (!S.etiquetas.length) return;
  const puestos = [], ancho = innerWidth, alto = innerHeight;
  // la interfaz fija también ocupa lugar: título, mandos de cámara, banda de decisión y avisos
  for (const sel of [".tiempo", ".titulo", ".mandos", "#aviso:not([hidden])"]) { const el = $(sel); if (el) puestos.push(el.getBoundingClientRect()); }
  const choca = (a) => puestos.some((b) => a.left < b.right + 4 && a.right + 4 > b.left && a.top < b.bottom + 3 && a.bottom + 3 > b.top);
  const orden = [...S.etiquetas].sort((a, b) => a.prioridad - b.prioridad);
  for (const e of orden) {
    const etq = e.el.querySelector(".etq");
    e.el.classList.remove("plegada", "sin-paso", ...e.variantes);
    if (e.el.hidden || getComputedStyle(etq).display === "none") continue;
    const punto = e.el.getBoundingClientRect();
    if (punto.right < 0 || punto.left > ancho || punto.bottom < 0 || punto.top > alto) continue;
    let ok = false;
    for (const v of e.variantes) {
      e.el.classList.add(v);
      const r = etq.getBoundingClientRect();
      if (!choca(r) && r.left >= 0 && r.right <= ancho) { puestos.push(r); ok = true; break; }
      e.el.classList.remove(v);
    }
    if (!ok && e.el.classList.contains("hito")) {
      // segundo intento: el nombre solo, sin la hora de paso (la hora sigue en la matriz y en la lectura)
      e.el.classList.add("sin-paso");
      for (const v of e.variantes) {
        e.el.classList.add(v);
        const r = etq.getBoundingClientRect();
        if (!choca(r) && r.left >= 0 && r.right <= ancho) { puestos.push(r); ok = true; break; }
        e.el.classList.remove(v);
      }
    }
    if (!ok) {
      if (e.plegable) e.el.classList.add("plegada");
      else {
        // imprescindible: la primera posición que quepa en pantalla, aunque roce otra etiqueta
        let elegida = e.variantes[0];
        for (const v of e.variantes) {
          e.el.classList.add(v);
          const r = etq.getBoundingClientRect();
          e.el.classList.remove(v);
          if (r.left >= 0 && r.right <= ancho) { elegida = v; break; }
        }
        e.el.classList.add(elegida); puestos.push(etq.getBoundingClientRect());
      }
    }
    puestos.push(punto);
  }
}

function marcadores() {
  const R = S.ruta, ultimo = R.hitos.length - 1;
  R.hitos.forEach((h, i) => {
    const extremo = i === 0 || i === ultimo;
    S.marcadores[h.id] = marcador(`<span class="nombre">${esc(h.nombre)}</span><span class="paso"></span>`,
      [h.en_via.lon, h.en_via.lat], `hito${extremo ? " extremo" : ""}`, { prioridad: extremo ? 1 : 2, plegable: false });
  });
  S.vehiculo = marcador(`<span class="hora-v"></span>`, R.coords[0], "vehiculo", { prioridad: 0, variantes: ["der", "izq", "arriba"], plegable: false });
  S.pico = marcador(`<span class="pico-v"></span>`, R.coords[0], "pico", { prioridad: 3, variantes: ["der", "izq", "arriba"] });
  // Referencia geográfica (no dato).
  marcador(`<span>Cotopaxi</span><small>5.897 m</small>`, [-78.4378, -0.6836], "relieve", { prioridad: 9, variantes: ["arriba"] });
  marcador(`<span>Tungurahua</span><small>5.023 m</small>`, [-78.4422, -1.4675], "relieve", { prioridad: 9, variantes: ["arriba"] });
}

function pintarHitos(salida) {
  for (const h of S.ruta.hitos) {
    const el = S.marcadores[h.id].getElement().querySelector(".paso");
    el.textContent = hhmm(salida + h.min * 60e3);
  }
}

function moverVehiculo(km) {
  const p = puntoEnKm(km);
  S.vehiculo.setLngLat(p);
  const t = S.salidas[S.k] + segundosEnKm(km) * 1000;
  S.vehiculo.getElement().querySelector(".hora-v").textContent = hhmm(t);
  S.vehiculo.getElement().classList.toggle("en-origen", km < 0.5);
  return t;
}

// Estaciones: las del visor a 7 km o menos de la vía.
function estaciones() {
  const ests = (S.obs?.estaciones || []).map((e) => {
    let d = Infinity;
    for (let v = 0; v < S.ruta.coords.length; v += 4) d = Math.min(d, distKm([e.lon, e.lat], S.ruta.coords[v]));
    return { e, d };
  }).filter((x) => x.d <= 7).sort((a, b) => a.d - b.d);
  S.estaciones = ests;
  for (const { e, d } of ests) {
    const atraso = (Date.now() - Date.parse(e.ultimo)) / H;
    const vigente = atraso <= (S.obs.vigencia_h || 3);
    const mk = marcador(`<b>${num(e.mm_24h)}</b><span class="u"> mm en 24 h</span>`, [e.lon, e.lat],
      `estacion${vigente ? "" : " atrasada"}`, { prioridad: 4, boton: true });
    const el = mk.getElement();
    el.setAttribute("aria-label", `Estación ${e.nombre}, ${num(e.mm_24h)} mm medidos en 24 horas hasta las ${hhmm(Date.parse(e.ultimo))}. Abrir lectura.`);
    // El instrumento se abre ENCIMA de la estación; la cámara deja la estación en la mitad baja, sobre la banda.
    const pop = new ML.Popup({ anchor: "bottom", offset: 16, maxWidth: "360px", closeButton: true, focusAfterOpen: true }).setHTML(instrumento(e, d, vigente, atraso));
    el.addEventListener("click", (ev) => { ev.stopPropagation(); enfocarEstacion(e, mk, pop); });
  }
}

/** Foco de estación: la cámara se acerca a la estación sin dejar el paisaje, y abre su instrumento. */
function enfocarEstacion(e, mk, pop) {
  detener();
  const m = S.mapa;
  // En el teléfono el instrumento es una hoja inferior que reemplaza a la banda mientras está abierta (no se tapan).
  const abrir = MOVIL ? () => abrirHoja("", e) : () => {
    pop.setLngLat([e.lon, e.lat]).addTo(m);
    // si el instrumento no cabe bajo el título, la cámara baja lo justo para mostrarlo entero
    requestAnimationFrame(() => {
      const r = pop.getElement()?.getBoundingClientRect();
      if (r && r.top < 80) m.panBy([0, -(80 - r.top)], { duration: MOV ? 400 : 0 });
    });
  };
  const destino = { center: [e.lon, e.lat], zoom: MOVIL ? 11.4 : 12.2, pitch: 58, bearing: m.getBearing(), offset: [0, MOVIL ? -140 : Math.round(innerHeight * 0.2)] };
  if (MOV) { m.once("moveend", abrir); m.flyTo({ ...destino, duration: 1800, essential: true }); } else { m.jumpTo(destino); abrir(); }
}

function abrirHoja(_html, e) {
  const hoja = $("#hoja");
  const d = S.estaciones.find((x) => x.e === e)?.d ?? null;
  const atraso = (Date.now() - Date.parse(e.ultimo)) / H;
  $("#hoja-cuerpo").innerHTML = instrumento(e, d, atraso <= (S.obs.vigencia_h || 3), atraso);
  hoja.hidden = false;
  document.body.classList.add("con-hoja");
  $("#hoja-cerrar").focus();
}
function cerrarHoja() {
  $("#hoja").hidden = true;
  document.body.classList.remove("con-hoja");
}

/** Lupa de contraste: misma celda nativa, mismas horas y misma variable (lluvia de la hora), solo si hay ambas series. */
function contraste(e) {
  const L = S.lluvia;
  let j = 0, dmin = Infinity;
  L.celdas.forEach((c, k) => { const d = (c.lat - e.lat) ** 2 + (c.lon - e.lon) ** 2; if (d < dmin) { dmin = d; j = k; } });
  const idx = Object.fromEntries(L.tiempos.map((t, i) => [t.slice(0, 16), i]));
  let med = 0, pron = 0, n = 0, desde = null, hasta = null;
  for (const [f, v] of e.ultimas_24h || []) {
    const i = idx[String(f).slice(0, 16)];
    if (i == null || v == null) continue;
    const p = mmEn(j, i);
    if (p == null) continue;
    med += v; pron += p; n++;
    const t = Date.parse(f);
    desde = desde == null ? t : Math.min(desde, t); hasta = hasta == null ? t : Math.max(hasta, t);
  }
  return n ? { med, pron, n, desde, hasta } : null;
}

function instrumento(e, d, vigente, atraso) {
  const fin = Date.parse(e.ultimo);
  const c = contraste(e);
  const serie = e.ultimas_24h || [];
  const ultima = serie.length ? serie[serie.length - 1][1] : e.mm_1h;
  return `<div class="instrumento">
    <h3>${esc(e.nombre)}</h3>
    <p class="tipo">Medido, no pronóstico</p>
    <div class="cifra">${num(ultima)} mm</div>
    <div>en la hora de ${hhmm(fin - H)} a ${hhmm(fin)}, ${diaTxt(fin)}: última lectura recibida${vigente ? "" : ` <b>(con ${num(atraso)} h de atraso)</b>`}</div>
    <dl>
      <dt>Acumulado</dt><dd>${num(e.mm_3h)} mm en 3 h, ${num(e.mm_24h)} en 24 h, ${num(e.mm_72h)} en 72 h, contados hasta las ${hhmm(Date.parse(S.obs.generado))}</dd>
      <dt>Operador</dt><dd>${esc(e.propietario || "—")}, código ${esc(e.codigo)}</dd>
      <dt>Posición</dt><dd>${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}${e.altitud ? `, ${Math.round(e.altitud)} m` : ""}; a ${num(d)} km de la vía</dd>
      <dt>Transmisión</dt><dd>${esc(e.frecuencia || "—")}</dd>
      <dt>Calidad</dt><dd>sin validar (dato en tiempo real)</dd>
      <dt>Fuente</dt><dd>visor de estaciones del INAMHI</dd>
    </dl>
    <div class="contraste">${c
      ? `<b>Medido ${num(c.med)} mm frente a ${num(c.pron)} mm pronosticados</b>, en las mismas ${c.n} horas (de ${hhmm(c.desde - H)} del ${fechaTxt(c.desde - H)} a ${hhmm(c.hasta)} del ${fechaTxt(c.hasta)}), en la celda de ~8 km del modelo que contiene la estación.
         <span class="nota">Pronóstico: horas pasadas de ECMWF HRES archivadas por Open-Meteo, que une las primeras horas de corridas sucesivas; no se conserva la emisión exacta de cada hora. Una celda no representa un solo pluviómetro.</span>`
      : "Sin comparación disponible: no hay horas en común entre lo medido y el pronóstico archivado."}</div>
  </div>`;
}

// ------------------------------------------------------------------ tiempo: salidas, matriz y decisión

function prepararSalidas() {
  const L = S.lluvia, dur = duracionMs();
  const ahora = Date.now();
  const primera = Math.floor((ahora - UTC5) / H) * H + UTC5; // inicio de la hora en curso
  const fin = L._fin[L._fin.length - 1];
  S.salidas = [];
  for (let t = primera; t + dur <= fin; t += H) S.salidas.push(t);
  const k8 = S.salidas.findIndex((t) => local(t).getUTCHours() === 8 && t >= ahora);
  S.k = PARAM.has("salida") ? Math.max(0, S.salidas.findIndex((t) => hhmm(t) === PARAM.get("salida") && t >= ahora)) : k8 >= 0 ? k8 : 0;
  S.exposiciones = S.salidas.map(exposicion);
  // Salida con menos lluvia prevista (media en el camino) entre las que tienen datos completos.
  // Solo se consideran salidas de día (05:00 a 20:00), como en la web principal: de noche no es una sugerencia útil.
  let mejor = -1;
  const deDia = (k) => { const h = local(S.salidas[k]).getUTCHours(); return h >= 5 && h <= 20; };
  S.exposiciones.forEach((x, k) => { if (deDia(k) && x.media != null && (mejor < 0 || x.media < S.exposiciones[mejor].media - 1e-9)) mejor = k; });
  const max = Math.max(...S.exposiciones.map((x) => x.media ?? 0));
  S.mejor = mejor >= 0 && max - S.exposiciones[mejor].media >= 0.2 ? mejor : -1; // solo si la diferencia es apreciable
  dibujarMatriz();
}

/** Matriz distancia × hora de salida: cada columna es una salida; cada fila, un tramo de la ruta (el origen arriba). */
function dibujarMatriz() {
  const n = S.salidas.length, total = totalKm();
  const c = $("#matriz");
  c.width = n; c.height = FILAS;
  const ctx = c.getContext("2d"), img = ctx.createImageData(n, FILAS);
  const filasV = Array.from({ length: FILAS }, (_, f) => enKm(((f + 0.5) / FILAS) * total).i);
  S.matriz = S.salidas.map((salida) => filasV.map((v) => mmEn(S.celdaDeVertice[v], horaDe(salida + S.ruta.s[v] * 1000))));
  S.matriz.forEach((col, k) => col.forEach((mm, f) => {
    const p = (f * n + k) * 4, cc = colorDe(mm);
    if (mm == null) { img.data.set([0, 0, 0, 0], p); return; }
    if (!cc) { img.data.set([236, 239, 234, 18], p); return; }
    img.data.set([...cc, Math.round(110 + 145 * Math.min(1, mm / 5))], p);
  }));
  ctx.putImageData(img, 0, 0);
  // Ejes: hitos a la altura de su km; marcas de día y "ahora".
  // Etiquetas de hitos sin solaparse: los extremos siempre; los intermedios solo si caben (el mapa los muestra todos).
  const alto = $("#ejes").clientHeight || 66, min = 12, puestos = [];
  S.ruta.hitos.forEach((h, i) => {
    const y = (h.km / total) * alto, extremo = i === 0 || i === S.ruta.hitos.length - 1;
    while (extremo && puestos.length > 1 && y - puestos[puestos.length - 1].y < min) puestos.pop();
    if (extremo || !puestos.length || y - puestos[puestos.length - 1].y >= min) puestos.push({ h, y });
  });
  $("#ejes").innerHTML = puestos.map(({ h }) =>
    `<span style="top:${(h.km / total) * 100}%">${esc(MOVIL ? h.nombre.slice(0, 3) : h.nombre)}</span>`).join("");
  const ahora = Date.now(), marcas = [];
  S.salidas.forEach((t, k) => {
    const h = local(t).getUTCHours();
    if (h === 0) marcas.push(`<span class="dia" style="left:${(k / n) * 100}%">${diaTxt(t)}</span>`);
    else if (h % 6 === 0 && !MOVIL) marcas.push(`<span style="left:${((k + 0.5) / n) * 100}%">${String(h).padStart(2, "0")}</span>`);
  });
  marcas.push(`<span class="ahora" style="left:${(((ahora - S.salidas[0]) / H) / n) * 100}%">ahora</span>`);
  $("#marcas").innerHTML = marcas.join("");
  $("#hora").max = n - 1;
  const mej = $("#mejor");
  if (S.mejor >= 0) { mej.hidden = false; mej.style.left = `${((S.mejor + 0.5) / n) * 100}%`; mej.title = `Menos lluvia prevista: salir a las ${hhmm(S.salidas[S.mejor])}`; }
}

function elegirSalida(k, { mover = true } = {}) {
  S.k = Math.max(0, Math.min(S.salidas.length - 1, k));
  const salida = S.salidas[S.k], n = S.salidas.length;
  $("#hora").value = S.k;
  $("#hora").setAttribute("aria-valuetext", `Salida ${diaTxt(salida)} a las ${hhmm(salida)}`);
  const banda = $("#viaje-banda");
  banda.style.left = `${(S.k / n) * 100}%`;
  banda.style.width = `${(1 / n) * 100}%`;
  banda.dataset.hora = hhmm(salida);
  pintarHitos(salida);
  S.progreso = 0;
  moverVehiculo(0);
  pintarCampo(horaDe(salida));
  pintarRuta(1, null);
  pintarPico();
  pintarDecision();
  if (mover && S.recorriendo) detener();
}

/** El tramo más expuesto de esta salida, marcado sobre la cortina con su hora local de paso. */
function pintarPico() {
  const ex = S.exposiciones[S.k];
  const el = S.pico.getElement();
  if (!ex || ex.peor.mm < 0.1) { el.hidden = true; $("#banda-pico").hidden = true; return; }
  el.hidden = false;
  const v = ex.peor.v;
  S.pico.setLngLat(S.ruta.coords[v]);
  el.querySelector(".pico-v").innerHTML = `<b>${num(ex.peor.mm)} mm/h</b> ${hhmm(S.salidas[S.k] + S.ruta.s[v] * 1000)}`;
  // el mismo tramo, marcado en la columna de la matriz
  const marca = $("#banda-pico");
  marca.hidden = false;
  marca.style.top = `calc(3px + ${(S.ruta.km[v] / totalKm()).toFixed(4)} * var(--alto-matriz))`;
}

function pintarDecision(tVehiculo = null) {
  const salida = S.salidas[S.k], llegada = salida + duracionMs();
  const ex = S.exposiciones[S.k];
  let peor, conf = "";
  if (ex.faltan) peor = `<span class="tenue">Faltan horas de pronóstico para parte del trayecto.</span>`;
  else if (ex.peor.mm < 0.1) peor = `<span class="seco">Sin lluvia prevista en el camino</span>`;
  else {
    const km = S.ruta.km[ex.peor.v], t = salida + S.ruta.s[ex.peor.v] * 1000;
    peor = `Lo más lluvioso: <b>${num(ex.peor.mm)} mm/h</b> hacia las ${hhmm(t)}, cerca de ${esc(hitoCercano(km).nombre)}`;
    const cf = confianza(t, km);
    if (cf) conf = `<span class="conf" title="Fracción de los ${cf.n} escenarios del ensamble ECMWF con al menos 1 mm en esa hora, en ${esc(cf.lugar)}">${deCada10(cf.p)} escenarios del ensamble dan ≥ 1 mm</span>`;
  }
  let comp = "";
  if (S.mejor >= 0 && S.mejor !== S.k) {
    const m = S.exposiciones[S.mejor];
    comp = `<span class="comp">Menos lluvia prevista, saliendo de día: <b>${hhmm(S.salidas[S.mejor])}</b>${diaTxt(S.salidas[S.mejor]) !== diaTxt(salida) ? ` del ${diaTxt(S.salidas[S.mejor])}` : ""} (${m.peor.mm < 0.1 ? "sin lluvia en el camino" : `lo peor ${num(m.peor.mm)} mm/h`})</span>`;
  } else if (S.mejor === S.k) comp = `<span class="comp es">Es la salida de día con menos lluvia prevista en estas 72 h</span>`;
  else comp = `<span class="comp tenue">Sin diferencias apreciables entre salidas</span>`;
  const ruta = tVehiculo ? `<span class="tenue">en ruta ${hhmm(tVehiculo)}</span>` : "";
  $("#decision").innerHTML = `
    <p class="viaje"><span class="t"><b>${hhmm(salida)}</b> salida</span><span class="flecha" aria-hidden="true">→</span><span class="t"><b>${hhmm(llegada)}</b> llegada</span><span class="dia">${diaTxt(salida)}</span>${ruta}</p>
    <p class="peor">${peor}${conf}</p>
    <p class="otra">${comp}</p>`;
}

/** Pie de la banda: las cinco horas que intervienen, cada una con su nombre, y la leyenda. */
function pintarPie() {
  const L = S.lluvia, i = S.valida;
  const corrida = L.corrida_inicio_utc ? `${fechaTxt(Date.parse(L.corrida_inicio_utc))} ${hhmm(Date.parse(L.corrida_inicio_utc))}` : "sin dato";
  const valida = i < 0 ? "sin pronóstico" : `${hhmm(L._fin[i] - H)} a ${hhmm(L._fin[i])}`;
  const medido = S.obs ? hhmm(Math.max(...S.obs.estaciones.map((e) => Date.parse(e.ultimo)))) : "—";
  $("#pie").innerHTML = `
    <span class="leyenda" aria-hidden="true">${ESCALA.map(([, c]) => `<i style="background:rgb(${c.join(",")})"></i>`).join("")}</span>
    <span class="leyenda-t">0,1 → 10+ mm/h; la cortina sube ${ALTO_MM} m por cada mm/h</span>
    <span>Mapa válido <b>${valida}</b></span>
    <span>Emisión: ECMWF HRES, corrida ${corrida} (hora de Ecuador)</span>
    <span>Medido hasta ${medido}</span>
    <span class="vial">Lluvia prevista no indica estado de la vía ni deslaves</span>`;
}

// ------------------------------------------------------------------ cámara

function dibujarEntrada() {
  const m = S.mapa, t0 = performance.now(), dur = 3200;
  m.flyTo({ ...VISTAS.general(), duration: 5200, curve: 1.15, essential: true });
  const paso = (t) => {
    const q = Math.min(1, (t - t0) / dur);
    const mm = lluviaEnRuta(S.salidas[S.k]);
    S.mapa.getSource("tramos").setData(geoTramos(mm, 1 - (1 - q) ** 3, null));
    S.mapa.getSource("cortina").setData(geoCortina(mm, 1 - (1 - q) ** 3));
    if (q < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

const angDif = (a, b) => ((b - a + 540) % 360) - 180;

function recorrer() {
  if (S.recorriendo) { detener(); return; }
  S.recorriendo = true;
  botonRecorrer(true);
  const m = S.mapa, R = S.ruta, total = totalKm();
  // ~30 s por cada 92 min de viaje, entre 30 y 55 s: la ruta larga no se acelera al punto de no poder leerla.
  const durAnim = Math.max(30000, Math.min(55000, (R.duracion_min / 92) * (MOVIL ? 26000 : 30000)));
  if (!MOV) { // sin vuelo: saltos por hito
    let i = 0;
    const saltar = () => {
      if (!S.recorriendo) return;
      const h = R.hitos[i];
      m.jumpTo({ center: [h.en_via.lon, h.en_via.lat], zoom: 12, pitch: 60, bearing: m.getBearing() });
      const t = moverVehiculo(h.km); pintarCampo(horaDe(t)); pintarRuta(1, h.km); pintarDecision(t);
      if (++i < R.hitos.length) S.anim = setTimeout(saltar, 2500); else detener();
    };
    saltar();
    return;
  }
  const km0 = S.progreso >= total - 0.05 ? 0 : S.progreso;
  // Seguimiento: detrás del vehículo, mirando 3 km adelante; sube al acercarse a cada hito.
  // El suavizado depende del TIEMPO transcurrido, no de los cuadros: igual en un teléfono lento.
  const camara = (km) => {
    const dh = Math.min(...R.hitos.map((h) => Math.abs(h.km - km)));
    return {
      rumbo: rumbo(puntoEnKm(Math.max(0, km - 1.0)), puntoEnKm(Math.min(total, km + 3.2))),
      zoom: (MOVIL ? 11.5 : 12.05) - 0.7 * Math.exp(-(dh ** 2) / (2 * 2.4 ** 2)),
      centro: puntoEnKm(Math.min(total, km + 1.6)),
    };
  };
  const c0 = camara(km0);
  moverVehiculo(km0);
  m.easeTo({ center: c0.centro, bearing: c0.rumbo, pitch: 74, zoom: c0.zoom, duration: 2600, essential: true });
  let rumboSuave = c0.rumbo, zoomSuave = c0.zoom, centro = c0.centro, inicio = null, previo = null, ultimoPintado = -1;
  const paso = (ahoraMs) => {
    if (!S.recorriendo) return;
    if (inicio == null) { inicio = ahoraMs - (segundosEnKm(km0) / R.s[R.s.length - 1]) * durAnim; previo = ahoraMs; }
    const dt = Math.min(250, ahoraMs - previo); previo = ahoraMs;
    const suave = (tau) => 1 - Math.exp(-dt / tau);
    const q = Math.min(1, (ahoraMs - inicio) / durAnim);
    const km = kmEnSegundos(q * R.s[R.s.length - 1]);
    S.progreso = km;
    const t = moverVehiculo(km);
    const c = camara(km);
    rumboSuave = (rumboSuave + angDif(rumboSuave, c.rumbo) * suave(900) + 360) % 360;
    zoomSuave += (c.zoom - zoomSuave) * suave(1200);
    centro = [centro[0] + (c.centro[0] - centro[0]) * suave(350), centro[1] + (c.centro[1] - centro[1]) * suave(350)];
    m.jumpTo({ center: centro, bearing: rumboSuave, pitch: 74, zoom: zoomSuave });
    pintarCampo(horaDe(t));
    if (Math.abs(km - ultimoPintado) > 0.4) { S.mapa.getSource("tramos").setData(geoTramos(null, 1, km)); ultimoPintado = km; }
    pintarDecision(t);
    if (q < 1) S.anim = requestAnimationFrame(paso);
    else { detener(); m.easeTo({ ...VISTAS.general(), duration: 3500 }); }
  };
  S.anim = setTimeout(() => { if (S.recorriendo) S.anim = requestAnimationFrame(paso); }, 2600);
}

function detener() {
  if (!S.recorriendo) return;
  S.recorriendo = false;
  cancelAnimationFrame(S.anim); clearTimeout(S.anim);
  botonRecorrer(false);
}
function botonRecorrer(on) {
  $("#b-recorrer").setAttribute("aria-pressed", String(on));
  $("#b-recorrer-texto").textContent = on ? "Pausa" : "Recorrer";
}

// ------------------------------------------------------------------ controles e información

function controles() {
  $("#b-recorrer").addEventListener("click", recorrer);
  document.querySelectorAll("[data-vista]").forEach((b) => b.addEventListener("click", () => {
    detener();
    const v = VISTAS[b.dataset.vista]();
    if (MOV) S.mapa.flyTo({ ...v, duration: 2600, essential: true }); else S.mapa.jumpTo(v);
  }));
  let pendiente = null;
  $("#hora").addEventListener("input", (ev) => {
    if (pendiente) cancelAnimationFrame(pendiente);
    pendiente = requestAnimationFrame(() => { pendiente = null; elegirSalida(+ev.target.value); });
  });
  const info = $("#info"), b = $("#b-info");
  const abrir = (on) => { info.hidden = !on; b.setAttribute("aria-expanded", String(on)); if (on) info.focus(); };
  b.addEventListener("click", () => abrir(info.hidden));
  $("#info-cerrar").addEventListener("click", () => abrir(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { abrir(false); cerrarHoja(); } });
  $("#hoja-cerrar").addEventListener("click", cerrarHoja);
  pintarInfo();
}

/** Nombre de la ruta y distancia, desde datos/ruta.json (una sola fuente para las cifras). */
function pintarTitulo() {
  const R = S.ruta, a = R.hitos[0].nombre, b = R.hitos[R.hitos.length - 1].nombre;
  const n = document.querySelectorAll(".ruta-nombre > span:not(.flecha)");
  if (n.length === 2) { n[0].textContent = a; n[1].textContent = b; }
  $("#titulo-sub").textContent = `${Math.round(R.distancia_km)} km, unas ${horasMin(R.duracion_min)} sin tráfico ni paradas`;
  $("#escena").setAttribute("aria-label", `Escena 3D del corredor ${a}–${b} sobre relieve real`);
  $("#hora").setAttribute("aria-label", `Hora de salida (cada columna es una salida; las filas son los tramos de ${a} a ${b})`);
}
function horasMin(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`; }

function pintarInfo() {
  const R = S.ruta, L = S.lluvia;
  const ests = S.estaciones.map(({ e, d }) => `<li>${esc(e.nombre)} (${esc(e.codigo)}, ${esc(e.propietario || "")}), a ${num(d)} km de la vía</li>`).join("");
  $("#info-cuerpo").innerHTML = `
    <h3>Cómo leer la escena</h3><p>La cortina azul sobre la carretera es la lluvia que encontrarías en cada tramo a la hora en que pasarías: sube ${ALTO_MM} m por cada mm/h. El velo tenue sobre el corredor es la lluvia de la hora indicada en el pie. Abajo, la matriz muestra todas las salidas (columnas) y los tramos (filas, de ${esc(R.hitos[0].nombre)} arriba a ${esc(R.hitos[R.hitos.length - 1].nombre)} abajo).</p>
    <h3>Relieve</h3><p>Terrain Tiles de Mapzen en AWS (base SRTM de ~30 m en Ecuador), sin exagerar la altura. Suaviza quebradas estrechas.</p>
    <h3>Ruta</h3><p>${esc(R.fuente)}, consultada el ${esc(R.consultado.slice(0, 10))}.${R.origen ? ` Origen: ${esc(R.origen.nombre || R.origen.consulta)} según ${esc(R.origen.fuente)}.` : ""}${R.hitos.filter((h) => h.tipo === "paso").map((h) => ` ${esc(h.nombre)} se ubica en la vía, sin desviar la ruta hacia su centro.`).join("")} ${num(R.distancia_km)} km y ${num(R.duracion_min)} min sin tráfico ni paradas: duración total de OSRM; los tiempos por tramo son sus anotaciones escaladas a esa cifra. ${esc(R.licencia)}.</p>
    <h3>Lluvia prevista</h3><p>${esc(L.modelo)}, producto ${esc(L.producto)}, ${esc(L.rejilla)}. ${esc(L.seleccion)}. Corrida iniciada ${esc(L.corrida_inicio_utc || "sin dato")} (UTC). Determinista: un solo escenario. La confianza del punto más lluvioso sale del ensamble ECMWF de 51 escenarios en la localidad más cercana de la ruta.</p>
    <h3>Lluvia medida</h3><ul>${ests || "<li>Ninguna estación a menos de 7 km de la vía.</li>"}</ul><p>Visor del INAMHI, sin control de calidad publicado. Mover la hora de salida no cambia las mediciones.</p>
    <h3>Ambientación</h3><p>Cielo, bruma y color de luz son de representación, no datos. La dirección de la luz y la penumbra siguen la posición aproximada del sol a la hora de validez (astronomía); no indican nubosidad. No hay nubes porque el sistema no tiene datos de nubosidad del corredor.</p>
    <h3>Límites</h3><ul><li>Una celda de ~8 km no indica la lluvia exacta en un punto de la carretera.</li><li>No evalúa deslaves ni el estado de la vía: consulta el <a href="https://www.ecu911.gob.ec/consulta-de-vias/" target="_blank" rel="noopener">ECU 911</a>.</li><li>Prototipo: el fondo satelital es de uso no comercial.</li></ul>`;
}

// ------------------------------------------------------------------ rendimiento

/** ?medir=1: mide el vuelo completo y el arrastre de la línea de tiempo en ESTE equipo y muestra el resultado. */
function medicion() {
  const listo = performance.now() / 1000;
  const resumen = (v) => { v = v.filter((x) => x > 0).sort((a, b) => a - b); const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]; return { mediana: q(0.5), p5: q(0.05), min: v[0], n: v.length }; };
  setTimeout(() => {
    const desde = S.fps.length;
    if (!S.recorriendo) recorrer();
    const fin = setInterval(() => {
      if (S.recorriendo) return;
      clearInterval(fin);
      const vuelo = resumen(S.fps.slice(desde));
      // Línea de tiempo: una salida nueva por cuadro, 48 veces, midiendo el tiempo de cada cuadro.
      const tiempos = []; let k = 0, t0 = performance.now();
      const paso = (t) => {
        tiempos.push(t - t0); t0 = t;
        elegirSalida(k++ % S.salidas.length, { mover: false });
        if (k < 48) requestAnimationFrame(paso);
        else {
          const fpsT = tiempos.slice(1).map((ms) => Math.round(1000 / ms));
          const linea = resumen(fpsT);
          const gl = S.mapa.painter?.context?.gl, dbg = gl?.getExtension("WEBGL_debug_renderer_info");
          const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "no informado";
          window.__medicion = { vuelo, linea, listo_s: +listo.toFixed(1), ancho: innerWidth, alto: innerHeight, dpr: devicePixelRatio, gpu, navegador: navigator.userAgent };
          const el = document.createElement("div");
          el.className = "info"; el.style.top = "auto"; el.style.bottom = "180px"; el.setAttribute("role", "status");
          el.innerHTML = `<h2>Medición en este equipo</h2>
            <p><b>Vuelo:</b> mediana ${vuelo.mediana} fps, peor 5 % ${vuelo.p5}, mínimo ${vuelo.min} (${vuelo.n} s).</p>
            <p><b>Línea de tiempo:</b> mediana ${linea.mediana} fps, peor 5 % ${linea.p5}, mínimo ${linea.min} (48 cambios de salida).</p>
            <p>Pantalla ${innerWidth}×${innerHeight}, densidad ${devicePixelRatio}. Escena lista a los ${listo.toFixed(1)} s. GPU: ${esc(gpu)}.</p>`;
          document.body.appendChild(el);
        }
      };
      requestAnimationFrame(paso);
    }, 500);
  }, 6000);
}

function medirFps() {
  let n = 0, t0 = performance.now();
  const tic = (t) => {
    n++;
    if (t - t0 >= 1000) { S.fps.push(Math.round((n * 1000) / (t - t0))); if (S.fps.length > 240) S.fps.shift(); n = 0; t0 = t; }
    requestAnimationFrame(tic);
  };
  requestAnimationFrame(tic);
  window.__corredor = S;
}

iniciar();
