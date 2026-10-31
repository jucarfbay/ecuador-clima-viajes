/* Lluvia en Ecuador — interfaz. Lee data/*.json (generados por el pipeline) y usa logica.js para los cálculos. */
"use strict";

const Lg = window.Logica;
const VERSION = "dev"; // el flujo de publicación lo reemplaza por el commit, para renovar la caché del teléfono

const E = {
  pron: null, calor: null, obs: null, estado: null, vias: null, cargado: 0, desdeCache: false,
  porId: {}, favs: [], lugar: null, ubic: null, panel: null, pintados: new Set(),
  viaje: { ruta: null, fecha: null, salida: null, noche: false },
  mapa: null, capas: {}, calorIdx: 0, reproduciendo: null, provFecha: null,
};

// ------------------------------------------------------------------ utilidades

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const sinTildes = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function guardar(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } }
function leer(k) { try { return localStorage.getItem(k); } catch { return null; } }

const REGIONES = { Litoral: "Costa", Interandina: "Sierra", Amazonia: "Amazonía", Insular: "Galápagos" };
const ICONO_UBIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="8"/></svg>';

function nivelHTML(cod, { corto = false, extra = "" } = {}) {
  const n = E.pron.niveles[cod];
  return `<span class="nivel n${cod} ${extra}"><span class="icono" aria-hidden="true">${n.icono}</span>${esc(corto ? n.corto || n.texto : n.texto)}</span>`;
}
function intensidadHTML(clase, corto = false) {
  const c = Lg.CLASES[clase];
  return `<span class="int c${clase}"><span aria-hidden="true">${c.icono}</span>${corto ? c.corto : c.texto}</span>`;
}
const sello = () => `<button type="button" class="sello" data-abrir-frescura>no calibrado</button>`;

async function cargar(nombre) {
  try {
    const r = await fetch(`data/${nombre}`, { cache: "no-cache" });
    if (!r.ok) return null;
    if (r.headers.get("x-desde-cache") === "1") E.desdeCache = true;
    return await r.json();
  } catch { return null; }
}

// ------------------------------------------------------------------ inicio

async function iniciar() {
  E.desdeCache = false;
  [E.pron, E.calor, E.obs, E.estado, E.vias] = await Promise.all(["pronostico.json", "calor.json", "estaciones.json", "estado.json", "vias.json"].map(cargar));
  E.cargado = Date.now();
  E.viasProv = null;
  pintarFrescura();
  pintarConexion();
  if (!E.pron || !E.pron.puntos) { mostrarErrorCarga(); prepararNavegacion(); return; }
  $("#error-carga").hidden = true;
  E.porId = Object.fromEntries(E.pron.puntos.map((p) => [p.id, p]));
  const params = new URLSearchParams(location.search);
  E.favs = Lg.leerFavoritos(location.search, leer("favoritos"), Object.keys(E.porId));
  const pedido = params.get("lugar") || leer("lugar");
  E.lugar = pedido && (E.porId[pedido] || pedido === "ubicacion") ? pedido : E.favs.find((x) => x !== "ubicacion") || "quito";
  if (E.lugar === "ubicacion" && !E.ubic) E.lugar = E.favs.find((x) => x !== "ubicacion") || "quito"; // no pedir permiso al abrir
  E.pintados.clear();
  prepararNavegacion();
}

function mostrarErrorCarga() {
  const el = $("#error-carga");
  el.hidden = false;
  el.innerHTML = `<h2>No se pudo cargar el pronóstico</h2>
    <p>Revisa tu conexión a internet y vuelve a intentar. Mientras tanto, consulta las
      <a href="https://www.inamhi.gob.ec/" target="_blank" rel="noopener">advertencias del INAMHI</a>.</p>
    <button class="boton" type="button" id="reintentar">Volver a intentar</button>`;
  $("#reintentar").onclick = () => iniciar();
  $$(".panel").forEach((p) => { p.hidden = true; });
}

let navegacionLista = false;
function prepararNavegacion() {
  if (!navegacionLista) {
    window.addEventListener("hashchange", () => mostrar(panelDeHash()));
    document.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-abrir-frescura]")) { abrirFrescura(true); }
    });
    $("#frescura").addEventListener("click", () => abrirFrescura());
    window.addEventListener("online", pintarConexion);
    window.addEventListener("offline", pintarConexion);
    setInterval(pintarFrescura, 60000);
    setInterval(() => { E.pintados.clear(); if (E.pron) mostrar(E.panel, { conservarScroll: true }); }, 10 * 60000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - E.cargado > 20 * 60000) iniciar();
    });
    navegacionLista = true;
  }
  if (E.pron) mostrar(panelDeHash(), { conservarScroll: true });
}

function panelDeHash() {
  const h = location.hash.slice(1);
  return ["lugares", "viaje", "mapa", "provincias"].includes(h) ? h : "lugares";
}

function mostrar(id, { conservarScroll = false } = {}) {
  if (!E.pron) return;
  const ids = { lugares: "#lugares", viaje: "#viaje", mapa: "#mapa-panel", provincias: "#provincias" };
  Object.entries(ids).forEach(([k, sel]) => { $(sel).hidden = k !== id; });
  $$(".navegacion a").forEach((a) => (a.dataset.panel === id ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  document.body.classList.toggle("en-mapa", id === "mapa");
  if (id !== "mapa") detenerReproduccion();
  const cambio = E.panel !== id;
  E.panel = id;
  if (!E.pintados.has(id)) {
    ({ lugares: pintarLugares, viaje: prepararViaje, mapa: prepararMapa, provincias: pintarProvincias })[id]();
    E.pintados.add(id);
  } else if (id === "mapa") {
    setTimeout(() => E.mapa && E.mapa.invalidateSize(), 50);
  }
  if (cambio && !conservarScroll) window.scrollTo(0, 0);
}

function actualizarUrl() {
  const p = new URLSearchParams(location.search);
  p.set("l", E.favs.join(","));
  if (E.lugar && E.lugar !== "ubicacion") p.set("lugar", E.lugar); else p.delete("lugar");
  history.replaceState(null, "", `?${p.toString().replace(/%2C/g, ",")}${location.hash}`);
  guardar("favoritos", E.favs.join(","));
  if (E.lugar) guardar("lugar", E.lugar);
}

// ------------------------------------------------------------------ frescura y conexión

function pintarFrescura() {
  const b = $("#frescura");
  if (!E.pron) { b.textContent = "Sin datos"; b.className = "frescura sin-datos"; return; }
  const f = Lg.frescura(E.pron, E.obs, E.calor);
  if (E.vias?.generado) f.items.push({ clave: "vias", texto: `Estado de vías del ECU 911 consultado a las ${Lg.horaEcuador(E.vias.generado)}` });
  b.textContent = E.estado?.demo ? "Datos de demostración" : f.corto;
  b.className = "frescura" + (f.atrasado || E.estado?.demo ? " atrasado" : "");
  const panel = $("#frescura-panel");
  panel.innerHTML = `
    ${E.estado?.demo ? "<p><strong>Datos de demostración, sintéticos: no son un pronóstico.</strong></p>" : ""}
    <ul>${f.items.map((i) => `<li>${esc(i.texto)}</li>`).join("")}</ul>
    <p><strong>No calibrado.</strong> Los niveles y las probabilidades todavía no se han comparado con lluvia medida en una
      temporada completa. Úsalos como orientación y confirma con el
      <a href="https://www.inamhi.gob.ec/" target="_blank" rel="noopener">INAMHI</a> y el ECU 911.</p>
    <p>Las probabilidades salen de 51 escenarios de ECMWF, combinados con los de ECMWF AIFS y NOAA GEFS.</p>`;
}

function abrirFrescura(forzar) {
  const panel = $("#frescura-panel"), b = $("#frescura");
  const abrir = forzar === true ? true : panel.hidden;
  panel.hidden = !abrir;
  b.setAttribute("aria-expanded", String(abrir));
  if (abrir && forzar) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function pintarConexion() {
  const el = $("#sin-conexion");
  const offline = navigator.onLine === false;
  if (offline || E.desdeCache) {
    el.hidden = false;
    el.textContent = `Sin conexión. Se muestran los últimos datos guardados en este teléfono${E.pron ? ` (pronóstico de las ${Lg.horaEcuador(E.pron.generado)})` : ""}.`;
  } else {
    el.hidden = true;
  }
}

// ------------------------------------------------------------------ ubicación (opción B: punto del sistema más cercano)

function ubicar() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator) || !window.isSecureContext) {
      reject({ tipo: "sin-api", texto: "Este navegador no permite obtener la ubicación. Elige una ciudad de la lista." });
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
      if (!Lg.dentroEcuador(lat, lon)) {
        reject({ tipo: "fuera", texto: "Tu ubicación está fuera de Ecuador. Este sistema solo cubre Ecuador; elige una ciudad de la lista." });
        return;
      }
      E.ubic = { lat, lon, acc, cercano: Lg.masCercano(E.pron.puntos, lat, lon) };
      resolve(E.ubic);
    }, (err) => {
      if (err.code === 1) {
        reject({ tipo: "denegado", texto: "No diste permiso para usar tu ubicación.",
          ayuda: `<p>Para activarlo:</p><ul>
            <li><strong>iPhone:</strong> Ajustes, Privacidad y seguridad, Localización, Safari (o tu navegador): «Al usar la app».</li>
            <li><strong>Android con Chrome:</strong> toca el candado junto a la dirección, Permisos, Ubicación: «Permitir».</li></ul>
            <p>Luego vuelve a tocar Mi ubicación. La página funciona igual sin ubicación.</p>` });
      } else if (err.code === 3) {
        reject({ tipo: "tiempo", texto: "Tu teléfono no entregó la ubicación a tiempo. Revisa que la ubicación esté activada y vuelve a intentar." });
      } else {
        reject({ tipo: "otro", texto: "No se pudo obtener tu ubicación. Vuelve a intentar o elige una ciudad de la lista." });
      }
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
}

// ------------------------------------------------------------------ lugares

function pintarLugares() {
  pintarChips();
  elegirLugar(E.lugar);
}

function pintarChips() {
  const chips = E.favs.map((id) => {
    const activo = id === E.lugar;
    if (id === "ubicacion") return `<button type="button" class="chip" data-lugar="ubicacion" aria-pressed="${activo}">${ICONO_UBIC}Mi ubicación</button>`;
    return `<button type="button" class="chip" data-lugar="${esc(id)}" aria-pressed="${activo}">${esc(E.porId[id].nombre)}</button>`;
  });
  const extra = E.lugar && E.lugar !== "ubicacion" && !E.favs.includes(E.lugar)
    ? `<button type="button" class="chip" data-lugar="${esc(E.lugar)}" aria-pressed="true">${esc(E.porId[E.lugar].nombre)}</button>` : "";
  $("#chips").innerHTML = chips.join("") + extra + `<button type="button" class="chip agregar" id="agregar">+ Agregar</button>`;
  $$("#chips [data-lugar]").forEach((b) => b.addEventListener("click", () => elegirLugar(b.dataset.lugar)));
  $("#agregar").addEventListener("click", abrirDialogoLugares);
  const activo = $('#chips [aria-pressed="true"]');
  if (activo) activo.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function elegirLugar(id) {
  E.lugar = id;
  pintarChips();
  actualizarUrl();
  const cont = $("#lugar");
  if (id !== "ubicacion") { pintarLugar(E.porId[id]); return; }
  if (E.ubic) { pintarLugar(E.ubic.cercano.punto, E.ubic); return; }
  cont.innerHTML = `<p class="nota" role="status">Buscando tu ubicación… Tu teléfono te pedirá permiso. La ubicación no sale del teléfono: solo se usa para encontrar el punto del sistema más cercano.</p>`;
  try {
    const u = await ubicar();
    if (E.lugar === "ubicacion") pintarLugar(u.cercano.punto, u);
  } catch (err) {
    if (E.lugar !== "ubicacion") return;
    cont.innerHTML = `<div class="error-carga" role="alert"><h2>${esc(err.texto)}</h2>${err.ayuda || ""}
      <div class="acciones"><button class="boton" type="button" id="reubicar">Volver a intentar</button>
      <button class="boton secundario" type="button" id="elegir-ciudad">Elegir una ciudad</button></div></div>`;
    $("#reubicar").onclick = () => elegirLugar("ubicacion");
    $("#elegir-ciudad").onclick = abrirDialogoLugares;
  }
}

function pintarLugar(p, ubic = null) {
  const ahora = Date.now();
  const bl = Lg.bloquesVigentes(p, ahora, 72);
  const f = Lg.frase(bl, ahora, Lg.offsetDe(p));
  const sub = ubic
    ? `Punto del sistema más cercano a ti, a ${Lg.num(ubic.cercano.km, 0)} km. ${esc(p.provincia)}.`
    : `${esc(p.provincia)}${p.utc_offset_s === -21600 ? ", hora de Galápagos" : ""}.`;
  $("#lugar").innerHTML = `
    <div class="lugar-cab">
      <h2 class="lugar-nombre">${esc(p.nombre)}</h2>
      <p class="lugar-sub">${sub} El pronóstico describe una zona de ~25 km alrededor del punto.</p>
    </div>
    <div class="respuesta pronostico-marco">
      <p class="frase">${esc(f.texto)}</p>
      <p class="frase-detalle">${f.detalle ? `En ${esc(f.detalle)} de ECMWF.` : "Próximas 24 h, 51 escenarios de ECMWF."} ${sello()}</p>
    </div>
    ${hietogramaHTML(bl, p)}
    <div class="medido medido-marco" id="lugar-medido"></div>
    <h3 class="rotulo" style="margin-top:20px">Próximos días <span class="nota">(lluvia del día, umbrales de ${esc(REGIONES[p.region] || p.region)})</span></h3>
    ${diasHTML(Lg.diasVigentes(p, ahora))}
    <details class="plegable"><summary>Detalle cada 3 horas</summary>${tablaBloquesHTML(bl)}</details>`;
  $("#lugar-medido").innerHTML = medidoHTML(ubic ? ubic.lat : p.lat, ubic ? ubic.lon : p.lon);
  activarHietograma($("#lugar .hieto"), bl);
}

function hietogramaHTML(bl, p) {
  if (!bl.length) return `<p class="nota">No hay pronóstico por horas vigente para este lugar.</p>`;
  const umb = E.pron.umbrales.bloques_3h;
  const maxP90 = Math.max(...bl.map((b) => b.p90 || 0));
  const escala = Math.min(30, Math.max(8, Math.ceil(maxP90 / 2) * 2));
  const ahora = Lg.ahoraLocal(Lg.offsetDe(p));
  const pct = (v) => `${Math.min(100, ((v || 0) / escala) * 100).toFixed(1)}%`;
  const cols = bl.map((b, i) => {
    const h = b.ini.getUTCHours();
    const pos = b.en_curso ? ((ahora - b.ini) / (3 * Lg.H)) * 100 : 0;
    const etiqueta = `${Lg.diaRelativo(b.ini, ahora)} de ${Lg.hora(b.ini)} a ${Lg.hora(new Date(b.ini.getTime() + 3 * Lg.H))}: ${Lg.CLASES[b.clase].texto}, mediana ${Lg.num(b.p50)} mm`;
    return `<button type="button" class="hieto-col${h === 0 && i > 0 ? " dia" : ""}${b.en_curso ? " ahora" : ""}" style="--pos:${pos.toFixed(0)}%"
      data-i="${i}" aria-pressed="false" aria-label="${esc(etiqueta)}">
      <span class="p90" style="height:${pct(b.p90)}"></span><span class="p50" style="height:${pct(b.p50)}"></span></button>`;
  }).join("");
  const eje = bl.map((b) => `<span>${b.ini.getUTCHours() % 6 === 0 ? String(b.ini.getUTCHours()).padStart(2, "0") : ""}</span>`).join("");
  // Nombres de día: cada uno ocupa sus columnas.
  const dias = [];
  bl.forEach((b, i) => {
    if (i === 0 || b.ini.getUTCHours() === 0) dias.push({ i, d: b.ini });
  });
  const diasHtml = dias.map((x, k) => {
    const fin = k + 1 < dias.length ? dias[k + 1].i : bl.length;
    const texto = fin - x.i >= 3 ? mayus(Lg.diaRelativo(x.d, ahora)) : "";
    return `<span style="grid-column:${x.i + 1} / ${fin + 1}">${texto}</span>`;
  }).join("");
  const umbrales = [[umb.moderada_mm, "moderada"], [umb.fuerte_mm, "fuerte"]].filter(([v]) => v <= escala)
    .map(([v, t]) => `<div class="hieto-umbral" style="top:${pct(v)}"><span>${t} ${Lg.num(v)}</span></div>`).join("");
  return `<figure class="hieto pronostico-marco" style="--n:${bl.length};margin-left:0;margin-right:0">
    <figcaption class="rotulo">Pronóstico de lluvia cada 3 horas, en mm (barras más largas, más lluvia)</figcaption>
    <div class="hieto-eje" aria-hidden="true">${eje}</div>
    <div class="hieto-cuerpo">${cols}${umbrales}</div>
    <div class="hieto-dias" aria-hidden="true">${diasHtml}</div>
    <div class="hieto-leyenda">
      <span><i style="background:var(--agua)"></i>Lo más probable (mediana)</span>
      <span><i style="background:var(--agua-claro)"></i>Podría llegar a (9 de cada 10 escenarios quedan por debajo)</span>
      <span><span class="ahora-marca">|</span> ahora</span>
    </div>
    <div class="hieto-detalle" aria-live="polite">Toca una barra para ver el detalle de esas 3 horas.</div>
  </figure>`;
}

function activarHietograma(fig, bl) {
  if (!fig) return;
  const detalle = fig.querySelector(".hieto-detalle");
  const ahora = Lg.ahoraLocal(Lg.offsetDe(E.porId[E.lugar] || {}));
  fig.querySelectorAll(".hieto-col").forEach((b) => b.addEventListener("click", () => {
    fig.querySelectorAll(".hieto-col").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const x = bl[+b.dataset.i];
    const fin = new Date(x.ini.getTime() + 3 * Lg.H);
    detalle.innerHTML = `<strong>${mayus(Lg.diaRelativo(x.ini, ahora))}, ${Lg.hora(x.ini)} a ${Lg.hora(fin)}:</strong> ${intensidadHTML(x.clase)}<br>
      Llueve algo en ${Lg.deCada10(x.p_ligera)} escenarios, moderada en ${Lg.deCada10(x.p_moderada)} y fuerte en ${Lg.deCada10(x.p_fuerte)}.
      Lo más probable ${Lg.num(x.p50)} mm; podría llegar a ${Lg.num(x.p90)} mm.`;
  }));
}

function diasHTML(dias) {
  if (!dias.length) return `<p class="nota">Sin pronóstico diario vigente.</p>`;
  const max = Math.max(20, ...dias.map((d) => d.mm.p90 || 0));
  const pct = (v) => `${Math.min(100, ((v || 0) / max) * 100).toFixed(1)}%`;
  return `<ol class="dias">${dias.map((d) => {
    const fecha = Lg.parseLocal(d.fecha);
    const nombre = d.hoy ? "Hoy" : `${Lg.DIAS[fecha.getUTCDay()]} ${fecha.getUTCDate()}`;
    const conf = d.hoy ? "resto del día" : `confianza ${d.confianza}`;
    const tend = d.confianza === "tendencia";
    return `<li class="${tend ? "tendencia" : ""}">
      <span class="fecha">${nombre}<small>${conf}</small></span>
      <span>${nivelHTML(d.nivel, { corto: true })}</span>
      <span class="rango" role="img" aria-label="Lluvia del día entre ${Lg.num(d.mm.p10)} y ${Lg.num(d.mm.p90)} mm, lo más probable ${Lg.num(d.mm.p50)} mm">
        <span class="pista"></span>
        <span class="barra" style="left:${pct(d.mm.p10)};width:calc(${pct(d.mm.p90)} - ${pct(d.mm.p10)})"></span>
        <span class="med" style="left:${pct(d.mm.p50)}"></span>
        <span class="mm">${Lg.num(d.mm.p10, 0)}–${Lg.num(d.mm.p90, 0)} mm</span>
      </span></li>`;
  }).join("")}</ol>`;
}

function tablaBloquesHTML(bl) {
  if (!bl.length) return "";
  const ahora = Lg.ahoraLocal(Lg.offsetDe(E.porId[E.lugar] || {}));
  return `<table class="tabla-bloques"><thead><tr><th>Hora</th><th>Lluvia</th><th>Llueve algo</th><th>mm</th></tr></thead><tbody>
    ${bl.map((b) => `<tr><td>${mayus(Lg.diaRelativo(b.ini, ahora))} ${Lg.hora(b.ini)}</td><td>${intensidadHTML(b.clase, true)}</td>
      <td>${Lg.deCada10(b.p_ligera)}</td><td>${Lg.num(b.p50)}–${Lg.num(b.p90)}</td></tr>`).join("")}</tbody></table>`;
}

function medidoHTML(lat, lon) {
  if (!E.obs || !E.obs.estaciones) return `<p class="rotulo">Lluvia medida</p><p class="nota">La lluvia medida no está disponible ahora.</p>`;
  const vig = E.obs.vigencia_h || 3;
  const cerca = Lg.estacionesCercanas(E.obs.estaciones, lat, lon, 15, vig);
  if (!cerca.length) return `<p class="rotulo">Lluvia medida</p><p class="nota">Ninguna estación con datos de las últimas ${vig} h a menos de 15 km.</p>`;
  const hasta = Lg.horaEcuador(E.obs.generado);
  const [p, ...resto] = cerca;
  const linea = ({ e, km }) => `${esc(e.nombre)}, a ${Lg.num(km, 0)} km; último dato a las ${Lg.horaEcuador(e.ultimo)}`;
  return `<p class="rotulo">Lluvia medida en estaciones del INAMHI</p>
    <p><span class="cifra">${Lg.num(p.e.mm_3h ?? 0)} mm</span> en las 3 h hasta las ${hasta}</p>
    <p class="nota">24 h: ${Lg.num(p.e.mm_24h)} mm. 72 h: ${Lg.num(p.e.mm_72h)} mm. ${linea(p)}.</p>
    ${resto.length ? `<ul>${resto.slice(0, 2).map((x) => `<li>${Lg.num(x.e.mm_3h ?? 0)} mm en 3 h <span class="nota">(${linea(x)})</span></li>`).join("")}</ul>` : ""}
    <p class="nota">La lluvia de varios días seguidos satura el suelo de las laderas.</p>`;
}

// diálogo para agregar lugares
function abrirDialogoLugares() {
  const dlg = $("#dialogo-lugares");
  const input = $("#buscar-lugar");
  input.value = "";
  pintarListaLugares("");
  input.oninput = () => pintarListaLugares(input.value);
  if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  setTimeout(() => input.focus(), 50);
}

function pintarListaLugares(filtro) {
  const q = sinTildes(filtro.trim());
  const coincide = (p) => !q || sinTildes(p.nombre).includes(q) || sinTildes(p.provincia).includes(q);
  const hoy = (p) => Lg.diasVigentes(p)[0];
  const fila = (p) => {
    const es = E.favs.includes(p.id);
    const d = hoy(p);
    return `<div class="fila-lugar">
      <button type="button" class="elegir" data-id="${esc(p.id)}"><span class="nombre">${esc(p.nombre)}</span><small>${esc(p.provincia)}${es ? ", en tu lista" : ""}</small></button>
      ${d ? nivelHTML(d.nivel, { corto: true }) : "<span></span>"}
      ${es ? `<button type="button" class="boton-texto quitar" data-quitar="${esc(p.id)}" aria-label="Quitar ${esc(p.nombre)} de tu lista">Quitar</button>` : "<span></span>"}
    </div>`;
  };
  const principales = E.pron.puntos.filter((p) => p.capital || p.id === "banos");
  const otras = E.pron.puntos.filter((p) => !p.capital && p.id !== "banos");
  let html = "";
  if (!q || sinTildes("mi ubicacion").includes(q)) {
    html += `<div class="fila-lugar"><button type="button" class="elegir" data-id="ubicacion"><span class="nombre">Mi ubicación</span>
      <small>Usa la ubicación del teléfono para elegir el punto más cercano${E.favs.includes("ubicacion") ? ", en tu lista" : ""}</small></button><span></span>
      ${E.favs.includes("ubicacion") ? `<button type="button" class="boton-texto quitar" data-quitar="ubicacion" aria-label="Quitar Mi ubicación de tu lista">Quitar</button>` : "<span></span>"}</div>`;
  }
  for (const [reg, nombre] of Object.entries(REGIONES)) {
    const ps = principales.filter((p) => p.region === reg && coincide(p)).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    if (ps.length) html += `<h3>${nombre}</h3>${ps.map(fila).join("")}`;
  }
  const os = otras.filter(coincide).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  if (os.length) html += `<h3>Otras ciudades</h3>${os.map(fila).join("")}`;
  $("#lista-lugares").innerHTML = html || `<p class="nota">No hay ningún lugar con ese nombre. Prueba con la provincia.</p>`;
  $$("#lista-lugares .elegir").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.id;
    if (!E.favs.includes(id)) E.favs.push(id);
    $("#dialogo-lugares").close();
    if (location.hash !== "#lugares" && location.hash !== "") location.hash = "lugares";
    elegirLugar(id);
  }));
  $$("#lista-lugares [data-quitar]").forEach((b) => b.addEventListener("click", () => {
    E.favs = E.favs.filter((x) => x !== b.dataset.quitar);
    if (!E.favs.length) E.favs = ["quito"];
    actualizarUrl();
    pintarChips();
    pintarListaLugares($("#buscar-lugar").value);
  }));
}

// ------------------------------------------------------------------ viaje

function horariaDisponible() { return E.pron.horaria || {}; }

function prepararViaje() {
  const rutas = E.pron.rutas || [];
  const sel = $("#ruta");
  sel.innerHTML = rutas.map((r) => `<option value="${esc(r.id)}">${esc(r.nombre)}</option>`).join("");
  E.viaje.ruta = rutas.find((r) => r.id === leer("ruta")) || rutas[0];
  if (E.viaje.ruta) sel.value = E.viaje.ruta.id;
  E.viaje.noche = leer("noche") === "1";
  $("#viaje-noche").checked = E.viaje.noche;
  sel.onchange = () => { E.viaje.ruta = rutas.find((r) => r.id === sel.value); guardar("ruta", sel.value); pintarViaje(); };
  $("#viaje-noche").onchange = (ev) => { E.viaje.noche = ev.target.checked; guardar("noche", E.viaje.noche ? "1" : "0"); pintarViaje(); };
  pintarViaje();
}

function pintarViaje() {
  const { ruta } = E.viaje;
  const horaria = horariaDisponible();
  if (!ruta) { $("#viaje-respuesta").innerHTML = "<p>No hay rutas configuradas.</p>"; return; }
  const opciones = { noche: E.viaje.noche };
  const fechas = Lg.fechasDeViaje(ruta, horaria, opciones);
  if (!fechas.length) {
    $("#viaje-fechas").innerHTML = "";
    $("#salidas").innerHTML = "";
    $("#viaje-ruta").innerHTML = "";
    $("#viaje-medido").innerHTML = "";
    $("#viaje-respuesta").innerHTML = `<h2>No hay salidas con pronóstico vigente</h2><p>Activa «Incluir salidas de noche» o vuelve más tarde, cuando se actualice el pronóstico.</p>`;
    return;
  }
  if (!fechas.includes(E.viaje.fecha)) {
    // Si a hoy le quedan pocas salidas (de noche), empezar por el primer día con varias opciones.
    E.viaje.fecha = fechas.find((f) => Lg.salidasDelDia(ruta, horaria, f, opciones).length >= 3) || fechas[0];
  }
  const ahora = Lg.ahoraLocal();
  $("#viaje-fechas").innerHTML = fechas.map((f) => `<button type="button" class="chip" data-fecha="${f}" aria-pressed="${f === E.viaje.fecha}">${mayus(Lg.diaRelativo(Lg.parseLocal(f), ahora))}</button>`).join("");
  $$("#viaje-fechas .chip").forEach((b) => b.addEventListener("click", () => { E.viaje.fecha = b.dataset.fecha; E.viaje.salida = null; pintarViaje(); }));

  const umb = E.pron.umbrales.horaria;
  const cands = Lg.salidasDelDia(ruta, horaria, E.viaje.fecha, opciones);
  const evs = cands.map((t) => Lg.evaluarSalida(ruta, horaria, t, umb));
  let i = cands.findIndex((t) => t.getTime() === E.viaje.salida);
  if (i < 0) { i = cands.findIndex((t) => t.getUTCHours() === 7); if (i < 0) i = 0; }
  E.viaje.salida = cands[i].getTime();
  const ev = evs[i];
  const mejor = ev ? Lg.mejorSalida(ruta, horaria, ev, cands, umb) : null;
  const escala = Math.max(5, ...evs.map((e) => (e ? e.medianaTotal : 0)));
  $("#salidas").innerHTML = cands.map((t, k) => {
    const e = evs[k];
    const alto = e ? Math.max(3, (e.medianaTotal / escala) * 70) : 0;
    const etiqueta = e ? `Salida ${Lg.hora(t)}: ${Lg.num(e.medianaTotal)} mm en la ruta, ${Lg.CLASES[e.peor.clase].texto.toLowerCase()} en el peor tramo` : `Salida ${Lg.hora(t)}: sin datos`;
    const esMejor = mejor && mejor.t.getTime() === t.getTime();
    return `<button type="button" class="salida" role="radio" aria-checked="${k === i}" data-t="${t.getTime()}" tabindex="${k === i ? 0 : -1}" aria-label="${esc(etiqueta)}${esMejor ? ", mejor opción" : ""}">
      <span class="b" style="height:${alto.toFixed(0)}%;background:var(--i${e ? Math.max(1, e.peor.clase) : 0})"></span>
      ${esMejor ? '<span class="mejor">Mejor</span>' : ""}
      <span class="h">${t.getUTCHours() % 2 === 0 || cands.length < 12 ? String(t.getUTCHours()).padStart(2, "0") : ""}</span></button>`;
  }).join("");
  const botones = $$("#salidas .salida");
  botones.forEach((b, k) => {
    b.addEventListener("click", () => { E.viaje.salida = +b.dataset.t; pintarViaje(); });
    b.addEventListener("keydown", (kev) => {
      const d = kev.key === "ArrowRight" ? 1 : kev.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      kev.preventDefault();
      const n = botones[Math.min(botones.length - 1, Math.max(0, k + d))];
      E.viaje.salida = +n.dataset.t; pintarViaje();
      $(`#salidas .salida[data-t="${n.dataset.t}"]`)?.focus();
    });
  });

  if (!ev) { $("#viaje-respuesta").innerHTML = "<p>No hay pronóstico para esa hora.</p>"; return; }
  pintarRespuestaViaje(ruta, ev, mejor);
}

function pintarRespuestaViaje(ruta, ev, mejor) {
  const nombre = (pid) => E.porId[pid]?.nombre || pid;
  const ahora = Lg.ahoraLocal();
  const peor = ev.peor;
  const titulo = peor.clase >= 2
    ? `Lluvia ${peor.clase === 3 ? "fuerte" : "moderada"} probable cerca de ${esc(nombre(peor.punto))}`
    : peor.clase === 1 ? "Lluvia ligera probable en parte del camino" : "Sin lluvia relevante en la ruta";
  const noche = Lg.deNoche(ev.llegada) ? ` <span class="aviso-noche">Llegas de noche</span>` : "";
  const rec = mejor
    ? `Salir a las ${Lg.hora(mejor.t)} tendría menos lluvia en la ruta en ${Lg.deCada10(mejor.frac)} escenarios.`
    : "Sin diferencia clara con otras horas de salida de ese día.";
  $("#viaje-respuesta").innerHTML = `
    <h2>${titulo}</h2>
    <p>Sales ${Lg.diaRelativo(ev.salida, ahora)} a las ${Lg.hora(ev.salida)} y llegas hacia las ${Lg.hora(ev.llegada)}.${noche}</p>
    ${peor.clase >= 2 ? `<p>Lluvia moderada o más en ese tramo en ${Lg.deCada10(peor.pMod)} escenarios.</p>` : ""}
    <p class="recomendacion">${rec}</p>
    <p class="nota">Pronóstico ECMWF IFS ENS, 51 escenarios. Tiempos de viaje aproximados. ${sello()}</p>`;
  $("#viaje-ruta").innerHTML = ev.tramos.map((t) => `
    <li><span class="t">${Lg.hora(t.paso)}</span><span class="parada" style="background:var(--i${t.clase})" aria-hidden="true"></span>
      <span class="nombre">${esc(nombre(t.punto))} ${intensidadHTML(t.clase, true)}</span>
      <span class="det">Llueve algo en ${Lg.deCada10(t.pAlgo)} escenarios; moderada o más en ${Lg.deCada10(t.pMod)}. Lo más probable ${Lg.num(t.mediana)} mm en esa hora.</span></li>`).join("");
  pintarMedidoRuta(ruta);
  pintarViasRuta(ruta);
}

// ------------------------------------------------------------------ estado de las vías y alertas

const ICONO_VIA = { 3: "■", 2: "▲", 1: "◇" };
function estadoViaHTML(v) {
  const g = Lg.gravedadVia(v.estado);
  return `<span class="nivel n${g}"><span class="icono" aria-hidden="true">${ICONO_VIA[g]}</span>${esc(mayus(v.estado.toLowerCase()))}</span>`;
}

function viaHTML(v) {
  const mod = v.modificado ? Lg.parseLocal(v.modificado.slice(0, 16)) : null;
  const alt = (v.alternas || []).filter((a) => a && a !== "N/A");
  return `<li class="via g${Lg.gravedadVia(v.estado)}">
    <div class="via-cab"><span class="via-nombre">${esc(Lg.titulo(v.via))}</span>${estadoViaHTML(v)}</div>
    ${v.observaciones ? `<p>${esc(Lg.oracion(v.observaciones))}</p>` : ""}
    ${alt.length ? `<p class="nota">Vía alterna: ${alt.map((a) => esc(Lg.titulo(a))).join("; ")}</p>` : ""}
    <p class="nota">${esc(Lg.titulo(v.provincia))}${v.canton ? `, ${esc(Lg.titulo(v.canton))}` : ""}${mod ? `. Actualizado ${Lg.diaRelativo(mod, Lg.ahoraLocal())} a las ${Lg.hora(mod)}` : ""}</p>
  </li>`;
}

function pintarViasRuta(ruta) {
  const cont = $("#viaje-vias");
  const enlaceEcu = `<a href="https://www.ecu911.gob.ec/consulta-de-vias/" target="_blank" rel="noopener">consulta de vías del ECU 911</a>`;
  const cfg = ruta.vias;
  let html = `<h2 class="titulo-bloque">Estado de las vías</h2>`;
  if (!E.vias || !Array.isArray(E.vias.vias)) {
    html += `<p class="aviso-vias">No se pudo leer el estado de las vías. Revísalo en la ${enlaceEcu} antes de salir.</p>`;
  } else {
    const edad = Date.now() - new Date(E.vias.generado).getTime();
    const { enRuta, enProvincias } = Lg.viasDeRuta(E.vias.vias, cfg);
    const provs = (cfg?.provincias || []).map((x) => Lg.titulo(x)).join(", ");
    html += `<p class="nota">Según el ECU 911 (incluye reportes del MIT y la SNGR), consultado a las ${Lg.horaEcuador(E.vias.generado)}.</p>`;
    if (edad > 3 * Lg.H) html += `<p class="aviso-vias">Este dato tiene ${Lg.hace(edad).replace("hace ", "")}. Confírmalo en la ${enlaceEcu}.</p>`;
    if (!cfg) {
      html += `<p>Esta ruta todavía no tiene configuradas sus vías. Revisa la ${enlaceEcu}.</p>`;
    } else if (enRuta.length) {
      const cerradas = enRuta.filter((v) => Lg.gravedadVia(v.estado) === 3).length;
      const otras = enRuta.length - cerradas;
      const partes = [];
      if (cerradas) partes.push(`<strong>${cerradas} ${cerradas === 1 ? "vía cerrada" : "vías cerradas"}</strong>`);
      if (otras) partes.push(`${otras} ${otras === 1 ? "vía" : "vías"} con paso restringido`);
      html += `<p class="vias-resumen">En tu ruta: ${partes.join(" y ")}.</p>
        <ul class="vias">${enRuta.map(viaHTML).join("")}</ul>`;
    } else {
      html += `<p class="vias-resumen">Sin novedades reportadas en la vía de tu ruta.</p>`;
    }
    if (cfg && enProvincias.length) {
      html += `<details class="plegable"><summary>Otras ${enProvincias.length} novedades en ${esc(provs)}</summary>
        <ul class="vias">${enProvincias.map(viaHTML).join("")}</ul></details>`;
    }
  }
  html += `<div class="alertas-oficiales"><p class="rotulo">Antes de salir, revisa también</p><ul>
    <li><a href="https://www.ecu911.gob.ec/consulta-de-vias/" target="_blank" rel="noopener">Consulta de vías del ECU 911</a>: estado actualizado y pasos alternos.</li>
    <li><a href="https://www.inamhi.gob.ec/" target="_blank" rel="noopener">Advertencias meteorológicas del INAMHI</a> vigentes.</li>
    <li><a href="https://www.gestionderiesgos.gob.ec/" target="_blank" rel="noopener">Secretaría de Gestión de Riesgos</a>: alertas y emergencias por cantón.</li>
    <li>En una emergencia en la vía, llama al <a href="tel:911">911</a>.</li></ul></div>`;
  cont.innerHTML = html;
}

function pintarMedidoRuta(ruta) {
  const cont = $("#viaje-medido");
  if (!E.obs || !E.obs.estaciones) { cont.innerHTML = `<div class="medido-marco"><p class="rotulo">Lluvia medida</p><p class="nota">No disponible ahora.</p></div>`; return; }
  const vig = E.obs.vigencia_h || 3;
  const filas = ruta.tramos.map((t) => {
    const p = E.porId[t.punto];
    const c = Lg.estacionesCercanas(E.obs.estaciones, p.lat, p.lon, 15, vig);
    if (!c.length) return `<li>${esc(p.nombre)}: <span class="nota">sin estación al día a menos de 15 km</span></li>`;
    const { e, km } = c[0];
    return `<li>${esc(p.nombre)}: <strong>${Lg.num(e.mm_3h ?? 0)} mm</strong> en 3 h, ${Lg.num(e.mm_24h)} mm en 24 h
      <span class="nota">(${esc(e.nombre)}, a ${Lg.num(km, 0)} km, dato de las ${Lg.horaEcuador(e.ultimo)})</span></li>`;
  }).join("");
  cont.innerHTML = `<div class="medido-marco"><p class="rotulo">Lluvia medida en estaciones cercanas, hasta las ${Lg.horaEcuador(E.obs.generado)}</p><ul>${filas}</ul></div>`;
}

// ------------------------------------------------------------------ mapa

const NOMBRE_IZQUIERDA = new Set(["santo-domingo", "latacunga", "santa-elena", "salinas", "loja"]);
// Capitales demasiado juntas a zoom 7 (Guaranda entre Guayaquil y Riobamba): su nombre aparece desde zoom 8.
const NOMBRE_ZOOM_8 = new Set(["guaranda"]);
// Intensidad pronosticada (mm/h): misma familia azul que el hietograma.
const ESCALA_PRON = [
  [0.1, "rgba(169,200,230,0.55)"], [0.5, "rgba(120,170,215,0.65)"], [1, "rgba(63,134,198,0.72)"],
  [2.5, "rgba(42,111,176,0.8)"], [5, "rgba(24,63,115,0.85)"], [7.6, "rgba(84,39,143,0.88)"], [15, "rgba(122,1,119,0.92)"],
];
// Lluvia medida en 3 h (mm): círculos con borde continuo.
const ESCALA_OBS = [[0.1, "#c7e0f4"], [2.5, "#7fb3e0"], [7.5, "#2f78c0"], [15, "#183f73"], [30, "#54278f"]];
const colorDe = (escala, v) => { let c = null; for (const [u, col] of escala) if (v >= u) c = col; return c; };

function prepararMapa() {
  if (E.mapa) { setTimeout(() => E.mapa.invalidateSize(), 50); return; }
  const mapa = L.map("mapa", { zoomControl: true, attributionControl: true }).setView([-1.4, -78.6], 7);
  E.mapa = mapa;
  const base = L.tileLayer("https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg", {
    maxZoom: 13, attribution: 'Sentinel-2 cloudless 2024 by <a href="https://s2maps.eu">EOX</a> (CC BY-NC-SA 4.0)',
  }).addTo(mapa);
  const calles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 13, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  });
  mapa.createPane("ciudades");
  mapa.getPane("ciudades").style.zIndex = 640;
  mapa.getPane("ciudades").style.pointerEvents = "none";
  const ciudades = L.layerGroup().addTo(mapa);
  for (const p of E.pron.puntos) {
    L.marker([p.lat, p.lon], {
      pane: "ciudades", interactive: false, keyboard: false,
      icon: L.divIcon({
        className: `etiqueta-ciudad${p.capital ? " capital" : " secundaria"}${NOMBRE_IZQUIERDA.has(p.id) ? " izquierda" : ""}${NOMBRE_ZOOM_8.has(p.id) ? " desde-8" : ""}`,
        html: `<span class="punto" aria-hidden="true"></span><span class="nombre">${esc(p.nombre)}</span>`,
        iconSize: [8, 8], iconAnchor: [4, 4],
      }),
    }).addTo(ciudades);
  }
  const ajustarEtiquetas = () => {
    mapa.getContainer().classList.toggle("zoom-lejos", mapa.getZoom() < 9);
    mapa.getContainer().classList.toggle("zoom-7", mapa.getZoom() < 8);
  };
  mapa.on("zoomend", ajustarEtiquetas);
  ajustarEtiquetas();
  const goes = L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/default/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png", {
    maxNativeZoom: 7, maxZoom: 13, opacity: 0.85, attribution: "NASA GIBS, GOES-East",
  });
  const imerg = L.tileLayer("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate_30min/default/default/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png", {
    maxNativeZoom: 6, maxZoom: 13, opacity: 0.8, attribution: "NASA GIBS, GPM IMERG",
  });
  const calor = L.layerGroup().addTo(mapa);
  const estaciones = L.layerGroup().addTo(mapa);
  const yo = L.layerGroup().addTo(mapa);
  E.capas = { calor, estaciones, yo, overlay: null, lienzo: null, todas: false };
  L.control.layers({ "Satélite (Sentinel-2)": base, "Calles (OpenStreetMap)": calles }, {
    "Nombres de ciudades": ciudades,
    "Pronóstico de lluvia por hora": calor,
    "Lluvia medida (estaciones)": estaciones,
    "Nubes GOES (hace ~40 min)": goes,
    "Lluvia satelital IMERG (hace ~5–6 h)": imerg,
  }, { collapsed: true }).addTo(mapa);
  controlUbicar().addTo(mapa);
  controlLeyenda().addTo(mapa);

  pintarEstaciones();
  prepararReproductor();
}

function controlUbicar() {
  const C = L.Control.extend({
    options: { position: "topleft" },
    onAdd() {
      const b = L.DomUtil.create("button", "control-ubicar leaflet-bar");
      b.type = "button";
      b.title = "Ubicarme";
      b.setAttribute("aria-label", "Ubicarme en el mapa");
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="8"/></svg>';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, "click", () => ubicarEnMapa(b));
      return b;
    },
  });
  return new C();
}

async function ubicarEnMapa(boton) {
  boton.classList.add("buscando");
  abrirHoja(`<h2 id="hoja-titulo">Buscando tu ubicación…</h2><p class="nota">Tu teléfono te pedirá permiso. La ubicación no sale del teléfono.</p>`);
  try {
    const u = await ubicar();
    const { punto: p, km } = u.cercano;
    E.capas.yo.clearLayers();
    L.circle([u.lat, u.lon], { radius: u.acc, color: "#2A6FB0", weight: 1, fillOpacity: 0.12, interactive: false }).addTo(E.capas.yo);
    L.circleMarker([u.lat, u.lon], { radius: 7, color: "#ffffff", weight: 3, fillColor: "#2A6FB0", fillOpacity: 1, interactive: false }).addTo(E.capas.yo);
    E.mapa.setView([u.lat, u.lon], Math.max(E.mapa.getZoom(), 10));
    const bl = Lg.bloquesVigentes(p, Date.now(), 24);
    const f = Lg.frase(bl, Date.now(), Lg.offsetDe(p));
    const hoy = Lg.diasVigentes(p)[0];
    const prov = E.pron.provincias.find((x) => x.provincia === p.provincia);
    const dProv = prov?.dias.find((d) => hoy && d.fecha === hoy.fecha);
    abrirHoja(`<h2 id="hoja-titulo">Cerca de ${esc(p.nombre)}</h2>
      <p class="nota">Estás a ${Lg.num(km, 0)} km del punto ${esc(p.nombre)} del sistema; su pronóstico describe una zona de ~25 km. Precisión de tu ubicación: ${Lg.num(u.acc, 0)} m.</p>
      <p><strong>${esc(f.texto)}</strong>${f.detalle ? ` (${esc(f.detalle)})` : ""}</p>
      ${hoy ? `<p>Hoy en ${esc(p.nombre)}: ${nivelHTML(hoy.nivel)}${dProv ? ` En la provincia: ${nivelHTML(dProv.nivel, { corto: true })}` : ""}</p>` : ""}
      <div class="medido-marco" style="margin-top:8px">${medidoHTML(u.lat, u.lon)}</div>
      <div class="acciones"><a class="boton" href="#lugares" id="hoja-ver">Ver pronóstico completo</a></div>`);
    $("#hoja-ver").addEventListener("click", () => {
      if (!E.favs.includes("ubicacion")) E.favs.unshift("ubicacion");
      E.lugar = "ubicacion";
      E.pintados.delete("lugares");
    });
  } catch (err) {
    abrirHoja(`<h2 id="hoja-titulo">${esc(err.texto)}</h2>${err.ayuda || ""}
      <div class="acciones"><button class="boton" type="button" id="hoja-reintentar">Volver a intentar</button></div>`);
    $("#hoja-reintentar").addEventListener("click", () => ubicarEnMapa(boton));
  } finally {
    boton.classList.remove("buscando");
  }
}

function abrirHoja(html) {
  const h = $("#hoja");
  h.innerHTML = `<button type="button" class="cerrar" aria-label="Cerrar">×</button>${html}`;
  h.hidden = false;
  h.querySelector(".cerrar").addEventListener("click", () => { h.hidden = true; });
}

function controlLeyenda() {
  const C = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd() {
      const d = L.DomUtil.create("details", "leyenda-mapa");
      if (window.innerWidth > 700) d.open = true;
      d.innerHTML = `<summary>Leyenda</summary><div class="cuerpo">
        <div><span class="trazo"></span>Pronóstico, mm por hora (rejilla de ~25 km)</div>
        <div class="escala">${ESCALA_PRON.map(([, c]) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="valores"><span>0,1</span><span>1</span><span>5</span><span>15+</span></div>
        <div style="margin-top:8px"><span class="trazo solido"></span>Medido, mm en las últimas 3 h</div>
        <div class="escala">${ESCALA_OBS.map(([, c]) => `<span style="background:${c}"></span>`).join("")}</div>
        <div class="valores"><span>0,1</span><span>7,5</span><span>30+</span></div>
        <label><input type="checkbox" id="todas-estaciones"> Ver todas las estaciones (también sin lluvia o atrasadas)</label>
      </div>`;
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      d.querySelector("#todas-estaciones").addEventListener("change", (ev) => { E.capas.todas = ev.target.checked; pintarEstaciones(); });
      return d;
    },
  });
  return new C();
}

function pintarEstaciones() {
  const grupo = E.capas.estaciones;
  grupo.clearLayers();
  const vig = E.obs?.vigencia_h || 3;
  for (const e of E.obs?.estaciones || []) {
    const fresca = Lg.alDia(e, vig);
    const llueve = fresca && (e.mm_3h ?? 0) >= 0.1;
    if (!E.capas.todas && !llueve) continue;
    const estilo = !fresca
      ? { radius: 5, weight: 1.5, color: "#9AA79B", dashArray: "2 2", fillOpacity: 0 }
      : llueve
        ? { radius: 7, weight: 2, color: "#ffffff", fillColor: colorDe(ESCALA_OBS, e.mm_3h), fillOpacity: 0.95 }
        : { radius: 4, weight: 1, color: "#ffffff", fillColor: "#6E7C72", fillOpacity: 0.8 };
    L.circleMarker([e.lat, e.lon], estilo)
      .bindPopup(`<div class="popup-estacion"><strong>${esc(e.nombre)}</strong><br>${esc(e.codigo)}, ${esc(e.propietario || "")}<br>
        Medido. Último dato a las ${Lg.horaEcuador(e.ultimo)} (${Lg.hace(Date.now() - new Date(e.ultimo).getTime())})${fresca ? "" : ", <strong>atrasada</strong>"}<br>
        Última hora: ${Lg.num(e.mm_1h)} mm. 3 h: ${Lg.num(e.mm_3h)} mm.<br>24 h: ${Lg.num(e.mm_24h)} mm. 72 h: ${Lg.num(e.mm_72h)} mm.</div>`)
      .addTo(grupo);
  }
}

function prepararReproductor() {
  const slider = $("#hora-mapa"), texto = $("#hora-mapa-texto"), play = $("#play");
  const c = E.calor;
  if (!c || !c.tiempos?.length) {
    texto.textContent = "El mapa de pronóstico no está disponible ahora.";
    slider.disabled = true; play.disabled = true;
    return;
  }
  const inicio = Lg.indiceCalorAhora(c);
  if (inicio >= c.tiempos.length) {
    texto.textContent = "El mapa de pronóstico venció; se actualizará en la próxima corrida.";
    slider.disabled = true; play.disabled = true;
    return;
  }
  slider.min = inicio; slider.max = c.tiempos.length - 1; slider.value = inicio;
  // Marcas de día bajo la pista.
  const span = Math.max(1, c.tiempos.length - 1 - inicio);
  const marcas = [];
  for (let i = inicio; i < c.tiempos.length; i++) {
    const ini = new Date(Lg.parseLocal(c.tiempos[i]).getTime() - Lg.H);
    if (ini.getUTCHours() === 0) marcas.push(`<span style="left:${(((i - inicio) / span) * 100).toFixed(1)}%">${Lg.diaCorto(ini)}</span>`);
  }
  $("#marcas-dia").innerHTML = marcas.join("");
  // Un solo lienzo y una sola capa; se redibuja por cuadro sin crear capas nuevas.
  // Rejilla en un lienzo pequeño y, ampliada 8 veces con interpolación, en el que se muestra (calor suavizado).
  const rejilla = document.createElement("canvas");
  rejilla.width = c.lons.length; rejilla.height = c.lats.length;
  const lienzo = document.createElement("canvas");
  lienzo.width = c.lons.length * 8; lienzo.height = c.lats.length * 8;
  E.capas.rejilla = rejilla;
  E.capas.lienzo = lienzo;
  const limites = [[c.lats[c.lats.length - 1] - c.paso / 2, c.lons[0] - c.paso / 2], [c.lats[0] + c.paso / 2, c.lons[c.lons.length - 1] + c.paso / 2]];
  dibujarCalor(inicio);
  E.capas.overlay = L.imageOverlay(lienzo.toDataURL(), limites, { opacity: 1, interactive: false, className: "capa-calor" }).addTo(E.capas.calor);
  let pendiente = null;
  slider.addEventListener("input", () => {
    if (pendiente) return;
    pendiente = requestAnimationFrame(() => { pendiente = null; irAHora(+slider.value); });
  });
  play.addEventListener("click", () => (E.reproduciendo ? detenerReproduccion() : reproducir()));
  irAHora(inicio);
}

function dibujarCalor(i) {
  const c = E.calor, rejilla = E.capas.rejilla, ctx = rejilla.getContext("2d");
  ctx.clearRect(0, 0, rejilla.width, rejilla.height);
  const vals = c.valores_dmm[i];
  for (let f = 0; f < c.lats.length; f++) {
    for (let k = 0; k < c.lons.length; k++) {
      const v = vals[f * c.lons.length + k];
      const col = v == null ? null : colorDe(ESCALA_PRON, v / 10);
      if (col) { ctx.fillStyle = col; ctx.fillRect(k, f, 1, 1); }
    }
  }
  const grande = E.capas.lienzo, g = grande.getContext("2d");
  g.clearRect(0, 0, grande.width, grande.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(rejilla, 0, 0, grande.width, grande.height);
}

function irAHora(i) {
  const c = E.calor;
  E.calorIdx = i;
  dibujarCalor(i);
  if (E.capas.overlay) E.capas.overlay.setUrl(E.capas.lienzo.toDataURL());
  $("#hora-mapa").value = i;
  const fin = Lg.parseLocal(c.tiempos[i]);
  const ini = new Date(fin.getTime() - Lg.H);
  $("#hora-mapa-texto").textContent = `Pronóstico de ${Lg.diaRelativo(ini, Lg.ahoraLocal())}, ${Lg.hora(ini)} a ${Lg.hora(fin)} (ECMWF 9 km)`;
}

function reproducir() {
  const slider = $("#hora-mapa");
  $("#play").setAttribute("aria-pressed", "true");
  $("#play").setAttribute("aria-label", "Pausar");
  E.reproduciendo = setInterval(() => {
    let i = +slider.value + 1;
    if (i > +slider.max) i = +slider.min;
    irAHora(i);
  }, 700);
}

function detenerReproduccion() {
  if (!E.reproduciendo) return;
  clearInterval(E.reproduciendo);
  E.reproduciendo = null;
  $("#play").setAttribute("aria-pressed", "false");
  $("#play").setAttribute("aria-label", "Reproducir las próximas horas");
}

// ------------------------------------------------------------------ provincias

function viasDeProvincia(nombre) {
  if (!E.vias || !Array.isArray(E.vias.vias)) return [];
  E.viasProv ||= Lg.viasPorProvincia(E.vias.vias);
  return E.viasProv[Lg.palabras(nombre)] || [];
}
function textoViasProvincia(nombre) {
  const vs = viasDeProvincia(nombre);
  if (!vs.length) return "";
  const c = vs.filter((v) => Lg.gravedadVia(v.estado) === 3).length;
  return `. ${vs.length} ${vs.length === 1 ? "vía" : "vías"} con novedades${c ? ` (${c} ${c === 1 ? "cerrada" : "cerradas"})` : ""}`;
}
function listaViasProvincia(nombre) {
  const vs = viasDeProvincia(nombre).sort((a, b) => Lg.gravedadVia(b.estado) - Lg.gravedadVia(a.estado));
  if (!vs.length) return "";
  return `<li class="prov-vias"><details><summary>Vías con novedades (ECU 911)</summary><ul class="vias">${vs.map(viaHTML).join("")}</ul></details></li>`;
}

function pintarProvincias() {
  const p = E.pron;
  const hoy = Lg.fechaISO(Lg.ahoraLocal());
  const fechas = p.provincias[0].dias.map((d) => d.fecha).filter((f) => f >= hoy);
  if (!fechas.includes(E.provFecha)) E.provFecha = fechas[0];
  const ahora = Lg.ahoraLocal();
  $("#prov-fechas").innerHTML = fechas.map((f) => `<button type="button" class="chip" data-fecha="${f}" aria-pressed="${f === E.provFecha}">${mayus(Lg.diaRelativo(Lg.parseLocal(f), ahora))}</button>`).join("");
  $$("#prov-fechas .chip").forEach((b) => b.addEventListener("click", () => { E.provFecha = b.dataset.fecha; pintarProvincias(); }));

  const filas = p.provincias.map((pr) => ({ pr, d: pr.dias.find((x) => x.fecha === E.provFecha) })).filter((x) => x.d)
    .sort((a, b) => b.d.nivel - a.d.nivel || b.d.puntos_afectados / b.d.puntos_total - a.d.puntos_afectados / a.d.puntos_total || a.pr.provincia.localeCompare(b.pr.provincia, "es"));
  $("#prov-lista").innerHTML = filas.map(({ pr, d }, k) => `<li>
    <button type="button" class="prov-fila" aria-expanded="false" aria-controls="prov-${k}">
      <span class="nombre">${esc(pr.provincia)}</span>
      ${nivelHTML(d.nivel, { corto: true, extra: d.confianza === "tendencia" ? "tendencia" : "" })}
      <span class="cuantos">${d.nivel > 0 ? `En ${d.puntos_afectados} de ${d.puntos_total} puntos` : `${d.puntos_total} puntos`}, confianza ${d.confianza}${textoViasProvincia(pr.provincia)}</span>
    </button>
    <ul class="prov-puntos" id="prov-${k}" hidden>${listaViasProvincia(pr.provincia)}${pr.puntos.map((id) => {
      const pt = E.porId[id];
      const dd = pt.dias.find((x) => x.fecha === E.provFecha);
      return `<li><span>${esc(pt.nombre)} ${dd ? nivelHTML(dd.nivel, { corto: true }) : ""}
        <span class="nota">${dd ? `${Lg.num(dd.mm.p10, 0)}–${Lg.num(dd.mm.p90, 0)} mm` : ""}</span></span>
        <button type="button" class="boton-texto" data-ver="${esc(id)}">Ver lugar</button></li>`;
    }).join("")}</ul></li>`).join("");
  $$("#prov-lista .prov-fila").forEach((b) => b.addEventListener("click", () => {
    const lista = $(`#${b.getAttribute("aria-controls")}`);
    const abrir = lista.hidden;
    lista.hidden = !abrir;
    b.setAttribute("aria-expanded", String(abrir));
  }));
  $$("#prov-lista [data-ver]").forEach((b) => b.addEventListener("click", () => {
    E.lugar = b.dataset.ver;
    E.pintados.delete("lugares");
    location.hash = "lugares";
  }));

  const cab = `<thead><tr><th>Provincia</th>${fechas.map((f) => `<th>${mayus(Lg.diaRelativo(Lg.parseLocal(f), ahora))}</th>`).join("")}</tr></thead>`;
  const cuerpo = p.provincias.map((pr) => `<tr><td>${esc(pr.provincia)}</td>${fechas.map((f) => {
    const d = pr.dias.find((x) => x.fecha === f);
    if (!d) return "<td></td>";
    const n = p.niveles[d.nivel];
    return `<td><span class="nivel n${d.nivel} ${d.confianza === "tendencia" ? "tendencia" : ""}" title="${esc(n.texto)}"><span aria-hidden="true">${n.icono}</span>${d.nivel > 0 ? ` ${d.puntos_afectados}/${d.puntos_total}` : ""}<span class="visualmente-oculto">${esc(n.texto)}</span></span></td>`;
  }).join("")}</tr>`).join("");
  const t = $("#tabla-provincias");
  t.className = "tabla-prov";
  t.innerHTML = cab + `<tbody>${cuerpo}</tbody>`;
}

// ------------------------------------------------------------------ uso sin conexión

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => { navigator.serviceWorker.register(`sw.js?v=${VERSION}`).catch(() => {}); });
}

iniciar();
