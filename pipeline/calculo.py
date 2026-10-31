"""Cálculo de probabilidades, niveles de alerta y confianza a partir de los miembros del ensamble.

Convenciones:
- Open-Meteo entrega `precipitation` como suma de la hora anterior, en la hora local del punto
  (America/Guayaquil, UTC-5; Galápagos, UTC-6). La lluvia de la hora que termina en T se asigna a la fecha de T - 1 h.
- Los niveles usan umbrales del INAMHI y cortes de probabilidad NO calibrados (ver config/umbrales.json).
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

NIVELES = [
    {"codigo": 0, "clave": "sin_senal", "texto": "Sin señal de lluvia fuerte", "icono": "○", "corto": "Sin señal"},
    {"codigo": 1, "clave": "vigilar", "texto": "Vigilar", "icono": "◇", "corto": "Vigilar"},
    {"codigo": 2, "clave": "prepararse", "texto": "Prepararse", "icono": "▲", "corto": "Prepararse"},
    {"codigo": 3, "clave": "actuar", "texto": "Actuar", "icono": "■", "corto": "Actuar"},
]


ECU = timezone(timedelta(hours=-5))


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s)


def local(ahora: datetime, offset_s: int = -18000) -> datetime:
    """Hora local sin zona del punto (como los tiempos de Open-Meteo con su zona horaria); por defecto UTC-5."""
    if not ahora.tzinfo:
        return ahora
    return ahora.astimezone(timezone(timedelta(seconds=offset_s))).replace(tzinfo=None)


def _validos(xs):
    return [x for x in xs if x is not None and not (isinstance(x, float) and math.isnan(x))]


def prob(totales, umbral: float) -> float | None:
    v = _validos(totales)
    if not v:
        return None
    return sum(1 for x in v if x >= umbral) / len(v)


def percentil(xs, q: float) -> float | None:
    v = sorted(_validos(xs))
    if not v:
        return None
    if len(v) == 1:
        return v[0]
    pos = q * (len(v) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return v[lo] + (v[hi] - v[lo]) * (pos - lo)


def acumulados_diarios(tiempos: list[str], miembros: list[list[float]], ahora: datetime, max_dias: int = 10,
                       offset_s: int = -18000):
    """Totales diarios por miembro. El día de hoy cuenta solo las horas que faltan (marcado `parcial`)."""
    ahora = local(ahora, offset_s)
    hora_actual = ahora.replace(minute=0, second=0, microsecond=0)
    por_fecha: dict[str, list[int]] = {}
    for i, ts in enumerate(tiempos):
        inicio = _t(ts) - timedelta(hours=1)  # la hora acumulada empieza 1 h antes
        if inicio < hora_actual:
            continue
        por_fecha.setdefault(inicio.date().isoformat(), []).append(i)
    hoy = hora_actual.date().isoformat()
    dias = []
    for fecha, idx in sorted(por_fecha.items()):
        parcial = fecha == hoy
        if not parcial and len(idx) < 24:
            continue  # día incompleto al final del horizonte
        totales = [sum(m[i] for i in idx) if all(not math.isnan(m[i]) for i in idx) else float("nan")
                   for m in miembros]
        dias.append({"fecha": fecha, "parcial": parcial, "horas": len(idx), "totales": totales})
        if len(dias) >= max_dias + (1 if dias[0]["parcial"] else 0):
            break
    return dias


def nivel_desde_probs(p: dict, cortes: dict) -> int:
    """p = {"medio": P, "alto": P, "muy_alto": P} -> código de nivel 0..3."""
    def ge(nombre, corte):
        return p.get(nombre) is not None and p[nombre] >= corte
    if ge("muy_alto", cortes["actuar"]["muy_alto"]):
        return 3
    if ge("alto", cortes["prepararse"]["alto"]) or ge("muy_alto", cortes["prepararse"]["muy_alto"]):
        return 2
    if ge("alto", cortes["vigilar"]["alto"]) or ge("medio", cortes["vigilar"]["medio"]):
        return 1
    return 0


def combinar(probs_por_modelo: dict, pesos: dict) -> float | None:
    """Promedio ponderado de probabilidades entre modelos disponibles (pesos renormalizados)."""
    pares = [(pesos[m], p) for m, p in probs_por_modelo.items() if p is not None]
    if not pares:
        return None
    total = sum(w for w, _ in pares)
    return sum(w * p for w, p in pares) / total


def confianza(dia_indice: int, dispersion: float | None) -> str:
    """Confianza por plazo (días 0-3 alta, 4-7 media, 8+ tendencia); baja un nivel si los modelos discrepan."""
    escala = ["alta", "media", "tendencia"]
    nivel = 0 if dia_indice <= 3 else (1 if dia_indice <= 7 else 2)
    if dispersion is not None and dispersion > 0.4:
        nivel = min(nivel + 1, 2)
    return escala[nivel]


def bloques_3h(tiempos, miembros, ahora: datetime, horas: int = 84, umbrales: dict | None = None,
               offset_s: int = -18000):
    """Bloques locales de 3 h (00-03, 03-06, ...) desde el bloque en curso, con probabilidades por clase.

    Se calculan 84 h para que, aunque el pronóstico se reutilice hasta 6 h, la web siempre tenga 72 h por delante."""
    ahora = local(ahora, offset_s)
    umbrales = umbrales or {"ligera_mm": 0.5, "moderada_mm": 7.5, "fuerte_mm": 22.8}
    hora_actual = ahora.replace(minute=0, second=0, microsecond=0)
    inicio_bloque = hora_actual.replace(hour=(hora_actual.hour // 3) * 3)
    indice = {_t(ts): i for i, ts in enumerate(tiempos)}
    bloques = []
    b = inicio_bloque
    while b < hora_actual + timedelta(hours=horas):
        fines = [b + timedelta(hours=k) for k in (1, 2, 3)]
        if not all(f in indice for f in fines):
            break
        idx = [indice[f] for f in fines]
        tot = [sum(m[i] for i in idx) for m in miembros]
        bloques.append({
            "inicio": b.isoformat(timespec="minutes"),
            "en_curso": b <= ahora < b + timedelta(hours=3),
            "p_ligera": _r(prob(tot, umbrales["ligera_mm"])),
            "p_moderada": _r(prob(tot, umbrales["moderada_mm"])),
            "p_fuerte": _r(prob(tot, umbrales["fuerte_mm"])),
            "p10": _r(percentil(tot, 0.1), 1),
            "p50": _r(percentil(tot, 0.5), 1),
            "p90": _r(percentil(tot, 0.9), 1),
        })
        b += timedelta(hours=3)
    return bloques


def clase_bloque(bl: dict) -> int:
    """0 sin lluvia relevante, 1 ligera, 2 moderada, 3 fuerte (cortes sin calibrar)."""
    if (bl["p_fuerte"] or 0) >= 0.3:
        return 3
    if (bl["p_moderada"] or 0) >= 0.5:
        return 2
    if (bl["p_ligera"] or 0) >= 0.5:
        return 1
    return 0


def serie_horaria(tiempos, miembros, ahora: datetime, horas: int = 84, offset_s: int = -18000):
    """Miembros hora a hora desde la próxima hora, en décimas de mm (enteros), para el planificador de viajes.

    El ensamble IFS es nativo cada 3 h; Open-Meteo interpola a 1 h. La web lo usa solo para ubicar el paso
    por cada tramo, no para afirmar a qué hora exacta llueve."""
    ahora = local(ahora, offset_s)
    proxima = ahora.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    sel = [i for i, ts in enumerate(tiempos) if proxima <= _t(ts) < proxima + timedelta(hours=horas)]
    return {
        "tiempos": [tiempos[i] for i in sel],
        "miembros_dmm": [[int(round(m[i] * 10)) if not math.isnan(m[i]) else None for i in sel] for m in miembros],
    }


def _r(x, n=2):
    return None if x is None else round(x, n)
