"""Genera datos de DEMOSTRACIÓN (sintéticos) con el mismo formato que el pipeline, para revisar la interfaz
sin conexión. No son un pronóstico: la web muestra un aviso cuando estado.json trae "demo": true."""
import json
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

from pipeline import run  # noqa: E402
from pipeline.fuentes import ENSEMBLE_URL, FORECAST_URL  # noqa: E402

ECU = timezone(timedelta(hours=-5))


def lluvia(lat, lon, m, t, rnd):
    h = t.hour
    tarde = math.exp(-((h - 16) ** 2) / 8)  # convección de la tarde
    humedad = 1.6 if lon > -78.3 else (1.2 if lon < -79.3 else 0.8)
    dia = (t.date() - datetime(2026, 10, 29).date()).days
    ola = 1 + 0.6 * math.sin(dia * 0.9 + lat)
    base = max(0.0, rnd.gauss(1.0, 0.7)) * 3.0 * tarde * humedad * ola
    return round(base if rnd.random() < 0.55 + 0.1 * humedad else 0.0, 1)


class HttpDemo:
    llamadas = 0

    def get(self, url, params=None):
        lats = [float(x) for x in params["latitude"].split(",")]
        lons = [float(x) for x in params["longitude"].split(",")]
        t0 = datetime(2026, 10, 29, 0, 0)
        n_h = 24 * params["forecast_days"]
        tiempos = [(t0 + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(n_h)]
        out = []
        for la, lo in zip(lats, lons):
            rnd = random.Random(f"{la}{lo}{params.get('models')}")
            if url == ENSEMBLE_URL:
                n = 31 if params["models"] == "ncep_gefs025" else 51
                hourly = {"time": tiempos}
                for m in range(n):
                    clave = "precipitation" if m == 0 else f"precipitation_member{m:02d}"
                    hourly[clave] = [lluvia(la, lo, m, t0 + timedelta(hours=i + 1), rnd) for i in range(n_h)]
                out.append({"elevation": 2500.0, "hourly": hourly})
            elif url == FORECAST_URL:
                out.append({"hourly": {"time": tiempos, "precipitation":
                                       [lluvia(la, lo, 0, t0 + timedelta(hours=i + 1), rnd) for i in range(n_h)]}})
        return out


def estaciones_demo(ahora):
    rnd = random.Random(7)
    sitios = [("TOCTIUCO - EPMAPS QUITO", -0.2025, -78.525), ("IZOBAMBA", -0.3659, -78.5551),
              ("LATACUNGA AEROPUERTO", -0.9064, -78.6158), ("AMBATO", -1.2539, -78.6264),
              ("BAÑOS", -1.3964, -78.4320), ("PUYO", -1.5070, -78.0627), ("GUAYAQUIL", -2.1990, -79.8837)]
    fin = ahora.replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    salida = []
    for i, (nombre, la, lo) in enumerate(sitios):
        serie = [[(fin - timedelta(hours=h)).isoformat(timespec="minutes"), round(max(0, rnd.gauss(0.3, 1.2)), 1)]
                 for h in range(23, -1, -1)]
        vals = [v for _, v in serie]
        salida.append({"id": i, "codigo": f"DEMO{i}", "nombre": nombre, "provincia": "", "propietario": "DEMO",
                       "lat": la, "lon": lo, "altitud": None, "frecuencia": "1 HORA", "tablas": [],
                       "ultimo": fin.isoformat(timespec="minutes"), "retraso_h": 1.0,
                       "mm_1h": vals[-1], "mm_3h": round(sum(vals[-3:]), 1), "mm_24h": round(sum(vals), 1),
                       "mm_72h": round(sum(vals) * 2.4, 1), "ultimas_24h": serie})
    return {"generado": ahora.isoformat(timespec="minutes"), "fuente": "DEMO", "estaciones": salida}


def main(destino):
    ahora = datetime(2026, 10, 29, 20, 30, tzinfo=ECU)
    cfg = json.loads((RAIZ / "config/puntos.json").read_text(encoding="utf-8"))
    umb = json.loads((RAIZ / "config/umbrales.json").read_text(encoding="utf-8"))
    http = HttpDemo()
    pron, _ = run.pronostico(http, cfg, umb, ahora)
    calor = run.mapa_calor(http, ahora)
    obs = estaciones_demo(ahora)
    d = Path(destino)
    run.escribir(d / "pronostico.json", pron)
    run.escribir(d / "calor.json", calor)
    run.escribir(d / "estaciones.json", obs)
    run.escribir(d / "estado.json", {"generado": pron["generado"], "demo": True})
    print("Datos de demostración en", d)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "site_demo/data")
