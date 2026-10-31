/* Lluvias Ecuador — lógica pura (sin DOM). La usan app.js en el navegador y las pruebas en Node.
 *
 * Convención de tiempos: los JSON traen la hora LOCAL de cada punto sin zona ("2026-10-30T15:00").
 * Se manejan como objetos Date cuyos campos UTC son la hora local (parseLocal), y "ahora" se lleva a esa
 * misma convención con el desfase del punto (utc_offset_s: -18000 continente, -21600 Galápagos).
 */
(function (raiz, fabrica) {
  const L = fabrica();
  if (typeof module === "object" && module.exports) module.exports = L;
  else raiz.Logica = L;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const H = 3600000;
  const OFFSET_CONTINENTE = -18000;
  const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const DIAS_LARGOS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const CLASES = [
    { texto: "Sin lluvia relevante", corto: "Seco", icono: "○" },
    { texto: "Lluvia ligera", corto: "Ligera", icono: "◇" },
    { texto: "Lluvia moderada", corto: "Moderada", icono: "▲" },
    { texto: "Lluvia fuerte", corto: "Fuerte", icono: "■" },
  ];
  // Límites de Ecuador con Galápagos, con margen de ~20 km.
  const ECUADOR = { latMin: -5.2, latMax: 1.65, lonMin: -92.2, lonMax: -75.0 };

  // ------------------------------------------------------------ tiempo local

  function parseLocal(s) {
    const [d, t = "00:00"] = String(s).slice(0, 16).split("T");
    const [y, m, dd] = d.split("-").map(Number);
    const [hh, mi] = t.split(":").map(Number);
    return new Date(Date.UTC(y, m - 1, dd, hh, mi));
  }
  const fmtLocal = (d) => d.toISOString().slice(0, 16);
  const fechaISO = (d) => d.toISOString().slice(0, 10);
  const hora = (d) => d.toISOString().slice(11, 16);
  /** "Ahora" en la hora local de un punto, con la misma convención que parseLocal. */
  const ahoraLocal = (offsetS = OFFSET_CONTINENTE, ahoraMs = Date.now()) => new Date(ahoraMs + offsetS * 1000);
  const offsetDe = (p) => (p && typeof p.utc_offset_s === "number" ? p.utc_offset_s : OFFSET_CONTINENTE);

  /** "hoy", "mañana" o "vie 31" relativo al día local de `ref`. */
  function diaRelativo(d, ref) {
    const dif = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
      Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate())) / (24 * H));
    if (dif === 0) return "hoy";
    if (dif === 1) return "mañana";
    return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`;
  }
  const diaCorto = (d) => `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`;
  const diaLargo = (d) => `${DIAS_LARGOS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;

  // ------------------------------------------------------------ números (formato de Ecuador: 1.234,5)

  const formatos = {};
  function num(x, dec = 1) {
    if (x == null || Number.isNaN(x)) return "—";
    const f = formatos[dec] || (formatos[dec] = new Intl.NumberFormat("es-EC", { maximumFractionDigits: dec, minimumFractionDigits: 0 }));
    return f.format(x);
  }
  const deCada10 = (p) => (p == null ? "—" : `${Math.round(p * 10)} de cada 10`);

  /** "hace 40 min", "hace 2 h 10 min", "hace 26 h". */
  function hace(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return "hace menos de 1 min";
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60), r = min % 60;
    if (h >= 10 || r === 0) return `hace ${h} h`;
    return `hace ${h} h ${r} min`;
  }

  // ------------------------------------------------------------ pronóstico por lugar

  /** Bloques de 3 h que aún no terminan, con `en_curso` según la hora real (no la de cálculo). */
  function bloquesVigentes(punto, ahoraMs = Date.now(), horas = 72) {
    const ahora = ahoraLocal(offsetDe(punto), ahoraMs);
    const limite = ahora.getTime() + horas * H;
    return (punto.bloques || [])
      .map((b) => ({ ...b, ini: parseLocal(b.inicio) }))
      .filter((b) => b.ini.getTime() + 3 * H > ahora.getTime() && b.ini.getTime() < limite)
      .map((b) => ({ ...b, en_curso: b.ini <= ahora }));
  }

  /** Días de hoy en adelante (el pronóstico puede haberse calculado ayer en la noche). */
  function diasVigentes(punto, ahoraMs = Date.now()) {
    const hoy = fechaISO(ahoraLocal(offsetDe(punto), ahoraMs));
    return (punto.dias || []).filter((d) => d.fecha >= hoy).map((d) => ({ ...d, hoy: d.fecha === hoy }));
  }

  /** Frase de respuesta para las próximas `horas`: la primera racha de lluvia relevante, o que no la hay. */
  function frase(bloques, ahoraMs = Date.now(), offsetS = OFFSET_CONTINENTE, horas = 24) {
    const ahora = ahoraLocal(offsetS, ahoraMs);
    const ventana = bloques.filter((b) => b.ini.getTime() < ahora.getTime() + horas * H);
    if (!ventana.length) return { clase: null, texto: "Sin pronóstico para las próximas horas." };
    const i = ventana.findIndex((b) => b.clase >= 1);
    if (i < 0) {
      return { clase: 0, texto: `Sin lluvia relevante en las próximas ${horas} h.` };
    }
    let j = i;
    while (j + 1 < ventana.length && ventana[j + 1].clase >= 1) j++;
    const racha = ventana.slice(i, j + 1);
    const max = racha.reduce((a, b) => Math.max(a, b.clase), 0);
    const pico = racha.find((b) => b.clase === max);
    const prob = max === 3 ? pico.p_fuerte : max === 2 ? pico.p_moderada : pico.p_ligera;
    const inicio = ventana[i].ini, fin = new Date(ventana[j].ini.getTime() + 3 * H);
    const cuando = ventana[i].en_curso
      ? `ahora y hasta las ${hora(fin)}`
      : `${diaRelativo(inicio, ahora) === "hoy" ? "" : diaRelativo(inicio, ahora) + " "}desde las ${hora(inicio)} hasta las ${hora(fin)}`;
    return {
      clase: max,
      texto: `${CLASES[max].texto} probable ${cuando}`,
      detalle: `${deCada10(prob)} escenarios`,
      inicio, fin,
    };
  }

  // ------------------------------------------------------------ distancia y ubicación

  function distanciaKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Punto del sistema más cercano (opción B de Ubicarme: nada sale del teléfono). */
  function masCercano(puntos, lat, lon) {
    let mejor = null;
    for (const p of puntos) {
      const d = distanciaKm({ lat, lon }, p);
      if (!mejor || d < mejor.km) mejor = { punto: p, km: d };
    }
    return mejor;
  }

  const dentroEcuador = (lat, lon) =>
    lat >= ECUADOR.latMin && lat <= ECUADOR.latMax && lon >= ECUADOR.lonMin && lon <= ECUADOR.lonMax;

  // ------------------------------------------------------------ estaciones

  /** Horas desde el último dato, contadas con el reloj real (el JSON puede tener horas). */
  const retrasoH = (e, ahoraMs = Date.now()) => (ahoraMs - new Date(e.ultimo).getTime()) / H;

  function alDia(e, vigenciaH = 3, ahoraMs = Date.now()) {
    return e.ultimo != null && retrasoH(e, ahoraMs) <= vigenciaH;
  }

  /** Estaciones al día a menos de `km`, de la más cercana a la más lejana. */
  function estacionesCercanas(estaciones, lat, lon, km = 15, vigenciaH = 3, ahoraMs = Date.now()) {
    return (estaciones || [])
      .filter((e) => alDia(e, vigenciaH, ahoraMs))
      .map((e) => ({ e, km: distanciaKm({ lat, lon }, e) }))
      .filter((x) => x.km <= km)
      .sort((a, b) => a.km - b.km);
  }

  // ------------------------------------------------------------ viaje

  function indiceHora(serie, t) {
    for (let i = 0; i < serie.tiempos.length; i++) {
      const fin = parseLocal(serie.tiempos[i]);
      if (t < fin && t.getTime() >= fin.getTime() - H) return i;
    }
    return -1;
  }

  function mediana(xs) {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b), n = v.length;
    return n ? (n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2) : null;
  }

  /** Lluvia en cada tramo a la hora de paso, para una salida (hora local). */
  function evaluarSalida(ruta, horaria, salida, umb) {
    const tramos = [];
    let totales = null;
    for (const t of ruta.tramos) {
      const serie = horaria[t.punto];
      const paso = new Date(salida.getTime() + t.min * 60000);
      const i = serie ? indiceHora(serie, paso) : -1;
      if (i < 0) return null;
      const mm = serie.miembros_dmm.map((m) => (m[i] == null ? null : m[i] / 10)).filter((v) => v != null);
      if (!mm.length) return null;
      totales = totales || mm.map(() => 0);
      mm.forEach((v, k) => { if (k < totales.length) totales[k] += v; });
      const frac = (u) => mm.filter((v) => v >= u).length / mm.length;
      const pAlgo = frac(0.2), pMod = frac(umb.moderada_mm_h), pFue = frac(umb.fuerte_mm_h);
      const clase = pFue >= 0.3 ? 3 : pMod >= 0.5 ? 2 : pAlgo >= 0.5 ? 1 : 0;
      tramos.push({ punto: t.punto, min: t.min, paso, pAlgo, pMod, pFue, clase, mediana: mediana(mm) });
    }
    const peor = tramos.reduce((a, b) => (b.clase > a.clase ? b : a), tramos[0]);
    return { salida, llegada: tramos[tramos.length - 1].paso, tramos, totales, peor, medianaTotal: mediana(totales) };
  }

  /** Salidas posibles de un día (hora local de la ruta): de 05:00 a 20:00, o todo el día con `noche`. */
  function salidasDelDia(ruta, horaria, fecha, { noche = false } = {}, ahoraMs = Date.now(), offsetS = OFFSET_CONTINENTE) {
    const serie = horaria[ruta.tramos[0].punto];
    const ultima = horaria[ruta.tramos[ruta.tramos.length - 1].punto];
    if (!serie || !ultima) return [];
    const dur = ruta.tramos[ruta.tramos.length - 1].min * 60000;
    const primeraHora = parseLocal(serie.tiempos[0]).getTime() - H;
    const finSerie = parseLocal(ultima.tiempos[ultima.tiempos.length - 1]).getTime();
    const ahora = ahoraLocal(offsetS, ahoraMs).getTime();
    const base = parseLocal(fecha + "T00:00").getTime();
    const [desde, hasta] = noche ? [0, 23] : [5, 20];
    const out = [];
    for (let h = desde; h <= hasta; h++) {
      const t = base + h * H;
      if (t < ahora - 15 * 60000) continue; // ya pasó (se admite la hora en curso hasta 15 min tarde)
      if (t < primeraHora || t + dur >= finSerie) continue;
      out.push(new Date(t));
    }
    return out;
  }

  /** Fechas (AAAA-MM-DD) que tienen al menos una salida posible. */
  function fechasDeViaje(ruta, horaria, opciones, ahoraMs = Date.now(), offsetS = OFFSET_CONTINENTE) {
    const hoy = ahoraLocal(offsetS, ahoraMs);
    const out = [];
    for (let d = 0; d < 5; d++) {
      const f = fechaISO(new Date(hoy.getTime() + d * 24 * H));
      if (salidasDelDia(ruta, horaria, f, opciones, ahoraMs, offsetS).length) out.push(f);
    }
    return out;
  }

  /** Otra salida más seca que `ev` en al menos `regla` de los escenarios; null si ninguna lo es claramente. */
  function mejorSalida(ruta, horaria, ev, candidatas, umb, regla = 0.75) {
    let mejor = null;
    for (const t of candidatas) {
      if (t.getTime() === ev.salida.getTime()) continue;
      const e = evaluarSalida(ruta, horaria, t, umb);
      if (!e) continue;
      const n = Math.min(e.totales.length, ev.totales.length);
      let masSeca = 0;
      for (let k = 0; k < n; k++) if (e.totales[k] + 0.5 < ev.totales[k]) masSeca++;
      const frac = masSeca / n;
      if (frac >= regla && (!mejor || frac > mejor.frac || (frac === mejor.frac && e.medianaTotal < mejor.ev.medianaTotal))) {
        mejor = { t, ev: e, frac };
      }
    }
    return mejor;
  }

  const deNoche = (d) => d.getUTCHours() >= 19 || d.getUTCHours() < 6;

  // ------------------------------------------------------------ mapa de calor

  /** Primer índice cuya hora aún no termina (los tiempos del calor marcan el fin de cada hora, UTC-5). */
  function indiceCalorAhora(calor, ahoraMs = Date.now()) {
    const ahora = ahoraLocal(OFFSET_CONTINENTE, ahoraMs);
    const i = calor.tiempos.findIndex((t) => parseLocal(t) > ahora);
    return i < 0 ? calor.tiempos.length : i;
  }

  // ------------------------------------------------------------ frescura

  /** Qué tan nuevos son los datos, en frases que dicen a qué se refiere cada hora. */
  function frescura(pron, obs, calor, ahoraMs = Date.now()) {
    const items = [];
    let atrasado = false;
    if (pron) {
      const ms = ahoraMs - new Date(pron.generado).getTime();
      items.push({ clave: "pronostico", texto: `Pronóstico calculado a las ${horaEcuador(pron.generado)} (${hace(ms)})` });
      if (ms > 12 * H) atrasado = true;
      const caidos = Object.values(pron.modelos || {}).filter((m) => m.estado !== "ok").map((m) => m.nombre);
      if (caidos.length) { items.push({ clave: "modelos", texto: `Sin ${caidos.join(" ni ")}: se calculó con el resto de modelos` }); atrasado = true; }
    }
    if (obs && obs.estaciones && obs.estaciones.length) {
      const vig = obs.vigencia_h || 3;
      const ult = Math.max(...obs.estaciones.map((e) => new Date(e.ultimo).getTime()));
      const n = obs.estaciones.filter((e) => alDia(e, vig, ahoraMs)).length;
      items.push({ clave: "estaciones", texto: `Lluvia medida: último dato a las ${horaEcuador(new Date(ult).toISOString())} (${hace(ahoraMs - ult)}); ${n} de ${obs.estaciones.length} estaciones al día` });
      if (ahoraMs - ult > 3 * H) atrasado = true;
    } else {
      items.push({ clave: "estaciones", texto: "Lluvia medida no disponible ahora" });
    }
    if (calor) items.push({ clave: "calor", texto: `Mapa de lluvia por hora calculado a las ${horaEcuador(calor.generado)}` });
    const corto = pron ? `Datos de las ${horaEcuador(pron.generado)}` : "Sin datos";
    return { corto, atrasado, items };
  }

  /** Hora de Ecuador continental (HH:MM) de un instante ISO con zona. */
  function horaEcuador(iso) {
    return hora(ahoraLocal(OFFSET_CONTINENTE, new Date(iso).getTime()));
  }

  // ------------------------------------------------------------ favoritos

  const FAVORITOS_INICIALES = ["ubicacion", "quito", "banos"];

  /** Favoritos desde la URL (?l=a,b) o, si no, del teléfono; solo ids válidos, sin repetir. */
  function leerFavoritos(busqueda, guardado, idsValidos) {
    const validos = new Set([...idsValidos, "ubicacion"]);
    const deUrl = new URLSearchParams(busqueda || "").get("l");
    const fuente = deUrl != null ? deUrl.split(",") : guardado ? guardado.split(",") : FAVORITOS_INICIALES;
    const out = [];
    for (const id of fuente.map((x) => x.trim()).filter(Boolean)) if (validos.has(id) && !out.includes(id)) out.push(id);
    return out.length ? out : FAVORITOS_INICIALES.filter((x) => validos.has(x));
  }

  // ------------------------------------------------------------ estado de vías (ECU 911)

  const normal = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const palabras = (t) => normal(t).replace(/[^A-Z0-9]+/g, " ").trim();

  /** 3 cerrada, 2 parcialmente habilitada, 1 con restricción u otra novedad. */
  function gravedadVia(estado) {
    const e = normal(estado);
    if (e.startsWith("CERRADA")) return 3;
    if (e.includes("PARCIAL")) return 2;
    return 1;
  }

  /** Vías del ECU 911 que tocan la ruta (por nombre) y las demás novedades en las provincias que cruza. */
  function viasDeRuta(vias, cfg) {
    if (!cfg) return { enRuta: [], enProvincias: [] };
    const provs = new Set((cfg.provincias || []).map(palabras));
    const locs = (cfg.localidades || []).map(palabras);
    const codigos = (cfg.carreteras || []).map((c) => palabras(c).replace(/ /g, ""));
    const tieneCodigo = (texto) => {
      const t = ` ${palabras(texto).replace(/\bE (\d)/g, "E$1")} `;
      return codigos.some((c) => t.includes(` ${c} `));
    };
    const enRuta = [], enProvincias = [];
    for (const v of vias || []) {
      const nombre = ` ${palabras(v.via)} `;
      const n = locs.filter((l) => nombre.includes(` ${l} `)).length;
      const prov = provs.has(palabras(v.provincia));
      const deRuta = (prov || n >= 2) && (n >= 2 || tieneCodigo(`${v.via} ${v.observaciones}`));
      if (deRuta) enRuta.push(v);
      else if (prov) enProvincias.push(v);
    }
    const orden = (a, b) => gravedadVia(b.estado) - gravedadVia(a.estado) || String(b.modificado).localeCompare(String(a.modificado));
    return { enRuta: enRuta.sort(orden), enProvincias: enProvincias.sort(orden) };
  }

  /** Novedades por provincia (nombre normalizado -> vías), para la pestaña Provincias. */
  function viasPorProvincia(vias) {
    const out = {};
    for (const v of vias || []) (out[palabras(v.provincia)] ||= []).push(v);
    return out;
  }

  /** "SECTOR SACRE Y KM. 61" -> "Sector sacre y km. 61": el ECU 911 publica todo en mayúsculas. */
  function oracion(t) {
    const s = String(t || "").trim().toLowerCase();
    return s.replace(/(^|[.!?/]\s*)([a-záéíóúñü])/g, (m, a, c) => a + c.toUpperCase());
  }
  /** "CUENCA - GIRON -PASAJE" -> "Cuenca - Giron - Pasaje". */
  function titulo(t) {
    return String(t || "").trim().toLowerCase().replace(/\s*-\s*/g, " - ")
      .replace(/(^|[\s(-])([a-záéíóúñü])/g, (m, a, c) => a + c.toUpperCase())
      .replace(/\b(Km|Via|Vía|Y|De|Del|La|Las|El|Los|A)\b/g, (w, _x, i) => (i === 0 ? w : w.toLowerCase()))
      .replace(/\bE(\d+)\b/gi, "E$1");
  }

  return {
    normal, palabras, gravedadVia, viasDeRuta, viasPorProvincia, oracion, titulo,
    H, CLASES, DIAS, MESES, ECUADOR,
    parseLocal, fmtLocal, fechaISO, hora, ahoraLocal, offsetDe, diaRelativo, diaCorto, diaLargo,
    num, deCada10, hace,
    bloquesVigentes, diasVigentes, frase,
    distanciaKm, masCercano, dentroEcuador,
    retrasoH, alDia, estacionesCercanas,
    indiceHora, mediana, evaluarSalida, salidasDelDia, fechasDeViaje, mejorSalida, deNoche,
    indiceCalorAhora, frescura, horaEcuador,
    FAVORITOS_INICIALES, leerFavoritos,
  };
});
