// Pruebas de site/logica.js (node --test tests/). Sin red ni navegador.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../site/logica.js");

// 30 oct 2026, 19:40 en Ecuador continental (UTC-5) = 00:40 UTC del 31.
const AHORA = Date.UTC(2026, 9, 31, 0, 40);

function puntoCon(bloques, offset = -18000) {
  return { id: "x", utc_offset_s: offset, bloques, dias: [
    { fecha: "2026-10-29", nivel: 0 }, { fecha: "2026-10-30", nivel: 1 }, { fecha: "2026-10-31", nivel: 2 }] };
}
const bloque = (inicio, clase, extra = {}) => ({ inicio, clase, p_ligera: 0.8, p_moderada: 0.6, p_fuerte: 0.1, p50: 1, p90: 3, ...extra });

test("no muestra bloques ya terminados y marca el bloque en curso con el reloj real", () => {
  const p = puntoCon([bloque("2026-10-30T15:00", 2), bloque("2026-10-30T18:00", 0), bloque("2026-10-30T21:00", 1)]);
  const b = L.bloquesVigentes(p, AHORA);
  assert.deepEqual(b.map((x) => x.inicio), ["2026-10-30T18:00", "2026-10-30T21:00"]);
  assert.equal(b[0].en_curso, true);
  assert.equal(b[1].en_curso, false);
});

test("Galápagos usa su hora (UTC-6): a las 19:40 de Quito allá son las 18:40", () => {
  const p = puntoCon([bloque("2026-10-30T15:00", 0), bloque("2026-10-30T18:00", 0)], -21600);
  const b = L.bloquesVigentes(p, AHORA);
  assert.equal(b[0].inicio, "2026-10-30T18:00");
  assert.equal(L.hora(L.ahoraLocal(-21600, AHORA)), "18:40");
});

test("días: descarta los que ya pasaron y marca hoy", () => {
  const d = L.diasVigentes(puntoCon([]), AHORA);
  assert.deepEqual(d.map((x) => x.fecha), ["2026-10-30", "2026-10-31"]);
  assert.equal(d[0].hoy, true);
});

test("frase: primera racha de lluvia con su probabilidad", () => {
  const p = puntoCon([bloque("2026-10-30T18:00", 0), bloque("2026-10-30T21:00", 2), bloque("2026-10-31T00:00", 1), bloque("2026-10-31T03:00", 0)]);
  const f = L.frase(L.bloquesVigentes(p, AHORA), AHORA);
  assert.equal(f.clase, 2);
  assert.equal(f.texto, "Lluvia moderada probable desde las 21:00 hasta las 03:00");
  assert.equal(f.detalle, "6 de cada 10 escenarios");
});

test("frase: lluvia en curso y día siguiente", () => {
  const p = puntoCon([bloque("2026-10-30T18:00", 1)]);
  assert.equal(L.frase(L.bloquesVigentes(p, AHORA), AHORA).texto, "Lluvia ligera probable ahora y hasta las 21:00");
  const q = puntoCon([bloque("2026-10-30T18:00", 0), bloque("2026-10-31T09:00", 3)]);
  assert.equal(L.frase(L.bloquesVigentes(q, AHORA), AHORA).texto, "Lluvia fuerte probable mañana desde las 09:00 hasta las 12:00");
  const r = puntoCon([bloque("2026-10-30T18:00", 0)]);
  assert.equal(L.frase(L.bloquesVigentes(r, AHORA), AHORA).texto, "Sin lluvia relevante en las próximas 24 h.");
});

test("número con formato de Ecuador", () => {
  assert.equal(L.num(1234.5), "1.234,5");
  assert.equal(L.num(0.25, 2), "0,25");
  assert.equal(L.num(null), "—");
});

test("punto más cercano y límites de Ecuador", () => {
  const pts = [{ id: "quito", lat: -0.22, lon: -78.51 }, { id: "banos", lat: -1.3964, lon: -78.424 }];
  const m = L.masCercano(pts, -1.25, -78.62); // Ambato
  assert.equal(m.punto.id, "banos");
  assert.ok(m.km > 25 && m.km < 30);
  assert.ok(L.dentroEcuador(-0.74, -90.31)); // Puerto Ayora
  assert.ok(!L.dentroEcuador(4.6, -74.1)); // Bogotá
});

test("estaciones: solo las que reportaron hace 3 h o menos, por distancia", () => {
  const est = [
    { id: 1, lat: -0.2, lon: -78.5, ultimo: "2026-10-30T18:00-05:00" },
    { id: 2, lat: -0.21, lon: -78.5, ultimo: "2026-10-30T10:00-05:00" }, // atrasada
    { id: 3, lat: -0.3, lon: -78.5, ultimo: "2026-10-30T19:00-05:00" },
    { id: 4, lat: -1.5, lon: -78.0, ultimo: "2026-10-30T19:00-05:00" }, // lejos
  ];
  const c = L.estacionesCercanas(est, -0.21, -78.5, 15, 3, AHORA);
  assert.deepEqual(c.map((x) => x.e.id), [1, 3]);
});

// Ruta de prueba: A (0 min) -> B (120 min). Serie horaria desde las 20:00 del 30 (fin de hora 21:00).
function rutaYSerie(llueve) {
  const tiempos = [];
  for (let h = 0; h < 84; h++) tiempos.push(L.fmtLocal(new Date(Date.UTC(2026, 9, 30, 21 + h))));
  const miembros = (pid) => Array.from({ length: 10 }, (_, m) => tiempos.map((t) => Math.round(llueve(pid, L.parseLocal(t), m) * 10)));
  return {
    ruta: { id: "r", tramos: [{ punto: "a", min: 0 }, { punto: "b", min: 120 }] },
    horaria: { a: { tiempos, miembros_dmm: miembros("a") }, b: { tiempos, miembros_dmm: miembros("b") } },
  };
}
const UMB = { moderada_mm_h: 2.5, fuerte_mm_h: 7.6 };

test("viaje: salidas de día desde la próxima hora, con opción de noche", () => {
  const { ruta, horaria } = rutaYSerie(() => 0);
  const hoy = L.salidasDelDia(ruta, horaria, "2026-10-30", {}, AHORA);
  assert.deepEqual(hoy.map(L.hora), ["20:00"]); // la última salida de día
  const noche = L.salidasDelDia(ruta, horaria, "2026-10-30", { noche: true }, AHORA);
  assert.deepEqual(noche.map(L.hora), ["20:00", "21:00", "22:00", "23:00"]);
  const manana = L.salidasDelDia(ruta, horaria, "2026-10-31", {}, AHORA);
  assert.equal(L.hora(manana[0]), "05:00");
  assert.equal(L.hora(manana[manana.length - 1]), "20:00");
  assert.deepEqual(L.fechasDeViaje(ruta, horaria, {}, AHORA), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
});

test("viaje: recomienda otra salida solo si es más seca en 7,5 de cada 10 escenarios", () => {
  // En B llueve 5 mm/h entre las 12:00 y las 15:00 del 31 en 8 de 10 escenarios.
  const { ruta, horaria } = rutaYSerie((pid, fin, m) => (pid === "b" && fin.getUTCDate() === 31 && fin.getUTCHours() > 12 && fin.getUTCHours() <= 15 && m < 8 ? 5 : 0));
  const salida = L.parseLocal("2026-10-31T11:00"); // pasa por B a las 13:00
  const ev = L.evaluarSalida(ruta, horaria, salida, UMB);
  assert.equal(ev.peor.punto, "b");
  assert.equal(ev.peor.clase, 2);
  assert.equal(L.hora(ev.llegada), "13:00");
  const cands = L.salidasDelDia(ruta, horaria, "2026-10-31", {}, AHORA);
  const m = L.mejorSalida(ruta, horaria, ev, cands, UMB);
  assert.ok(m);
  assert.equal(m.frac, 0.8);
  // Con 6 de 10 escenarios lluviosos no hay diferencia clara.
  const otro = rutaYSerie((pid, fin, mm) => (pid === "b" && fin.getUTCHours() > 12 && fin.getUTCHours() <= 15 && mm < 6 ? 5 : 0));
  const ev2 = L.evaluarSalida(otro.ruta, otro.horaria, salida, UMB);
  assert.equal(L.mejorSalida(otro.ruta, otro.horaria, ev2, cands, UMB), null);
});

test("llegada de noche", () => {
  assert.ok(L.deNoche(L.parseLocal("2026-10-31T19:30")));
  assert.ok(L.deNoche(L.parseLocal("2026-10-31T05:00")));
  assert.ok(!L.deNoche(L.parseLocal("2026-10-31T14:00")));
});

test("mapa de calor arranca en la hora en curso", () => {
  const calor = { tiempos: ["2026-10-30T19:00", "2026-10-30T20:00", "2026-10-30T21:00"] };
  assert.equal(L.indiceCalorAhora(calor, AHORA), 1); // la hora 19:00-20:00 está en curso
});

test("favoritos: URL primero, luego el teléfono, sin ids inválidos", () => {
  const ids = ["quito", "banos", "cuenca"];
  assert.deepEqual(L.leerFavoritos("?l=cuenca,nada,quito,cuenca", "banos", ids), ["cuenca", "quito"]);
  assert.deepEqual(L.leerFavoritos("", "banos,ubicacion", ids), ["banos", "ubicacion"]);
  assert.deepEqual(L.leerFavoritos("", null, ids), ["ubicacion", "quito", "banos"]);
});

test("frescura dice a qué se refiere cada hora", () => {
  const pron = { generado: "2026-10-30T13:34-05:00", modelos: { a: { nombre: "ECMWF", estado: "ok" } } };
  const obs = { vigencia_h: 3, estaciones: [{ ultimo: "2026-10-30T19:00-05:00" }, { ultimo: "2026-10-30T09:00-05:00" }] };
  const f = L.frescura(pron, obs, null, AHORA);
  assert.equal(f.corto, "Datos de las 13:34");
  assert.equal(f.atrasado, false);
  assert.match(f.items[0].texto, /calculado a las 13:34 \(hace 6 h 6 min\)/);
  assert.match(f.items[1].texto, /último dato a las 19:00 \(hace 40 min\); 1 de 2 estaciones al día/);
});

// ------------------------------------------------------------ estado de vías
const CFG_RUTA = { provincias: ["PICHINCHA", "COTOPAXI", "TUNGURAHUA"],
  localidades: ["QUITO", "TAMBILLO", "ALOAG", "MACHACHI", "LASSO", "LATACUNGA", "SALCEDO", "AMBATO", "PELILEO", "BANOS"],
  carreteras: ["E35", "PANAMERICANA"] };
const via = (via, provincia, estado = "PARCIALMENTE HABILITADA", observaciones = "", modificado = "2026-10-30T06:00-05:00") =>
  ({ via, provincia, estado, observaciones, modificado });

test("vías: de la ruta por dos localidades o por la carretera; el resto de la provincia aparte", () => {
  const vias = [
    via("AMBATO - PELILEO - BAÑOS", "TUNGURAHUA", "CERRADA"),
    via("BAÑOS - PUYO", "TUNGURAHUA"),                       // solo una localidad: sigue después de Baños
    via("ZUMBAHUA - LATACUNGA", "COTOPAXI", "PARCIALMENTE HABILITADA", "E30 KM 79"), // otra vía que sale de Latacunga
    via("ALOAG - SANTO DOMINGO", "PICHINCHA"),
    via("SECTOR LASSO", "COTOPAXI", "PARCIALMENTE HABILITADA", "HUNDIMIENTO EN LA E-35 KM 12"),
    via("CUENCA - MOLLETURO - NARANJAL", "AZUAY"),           // fuera de la ruta y de sus provincias
  ];
  const r = L.viasDeRuta(vias, CFG_RUTA);
  assert.deepEqual(r.enRuta.map((v) => v.via), ["AMBATO - PELILEO - BAÑOS", "SECTOR LASSO"]);
  assert.deepEqual(r.enProvincias.map((v) => v.via).sort(), ["ALOAG - SANTO DOMINGO", "BAÑOS - PUYO", "ZUMBAHUA - LATACUNGA"]);
});

test("vías: gravedad, texto legible y agrupación por provincia", () => {
  assert.equal(L.gravedadVia("CERRADA"), 3);
  assert.equal(L.gravedadVia("PARCIALMENTE HABILITADA"), 2);
  assert.equal(L.gravedadVia("HABILITADA CON RESTRICCIÓN VEHICULAR"), 1);
  assert.equal(L.oracion("DESLIZAMIENTO EN EL KM 40. MANEJAR CON CUIDADO"), "Deslizamiento en el km 40. Manejar con cuidado");
  assert.equal(L.titulo("CUENCA - GIRON -PASAJE - MACHALA"), "Cuenca - Giron - Pasaje - Machala");
  const g = L.viasPorProvincia([via("A", "LOS RIOS"), via("B", "Los Ríos")]);
  assert.equal(g["LOS RIOS"].length, 2);
});
