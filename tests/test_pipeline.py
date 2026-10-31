"""Pruebas sin red: un Http falso devuelve respuestas con el mismo formato que Open-Meteo y el INAMHI."""
import json
import math
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from pipeline import calculo, run  # noqa: E402
from pipeline.fuentes import ECU911_VIAS, ENSEMBLE_URL, FORECAST_URL, INAMHI_API, vias_ecu911  # noqa: E402

ECU = timezone(timedelta(hours=-5))
AHORA = datetime(2026, 10, 29, 20, 30, tzinfo=ECU)


def tiempos_locales(dias):
    t0 = datetime(2026, 10, 29, 0, 0)
    return [(t0 + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M") for h in range(24 * dias)]


def respuesta_ensamble(n_puntos, n_miembros, dias, mm_por_hora, offset_s=-18000):
    t = tiempos_locales(dias)
    out = []
    for _ in range(n_puntos):
        hourly = {"time": t, "precipitation": [mm_por_hora(0, i) for i in range(len(t))]}
        for m in range(1, n_miembros):
            hourly[f"precipitation_member{m:02d}"] = [mm_por_hora(m, i) for i in range(len(t))]
        out.append({"latitude": 0, "longitude": 0, "elevation": 2000.0, "utc_offset_seconds": offset_s, "hourly": hourly})
    return out


class HttpFalso:
    def __init__(self, mm_por_hora):
        self.mm = mm_por_hora
        self.llamadas = 0

    def get(self, url, params=None):
        self.llamadas += 1
        params = params or {}
        if url == ENSEMBLE_URL:
            n = len(params["latitude"].split(","))
            miembros = {"ecmwf_ifs025": 51, "ecmwf_aifs025_ensemble": 51, "ncep_gefs025": 31}[params["models"]]
            off = -21600 if params["timezone"] == "Pacific/Galapagos" else -18000
            return respuesta_ensamble(n, miembros, params["forecast_days"], self.mm, off)
        if url == FORECAST_URL:
            n = len(params["latitude"].split(","))
            if params.get("cell_selection") == "nearest":
                # Rejilla "nativa" de 0,07°: varios puntos de consulta caen en la misma celda.
                t = tiempos_locales(params["forecast_days"] + params["past_days"])
                lats = [float(x) for x in params["latitude"].split(",")]
                lons = [float(x) for x in params["longitude"].split(",")]
                return [{"latitude": round(la / 0.07) * 0.07, "longitude": round(lo / 0.07) * 0.07, "elevation": 2500.0,
                         "hourly": {"time": t, "precipitation": [0.3] * len(t)}} for la, lo in zip(lats, lons)]
            t = tiempos_locales(params["forecast_days"])
            return [{"hourly": {"time": t, "precipitation": [0.2] * len(t)}} for _ in range(n)]
        if url.endswith("/static/meta.json"):
            return {"last_run_initialisation_time": 1793383200, "last_run_availability_time": 1793404647,
                    "crs_wkt": "REMARK[\"Reduced Gaussian Grid O1280 (ECMWF)\"]"}
        if url.endswith("estaciones/visores/"):
            return [
                {"id_estacion": 1, "codigo": "M1", "estado_transmision": "TRANSMITIENDO", "latitud": "-0.2",
                 "longitud": "-78.5", "altitud": "2800", "propietario": "EPMAPS", "frecuencia_transmision": "5 MINUTOS"},
                {"id_estacion": 2, "codigo": "M2", "estado_transmision": "SIN TRANSMISION", "latitud": "-1",
                 "longitud": "-78", "altitud": "2000", "propietario": "INAMHI", "frecuencia_transmision": "1 HORA"},
            ]
        if url.endswith("station_information/parametros/"):
            return [{"id_param": 17, "params": [{"nemonico": "017140801h"}]}]
        if url.endswith("station_information/estaciones/"):
            return [{"punto_obs": "TOCTIUCO - EPMAPS QUITO", "provincia": "PICHINCHA"}]
        if url == ECU911_VIAS:
            # Mismo formato que el servicio real (recortado); dos páginas para probar la paginación.
            via = {"id": "x", "descripcion": " AMBATO - BAÑOS ", "observaciones": "DERRUMBE EN EL KM 5",
                   "modified": "2026-10-29 06:11:10", "GroupDetail": {"nombre": "ARTERIAL"},
                   "EstadoActual": {"id": 595, "nombre": "CERRADA"}, "Provincia": {"descripcion": "TUNGURAHUA"},
                   "Canton": {"descripcion": "BAÑOS DE AGUA SANTA"},
                   "DetalleViaAlterna": [{"Via": {"descripcion": "PATATE - BAÑOS"}}]}
            datos = [via] if params["start"] == 0 else [dict(via, id="y")]
            return {"data": datos, "total": 2, "code": 200}
        raise AssertionError("URL inesperada " + url)

    def post(self, url, body):
        self.llamadas += 1
        assert url == INAMHI_API + "station_data_hour/get_precipitation/"
        fin = datetime(2026, 10, 30, 0, 0, tzinfo=timezone.utc)
        data = [{"fecha": (fin - timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%S+00:00"), "valor": 1.0}
                for h in range(359, -1, -1)]
        return [{"name": "PRECIPITACION ACUMULADA HORARIA", "data": data},
                {"name": "PRECIPITACION ACUMULADA DIARIA", "data": []}]


class TestCalculo(unittest.TestCase):
    def test_dia_hora_final(self):
        # 1 mm/h constante. El 30 de oct (completo) suma 24 horas: de 01:00 del 30 a 00:00 del 31.
        t = tiempos_locales(3)
        dias = calculo.acumulados_diarios(t, [[1.0] * len(t)], AHORA)
        self.assertEqual(dias[0]["fecha"], "2026-10-29")
        self.assertTrue(dias[0]["parcial"])
        self.assertEqual(dias[0]["horas"], 4)  # 20-21, 21-22, 22-23, 23-24
        self.assertEqual(dias[1], {"fecha": "2026-10-30", "parcial": False, "horas": 24, "totales": [24.0]})
        self.assertEqual(len(dias), 2)  # el 31 queda incompleto (falta la hora que termina el 1 nov 00:00)

    def test_diez_dias_completos(self):
        t = tiempos_locales(12)
        dias = calculo.acumulados_diarios(t, [[1.0] * len(t)], AHORA)
        self.assertEqual(len(dias), 11)  # resto de hoy + 10 días completos
        self.assertTrue(all(d["horas"] == 24 for d in dias[1:]))

    def test_prob_y_percentil(self):
        self.assertAlmostEqual(calculo.prob([0, 5, 10, 20], 10), 0.5)
        self.assertAlmostEqual(calculo.percentil([0, 10], 0.5), 5)
        self.assertIsNone(calculo.prob([float("nan")], 1))

    def test_niveles(self):
        c = json.loads((RAIZ / "config/umbrales.json").read_text())["cortes_probabilidad"]
        self.assertEqual(calculo.nivel_desde_probs({"medio": 0.1, "alto": 0.05, "muy_alto": 0}, c), 0)
        self.assertEqual(calculo.nivel_desde_probs({"medio": 0.6, "alto": 0.1, "muy_alto": 0}, c), 1)
        self.assertEqual(calculo.nivel_desde_probs({"medio": 0.9, "alto": 0.6, "muy_alto": 0.1}, c), 2)
        self.assertEqual(calculo.nivel_desde_probs({"medio": 0.9, "alto": 0.4, "muy_alto": 0.3}, c), 2)
        self.assertEqual(calculo.nivel_desde_probs({"medio": 1, "alto": 1, "muy_alto": 0.5}, c), 3)

    def test_combinar_renormaliza(self):
        pesos = {"a": 0.5, "b": 0.3, "c": 0.2}
        self.assertAlmostEqual(calculo.combinar({"a": 1.0, "b": 0.0, "c": None}, pesos), 0.625)

    def test_confianza(self):
        self.assertEqual(calculo.confianza(2, 0.1), "alta")
        self.assertEqual(calculo.confianza(2, 0.5), "media")
        self.assertEqual(calculo.confianza(9, 0.5), "tendencia")

    def test_bloques(self):
        t = tiempos_locales(4)
        # la mitad de los miembros llueve 8 mm/h (24 mm por bloque: fuerte), la otra mitad 3 mm/h (9 mm: moderada)
        miembros = [[8.0] * len(t) if m % 2 else [3.0] * len(t) for m in range(10)]
        bl = calculo.bloques_3h(t, miembros, AHORA, 24)
        self.assertEqual(bl[0]["inicio"], "2026-10-29T18:00")
        self.assertTrue(bl[0]["en_curso"])
        self.assertAlmostEqual(bl[0]["p_fuerte"], 0.5)
        self.assertAlmostEqual(bl[0]["p_moderada"], 1.0)
        self.assertEqual(calculo.clase_bloque(bl[0]), 3)


class TestPipeline(unittest.TestCase):
    def test_extremo_a_extremo(self):
        # Llueve más en los miembros altos: miembro m llueve m/20 mm/h -> totales diarios 0..60 mm
        http = HttpFalso(lambda m, i: m / 20)
        cfg = json.loads((RAIZ / "config/puntos.json").read_text())
        umb = json.loads((RAIZ / "config/umbrales.json").read_text())
        pron, arch = run.pronostico(http, cfg, umb, AHORA)
        self.assertEqual(len(pron["puntos"]), len(cfg["puntos"]))
        quito = next(p for p in pron["puntos"] if p["id"] == "quito")
        d1 = quito["dias"][1]
        self.assertEqual(d1["fecha"], "2026-10-30")
        # IFS: miembro m suma 24*m/20 = 1.2 m mm; >=12 mm (alto Interandina) cuando m>=10 -> 41/51
        self.assertAlmostEqual(d1["p_alto_por_modelo"]["ecmwf_ifs025"], round(41 / 51, 2))
        self.assertIn(d1["nivel"], (2, 3))
        self.assertEqual(len(pron["provincias"]), 24)
        self.assertEqual(pron["formato"], run.FORMATO)
        self.assertEqual(sum(1 for p in pron["puntos"] if p["capital"]), 24)
        # Bloques de 3 h para TODOS los puntos, 84 h desde el bloque en curso.
        self.assertTrue(all(len(p["bloques"]) >= 28 for p in pron["puntos"]))
        self.assertEqual(quito["bloques"][0]["inicio"], "2026-10-29T18:00")
        # Galápagos (UTC-6): a las 20:30 de Quito son las 19:30 allá -> el bloque en curso es 18:00 igual,
        # pero su día y hora local salen de su propia zona.
        gal = next(p for p in pron["puntos"] if p["id"] == "puerto-ayora")
        self.assertEqual(gal["utc_offset_s"], -21600)
        # Serie hora a hora solo para puntos de rutas.
        self.assertIn("banos", pron["horaria"])
        self.assertNotIn("guayaquil", pron["horaria"])
        self.assertEqual(len(pron["horaria"]["banos"]["tiempos"]), 84)
        self.assertEqual(len(pron["horaria"]["banos"]["miembros_dmm"]), 51)

    def test_main_completo(self):
        http = HttpFalso(lambda m, i: 0.1)
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(run, "Http", return_value=http), \
                mock.patch.object(run, "datetime", wraps=datetime) as dt:
            dt.now.return_value = AHORA
            codigo = run.main(["--salida", f"{tmp}/data", "--archivo", f"{tmp}/arch"])
            self.assertEqual(codigo, 0)
            est = json.loads(Path(f"{tmp}/data/estaciones.json").read_text())
            self.assertEqual(len(est["estaciones"]), 1)
            e = est["estaciones"][0]
            self.assertEqual(e["nombre"], "TOCTIUCO - EPMAPS QUITO")
            # Sumas desde AHORA (20:30): 24 h hacia atrás = 23 lecturas de 1 mm (último dato 19:00).
            self.assertEqual(e["mm_24h"], 23.0)
            self.assertEqual(e["mm_1h"], 1.0)
            self.assertTrue(e["vigente"])
            self.assertEqual(e["ultimo"], "2026-10-29T19:00-05:00")
            calor = json.loads(Path(f"{tmp}/data/calor.json").read_text())
            self.assertEqual(len(calor["tiempos"]), 72)  # 4 días desde las 00:00 -> 72 h completas desde las 21:00
            self.assertEqual(len(calor["valores_dmm"][0]), len(calor["lats"]) * len(calor["lons"]))
            self.assertTrue(list(Path(f"{tmp}/arch").glob("pronostico_*.json.gz")))
            self.assertTrue(list(Path(f"{tmp}/arch").glob("calor_*.json.gz")))
            vias = json.loads(Path(f"{tmp}/data/vias.json").read_text())
            self.assertEqual(len(vias["vias"]), 2)
            self.assertTrue(list(Path(f"{tmp}/arch").glob("vias_*.json.gz")))

    def test_freno_con_archivo(self):
        """Si el sitio no responde pero el archivo tiene un pronóstico de hace 2 h, no se recalcula."""
        http = HttpFalso(lambda m, i: 0.1)
        with tempfile.TemporaryDirectory() as tmp:
            previo = {"formato": run.FORMATO, "generado": (AHORA - timedelta(hours=2)).isoformat(timespec="minutes"),
                      "puntos": []}
            run.guardar_gz(Path(f"{tmp}/prev/pronostico_20261029T1830.json.gz"), {"pronostico": previo})
            run.guardar_gz(Path(f"{tmp}/prev/calor_20261029T1830.json.gz"), {"generado": previo["generado"]})
            with mock.patch.object(run, "Http", return_value=http), \
                    mock.patch.object(run, "datetime", wraps=datetime) as dt:
                dt.now.return_value = AHORA
                run.main(["--salida", f"{tmp}/data", "--archivo", f"{tmp}/arch", "--previo-archivo", f"{tmp}/prev"])
            estado = json.loads(Path(f"{tmp}/data/estado.json").read_text())
            self.assertEqual(estado["fuentes"]["pronostico"]["accion"], "reutilizado")
            pron = json.loads(Path(f"{tmp}/data/pronostico.json").read_text())
            self.assertIn("vias", pron["rutas"][0])  # la ruta reutilizada lleva la configuración actual
            self.assertEqual(estado["fuentes"]["calor"]["accion"], "reutilizado")
            self.assertFalse(list(Path(f"{tmp}/arch").glob("pronostico_*.json.gz")))

    def test_corredor_celdas_nativas(self):
        c = run.corredor_lluvia(HttpFalso(lambda m, i: 0), AHORA)
        claves = {(x["lat"], x["lon"]) for x in c["celdas"]}
        self.assertEqual(len(claves), len(c["celdas"]))  # sin celdas repetidas
        self.assertLess(len(c["celdas"]), c["consultas"])  # varias consultas por celda nativa: no se inventa detalle
        self.assertAlmostEqual(c["paso_lat"], 0.07, places=3)
        self.assertAlmostEqual(c["paso_lon"], 0.07, places=3)
        self.assertEqual(c["corrida_inicio_utc"], "2026-10-30T18:00+00:00")
        self.assertIn("O1280", c["rejilla"])
        # Ventana: 24 h antes y 72 h después de la próxima hora (21:00 del 29). La serie falsa empieza el 29 a las
        # 00:00, así que de las 24 h pasadas solo hay 21; termina a las 20:00 del 1 de noviembre.
        self.assertEqual(c["tiempos"][0], "2026-10-29T00:00")
        self.assertEqual(c["tiempos"][-1], "2026-11-01T20:00")
        self.assertEqual(len(c["tiempos"]), 21 + 72)
        self.assertEqual(len(c["valores_dmm"][0]), len(c["celdas"]))

    def test_vias_ecu911(self):
        vs = vias_ecu911(HttpFalso(lambda m, i: 0), lote=1)
        self.assertEqual(len(vs), 2)  # dos páginas
        self.assertEqual(vs[0], {"id": "x", "via": "AMBATO - BAÑOS", "estado": "CERRADA", "categoria": "ARTERIAL",
                                 "provincia": "TUNGURAHUA", "canton": "BAÑOS DE AGUA SANTA",
                                 "observaciones": "DERRUMBE EN EL KM 5", "alternas": ["PATATE - BAÑOS"],
                                 "modificado": "2026-10-29T06:11-05:00"})

    def test_estacion_atrasada(self):
        serie = [["2026-10-29T10:00:00+00:00", 5.0], ["2026-10-29T11:00:00+00:00", 2.0]]  # 06:00 hora de Ecuador
        s = run.sumas_estacion(serie, AHORA)
        self.assertIsNone(s["mm_1h"])  # 14 h sin datos: no se muestra como lluvia actual
        self.assertIsNone(s["mm_3h"])
        self.assertEqual(s["mm_24h"], 7.0)


if __name__ == "__main__":
    unittest.main()


class TestRutaCorredor(unittest.TestCase):
    def test_tiempos_conciliados_con_la_duracion_total(self):
        sys.path.insert(0, str(RAIZ / "tools"))
        import ruta_corredor  # noqa: E402
        d = {"duracion_min": 2.0, "s": [0.0, 30.0, 100.0], "hitos": [{"vertice": 0, "min": 0}, {"vertice": 2, "min": 1.67}]}
        r = ruta_corredor.escalar_tiempos(d)
        self.assertAlmostEqual(r["s"][-1], 120.0)
        self.assertAlmostEqual(r["hitos"][1]["min"], 2.0)
        self.assertEqual(ruta_corredor.escalar_tiempos(r)["s"], r["s"])  # idempotente
        publicada = json.loads((RAIZ / "site/corredor/datos/ruta.json").read_text(encoding="utf-8"))
        self.assertAlmostEqual(publicada["s"][-1] / 60, publicada["duracion_min"], places=1)
        self.assertAlmostEqual(publicada["hitos"][-1]["min"], publicada["duracion_min"], places=1)
