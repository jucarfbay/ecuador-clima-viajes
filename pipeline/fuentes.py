"""Descarga de datos públicos: Open-Meteo (ensambles, alta resolución) y estaciones del INAMHI.

Solo biblioteca estándar. Todas las llamadas pasan por `Http`, que se puede sustituir en pruebas.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TZ = "America/Guayaquil"
ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
INAMHI_API = "https://inamhi.gob.ec/api_rest/"
USER_AGENT = "ecuador-clima-viajes/0.1 (uso personal, no comercial; github.com/jucarfbay/ecuador-clima-viajes)"

# Modelos de ensamble y peso inicial en la probabilidad combinada (revisión independiente:
# ECMWF pesa más; los centros no son independientes). Se ajustan en Plan 5, etapa 3.
MODELOS = {
    "ecmwf_ifs025": {"nombre": "ECMWF IFS ENS", "peso": 0.5},
    "ecmwf_aifs025_ensemble": {"nombre": "ECMWF AIFS ENS (IA)", "peso": 0.3},
    "ncep_gefs025": {"nombre": "NOAA GEFS", "peso": 0.2},
}


class Http:
    def __init__(self, pausa_s: float = 0.0, reintentos: int = 3, timeout: int = 60):
        self.pausa_s = pausa_s
        self.reintentos = reintentos
        self.timeout = timeout
        self.llamadas = 0

    def _abrir(self, req):
        ultimo = None
        for intento in range(self.reintentos):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    self.llamadas += 1
                    return json.loads(r.read().decode("utf-8"))
            except Exception as e:  # noqa: BLE001 - se reintenta cualquier fallo de red
                ultimo = e
                time.sleep(2 * (intento + 1))
        raise RuntimeError(f"Fallo al consultar {req.full_url}: {ultimo}")

    def get(self, url: str, params: dict | None = None):
        if params:
            url = url + "?" + urllib.parse.urlencode(params, doseq=True)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        out = self._abrir(req)
        if self.pausa_s:
            time.sleep(self.pausa_s)
        return out

    def post(self, url: str, body: dict):
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"},
            method="POST",
        )
        out = self._abrir(req)
        if self.pausa_s:
            time.sleep(self.pausa_s)
        return out


def _lotes(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


TZ_GALAPAGOS = "Pacific/Galapagos"


def zona_de(p: dict) -> str:
    """Zona horaria del punto: Galápagos (UTC-6) para la región Insular; el resto, UTC-5."""
    return TZ_GALAPAGOS if p.get("region") == "Insular" else TZ


def ensamble(http: Http, modelo: str, puntos: list[dict], dias: int = 12, lote: int = 25) -> dict:
    """Devuelve {id_punto: {"tiempos": [...], "miembros": [[mm por hora] x miembro], "elevacion": m, "utc_offset_s": s}}.

    Cada punto se pide en su propia zona horaria, para que los días y bloques correspondan a su hora local.
    """
    salida = {}
    por_zona: dict[str, list[dict]] = {}
    for p in puntos:
        por_zona.setdefault(zona_de(p), []).append(p)
    for zona, pts in por_zona.items():
        for grupo in _lotes(pts, lote):
            params = {
                "latitude": ",".join(str(p["lat"]) for p in grupo),
                "longitude": ",".join(str(p["lon"]) for p in grupo),
                "hourly": "precipitation",
                "models": modelo,
                "forecast_days": dias,
                "timezone": zona,
            }
            resp = http.get(ENSEMBLE_URL, params)
            resp = resp if isinstance(resp, list) else [resp]
            if len(resp) != len(grupo):
                raise RuntimeError(f"{modelo}: se pidieron {len(grupo)} puntos y llegaron {len(resp)}")
            for p, r in zip(grupo, resp):
                h = r["hourly"]
                claves = ["precipitation"] + sorted(k for k in h if k.startswith("precipitation_member"))
                miembros = [[(v if v is not None else float("nan")) for v in h[k]] for k in claves if k in h]
                salida[p["id"]] = {
                    "tiempos": h["time"], "miembros": miembros, "elevacion": r.get("elevation"),
                    "utc_offset_s": r.get("utc_offset_seconds", -18000 if zona == TZ else -21600),
                }
    return salida


def alta_resolucion_rejilla(http: Http, celdas: list[tuple[float, float]], dias: int = 4, lote: int = 100) -> dict:
    """Lluvia horaria de ECMWF IFS HRES (9 km) en una rejilla, para el mapa de calor."""
    tiempos, valores = None, []
    for grupo in _lotes(celdas, lote):
        params = {
            "latitude": ",".join(f"{la:.2f}" for la, _ in grupo),
            "longitude": ",".join(f"{lo:.2f}" for _, lo in grupo),
            "hourly": "precipitation",
            "models": "ecmwf_ifs",
            "forecast_days": dias,
            "timezone": TZ,
        }
        resp = http.get(FORECAST_URL, params)
        resp = resp if isinstance(resp, list) else [resp]
        for r in resp:
            tiempos = tiempos or r["hourly"]["time"]
            valores.append(r["hourly"]["precipitation"])
    return {"tiempos": tiempos, "valores": valores}


def estaciones_inamhi(http: Http, metadatos_previos: dict | None = None, hilos: int = 4) -> list[dict]:
    """Lluvia horaria observada de las estaciones automáticas que transmiten (visor público del INAMHI).

    Servicio interno sin documentar: se consulta con moderación (pocos hilos) y se tolera que falle.
    """
    metadatos_previos = metadatos_previos or {}
    lista = http.get(
        INAMHI_API + "station_information/estaciones/visores/",
        {"id_aplicacion": "vs_1h_inh", "id_estado_estacion": [1, 2]},
    )
    activas = [s for s in lista if s.get("estado_transmision") == "TRANSMITIENDO"]

    def una(s):
        try:
            ide = s["id_estacion"]
            previo = metadatos_previos.get(str(ide), {})
            tablas = previo.get("tablas")
            nombre = previo.get("nombre")
            if tablas is None:
                params = http.get(INAMHI_API + "station_information/parametros/", {"id_estacion": ide})
                p = next((x for x in params if x.get("id_param") == 17), None)
                tablas = [t["nemonico"] for t in p["params"]] if p else []
            if not tablas:
                return None
            provincia = previo.get("provincia")
            if not nombre:
                info = http.get(INAMHI_API + "station_information/estaciones/", {"id_estacion": ide})
                info = info[0] if isinstance(info, list) and info else {}
                nombre = info.get("punto_obs") or s["codigo"]
                provincia = info.get("provincia")
            datos = http.post(
                INAMHI_API + "station_data_hour/get_precipitation/",
                {"id_estacion": ide, "table_names": tablas, "id_aplication": 1},
            )
            horaria = next((d for d in datos if "HORARIA" in (d.get("name") or "").upper()), None)
            serie = [(d["fecha"], d["valor"]) for d in (horaria or {}).get("data", []) if d.get("valor") is not None]
            if not serie:
                return None
            return {
                "id": ide,
                "codigo": s["codigo"],
                "nombre": nombre,
                "provincia": provincia,
                "propietario": s.get("propietario"),
                "lat": float(s["latitud"]),
                "lon": float(s["longitud"]),
                "altitud": float(s["altitud"]) if s.get("altitud") else None,
                "frecuencia": s.get("frecuencia_transmision"),
                "tablas": tablas,
                "serie": serie,
            }
        except Exception:  # noqa: BLE001 - una estación caída no detiene el resto
            return None

    with ThreadPoolExecutor(max_workers=hilos) as ex:
        res = [r for r in ex.map(una, activas) if r]
    return res
