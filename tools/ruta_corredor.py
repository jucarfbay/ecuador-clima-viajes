"""Geometría vial del corredor San Rafael (Quito) → Machachi → Latacunga → Ambato → Pelileo → Baños desde OSRM.

Se ejecuta a mano (flujo "Corredor: ruta") y el resultado se versiona en el repositorio, con fuente, fecha y
licencia, para que la escena no dependa del servidor de demostración de OSRM en cada visita.

Uso: python tools/ruta_corredor.py site/corredor/datos/ruta.json
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
OSRM = "https://router.project-osrm.org/route/v1/driving/"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
# Origen: San Rafael (Valle de los Chillos, cantón Rumiñahui). No es un punto del sistema de alertas: se geocodifica con
# OpenStreetMap (Nominatim) y se guarda la coordenada usada, con su fuente.
ORIGEN = {"id": "san-rafael", "nombre": "San Rafael", "consulta": "San Rafael, Rumiñahui, Pichincha, Ecuador",
          # El ensamble ECMWF por hora solo existe para las localidades de la ruta del sistema; la más cercana es Quito.
          "serie_ensamble": "quito"}
# Paradas que fijan el camino (la ruta pasa por ellas) y pasos de referencia (se ubican en la vía, sin desviarla).
PARADAS = ["latacunga", "ambato", "pelileo", "banos"]
PASOS = ["machachi"]
PASO_MAX_KM = 3.0
UA = "ecuador-clima-viajes/0.1 (uso personal, no comercial; github.com/jucarfbay/ecuador-clima-viajes)"


def decodificar_polyline(s: str, precision: int = 6) -> list[list[float]]:
    """Algoritmo de polilínea codificada de Google; devuelve [[lon, lat], ...]."""
    coords, i, lat, lon, f = [], 0, 0, 0, 10 ** precision
    while i < len(s):
        for eje in (0, 1):
            res = shift = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                res |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if eje == 0:
                lat += d
            else:
                lon += d
        coords.append([round(lon / f, 6), round(lat / f, 6)])
    return coords


def escalar_tiempos(d: dict) -> dict:
    """Concilia los tiempos: las anotaciones por vértice de OSRM no incluyen las penalizaciones de giro y suman menos
    que la duración total de la ruta. Se escalan proporcionalmente para que sumen la duración total, que es la cifra
    que se cita en todas partes. Idempotente."""
    total_s = d["duracion_min"] * 60
    suma = d["s"][-1]
    if abs(suma - total_s) < 1:
        return d
    f = total_s / suma
    d["s"] = [round(x * f, 1) for x in d["s"]]
    for h in d["hitos"]:
        h["min"] = round(d["s"][h["vertice"]] / 60, 2)
    d["tiempos"] = {
        "fuente": "duración total de la ruta según OSRM (incluye penalizaciones de giro)",
        "suma_anotaciones_min": round(suma / 60, 2), "duracion_ruta_min": d["duracion_min"], "factor": round(f, 5),
        "metodo": "tiempos por vértice de las anotaciones de OSRM, escalados para sumar la duración total",
    }
    return d


def _dist_km(a: list[float], b: list[float]) -> float:
    import math
    dy = (a[1] - b[1]) * 111.32
    dx = (a[0] - b[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot(dx, dy)


def ubicar_pasos(d: dict, pasos: list[dict]) -> dict:
    """Añade como hitos los pasos de referencia: el vértice de la ruta más cercano a cada localidad, si está a menos de
    PASO_MAX_KM. No cambian la geometría. Los hitos quedan ordenados por kilómetro."""
    for p in pasos:
        if any(h["id"] == p["id"] for h in d["hitos"]):
            continue
        dists = [_dist_km(c, [p["lon"], p["lat"]]) for c in d["coords"]]
        i = min(range(len(dists)), key=dists.__getitem__)
        if dists[i] > PASO_MAX_KM:
            raise ValueError(f"{p['nombre']} queda a {dists[i]:.1f} km de la ruta")
        d["hitos"].append({
            "id": p["id"], "nombre": p["nombre"], "lat": p["lat"], "lon": p["lon"], "tipo": "paso",
            "en_via": {"lon": d["coords"][i][0], "lat": d["coords"][i][1], "desplazamiento_m": round(dists[i] * 1000, 1)},
            "vertice": i, "km": d["km"][i], "min": round(d["s"][i] / 60, 2),
        })
    d["hitos"].sort(key=lambda h: h["km"])
    return d


def construir(respuesta: dict, hitos: list[dict], url: str, consultado: str) -> dict:
    r = respuesta["routes"][0]
    coords = decodificar_polyline(r["geometry"])
    km, s = [0.0], [0.0]
    for leg in r["legs"]:
        a = leg["annotation"]
        for d, t in zip(a["distance"], a["duration"]):
            km.append(km[-1] + d / 1000)
            s.append(s[-1] + t)
    if len(km) != len(coords):
        raise ValueError(f"vértices {len(coords)} y anotaciones {len(km)} no coinciden")
    # Índice del vértice de cada hito: fin acumulado de cada tramo.
    idx, acum = [0], 0
    for leg in r["legs"]:
        acum += len(leg["annotation"]["distance"])
        idx.append(acum)
    salida_hitos = []
    for h, i, wp in zip(hitos, idx, respuesta["waypoints"]):
        salida_hitos.append({
            "id": h["id"], "nombre": h["nombre"], "lat": h["lat"], "lon": h["lon"], "tipo": "parada",
            **({"serie_ensamble": h["serie_ensamble"]} if h.get("serie_ensamble") else {}),
            "en_via": {"lon": wp["location"][0], "lat": wp["location"][1], "desplazamiento_m": round(wp["distance"], 1)},
            "vertice": i, "km": round(km[i], 3), "min": round(s[i] / 60, 2),
        })
    out = {
        "fuente": "OSRM (router.project-osrm.org) sobre OpenStreetMap",
        "licencia": "Datos de ruta © colaboradores de OpenStreetMap, ODbL 1.0",
        "url": url,
        "consultado": consultado,
        "nota": "Tiempos de OSRM sin tráfico ni paradas. Estimación inicial; no reemplaza el estado de vías del ECU 911.",
        "distancia_km": round(r["distance"] / 1000, 3),
        "duracion_min": round(r["duration"] / 60, 2),
        "hitos": salida_hitos,
        "coords": coords,
        "km": [round(x, 4) for x in km],
        "s": [round(x, 1) for x in s],
    }
    return escalar_tiempos(out)


def geocodificar(o: dict) -> dict:
    """Coordenada del origen según OpenStreetMap (Nominatim), con la fuente para citarla. Se prefiere el lugar poblado
    (parroquia, barrio) o su límite administrativo frente a un comercio que lleve el mismo nombre."""
    import urllib.parse
    q = urllib.parse.urlencode({"q": o["consulta"], "format": "jsonv2", "limit": 10, "countrycodes": "ec"})
    req = urllib.request.Request(f"{NOMINATIM}?{q}", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        res = json.loads(resp.read().decode("utf-8"))
    for x in res:  # visible en las anotaciones del flujo
        print(f"::notice title=Nominatim::{x.get('category')}/{x.get('type')} {x['lat']},{x['lon']} {x.get('display_name')}")
    if not res:
        raise SystemExit(f"Nominatim no encontró «{o['consulta']}»")
    orden = lambda x: (0 if x.get("category") == "place" else 1 if x.get("category") == "boundary" else 2)  # noqa: E731
    r = sorted(res, key=orden)[0]  # sorted es estable: dentro de cada grupo, el orden de relevancia de Nominatim
    print(f"::notice title=Origen::{r.get('category')}/{r.get('type')} {r['lat']},{r['lon']} {r.get('display_name')}")
    return {**o, "lat": round(float(r["lat"]), 5), "lon": round(float(r["lon"]), 5),
            "geocodificado": {"fuente": "OpenStreetMap Nominatim", "nombre": r.get("display_name"),
                              "osm": f"{r.get('osm_type')}/{r.get('osm_id')}", "tipo": f"{r.get('category')}/{r.get('type')}"}}


def main(destino: str):
    cfg = json.loads((RAIZ / "config" / "puntos.json").read_text(encoding="utf-8"))
    por_id = {p["id"]: p for p in cfg["puntos"]}
    origen = geocodificar(ORIGEN)
    hitos = [origen] + [por_id[h] for h in PARADAS]
    url = OSRM + ";".join(f"{p['lon']},{p['lat']}" for p in hitos) + \
        "?overview=full&geometries=polyline6&steps=false&annotations=duration,distance"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as resp:
        datos = json.loads(resp.read().decode("utf-8"))
    if datos.get("code") != "Ok":
        raise SystemExit(f"OSRM respondió {datos.get('code')}")
    out = construir(datos, hitos, url, datetime.now(timezone.utc).isoformat(timespec="seconds"))
    out["origen"] = {"consulta": origen["consulta"], **origen["geocodificado"], "lat": origen["lat"], "lon": origen["lon"]}
    ubicar_pasos(out, [por_id[p] for p in PASOS])
    Path(destino).parent.mkdir(parents=True, exist_ok=True)
    Path(destino).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{out['distancia_km']} km, {out['duracion_min']} min, {len(out['coords'])} vértices ->", destino)
    for h in out["hitos"]:
        print(f"  {h['nombre']:<12} km {h['km']:>7.2f}  min {h['min']:>6.1f}  a {h['en_via']['desplazamiento_m']} m de la vía")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--conciliar":  # aplica la conciliación a un archivo ya descargado
        f = Path(sys.argv[2])
        f.write_text(json.dumps(escalar_tiempos(json.loads(f.read_text(encoding="utf-8"))), ensure_ascii=False,
                                separators=(",", ":")), encoding="utf-8")
        print("conciliado", f)
    else:
        main(sys.argv[1] if len(sys.argv) > 1 else "site/corredor/datos/ruta.json")
