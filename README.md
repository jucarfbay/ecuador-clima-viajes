# ecuador-clima-viajes

Sistema de monitoreo de lluvias, pronósticos meteorológicos y planificación de viajes en Ecuador.

Web de uso personal y familiar con el pronóstico probabilístico de lluvia para viajes y lugares de Ecuador durante El Niño 2026-27. Complementa, no reemplaza, los avisos del INAMHI, la SNGR y el ECU 911.

**Estado: MVP, no calibrado.** Los umbrales y cortes de probabilidad son provisionales hasta verificarlos con lluvia observada (Plan 4 y Plan 5 del documento de diseño).

## Qué muestra

- **Viaje:** para una ruta (por ahora Quito → Baños) y una hora de salida, el pronóstico en cada tramo a la hora en que pasarás por él, y si salir unas horas antes o después reduce la lluvia (solo cuando ocurre en al menos 75 % de los escenarios). Incluye la lluvia medida en las estaciones cercanas.
- **Lugares:** los próximos 3 días en bloques de 3 h y los próximos 10 días por nivel.
- **Mapa:** fondo satelital Sentinel-2, pronóstico de lluvia por hora (72 h), estaciones del INAMHI, y como capas opcionales las nubes GOES (~40 min de retraso) y la lluvia satelital IMERG (~5-6 h de retraso).
- **Provincias:** el peor nivel por provincia y día, con cuántos puntos lo alcanzan.

## Fuentes (todas públicas)

| Fuente | Uso | Frecuencia |
| --- | --- | --- |
| Open-Meteo: ECMWF IFS ENS (51 miembros), ECMWF AIFS ENS (IA, 51), NOAA GEFS (31) | Probabilidades por día, bloques de 3 h y viaje | Cada 6 h |
| Open-Meteo: ECMWF IFS HRES 9 km | Mapa de calor por hora | Cada 6 h |
| Visor de estaciones del INAMHI | Lluvia observada por hora (~1 h de retraso) | Cada hora |
| NASA GIBS (GOES-East GeoColor, GPM IMERG) | Capas satelitales del mapa | Directo en el navegador |
| EOX Sentinel-2 cloudless 2024 | Fondo del mapa | Fijo |

El servicio del visor del INAMHI no tiene documentación ni términos publicados: se consulta con moderación y el sistema tolera que falle. Se pidió acceso formal por LOTAIP.

## Cómo funciona

```
GitHub Actions (cada hora)
  ├─ pronóstico: solo si el publicado tiene más de 5,5 h (los modelos se actualizan cada 6 h)
  ├─ estaciones del INAMHI: siempre
  ├─ archivo histórico (.json.gz) → versión mensual "archivo-AAAA-MM" (fuera de git)
  └─ publica site/ en GitHub Pages (sin commits de datos)
```

El pipeline usa solo la biblioteca estándar de Python. Los datos quedan en `site/data/`:

- `pronostico.json`: niveles, probabilidades y escenarios por punto, provincia, lugar y ruta.
- `calor.json`: rejilla de 0,25° con lluvia por hora.
- `estaciones.json`: lluvia observada.
- `estado.json`: frescura de cada fuente y llamadas realizadas.

## Publicarlo (una sola vez)

1. El repositorio debe ser **público** (condición de GitHub Pages gratuito).
2. En el repositorio: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Sube este proyecto a la rama `main`.
4. En **Actions**, ejecuta "Datos y publicación" con "Run workflow" (marca *forzar* la primera vez).
5. La web queda en `https://jucarfbay.github.io/ecuador-clima-viajes/`.

El flujo "Mantener activo" hace un commit mínimo al mes, porque GitHub desactiva los flujos programados de repositorios públicos tras 60 días sin actividad.

## Configuración

- `config/puntos.json`: puntos por provincia, lugares guardados y rutas (con minutos aproximados entre puntos).
- `config/umbrales.json`: umbrales del INAMHI por región (versionados con fecha y fuente) y cortes de probabilidad.

Para agregar un lugar o una ruta, edita `config/puntos.json` y haz push: el flujo recalcula y publica.

## Desarrollo

```bash
python -m unittest discover -s tests -v      # pruebas sin red
python tools/demo.py site/data               # datos de DEMOSTRACIÓN para revisar la interfaz
python -m pipeline.run --salida site/data    # datos reales (requiere internet)
```

## Limitaciones conocidas

- Celdas del ensamble de ~25 km: subestiman los aguaceros locales en los Andes.
- Los niveles usan umbrales del INAMHI por región y cortes sin calibrar.
- Tiempos de viaje aproximados; no evalúa deslaves ni el estado de la vía (consulta el ECU 911).
- La lluvia de estaciones se interpreta como acumulada en la hora que termina en la fecha indicada (por confirmar con el INAMHI).

## Licencias y atribución

Datos de Open-Meteo y ECMWF bajo CC BY 4.0. Sentinel-2 cloudless 2024 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0. Imágenes de NASA GIBS/EOSDIS. Estaciones: INAMHI. Calles: © OpenStreetMap. Uso personal, no comercial.
