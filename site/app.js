/* Alerta de lluvias Ecuador — interfaz. Lee los JSON que genera el pipeline (data/*.json). */
"use strict";

const ESTADO = { pron: null, calor: null, obs: null, estado: null, mapa: null, capas: {} };
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const CLASES_BLOQUE = [
  { texto: "Sin lluvia relevante", icono: "○" },
  { texto: "Lluvia ligera", icono: "◇" },
  { texto: "Lluvia moderada", icono: "▲" },
  { texto: "Lluvia fuerte", icono: "■" },
];

// ------------------------------------------------------------------ utilidades

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Los tiempos de Open-Meteo vienen en hora local de Ecuador sin zona; se manejan como texto local.
const parseLocal = (s) => { const [d, t = "00:00"] = s.slice(0, 16).split("T"); const [y, m, dd] = d.split("-").map(Number); const [hh, mm] = t.split(":").map(Number); return new Date(Date.UTC(y, m - 1, dd, hh, mm)); };
const fmtLocal = (d) => d.toISOString().slice(0, 16);
const hora = (d) => d.toISOString().slice(11, 16);
const diaCorto = (d) => `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`;
const fechaLarga = (s) => { const d = parseLocal(s + "T00:00"); return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`; };
const ahoraLocal = () => new Date(Date.now() - 5 * 3600 * 1000); // Ecuador UTC-5, sin horario de verano
const deCada10 = (p) => (p == null ? "—" : `${Math.round(p * 10)} de cada 10`);
const edadHoras = (iso) => (Date.now() - new Date(iso).getTime()) / 3600000;
const edadTexto = (h) => (h < 1 ? `hace ${Math.max(1, Math.round(h * 60))} min` : `hace ${h.toFixed(h < 10 ? 1 : 0)} h`);

function nivelHTML(cod, extra = "", corto = false) {
  const n = ESTADO.pron.niveles[cod];
  const texto = corto ? (n.corto || n.texto) : n.texto;
  return `<span class="nivel n${cod} ${extra}" title="${esc(n.texto)}"><span class="icono" aria-hidden="true">${n.icono}</span>${esc(texto)}</span>`;
}

async function cargar(nombre) {
  try {
    const r = await fetch(`data/${nombre}?v=${Math.floor(Date.now() / 600000)}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function guardar(clave, valor) { try { localStorage.setItem(clave, valor); } catch { /* sin almacenamiento */ } }
function leer(clave) { try { return localStorage.getItem(clave); } catch { return null; } }

// ------------------------------------------------------------------ inicio

async function iniciar() {
  [ESTADO.pron, ESTADO.calor, ESTADO.obs, ESTADO.estado] = await Promise.all(
    ["pronostico.json", "calor.json", "estaciones.json", "estado.json"].map(cargar));
  pintarFrescura();
  if (!ESTADO.pron) return;
  prepararPestanas();
  prepararViaje();
  pintarLugares();
  pintarProvincias();
}

function pintarFrescura() {
  const el = $("#frescura");
  const p = ESTADO.pron, o = ESTADO.obs;
  if (!p) { el.className = "frescura error"; el.textContent = "No se pudieron cargar los datos del pronóstico. Intenta más tarde y consulta al INAMHI."; return; }
  const ep = edadHoras(p.generado);
  const partes = [`Pronóstico ${edadTexto(ep)}`];
  let alerta = ep > 12;
  if (o && o.estaciones.length) {
    const ultimo = o.estaciones.map((e) => new Date(e.ultimo).getTime()).reduce((a, b) => Math.max(a, b), 0);
    const eo = (Date.now() - ultimo) / 3600000;
    partes.push(`estaciones: último dato ${edadTexto(eo)} (${o.estaciones.length} estaciones)`);
    if (eo > 3) alerta = true;
  } else {
    partes.push("estaciones sin datos");
  }
  const caidos = Object.values(p.modelos).filter((m) => m.estado !== "ok").map((m) => m.nombre);
  if (caidos.length) { partes.push(`sin ${caidos.join(", ")}`); alerta = true; }
  if (ESTADO.estado?.demo) {
    el.className = "frescura error";
    el.textContent = "DATOS DE DEMOSTRACIÓN (sintéticos, no son un pronóstico). Sirven solo para revisar el diseño.";
    return;
  }
  el.className = "frescura" + (alerta ? " alerta" : "");
  el.textContent = (alerta ? "Datos atrasados o incompletos · " : "") + partes.join(" · ");
}

function prepararPestanas() {
  const botones = document.querySelectorAll(".pestanas button");
  const paneles = { viaje: "#viaje", lugares: "#lugares", mapa: "#mapa-panel", provincias: "#provincias" };
  const mostrar = (id) => {
    botones.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.pestana === id)));
    Object.entries(paneles).forEach(([k, sel]) => { $(sel).hidden = k !== id; });
    if (id === "mapa") prepararMapa();
    guardar("pestana", id);
  };
  botones.forEach((b) => b.addEventListener("click", () => mostrar(b.dataset.pestana)));
  mostrar(leer("pestana") || "viaje");
}

// ------------------------------------------------------------------ viaje

function seriePunto(pid) { return ESTADO.pron.detalle[pid]?.horaria; }

// Índice de la hora que contiene el instante t (los tiempos marcan el FIN de cada hora).
function indiceHora(serie, t) {
  for (let i = 0; i < serie.tiempos.length; i++) {
    const fin = parseLocal(serie.tiempos[i]);
    if (t < fin && t >= new Date(fin.getTime() - 3600000)) return i;
  }
  return -1;
}

function evaluarSalida(ruta, salida) {
  const umb = ESTADO.pron.umbrales.horaria;
  const tramos = [];
  let totales = null;
  for (const t of ruta.tramos) {
    const serie = seriePunto(t.punto);
    const paso = new Date(salida.getTime() + t.min * 60000);
    const i = serie ? indiceHora(serie, paso) : -1;
    if (i < 0) return null;
    const mm = serie.miembros_dmm.map((m) => (m[i] == null ? null : m[i] / 10)).filter((v) => v != null);
    totales = totales || mm.map(() => 0);
    mm.forEach((v, k) => { totales[k] += v; });
    const pMod = mm.filter((v) => v >= umb.moderada_mm_h).length / mm.length;
    const pFue = mm.filter((v) => v >= umb.fuerte_mm_h).length / mm.length;
    const pAlgo = mm.filter((v) => v >= 0.2).length / mm.length;
    const clase = pFue >= 0.3 ? 3 : pMod >= 0.5 ? 2 : pAlgo >= 0.5 ? 1 : 0;
    tramos.push({ punto: t.punto, paso, pMod, pFue, pAlgo, clase, mediana: mediana(mm) });
  }
  return { salida, tramos, totales };
}

function mediana(xs) { const v = [...xs].sort((a, b) => a - b); const n = v.length; return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null; }

function salidasPosibles(ruta) {
  const serie = seriePunto(ruta.tramos[0].punto);
  if (!serie) return [];
  const primera = new Date(parseLocal(serie.tiempos[0]).getTime() - 3600000); // inicio de la primera hora
  const ultimaFin = parseLocal(serie.tiempos[serie.tiempos.length - 1]);
  const dur = ruta.tramos[ruta.tramos.length - 1].min * 60000;
  const out = [];
  for (let t = primera; t.getTime() + dur < ultimaFin.getTime() && out.length < 48; t = new Date(t.getTime() + 3600000)) out.push(t);
  return out;
}

function prepararViaje() {
  const rutas = ESTADO.pron.rutas;
  const selRuta = $("#ruta"), selSal = $("#salida");
  selRuta.innerHTML = rutas.map((r) => `<option value="${esc(r.id)}">${esc(r.nombre)}</option>`).join("");
  const rellenarSalidas = () => {
    const ruta = rutas.find((r) => r.id === selRuta.value);
    const opciones = salidasPosibles(ruta);
    selSal.innerHTML = opciones.map((t) => `<option value="${fmtLocal(t)}">${diaCorto(t)} · ${hora(t)}</option>`).join("");
    const guardada = leer("salida");
    if (guardada && opciones.some((t) => fmtLocal(t) === guardada)) selSal.value = guardada;
  };
  selRuta.addEventListener("change", () => { rellenarSalidas(); pintarViaje(); });
  selSal.addEventListener("change", () => { guardar("salida", selSal.value); pintarViaje(); });
  rellenarSalidas();
  pintarViaje();
}

function pintarViaje() {
  const ruta = ESTADO.pron.rutas.find((r) => r.id === $("#ruta").value);
  const salida = parseLocal($("#salida").value);
  const ev = evaluarSalida(ruta, salida);
  const nombre = (pid) => ESTADO.pron.detalle[pid]?.nombre || pid;
  if (!ev) { $("#viaje-respuesta").innerHTML = "<p>No hay pronóstico para esa hora.</p>"; return; }

  const peor = ev.tramos.reduce((a, b) => (b.clase > a.clase ? b : a), ev.tramos[0]);
  const llegada = ev.tramos[ev.tramos.length - 1].paso;
  const rec = recomendar(ruta, salida, ev);
  const titulo = peor.clase >= 2
    ? `Lluvia ${peor.clase === 3 ? "fuerte" : "moderada"} probable cerca de ${esc(nombre(peor.punto))}`
    : peor.clase === 1 ? "Lluvia ligera probable en parte del camino" : "Sin señal de lluvia relevante en la ruta";
  $("#viaje-respuesta").innerHTML = `
    <h2>${titulo}</h2>
    <p>Salida ${diaCorto(salida)} a las ${hora(salida)} · llegada aprox. ${hora(llegada)}.
      ${peor.clase >= 2 ? `Lluvia moderada o más en ese tramo en ${deCada10(peor.pMod)} escenarios.` : ""}</p>
    <p class="recomendacion">${rec}</p>
    <p class="aviso"><span class="etiqueta-capa pronostico">PRONÓSTICO</span> ECMWF IFS ENS, 51 escenarios. Tiempos de viaje aproximados.</p>`;

  $("#viaje-tramos").innerHTML = ev.tramos.map((t) => `
    <li>
      <span class="hora">${hora(t.paso)}</span>
      <span class="lugar">${esc(nombre(t.punto))} <span class="nivel n${t.clase === 3 ? 3 : t.clase}" style="margin-left:4px">
        <span class="icono" aria-hidden="true">${CLASES_BLOQUE[t.clase].icono}</span>${CLASES_BLOQUE[t.clase].texto}</span></span>
      <span class="detalle">Llueve algo en ${deCada10(t.pAlgo)} escenarios · moderada o más en ${deCada10(t.pMod)} · mediana ${t.mediana?.toFixed(1) ?? "—"} mm en esa hora</span>
    </li>`).join("");

  pintarObservadoRuta(ruta);
}

// Compara contra salidas dentro de ±6 h. Solo recomienda si es más seca en >= 75 % de los escenarios.
function recomendar(ruta, salida, ev) {
  const candidatas = salidasPosibles(ruta).filter((t) => Math.abs(t - salida) <= 6 * 3600000 && t.getTime() !== salida.getTime());
  let mejor = null;
  for (const t of candidatas) {
    const e = evaluarSalida(ruta, t);
    if (!e) continue;
    const n = Math.min(e.totales.length, ev.totales.length);
    let masSeca = 0;
    for (let k = 0; k < n; k++) if (e.totales[k] + 0.5 < ev.totales[k]) masSeca++;
    const frac = masSeca / n;
    if (frac >= 0.75 && (!mejor || frac > mejor.frac || (frac === mejor.frac && mediana(e.totales) < mediana(mejor.e.totales)))) mejor = { t, e, frac };
  }
  if (!mejor) return "Sin diferencia clara con salir unas horas antes o después.";
  return `Salir a las ${hora(mejor.t)} (${diaCorto(mejor.t)}) tendría menos lluvia en ruta en ${deCada10(mejor.frac)} escenarios.`;
}

function distanciaKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pintarObservadoRuta(ruta) {
  const cont = $("#viaje-observado");
  const est = ESTADO.obs?.estaciones || [];
  if (!est.length) { cont.innerHTML = ""; return; }
  const puntos = Object.fromEntries(ESTADO.pron.puntos.map((p) => [p.id, p]));
  const filas = ruta.tramos.map((t) => {
    const p = puntos[t.punto];
    const cercanas = est.map((e) => ({ e, d: distanciaKm(p, e) })).filter((x) => x.d <= 15).sort((a, b) => a.d - b.d);
    if (!cercanas.length) return `<li>${esc(p.nombre)}: sin estación a menos de 15 km</li>`;
    const { e, d } = cercanas[0];
    return `<li>${esc(p.nombre)}: <strong>${e.mm_3h} mm</strong> en 3 h, ${e.mm_24h} mm en 24 h
      <span class="aviso">(${esc(e.nombre)}, a ${d.toFixed(0)} km, dato ${edadTexto(edadHoras(e.ultimo))})</span></li>`;
  }).join("");
  cont.innerHTML = `<h3><span class="etiqueta-capa observado">OBSERVADO</span> Lluvia medida en estaciones cercanas</h3><ul>${filas}</ul>
    <p class="aviso">Visor del INAMHI. La lluvia acumulada de varios días satura el suelo de las laderas; el umbral de riesgo se calibrará con eventos reportados (Plan 5, etapa 5).</p>`;
}

// ------------------------------------------------------------------ lugares

function pintarLugares() {
  const cont = $("#lugares-lista");
  const p = ESTADO.pron;
  const puntos = Object.fromEntries(p.puntos.map((x) => [x.id, x]));
  cont.innerHTML = p.lugares.map((pid) => {
    const det = p.detalle[pid], pt = puntos[pid];
    if (!det || !pt) return "";
    const hoy = parseLocal(det.bloques[0].inicio.slice(0, 10) + "T00:00");
    const porInicio = Object.fromEntries(det.bloques.map((b) => [b.inicio.slice(0, 16), b]));
    let filas = `<div class="cab"></div>${[0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<div class="cab">${String(h).padStart(2, "0")}</div>`).join("")}`;
    for (let d = 0; d < 3; d++) {
      const dia = new Date(hoy.getTime() + d * 86400000);
      filas += `<div class="dia">${d === 0 ? "Hoy" : diaCorto(dia)}</div>`;
      for (let h = 0; h < 24; h += 3) {
        const ini = fmtLocal(new Date(dia.getTime() + h * 3600000));
        const b = porInicio[ini];
        filas += b
          ? `<button class="bloque c${b.clase}" data-lugar="${esc(pid)}" data-inicio="${ini}" aria-label="${diaCorto(dia)} ${ini.slice(11)}: ${CLASES_BLOQUE[b.clase].texto}"><span aria-hidden="true">${CLASES_BLOQUE[b.clase].icono}</span></button>`
          : `<div class="bloque pasado" aria-hidden="true"></div>`;
      }
    }
    const franja = pt.dias.slice(0, 11).map((d, i) => `
      <div class="celda">${d.parcial ? "Hoy" : fechaLarga(d.fecha).split(" ").slice(0, 2).join(" ")}<br>
        ${nivelHTML(d.nivel, d.confianza === "tendencia" ? "tendencia" : "", true)}<br>
        <span class="aviso">${d.mm.p50 ?? "—"} mm</span></div>`).join("");
    return `<article class="tarjeta">
      <h3>${esc(pt.nombre)} <span class="aviso">· próximos 3 días en bloques de 3 h</span></h3>
      <div class="bloques">${filas}</div>
      <div class="leyenda-bloques">${CLASES_BLOQUE.map((c, i) => `<span class="nivel n${i}"><span aria-hidden="true">${c.icono}</span>${c.texto}</span>`).join(" ")}</div>
      <div class="bloque-detalle" id="det-${esc(pid)}">Toca un bloque para ver el detalle.</div>
      <h3 style="margin-top:12px">Próximos 10 días <span class="aviso">· umbrales ${esc(pt.region)}, ${p.estado}</span></h3>
      <div class="franja">${franja}</div>
    </article>`;
  }).join("");
  cont.addEventListener("click", (ev) => {
    const b = ev.target.closest(".bloque[data-lugar]");
    if (!b) return;
    const det = p.detalle[b.dataset.lugar];
    const bl = det.bloques.find((x) => x.inicio.slice(0, 16) === b.dataset.inicio);
    $(`#det-${CSS.escape(b.dataset.lugar)}`).innerHTML = `<strong>${b.dataset.inicio.slice(11)}–${hora(new Date(parseLocal(b.dataset.inicio).getTime() + 3 * 3600000))}:</strong>
      ${CLASES_BLOQUE[bl.clase].texto}. Llueve algo en ${deCada10(bl.p_ligera)} escenarios, moderada en ${deCada10(bl.p_moderada)},
      fuerte en ${deCada10(bl.p_fuerte)}. Rango probable ${bl.p10}–${bl.p90} mm (mediana ${bl.p50} mm).`;
  });
}

// ------------------------------------------------------------------ provincias

function pintarProvincias() {
  const p = ESTADO.pron;
  const fechas = p.provincias[0].dias;
  const cab = `<thead><tr><th>Provincia</th>${fechas.map((d) => `<th>${d.parcial ? "Hoy" : fechaLarga(d.fecha).split(" ").slice(0, 2).join(" ")}</th>`).join("")}</tr></thead>`;
  const cuerpo = p.provincias.map((pr) => `<tr data-provincia="${esc(pr.provincia)}"><td>${esc(pr.provincia)}</td>${pr.dias.map((d) => {
    const n = p.niveles[d.nivel];
    const titulo = `${n.texto}${d.nivel > 0 ? ` en ${d.puntos_afectados} de ${d.puntos_total} puntos` : ""} · confianza ${d.confianza}`;
    return `<td title="${esc(titulo)}"><span class="nivel n${d.nivel} ${d.confianza === "tendencia" ? "tendencia" : ""}" aria-label="${esc(titulo)}"><span aria-hidden="true">${n.icono}</span>${d.nivel > 0 ? ` ${d.puntos_afectados}/${d.puntos_total}` : ""}</span></td>`;
  }).join("")}</tr>`).join("");
  $("#tabla-provincias").innerHTML = cab + `<tbody>${cuerpo}</tbody>`;
  const leyenda = p.niveles.map((n) => nivelHTML(n.codigo)).join(" ");
  $("#provincias .intro").innerHTML = `Peor nivel entre los puntos de cada provincia por día; el número indica cuántos puntos lo alcanzan. Los días pálidos son solo tendencia.<br>${leyenda}`;
  $("#tabla-provincias tbody").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-provincia]");
    if (tr) pintarProvincia(tr.dataset.provincia);
  });
}

function pintarProvincia(nombre) {
  const p = ESTADO.pron;
  const pts = p.puntos.filter((x) => x.provincia === nombre);
  $("#provincia-detalle").innerHTML = `<article class="tarjeta"><h3>${esc(nombre)}</h3>${pts.map((pt) => `
    <p><strong>${esc(pt.nombre)}</strong> <span class="aviso">(umbrales ${esc(pt.region)}: alto ≥ ${p.umbrales.regiones[pt.region].alto} mm/día)</span></p>
    <div class="franja">${pt.dias.slice(0, 11).map((d) => `<div class="celda">${d.parcial ? "Hoy" : fechaLarga(d.fecha).split(" ").slice(0, 2).join(" ")}<br>
      ${nivelHTML(d.nivel, d.confianza === "tendencia" ? "tendencia" : "", true)}<br>
      <span class="aviso">alto: ${deCada10(d.p.alto)}<br>${d.mm.p10 ?? "—"}–${d.mm.p90 ?? "—"} mm</span></div>`).join("")}</div>`).join("")}</article>`;
  $("#provincia-detalle").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ------------------------------------------------------------------ mapa

const ESCALA_PRON = [ // mm/h -> color (azules a violeta); pronóstico
  [0.1, "rgba(158,202,225,0.45)"], [0.5, "rgba(107,174,214,0.6)"], [1, "rgba(66,146,198,0.7)"],
  [2.5, "rgba(33,113,181,0.78)"], [5, "rgba(84,39,143,0.82)"], [7.6, "rgba(122,1,119,0.88)"], [15, "rgba(73,0,106,0.92)"],
];
const ESCALA_OBS = [[0.1, "#fdd49e"], [2.5, "#fdbb84"], [7.5, "#fc8d59"], [15, "#e34a33"], [30, "#b30000"]]; // mm en 3 h; observado

function colorDe(escala, v) { let c = null; for (const [u, col] of escala) if (v >= u) c = col; return c; }

function prepararMapa() {
  if (ESTADO.mapa) { setTimeout(() => ESTADO.mapa.invalidateSize(), 50); return; }
  const mapa = L.map("mapa", { zoomControl: true, attributionControl: true }).setView([-1.4, -78.6], 7);
  ESTADO.mapa = mapa;
  const base = L.tileLayer("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg", {
    maxZoom: 13, attribution: 'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu">EOX</a> (CC BY-NC-SA 4.0)',
  }).addTo(mapa);
  const etiquetas = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png", {
    maxZoom: 13, subdomains: "abcd", attribution: "© OpenStreetMap © CARTO", pane: "shadowPane",
  }).addTo(mapa);
  const goes = L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png", {
    maxNativeZoom: 7, maxZoom: 13, opacity: 0.85, attribution: "NASA GIBS · GOES-East",
  });
  const imerg = L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png", {
    maxNativeZoom: 6, maxZoom: 13, opacity: 0.8, attribution: "NASA GIBS · GPM IMERG",
  });
  const calor = L.layerGroup().addTo(mapa);
  const estaciones = L.layerGroup().addTo(mapa);
  ESTADO.capas = { calor, estaciones };
  L.control.layers({ "Satélite (Sentinel-2)": base }, {
    "Etiquetas": etiquetas,
    "PRONÓSTICO · lluvia por hora": calor,
    "OBSERVADO · estaciones INAMHI (3 h)": estaciones,
    "Nubes GOES (~40 min de retraso)": goes,
    "Lluvia satelital IMERG (hace ~5–6 h)": imerg,
  }, { collapsed: true }).addTo(mapa);

  pintarEstaciones();
  const slider = $("#hora-mapa");
  if (ESTADO.calor) {
    slider.max = ESTADO.calor.tiempos.length - 1;
    slider.addEventListener("input", () => pintarCalor(+slider.value));
    pintarCalor(0);
  } else {
    $("#hora-mapa-texto").textContent = "Mapa de pronóstico no disponible";
  }
  $("#mapa-leyenda").innerHTML = `
    <div><span class="etiqueta-capa pronostico">PRONÓSTICO</span> mm/h (ECMWF HRES 9 km)</div>
    <div class="escala">${ESCALA_PRON.map(([, c]) => `<span style="background:${c}"></span>`).join("")}</div>
    <div>0,1 · 0,5 · 1 · 2,5 · 5 · 7,6 · 15+</div>
    <div style="margin-top:6px"><span class="etiqueta-capa observado">OBSERVADO</span> círculos: lluvia medida en las últimas 3 h (mm)</div>
    <div class="escala">${ESCALA_OBS.map(([, c]) => `<span style="background:${c}"></span>`).join("")}</div>
    <div>0,1 · 2,5 · 7,5 · 15 · 30+ · gris = sin lluvia</div>`;
}

function pintarCalor(i) {
  const c = ESTADO.calor;
  const { lats, lons, paso } = c;
  const lienzo = document.createElement("canvas");
  lienzo.width = lons.length; lienzo.height = lats.length;
  const ctx = lienzo.getContext("2d");
  const vals = c.valores_dmm[i];
  for (let f = 0; f < lats.length; f++) {
    for (let k = 0; k < lons.length; k++) {
      const v = vals[f * lons.length + k];
      const col = v == null ? null : colorDe(ESCALA_PRON, v / 10);
      if (col) { ctx.fillStyle = col; ctx.fillRect(k, f, 1, 1); }
    }
  }
  const limites = [[lats[lats.length - 1] - paso / 2, lons[0] - paso / 2], [lats[0] + paso / 2, lons[lons.length - 1] + paso / 2]];
  ESTADO.capas.calor.clearLayers();
  L.imageOverlay(lienzo.toDataURL(), limites, { opacity: 1, interactive: false, className: "capa-calor" }).addTo(ESTADO.capas.calor);
  const fin = parseLocal(c.tiempos[i]);
  const ini = new Date(fin.getTime() - 3600000);
  $("#hora-mapa-texto").textContent = `PRONÓSTICO ${diaCorto(ini)} ${hora(ini)}–${hora(fin)}`;
}

function pintarEstaciones() {
  const grupo = ESTADO.capas.estaciones;
  grupo.clearLayers();
  for (const e of ESTADO.obs?.estaciones || []) {
    const col = colorDe(ESCALA_OBS, e.mm_3h) || "#9aa0a6";
    L.circleMarker([e.lat, e.lon], { radius: 6, weight: 1.5, color: "#ffffff", fillColor: col, fillOpacity: 0.95 })
      .bindPopup(`<strong>${esc(e.nombre)}</strong><br>${esc(e.codigo)} · ${esc(e.propietario || "")}<br>
        <span class="etiqueta-capa observado">OBSERVADO</span> ${edadTexto(edadHoras(e.ultimo))}<br>
        1 h: ${e.mm_1h} mm · 3 h: ${e.mm_3h} mm<br>24 h: ${e.mm_24h} mm · 72 h: ${e.mm_72h} mm`)
      .addTo(grupo);
  }
}

iniciar();
