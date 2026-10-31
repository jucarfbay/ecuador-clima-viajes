"""Genera los datos de la web: pronóstico por ensamble, mapa de calor y estaciones observadas.

Uso:
  python -m pipeline.run --salida site/data [--previo https://usuario.github.io/repo/data] [--archivo archivo/]

Diseño sin estado: cada ejecución horaria descarga las estaciones; el pronóstico se recalcula solo si el
anterior (leído del sitio publicado) tiene más de --vigencia-h horas. Así se respeta el límite gratuito de
Open-Meteo y los modelos (que se actualizan cada 6 h) no se descargan repetidos.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import calculo
from .fuentes import MODELOS, Http, alta_resolucion_rejilla, ensamble, estaciones_inamhi, vias_ecu911

ECU = timezone(timedelta(hours=-5))
RAIZ = Path(__file__).resolve().parent.parent
FORMATO = 2  # versión del pronostico.json que entiende la web; un previo con otro formato no se reutiliza
VIGENCIA_ESTACION_H = 3  # una estación con datos más viejos no se usa para colorear ni sumar "ahora"


def cargar_json(ruta: Path):
    return json.loads(ruta.read_text(encoding="utf-8"))


def leer_previo(base: str | None, nombre: str):
    if not base:
        return None
    try:
        with urllib.request.urlopen(f"{base.rstrip('/')}/{nombre}", timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - primera ejecución o sitio caído
        return None


def escribir(ruta: Path, datos):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


# ---------------------------------------------------------------- pronóstico por ensamble

def pronostico(http: Http, cfg: dict, umbrales: dict, ahora: datetime):
    puntos = cfg["puntos"]
    datos = {}
    estado_modelos = {}
    for modelo in MODELOS:
        try:
            datos[modelo] = ensamble(http, modelo, puntos)
            estado_modelos[modelo] = "ok"
        except Exception as e:  # noqa: BLE001 - un modelo caído no detiene el resto
            estado_modelos[modelo] = f"error: {e}"[:200]
    if "ecmwf_ifs025" not in datos:
        raise RuntimeError("Sin ECMWF IFS ENS no se puede calcular el pronóstico: " + estado_modelos["ecmwf_ifs025"])

    pesos = {m: MODELOS[m]["peso"] for m in MODELOS}
    cortes = umbrales["cortes_probabilidad"]
    salida_puntos = []
    archivo_puntos = {}
    for p in puntos:
        reg = umbrales["regiones"][p["region"]]
        off = datos["ecmwf_ifs025"][p["id"]]["utc_offset_s"]
        dias_por_modelo = {
            m: calculo.acumulados_diarios(d[p["id"]]["tiempos"], d[p["id"]]["miembros"], ahora, offset_s=off)
            for m, d in datos.items() if p["id"] in d
        }
        base = dias_por_modelo["ecmwf_ifs025"]
        dias = []
        for i, dia in enumerate(base):
            probs = {}
            dispersion = None
            for nivel in ("medio", "alto", "muy_alto"):
                por_modelo = {}
                for m, dlist in dias_por_modelo.items():
                    match = next((x for x in dlist if x["fecha"] == dia["fecha"] and x["parcial"] == dia["parcial"]), None)
                    por_modelo[m] = calculo.prob(match["totales"], reg[nivel]) if match else None
                probs[nivel] = calculo.combinar(por_modelo, pesos)
                vals = [v for v in por_modelo.values() if v is not None]
                if nivel == "alto" and len(vals) > 1:
                    dispersion = max(vals) - min(vals)
                if nivel == "alto":
                    probs_alto_modelos = {m: (None if v is None else round(v, 2)) for m, v in por_modelo.items()}
            nivel_cod = calculo.nivel_desde_probs(probs, cortes)
            dias.append({
                "fecha": dia["fecha"],
                "parcial": dia["parcial"],
                "nivel": nivel_cod,
                "confianza": calculo.confianza(i if base[0]["parcial"] else i + 1, dispersion),
                "p": {k: (None if v is None else round(v, 2)) for k, v in probs.items()},
                "p_alto_por_modelo": probs_alto_modelos,
                "mm": {
                    "p10": calculo._r(calculo.percentil(dia["totales"], 0.1), 1),
                    "p50": calculo._r(calculo.percentil(dia["totales"], 0.5), 1),
                    "p90": calculo._r(calculo.percentil(dia["totales"], 0.9), 1),
                },
            })
        ifs_p = datos["ecmwf_ifs025"][p["id"]]
        bloques = calculo.bloques_3h(ifs_p["tiempos"], ifs_p["miembros"], ahora, 84, umbrales["bloques_3h"], offset_s=off)
        for bl in bloques:
            bl["clase"] = calculo.clase_bloque(bl)
        salida_puntos.append({
            "id": p["id"], "nombre": p["nombre"], "provincia": p["provincia"], "region": p["region"],
            "capital": bool(p.get("capital")), "lat": p["lat"], "lon": p["lon"], "utc_offset_s": off,
            "elevacion_modelo": ifs_p["elevacion"],
            "dias": dias, "bloques": bloques,
        })
        archivo_puntos[p["id"]] = {
            m: [{"fecha": x["fecha"], "parcial": x["parcial"],
                 "dmm": [None if math.isnan(t) else int(round(t * 10)) for t in x["totales"]]} for x in dl]
            for m, dl in dias_por_modelo.items()
        }

    # Puntos de rutas: miembros hora a hora (ECMWF IFS ENS) para el planificador de viajes.
    ids_ruta = set()
    for ruta in cfg.get("rutas", []):
        ids_ruta.update(t["punto"] for t in ruta["tramos"])
    ifs = datos["ecmwf_ifs025"]
    horaria = {}
    for pid in sorted(ids_ruta):
        d = ifs[pid]
        horaria[pid] = calculo.serie_horaria(d["tiempos"], d["miembros"], ahora, 84, offset_s=d["utc_offset_s"])

    # Semáforo provincial: peor punto + fracción de puntos afectados.
    provincias = {}
    for sp in salida_puntos:
        provincias.setdefault(sp["provincia"], []).append(sp)
    sem = []
    for prov, pts in sorted(provincias.items()):
        n_dias = min(len(x["dias"]) for x in pts)
        dias = []
        for i in range(n_dias):
            niveles = [x["dias"][i]["nivel"] for x in pts]
            peor = max(niveles)
            dias.append({
                "fecha": pts[0]["dias"][i]["fecha"],
                "parcial": pts[0]["dias"][i]["parcial"],
                "nivel": peor,
                "puntos_afectados": sum(1 for n in niveles if n == peor and peor > 0),
                "puntos_total": len(niveles),
                "confianza": pts[0]["dias"][i]["confianza"],
            })
        sem.append({"provincia": prov, "puntos": [x["id"] for x in pts], "dias": dias})

    return {
        "formato": FORMATO,
        "generado": ahora.isoformat(timespec="minutes"),
        "estado": umbrales["estado"],
        "umbrales_version": umbrales["version"],
        "modelos": {m: {"nombre": MODELOS[m]["nombre"], "peso": MODELOS[m]["peso"], "estado": estado_modelos[m]}
                    for m in MODELOS},
        "niveles": calculo.NIVELES,
        "umbrales": umbrales,
        "rutas": cfg.get("rutas", []),
        "lugares": cfg.get("lugares", []),
        "provincias": sem,
        "puntos": salida_puntos,
        "horaria": horaria,
    }, archivo_puntos


# ---------------------------------------------------------------- mapa de calor

def rejilla_ecuador(paso: float = 0.25):
    """Rejilla sobre Ecuador continental (lat 1.5 a -5.0, lon -81.0 a -75.25)."""
    lats = [round(1.5 - i * paso, 2) for i in range(int((1.5 + 5.0) / paso) + 1)]
    lons = [round(-81.0 + j * paso, 2) for j in range(int((81.0 - 75.25) / paso) + 1)]
    return lats, lons


def mapa_calor(http: Http, ahora: datetime):
    lats, lons = rejilla_ecuador()
    celdas = [(la, lo) for la in lats for lo in lons]
    r = alta_resolucion_rejilla(http, celdas)
    proxima = calculo.local(ahora).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    sel = [i for i, ts in enumerate(r["tiempos"]) if datetime.fromisoformat(ts) >= proxima][:72]
    return {
        "generado": ahora.isoformat(timespec="minutes"),
        "modelo": "ECMWF IFS HRES 9 km (Open-Meteo)",
        "nota": "PRONÓSTICO determinista. Valor = lluvia de la hora que termina en el tiempo indicado, en décimas de mm.",
        "paso": 0.25,
        "lats": lats,
        "lons": lons,
        "tiempos": [r["tiempos"][i] for i in sel],
        # valores[t][celda] en décimas de mm, celdas en orden fila (lat) x columna (lon)
        "valores_dmm": [[None if v[i] is None else int(round(v[i] * 10)) for v in r["valores"]] for i in sel],
    }


# ---------------------------------------------------------------- estaciones

def _utc(f: str) -> datetime:
    return datetime.fromisoformat(f.replace("Z", "+00:00"))


def sumas_estacion(serie: list, ahora: datetime) -> dict:
    """Lluvia de las últimas 1/3/24/72 h contadas desde AHORA (no desde el último dato de la estación).

    `mm_1h` es la última hora reportada, solo si llegó hace 2 h o menos (el visor tarda ~1 h); si la estación
    lleva más tiempo sin reportar queda en None en lugar de mostrar una lluvia vieja como actual."""
    def suma(h):
        limite = ahora - timedelta(hours=h)
        vals = [v for f, v in serie if _utc(f) > limite and v is not None]
        return round(sum(vals), 1) if vals else None
    ultima = None
    if serie and serie[-1][1] is not None and ahora - _utc(serie[-1][0]) <= timedelta(hours=2):
        ultima = round(serie[-1][1], 1)
    return {"mm_1h": ultima, "mm_3h": suma(3), "mm_24h": suma(24), "mm_72h": suma(72)}


def observado(http: Http, previo: dict | None, ahora: datetime):
    meta = {}
    if previo:
        for e in previo.get("estaciones", []):
            meta[str(e["id"])] = {"nombre": e.get("nombre"), "provincia": e.get("provincia"), "tablas": e.get("tablas")}
    lista = estaciones_inamhi(http, meta)
    salida = []
    for e in lista:
        serie = sorted(e["serie"])
        ultimo = _utc(serie[-1][0])
        retraso = round((ahora - ultimo).total_seconds() / 3600, 1)
        salida.append({
            "id": e["id"], "codigo": e["codigo"], "nombre": e["nombre"], "provincia": e.get("provincia"),
            "propietario": e["propietario"], "lat": e["lat"], "lon": e["lon"], "altitud": e["altitud"],
            "frecuencia": e["frecuencia"], "tablas": e["tablas"],
            "ultimo": ultimo.astimezone(ECU).isoformat(timespec="minutes"),
            "retraso_h": retraso,
            "vigente": retraso <= VIGENCIA_ESTACION_H,
            **sumas_estacion(serie, ahora),
            "ultimas_24h": [[_utc(f).astimezone(ECU).isoformat(timespec="minutes"), v] for f, v in serie[-24:]],
        })
    return {
        "generado": ahora.isoformat(timespec="minutes"),
        "fuente": "Visor de estaciones del INAMHI (servicio público sin documentar; puede cambiar sin aviso)",
        "nota": ("Valor horario = lluvia acumulada en la hora que termina en la fecha indicada (supuesto, por confirmar "
                 f"con el INAMHI). Sumas contadas desde la hora de generación; 'vigente' = último dato de hace {VIGENCIA_ESTACION_H} h o menos."),
        "vigencia_h": VIGENCIA_ESTACION_H,
        "estaciones": salida,
    }, lista


# ---------------------------------------------------------------- previo y archivo

def leer_gz(ruta: Path):
    try:
        with gzip.open(ruta, "rt", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def previo_archivado(carpeta: str | None, prefijo: str):
    """Último pronostico_*/calor_*.json.gz descargado de la versión mensual (respaldo si el sitio no responde)."""
    if not carpeta or not Path(carpeta).is_dir():
        return None
    for ruta in sorted(Path(carpeta).glob(f"{prefijo}_*.json.gz"), reverse=True):
        d = leer_gz(ruta)
        if not d:
            continue
        if prefijo == "pronostico":
            d = d.get("pronostico")  # archivos viejos no traían el pronóstico completo
        if d and d.get("generado"):
            return d
    return None


def mas_reciente(*cands):
    cands = [c for c in cands if c and c.get("generado")]
    return max(cands, key=lambda c: datetime.fromisoformat(c["generado"])) if cands else None


def edad_h(d: dict, ahora: datetime) -> float:
    return (ahora - datetime.fromisoformat(d["generado"])).total_seconds() / 3600


def guardar_gz(ruta: Path, datos):
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(ruta, "wt", encoding="utf-8") as f:
        json.dump(datos, f, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------- principal

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--salida", default="site/data")
    ap.add_argument("--previo", default=os.environ.get("SITIO_PREVIO"))
    ap.add_argument("--previo-archivo", default="previo", help="carpeta con el último pronóstico/calor archivado")
    ap.add_argument("--archivo", default="archivo")
    ap.add_argument("--vigencia-h", type=float, default=5.5)
    ap.add_argument("--forzar-pronostico", action="store_true")
    a = ap.parse_args(argv)

    ahora = datetime.now(ECU)
    salida, archivo = Path(a.salida), Path(a.archivo)
    cfg = cargar_json(RAIZ / "config" / "puntos.json")
    umbrales = cargar_json(RAIZ / "config" / "umbrales.json")
    http = Http(pausa_s=0.3)
    estado = {"generado": ahora.isoformat(timespec="minutes"), "fuentes": {}}

    # Pronóstico (cada ~6 h) y mapa de calor. El previo sale del sitio publicado o, si no responde, del archivo.
    def previo_valido(d):
        return d if d and d.get("formato") == FORMATO else None
    prev_pron = mas_reciente(previo_valido(leer_previo(a.previo, "pronostico.json")),
                             previo_valido(previo_archivado(a.previo_archivo, "pronostico")))
    prev_calor = mas_reciente(leer_previo(a.previo, "calor.json"), previo_archivado(a.previo_archivo, "calor"))
    vigente = bool(prev_pron) and not a.forzar_pronostico and edad_h(prev_pron, ahora) < a.vigencia_h
    if vigente:
        # Rutas y lugares salen siempre de la configuración actual (un cambio en config/ no espera al recálculo).
        prev_pron["rutas"] = cfg.get("rutas", [])
        prev_pron["lugares"] = cfg.get("lugares", [])
        escribir(salida / "pronostico.json", prev_pron)
        estado["fuentes"]["pronostico"] = {"generado": prev_pron["generado"], "accion": "reutilizado"}
    else:
        try:
            pron, arch = pronostico(http, cfg, umbrales, ahora)
            escribir(salida / "pronostico.json", pron)
            estado["fuentes"]["pronostico"] = {"generado": pron["generado"], "accion": "recalculado",
                                               "modelos": {m: v["estado"] for m, v in pron["modelos"].items()}}
            guardar_gz(archivo / f"pronostico_{ahora:%Y%m%dT%H%M}.json.gz",
                       {"generado": pron["generado"], "puntos": arch, "pronostico": pron})
        except Exception as e:  # noqa: BLE001
            estado["fuentes"]["pronostico"] = {"error": str(e)[:300]}
            if prev_pron:
                escribir(salida / "pronostico.json", prev_pron)
    calor_vigente = bool(prev_calor) and vigente and edad_h(prev_calor, ahora) < a.vigencia_h
    if calor_vigente:
        escribir(salida / "calor.json", prev_calor)
        estado["fuentes"]["calor"] = {"generado": prev_calor["generado"], "accion": "reutilizado"}
    else:
        try:
            calor = mapa_calor(http, ahora)
            escribir(salida / "calor.json", calor)
            estado["fuentes"]["calor"] = {"generado": calor["generado"], "accion": "recalculado"}
            guardar_gz(archivo / f"calor_{ahora:%Y%m%dT%H%M}.json.gz", calor)
        except Exception as e:  # noqa: BLE001
            estado["fuentes"]["calor"] = {"error": str(e)[:300]}
            if prev_calor:
                escribir(salida / "calor.json", prev_calor)

    # Estaciones (cada ejecución).
    prev_obs = leer_previo(a.previo, "estaciones.json")
    try:
        obs, crudo = observado(http, prev_obs, ahora)
        escribir(salida / "estaciones.json", obs)
        estado["fuentes"]["estaciones"] = {"generado": obs["generado"], "n": len(obs["estaciones"]),
                                           "vigentes": sum(1 for e in obs["estaciones"] if e["vigente"])}
        guardar_gz(archivo / f"estaciones_{ahora:%Y%m%dT%H%M}.json.gz",
                   [{"id": e["id"], "codigo": e["codigo"], "serie": e["serie"]} for e in crudo])
    except Exception as e:  # noqa: BLE001
        estado["fuentes"]["estaciones"] = {"error": str(e)[:300]}
        if prev_obs:
            escribir(salida / "estaciones.json", prev_obs)

    # Estado de las vías (ECU 911), cada ejecución.
    prev_vias = leer_previo(a.previo, "vias.json")
    try:
        vs = vias_ecu911(Http(reintentos=1, timeout=20))  # desde fuera de Ecuador suele no responder
        escribir(salida / "vias.json", {
            "generado": ahora.isoformat(timespec="minutes"),
            "fuente": "ECU 911, consulta de vías (consolida reportes del ECU 911, el MIT y la SNGR)",
            "enlace": "https://www.ecu911.gob.ec/consulta-de-vias/",
            "vias": vs,
        })
        estado["fuentes"]["vias"] = {"generado": ahora.isoformat(timespec="minutes"), "n": len(vs),
                                     "cerradas": sum(1 for v in vs if v["estado"].upper().startswith("CERRADA"))}
        guardar_gz(archivo / f"vias_{ahora:%Y%m%dT%H%M}.json.gz", vs)
    except Exception as e:  # noqa: BLE001 - sin vías la web muestra el enlace al ECU 911
        estado["fuentes"]["vias"] = {"error": str(e)[:300]}
        if prev_vias:
            escribir(salida / "vias.json", prev_vias)

    estado["llamadas_http"] = http.llamadas
    escribir(salida / "estado.json", estado)
    print(json.dumps(estado, ensure_ascii=False, indent=2))
    return 0 if (salida / "pronostico.json").exists() else 1


if __name__ == "__main__":
    sys.exit(main())
