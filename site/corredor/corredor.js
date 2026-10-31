/* El corredor vivo — prueba técnica cinematográfica (Latacunga → Ambato → Pelileo → Baños).
 *
 * Reglas de datos (no negociables):
 *  - Relieve: elevaciones reales (Terrarium/AWS). Ruta: geometría OSRM sobre OpenStreetMap, versionada.
 *  - Lluvia: ECMWF IFS HRES en sus celdas nativas; se dibuja cada celda tal cual, sin interpolar.
 *  - Estaciones: metadatos y lecturas del visor del INAMHI; mover el tiempo del pronóstico NUNCA cambia una medición.
 *  - Neblina y cielo son ambientación, no datos.
 */
"use strict";

const ML = window.maplibregl;
const H = 3600e3;
const UTC5 = 5 * H; // Ecuador continental: local = UTC - 5 h
const MOV = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOVIL = window.matchMedia("(max-width: 640px)").matches;

// Escala de intensidad (mm en la hora). Igual en el campo, la trayectoria y la leyenda.
const ESCALA = [
  [0.1, [156, 200, 236]], [0.5, [111, 168, 224]], [1, [75, 143, 214]],
  [2.5, [47, 95, 184]], [5, [107, 63, 179]], [10, [142, 44, 158]],
];
const SECO = [243, 227, 191]; // trayectoria sin lluvia prevista: luz de cresta
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const S = {
  ruta: null, lluvia: null, obs: null, mapa: null,
  celdaDeVertice: null, salidas: [], k: 0, valida: -1,
  progreso: 0, recorriendo: false, anim: null, marcadores: {}, fps: [],
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
function colorLluvia(mm, alfa = 1) {
  if (mm == null || mm < ESCALA[0][0]) return null;
  let c = ESCALA[0][1];
  for (const [u, col] of ESCALA) if (mm >= u) c = col;
  return `rgba(${c[0]},${c[1]},${c[2]},${alfa})`;
}
async function json(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

// ------------------------------------------------------------------ geometría de la ruta

/** Índice del vértice y fracción para un km dado (búsqueda binaria en km acumulados). */
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
  // Rejilla gaussiana reducida: cada fila de latitud tiene su propio espaciado en longitud; se mide de los datos.
  const dlat = L.paso_lat || 0.07;
  const filas = {};
  L.celdas.forEach((c) => (filas[c.lat] ||= []).push(c.lon));
  const dlonFila = {};
  for (const [lat, lons] of Object.entries(filas)) {
    const v = lons.sort((a, b) => a - b), d = v.slice(1).map((x, i) => x - v[i]).sort((a, b) => a - b);
    dlonFila[lat] = d.length ? d[d.length >> 1] : dlat;
  }
  L._geo = {
    type: "FeatureCollection",
    features: L.celdas.map((c, i) => { const dlon = dlonFila[c.lat]; return ({
      type: "Feature", id: i, properties: { v: 0 },
      geometry: { type: "Polygon", coordinates: [[
        [c.lon - dlon / 2, c.lat - dlat / 2], [c.lon + dlon / 2, c.lat - dlat / 2],
        [c.lon + dlon / 2, c.lat + dlat / 2], [c.lon - dlon / 2, c.lat + dlat / 2], [c.lon - dlon / 2, c.lat - dlat / 2]]] },
    }); }),
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

/** Exposición de una salida: intensidad media en el camino ponderada por tiempo, y el peor punto. */
function exposicion(salida) {
  const mm = lluviaEnRuta(salida), s = S.ruta.s;
  let suma = 0, pesos = 0, peor = { mm: 0, v: -1 }, faltan = false;
  for (let v = 1; v < s.length; v++) {
    const dt = s[v] - s[v - 1];
    if (mm[v] == null) { faltan = true; continue; }
    suma += mm[v] * dt; pesos += dt;
    if (mm[v] > peor.mm) peor = { mm: mm[v], v };
  }
  return { media: pesos ? suma / pesos : null, peor, faltan };
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
          // Luz rasante de la tarde desde el oeste-noroeste: laderas al este en sombra azul, crestas cálidas.
          "hillshade-method": "combined",
          "hillshade-illumination-direction": 292, "hillshade-illumination-altitude": 16, "hillshade-illumination-anchor": "map",
          "hillshade-exaggeration": 0.9, "hillshade-shadow-color": "rgba(3,9,20,0.96)", "hillshade-highlight-color": "rgba(255,196,128,0.42)",
          "hillshade-accent-color": "rgba(6,14,28,0.75)",
        } },
    ],
    terrain: { source: "dem", exaggeration: 1.0 },
    sky: {
      // Ambientación (no dato): cielo profundo, horizonte cálido y bruma azul que separa los planos del relieve.
      "sky-color": "#081522", "horizon-color": "#c9976a", "fog-color": "#4a5d6c",
      "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.65, "fog-ground-blend": 0.42,
      "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 0.9, 12, 0.45],
    },
  };
}

const VISTAS = {
  // Desde detrás de Latacunga, a baja altura, con el valle abriéndose hacia el Tungurahua al fondo.
  general: () => ({ center: [-78.585, -1.15], zoom: MOVIL ? 10.05 : 10.95, pitch: 73, bearing: 154 }),
  cenital: () => ({ center: [-78.53, -1.17], zoom: MOVIL ? 9.2 : 9.85, pitch: 0, bearing: 0 }),
  intro: () => ({ center: [-78.62, -0.95], zoom: MOVIL ? 8.7 : 9.3, pitch: 50, bearing: 168 }),
};

async function iniciar() {
  try {
    const [ruta, lluvia, obs] = await Promise.all([
      json("datos/ruta.json"), json("../data/corredor_lluvia.json"), json("../data/estaciones.json").catch(() => null)]);
    Object.assign(S, { ruta, lluvia, obs });
  } catch (e) {
    const el = $("#estado-carga");
    el.classList.add("error");
    el.textContent = `No se pudieron cargar los datos del corredor (${e.message}). La escena no se muestra con datos incompletos.`;
    return;
  }
  prepararLluvia();
  prepararSalidas();

  const mapa = new ML.Map({
    container: "escena", style: estilo(), ...VISTAS.intro(), maxPitch: 78, attributionControl: { compact: MOVIL },
    // ?captura=1 conserva el búfer de dibujo para poder capturar la escena desde herramientas de revisión
    canvasContextAttributes: { antialias: true, preserveDrawingBuffer: new URLSearchParams(location.search).has("captura") }, fadeDuration: 0,
  });
  S.mapa = mapa;
  window.__mapa = mapa;
  mapa.on("error", (ev) => console.warn("mapa", ev?.error?.message || ev));
  mapa.on("load", () => {
    capas();
    marcadores();
    estaciones();
    controles();
    elegirSalida(S.k, { mover: false });
    $("#estado-carga").classList.add("listo");
    // En teléfono la atribución compacta arranca abierta y tapa la escena: se cierra (sigue a un toque).
    if (MOVIL) document.querySelectorAll(".maplibregl-ctrl-attrib.maplibregl-compact-show").forEach((el) => el.classList.remove("maplibregl-compact-show"));
    if (MOV) dibujarEntrada(); else { mapa.jumpTo(VISTAS.general()); pintarRuta(1); }
    medirFps();
    if (new URLSearchParams(location.search).has("medir")) medicion();
  });
  mapa.on("dragstart", detener);
  mapa.on("rotatestart", (e) => { if (e.originalEvent) detener(); });
}

function capas() {
  const m = S.mapa, R = S.ruta;
  m.addSource("lluvia", { type: "geojson", data: S.lluvia._geo });
  texturasLluvia();
  m.addLayer({ id: "lluvia", type: "fill", source: "lluvia",
    paint: {
      "fill-color": ["step", ["get", "v"], "rgba(0,0,0,0)", ...ESCALA.flatMap(([u, c]) => [u, `rgb(${c.join(",")})`])],
      // Velo moderado: el relieve debe seguir leyéndose bajo la lluvia más intensa; el trazo lleva la intensidad.
      "fill-opacity": ["interpolate", ["linear"], ["get", "v"], 0.09, 0, 0.1, 0.05, 1, 0.16, 5, 0.27, 10, 0.34], "fill-antialias": false,
    } });
  // Trazo de lluvia dentro de cada celda: más denso cuanto más intensa. Es la misma cifra del modelo, no más detalle.
  m.addLayer({ id: "lluvia-trazo", type: "fill", source: "lluvia", filter: [">=", ["get", "v"], 0.1],
    paint: { "fill-pattern": ["step", ["get", "v"], "lluvia-t1", 1, "lluvia-t2", 2.5, "lluvia-t3", 5, "lluvia-t4"],
      // la llovizna apenas se insinúa; el trazo se afirma con la intensidad
      "fill-opacity": ["step", ["get", "v"], 0.3, 1, 0.6, 2.5, 0.8, 5, 0.9] } });
  // Bordes de celda muy tenues: la resolución real del modelo queda a la vista.
  m.addLayer({ id: "lluvia-celdas", type: "line", source: "lluvia", filter: [">=", ["get", "v"], 0.1],
    paint: { "line-color": "rgba(156,200,236,0.32)", "line-width": 0.8 } });

  // La trayectoria se divide en tramos de ~0,4 km. Cada tramo lleva la lluvia prevista a la hora en que pasarías:
  // la "manga" azul (ancho y color) es el dato; la línea clara es la vía.
  S.tramos = [];
  let ini = 0;
  for (let v = 1; v < R.coords.length; v++) {
    if (R.km[v] - R.km[ini] >= 0.4 || v === R.coords.length - 1) { S.tramos.push([ini, v]); ini = v; }
  }
  m.addSource("tramos", { type: "geojson", data: geoTramos(null, 0, 1) });
  const ancho = (base) => ["interpolate", ["linear"], ["zoom"], 8, ["*", base, 0.45], 13, base];
  m.addLayer({ id: "ruta-manga", type: "line", source: "tramos", layout: { "line-join": "round", "line-cap": "round" },
    filter: [">=", ["get", "mm"], 0.1],
    paint: {
      "line-color": ["step", ["get", "mm"], "rgba(0,0,0,0)", ...ESCALA.flatMap(([u, c]) => [u, `rgb(${c.join(",")})`])],
      "line-width": ancho(["interpolate", ["linear"], ["get", "mm"], 0.1, 10, 1, 18, 5, 30, 10, 40]),
      "line-opacity": ["*", ["get", "visible"], 0.62], "line-blur": 3,
    } });
  m.addLayer({ id: "ruta-sombra", type: "line", source: "tramos", layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "rgba(4,9,14,0.9)", "line-width": ancho(9), "line-opacity": ["get", "visible"], "line-blur": 1 } });
  m.addLayer({ id: "ruta", type: "line", source: "tramos", layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": ["case", ["get", "recorrido"], "rgba(243,227,191,0.5)", "rgb(243,227,191)"],
      "line-width": ancho(4.2), "line-opacity": ["get", "visible"],
    } });
}

/** Cuatro texturas de lluvia (trazos inclinados) del mismo color que la escala. Se dibujan una vez en un lienzo. */
function texturasLluvia() {
  const defs = [["lluvia-t1", 1, ESCALA[0][1]], ["lluvia-t2", 2, ESCALA[2][1]], ["lluvia-t3", 3, ESCALA[3][1]], ["lluvia-t4", 4, ESCALA[5][1]]];
  for (const [nombre, n, col] of defs) {
    const t = 32, c = document.createElement("canvas");
    c.width = c.height = t;
    const x = c.getContext("2d");
    x.strokeStyle = `rgba(${col.join(",")},0.95)`;
    x.lineWidth = 1.4;
    x.lineCap = "round";
    // n trazos por mosaico, repartidos para que el patrón no forme franjas
    for (let k = 0; k < n * 2; k++) {
      const px = ((k * 13 + 5) % t), py = ((k * 19 + 3) % t);
      x.beginPath(); x.moveTo(px, py); x.lineTo(px - 3, py + 8); x.stroke();
    }
    S.mapa.addImage(nombre, x.getImageData(0, 0, t, t), { pixelRatio: 2 });
  }
}

/** Tramos con la lluvia a la hora de paso. `hasta` (0–1) revela el trazo; `vehiculoKm` marca lo ya recorrido. */
function geoTramos(mm, hasta, vehiculoKm) {
  const R = S.ruta, total = R.km[R.km.length - 1];
  return {
    type: "FeatureCollection",
    features: S.tramos.map(([a, b]) => {
      // lluvia del tramo: la mayor entre sus vértices (no se promedia hacia abajo un chubasco)
      let v = null;
      if (mm) for (let i = a; i <= b; i++) if (mm[i] != null) v = Math.max(v ?? 0, mm[i]);
      return {
        type: "Feature",
        properties: { mm: v ?? 0, visible: R.km[a] / total <= hasta ? 1 : 0, recorrido: vehiculoKm != null && R.km[b] <= vehiculoKm },
        geometry: { type: "LineString", coordinates: R.coords.slice(a, b + 1) },
      };
    }),
  };
}
function pintarRuta(hasta = 1, vehiculoKm = null) {
  S.mapa.getSource("tramos").setData(geoTramos(lluviaEnRuta(S.salidas[S.k]), hasta, vehiculoKm));
}

function pintarCampo(i) {
  if (i === S.valida) return;
  S.valida = i;
  const L = S.lluvia;
  L._geo.features.forEach((f, j) => { f.properties.v = mmEn(j, i) ?? 0; });
  S.mapa.getSource("lluvia").setData(L._geo);
  if (i >= 0) luz(L._fin[i] - H / 2);
  pintarValidez();
}

function pintarValidez() {
  const L = S.lluvia, i = S.valida;
  const fin = L._fin[i], ini = fin - H;
  const corrida = L.corrida_inicio_utc ? `${fechaTxt(Date.parse(L.corrida_inicio_utc))}, ${hhmm(Date.parse(L.corrida_inicio_utc))}` : "sin dato de corrida";
  const km = Math.round((L.paso_lat || 0.07) * 111);
  $("#validez").innerHTML = i < 0 ? "Sin pronóstico para esta hora." : `
    <strong>Lluvia prevista de ${hhmm(ini)} a ${hhmm(fin)}, ${diaTxt(ini)}</strong>
    <span class="detalle"><br>ECMWF IFS HRES, determinista. Celdas nativas de ~${km} km sin interpolar. Corrida del ${corrida}.
    En la ruta, el ancho y color de la franja muestran la lluvia a la hora en que pasarías.</span>
    <span class="movil">ECMWF HRES, celdas de ~${km} km, corrida ${corrida}.</span>
    <div class="escala">${ESCALA.map(([, c]) => `<span style="background:rgb(${c.join(",")})"></span>`).join("")}</div>
    <div class="valores"><span>0,1</span><span>1</span><span>5</span><span>10+ mm/h</span></div>`;
}

// ------------------------------------------------------------------ luz según la hora (astronomía, no meteorología)

/** Posición aproximada del sol en el corredor (~1,2° S) a fines de octubre: sale ~06:00 por el este-sureste, se pone ~18:15
 *  por el oeste-suroeste. Solo orienta el sombreado y el tono de la escena; no representa nubosidad. */
function sol(tMs) {
  const d = local(tMs), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const fr = (h - 6.05) / 12.2; // 0 salida, 1 puesta
  return { dia: fr > 0 && fr < 1, fr, azimut: 105 + fr * 150, altura: Math.sin(Math.max(0, Math.min(1, fr)) * Math.PI) * 76 };
}
let ultimaLuz = null;
function luz(tMs) {
  const m = S.mapa, s0 = sol(tMs);
  // tres estados de iluminación con transiciones al amanecer y atardecer (alrededor de una hora)
  const crep = s0.dia ? Math.min(1, Math.min(s0.fr, 1 - s0.fr) * 12.2) : 0; // 0 noche … 1 pleno día
  const clave = Math.round(crep * 10) + ":" + Math.round(s0.azimut / 10);
  if (clave === ultimaLuz) return;
  ultimaLuz = clave;
  const mezcla = (a, b) => a.map((x, i) => Math.round(x + (b[i] - x) * crep));
  const rgb = (c) => `rgb(${c.join(",")})`;
  m.setPaintProperty("satelite", "raster-brightness-max", 0.3 + 0.42 * crep);
  m.setPaintProperty("satelite", "raster-saturation", -0.35 + 0.43 * crep);
  // de día el sombreado sigue al sol, con altura limitada (14–42°) para que el relieve siempre se lea
  m.setPaintProperty("sombras", "hillshade-illumination-direction", s0.dia ? s0.azimut : 292);
  m.setPaintProperty("sombras", "hillshade-illumination-altitude", s0.dia ? Math.max(14, Math.min(42, s0.altura)) : 30);
  m.setPaintProperty("sombras", "hillshade-highlight-color", crep > 0.05 ? `rgba(255,196,128,${0.18 + 0.24 * crep})` : "rgba(150,180,220,0.14)");
  m.setSky({
    "sky-color": rgb(mezcla([3, 8, 16], [8, 21, 34])),
    "horizon-color": rgb(mezcla([28, 38, 56], [201, 151, 106])),
    "fog-color": rgb(mezcla([14, 22, 32], [74, 93, 108])),
    "sky-horizon-blend": 0.55, "horizon-fog-blend": 0.65, "fog-ground-blend": 0.42,
    "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 0.9, 12, 0.45],
  });
  document.documentElement.dataset.luz = crep < 0.15 ? "noche" : crep < 0.85 ? "crepusculo" : "dia";
}

// ------------------------------------------------------------------ marcadores anclados al relieve

function marcador(html, lngLat, clase, anchor = "bottom") {
  const el = document.createElement("div");
  el.className = clase;
  el.innerHTML = html;
  // Detrás de una loma el marcador se atenúa, pero sigue legible (orientación espacial).
  return new ML.Marker({ element: el, anchor, opacityWhenCovered: "0.72" }).setLngLat(lngLat).addTo(S.mapa);
}

function marcadores() {
  for (const h of S.ruta.hitos) {
    S.marcadores[h.id] = marcador(`<span class="nombre">${esc(h.nombre)}</span><span class="paso"></span><span class="punto"></span>`,
      [h.en_via.lon, h.en_via.lat], "hito");
  }
  S.vehiculo = marcador(`<span class="hora-v"></span><span class="p"></span>`, S.ruta.coords[0], "vehiculo");
  // Marcas cada 10 minutos de viaje: la ruta se lee como trayectoria en el tiempo, no solo como línea.
  S.marcas = [];
  const fin = S.ruta.s[S.ruta.s.length - 1];
  for (let seg = 900; seg < fin - 300; seg += 900) {
    const km = kmEnSegundos(seg);
    if (S.ruta.hitos.some((h) => Math.abs(h.km - km) < 5.5)) continue; // no tapar los hitos
    // solo las marcas de cada media hora llevan la hora escrita; las demás son un trazo
    S.marcas.push({ seg, m: marcador(`<span class="t"></span>`, puntoEnKm(km), `marca-t${seg % 1800 ? " corta" : ""}`, "left") });
  }
  // Referencia geográfica (no dato): el volcán que domina el final del corredor.
  const tg = marcador(`<span class="triangulo" aria-hidden="true"></span><span>Tungurahua, 5.023 m</span>`, [-78.4422, -1.4675], "relieve-nombre");
  tg.setOffset([0, -14]);
}

function pintarHitos(salida) {
  for (const { seg, m } of S.marcas || []) m.getElement().querySelector(".t").textContent = hhmm(salida + seg * 1000);
  for (const h of S.ruta.hitos) {
    const el = S.marcadores[h.id].getElement().querySelector(".paso");
    el.textContent = h.min === 0 ? `sales ${hhmm(salida)}` : `pasas ${hhmm(salida + h.min * 60e3)}`;
  }
}

function moverVehiculo(km) {
  const p = puntoEnKm(km);
  S.vehiculo.setLngLat(p);
  // la etiqueta del vehículo reemplaza a la del hito cuando están juntos (no se encimam)
  for (const h of S.ruta.hitos) S.marcadores[h.id]?.getElement().classList.toggle("con-vehiculo", Math.abs(h.km - km) < 1.5);
  const t = S.salidas[S.k] + segundosEnKm(km) * 1000;
  S.vehiculo.getElement().querySelector(".hora-v").textContent = hhmm(t);
  return t;
}

// Estaciones: solo las que están a 7 km o menos de la vía y con coordenadas del visor.
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
    const el = document.createElement("button");
    el.type = "button";
    el.className = `estacion${vigente ? "" : " atrasada"}`;
    el.setAttribute("aria-label", `Estación ${e.nombre}: ${num(e.mm_24h)} mm en 24 horas hasta las ${hhmm(Date.parse(e.ultimo))}`);
    el.innerHTML = `<span class="placa"><b>${num(e.mm_24h)} mm</b><span class="u"> en 24 h</span><small>${esc(e.codigo)}, medido hasta ${hhmm(Date.parse(e.ultimo))}</small></span><span class="tallo"></span><span class="base"></span>`;
    const pop = new ML.Popup({ offset: [0, -64], maxWidth: "320px", closeButton: true }).setHTML(instrumento(e, d, vigente, atraso));
    new ML.Marker({ element: el, anchor: "bottom", opacityWhenCovered: "0.8" }).setLngLat([e.lon, e.lat]).setPopup(pop).addTo(S.mapa);
  }
}

/** Lupa de contraste: misma celda nativa y mismas horas, solo si hay ambas series. */
function contraste(e) {
  const L = S.lluvia;
  let j = 0, dmin = Infinity;
  L.celdas.forEach((c, k) => { const d = (c.lat - e.lat) ** 2 + (c.lon - e.lon) ** 2; if (d < dmin) { dmin = d; j = k; } });
  const idx = Object.fromEntries(L.tiempos.map((t, i) => [t.slice(0, 16), i]));
  let med = 0, pron = 0, n = 0;
  for (const [f, v] of e.ultimas_24h || []) {
    const i = idx[String(f).slice(0, 16)];
    if (i == null || v == null) continue;
    const p = mmEn(j, i);
    if (p == null) continue;
    med += v; pron += p; n++;
  }
  return n ? { med, pron, n } : null;
}

function instrumento(e, d, vigente, atraso) {
  const fin = Date.parse(e.ultimo);
  const c = contraste(e);
  return `<div class="instrumento">
    <h3>${esc(e.nombre)}</h3>
    <div class="cifra">${num(e.mm_1h)} mm</div>
    <div>en la hora de ${hhmm(fin - H)} a ${hhmm(fin)}, ${diaTxt(fin)}${vigente ? "" : ` <b>(dato con ${num(atraso)} h de atraso)</b>`}</div>
    <dl>
      <dt>3 h / 24 h / 72 h</dt><dd>${num(e.mm_3h)} / ${num(e.mm_24h)} / ${num(e.mm_72h)} mm</dd>
      <dt>Código</dt><dd>${esc(e.codigo)} (${esc(e.propietario || "")})</dd>
      <dt>Posición</dt><dd>${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}${e.altitud ? `, ${Math.round(e.altitud)} m` : ""}; a ${num(d)} km de la vía</dd>
      <dt>Transmisión</dt><dd>${esc(e.frecuencia || "—")}</dd>
      <dt>Calidad</dt><dd>sin validar (dato en tiempo real)</dd>
      <dt>Fuente</dt><dd>visor de estaciones del INAMHI</dd>
    </dl>
    <div class="contraste">${c
      ? `<b>Medido ${num(c.med)} mm, pronosticado ${num(c.pron)} mm</b> en las mismas ${c.n} horas, en la celda del modelo que contiene la estación (ECMWF HRES). Una celda de ~9 km no representa un solo pluviómetro.`
      : "Sin comparación disponible: no hay horas en común entre lo medido y el pronóstico guardado."}</div>
  </div>`;
}

// ------------------------------------------------------------------ tiempo: salidas y banda

function prepararSalidas() {
  const L = S.lluvia, dur = S.ruta.s[S.ruta.s.length - 1] * 1000;
  const ahora = Date.now();
  const primera = Math.floor((ahora - UTC5) / H) * H + UTC5; // inicio de la hora en curso
  const fin = L._fin[L._fin.length - 1];
  S.salidas = [];
  for (let t = primera; t + dur <= fin; t += H) S.salidas.push(t);
  // Salida inicial: el próximo 08:00 (escenario de la guía) si existe; si no, la hora en curso.
  const k8 = S.salidas.findIndex((t) => local(t).getUTCHours() === 8 && t >= ahora);
  S.k = k8 >= 0 ? k8 : 0;
  const ex = S.salidas.map(exposicion);
  const max = Math.max(1, ...ex.map((x) => x.media || 0));
  $("#exposicion").innerHTML = ex.map((x) => x.media == null
    ? `<i class="sin" style="height:2px"></i>`
    : `<i style="height:${Math.max(2, (x.media / max) * 30).toFixed(0)}px"></i>`).join("");
  S.exposiciones = ex;
  const n = S.salidas.length;
  const hora = $("#hora");
  hora.max = n - 1;
  const marcas = [];
  S.salidas.forEach((t, k) => {
    const h = local(t).getUTCHours();
    const x = ((k + 0.5) / n) * 100;
    if (h === 0) marcas.push(`<span class="dia" style="left:${(k / n) * 100}%">${diaTxt(t)}</span>`);
    else if (h % 6 === 0 && !MOVIL) marcas.push(`<span style="left:${x}%">${String(h).padStart(2, "0")}:00</span>`);
  });
  marcas.push(`<span class="ahora" style="left:${(((ahora - primera) / H) / n) * 100}%">ahora</span>`);
  $("#marcas").innerHTML = marcas.join("");
}

function elegirSalida(k, { mover = true } = {}) {
  S.k = Math.max(0, Math.min(S.salidas.length - 1, k));
  const salida = S.salidas[S.k], dur = S.ruta.s[S.ruta.s.length - 1] * 1000, n = S.salidas.length;
  $("#hora").value = S.k;
  $("#hora").setAttribute("aria-valuetext", `Salida ${diaTxt(salida)} a las ${hhmm(salida)}`);
  const banda = $("#viaje-banda");
  banda.style.left = `${(S.k / n) * 100}%`;
  banda.style.width = `${Math.max(0.6, (dur / H / n) * 100)}%`;
  banda.dataset.hora = hhmm(salida);
  pintarHitos(salida);
  S.progreso = 0;
  moverVehiculo(0);
  pintarCampo(horaDe(salida));
  pintarRuta(1, null);
  pintarLectura();
  if (mover && S.recorriendo) detener();
}

function pintarLectura(tVehiculo = null) {
  const salida = S.salidas[S.k], dur = S.ruta.s[S.ruta.s.length - 1] * 1000;
  const ex = S.exposiciones[S.k];
  let camino;
  if (ex.media == null) camino = '<span class="tenue">Sin pronóstico para todo el trayecto.</span>';
  else if (ex.peor.mm < 0.1) camino = "Sin lluvia prevista en el camino.";
  else {
    const km = S.ruta.km[ex.peor.v];
    const cerca = S.ruta.hitos.reduce((a, h) => (Math.abs(h.km - km) < Math.abs(a.km - km) ? h : a));
    camino = `Lluvia de hasta ${num(ex.peor.mm)} mm/h hacia las ${hhmm(salida + S.ruta.s[ex.peor.v] * 1000)}, cerca de ${esc(cerca.nombre)}.`;
  }
  const ahora = tVehiculo ? ` <span class="tenue">En ruta: ${hhmm(tVehiculo)}.</span>` : "";
  $("#lectura").innerHTML = `<b>Sales ${diaTxt(salida)} a las ${hhmm(salida)}</b>, llegas hacia las ${hhmm(salida + dur)}. ${camino}${ahora}`;
}

// ------------------------------------------------------------------ cámara

function dibujarEntrada() {
  const m = S.mapa, t0 = performance.now(), dur = 3200;
  m.flyTo({ ...VISTAS.general(), duration: 5200, curve: 1.15, essential: true });
  const paso = (t) => {
    const q = Math.min(1, (t - t0) / dur);
    pintarRuta(1 - (1 - q) ** 3, null);
    if (q < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

const angDif = (a, b) => ((b - a + 540) % 360) - 180;

function recorrer() {
  if (S.recorriendo) { detener(); return; }
  S.recorriendo = true;
  botonRecorrer(true);
  const m = S.mapa, R = S.ruta, total = R.km[R.km.length - 1];
  const duracionMs = MOVIL ? 26000 : 30000; // 92 min de viaje en ~30 s
  if (!MOV) { // sin vuelo: saltos por hito
    let i = 0;
    const saltar = () => {
      if (!S.recorriendo) return;
      const h = R.hitos[i];
      m.jumpTo({ center: [h.en_via.lon, h.en_via.lat], zoom: 12, pitch: 60, bearing: m.getBearing() });
      const t = moverVehiculo(h.km); pintarCampo(horaDe(t)); pintarRuta(1, h.km); pintarLectura(t);
      if (++i < R.hitos.length) S.anim = setTimeout(saltar, 2500); else detener();
    };
    saltar();
    return;
  }
  const km0 = S.progreso >= total - 0.05 ? 0 : S.progreso;
  // Cámara de seguimiento: detrás del vehículo, mirando 2 km adelante. Todo el suavizado depende del TIEMPO
  // transcurrido (no de los cuadros), así la cámara se comporta igual en un teléfono lento.
  const camara = (km) => {
    const dh = Math.min(...R.hitos.map((h) => Math.abs(h.km - km)));
    return {
      rumbo: rumbo(puntoEnKm(Math.max(0, km - 1.0)), puntoEnKm(Math.min(total, km + 3.2))),
      // se eleva al acercarse a cada hito para mostrar el contexto, y baja entre hitos
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
    if (inicio == null) { inicio = ahoraMs - (segundosEnKm(km0) / R.s[R.s.length - 1]) * duracionMs; previo = ahoraMs; }
    const dt = Math.min(250, ahoraMs - previo); previo = ahoraMs;
    const suave = (tau) => 1 - Math.exp(-dt / tau);
    const q = Math.min(1, (ahoraMs - inicio) / duracionMs);
    // avance en TIEMPO de viaje: el vehículo va más lento donde la vía es lenta
    const km = kmEnSegundos(q * R.s[R.s.length - 1]);
    S.progreso = km;
    const t = moverVehiculo(km);
    const c = camara(km);
    rumboSuave = (rumboSuave + angDif(rumboSuave, c.rumbo) * suave(900) + 360) % 360;
    zoomSuave += (c.zoom - zoomSuave) * suave(1200);
    centro = [centro[0] + (c.centro[0] - centro[0]) * suave(350), centro[1] + (c.centro[1] - centro[1]) * suave(350)];
    m.jumpTo({ center: centro, bearing: rumboSuave, pitch: 74, zoom: zoomSuave });
    pintarCampo(horaDe(t));
    if (Math.abs(km - ultimoPintado) > 0.4) { pintarRuta(1, km); ultimoPintado = km; }
    pintarLectura(t);
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
  const abrir = (on) => { info.hidden = !on; b.setAttribute("aria-expanded", String(on)); };
  b.addEventListener("click", () => abrir(info.hidden));
  $("#info-cerrar").addEventListener("click", () => abrir(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") abrir(false); });
  pintarInfo();
}

function pintarInfo() {
  const R = S.ruta, L = S.lluvia;
  const ests = S.estaciones.map(({ e, d }) => `<li>${esc(e.nombre)} (${esc(e.codigo)}, ${esc(e.propietario || "")}), a ${num(d)} km de la vía</li>`).join("");
  $("#info-cuerpo").innerHTML = `
    <h3>Relieve</h3><p>Terrain Tiles de Mapzen en AWS (base SRTM de ~30 m en Ecuador), sin exagerar la altura. Suaviza quebradas estrechas.</p>
    <h3>Ruta</h3><p>${esc(R.fuente)}, consultada el ${esc(R.consultado.slice(0, 10))}. ${num(R.distancia_km)} km y ${Math.round(R.s[R.s.length - 1] / 60)} min sin tráfico ni paradas (suma de tiempos por tramo de OSRM). ${esc(R.licencia)}.</p>
    <h3>Lluvia prevista</h3><p>${esc(L.modelo)}, producto ${esc(L.producto)}, ${esc(L.rejilla)}. ${esc(L.seleccion)}. Corrida iniciada ${esc(L.corrida_inicio_utc || "sin dato")} (UTC). La trayectoria toma la celda que contiene cada punto de la vía, a la hora en que pasarías.</p>
    <h3>Lluvia medida</h3><ul>${ests || "<li>Ninguna estación a menos de 7 km de la vía.</li>"}</ul><p>Visor del INAMHI, sin control de calidad publicado. Mover el tiempo no cambia las mediciones.</p>
    <h3>Ambientación</h3><p>Cielo, neblina y color de luz son de representación, no datos. La dirección de la luz y la penumbra siguen la posición aproximada del sol a la hora de validez (astronomía); no indican nubosidad. No hay nubes porque el sistema no tiene datos de nubosidad del corredor.</p>
    <h3>Límites</h3><ul><li>Una celda de ~9 km no indica la lluvia exacta en un punto de la carretera.</li><li>No evalúa deslaves ni el estado de la vía: consulta el <a href="https://www.ecu911.gob.ec/consulta-de-vias/" target="_blank" rel="noopener">ECU 911</a>.</li><li>Prototipo: el fondo satelital es de uso no comercial.</li></ul>`;
}

// ------------------------------------------------------------------ rendimiento

/** ?medir=1: hace el recorrido completo y muestra los cuadros por segundo medidos en ESTE equipo. */
function medicion() {
  const t0 = performance.now();
  setTimeout(() => {
    const desde = S.fps.length;
    if (!S.recorriendo) recorrer();
    const fin = setInterval(() => {
      if (S.recorriendo) return;
      clearInterval(fin);
      const v = S.fps.slice(desde).filter((x) => x > 0).sort((a, b) => a - b);
      const q = (p) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
      const el = document.createElement("div");
      el.className = "info"; el.style.top = "auto"; el.style.bottom = "150px"; el.setAttribute("role", "status");
      el.innerHTML = `<h2>Medición en este equipo</h2><p>Recorrido completo, ${v.length} s medidos.</p>
        <p><b>Cuadros por segundo: mediana ${q(0.5)}, peor 5 % ${q(0.05)}, mínimo ${v[0]}.</b></p>
        <p>Pantalla ${innerWidth}×${innerHeight}, densidad ${devicePixelRatio}. Escena lista a los ${(t0 / 1000).toFixed(1)} s de abrir la página.</p>`;
      document.body.appendChild(el);
      window.__medicion = { mediana: q(0.5), p5: q(0.05), min: v[0], n: v.length, listo_s: +(t0 / 1000).toFixed(1), ancho: innerWidth, alto: innerHeight, dpr: devicePixelRatio };
    }, 500);
  }, 6000);
}

function medirFps() {
  let n = 0, t0 = performance.now();
  const tic = (t) => {
    n++;
    if (t - t0 >= 1000) { S.fps.push(Math.round((n * 1000) / (t - t0))); if (S.fps.length > 120) S.fps.shift(); n = 0; t0 = t; }
    requestAnimationFrame(tic);
  };
  requestAnimationFrame(tic);
  window.__corredor = S;
}

iniciar();
