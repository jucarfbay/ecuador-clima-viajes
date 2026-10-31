# ecuador-clima-viajes

Sistema de monitoreo de lluvias, pronósticos meteorológicos y planificación de viajes en Ecuador.

Web de uso personal y familiar con el pronóstico probabilístico de lluvia para viajes y lugares de Ecuador durante El Niño 2026-27. Complementa, no reemplaza, los avisos del INAMHI, la SNGR y el ECU 911.

**Estado: MVP, no calibrado.** Los umbrales y cortes de probabilidad son provisionales hasta verificarlos con lluvia observada (Plan 4 y Plan 5 del documento de diseño).

## Qué muestra

- **Lugares (inicio):** tus lugares (las 24 capitales, Baños y otras 39 ciudades, más "Mi ubicación"), con una frase de respuesta, el hietograma de las próximas 72 h en bloques de 3 h, la lluvia medida en la estación más cercana y los próximos días. Los favoritos se guardan en el teléfono y en el enlace (`?l=quito,banos`), para compartirlos.
- **Viaje:** para una ruta (por ahora Quito → Baños), barras por hora de salida con la lluvia esperada en la ruta, la ruta como carretera con la lluvia en cada tramo a la hora de paso, aviso si llegas de noche y otra salida solo si es más seca en al menos 7,5 de cada 10 escenarios.
- **Mapa:** fondo satelital Sentinel-2, nombres de ciudades, pronóstico de lluvia por hora (72 h, con reproductor), estaciones del INAMHI que registran lluvia, botón Ubicarme y capas opcionales de nubes GOES (~40 min de retraso) y lluvia satelital IMERG (~5-6 h de retraso).
- **Provincias:** lista de la peor a la mejor para el día elegido, con cuántos puntos alcanzan el nivel; tabla completa como detalle.

**Ubicación:** se usa solo en el teléfono para elegir el punto del sistema más cercano; no se envía a ningún servidor ni se guarda en el enlace.

**Sin conexión:** la página y los últimos datos quedan guardados en el teléfono (service worker) y se muestran con un aviso si no hay red.

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
GitHub Actions (cada hora, idealmente disparado desde fuera; ver abajo)
  ├─ pronóstico y mapa de calor: solo si el publicado (o, si el sitio no responde, el último archivado) tiene más de 5,5 h
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

### Disparador externo (recomendado)

GitHub no respeta la frecuencia horaria de los flujos programados: en 19 h corrió solo 3 veces. Para que la lluvia medida llegue cada hora, un servicio gratuito de tareas programadas puede iniciar el flujo:

1. En GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Repositorio: solo `ecuador-clima-viajes`. Permiso: **Actions: Read and write**. Vencimiento: 1 año.
2. En [cron-job.org](https://cron-job.org) (gratis), crea una tarea cada hora, en el minuto 10:
   - URL: `https://api.github.com/repos/jucarfbay/ecuador-clima-viajes/actions/workflows/datos.yml/dispatches`
   - Método: `POST`
   - Encabezados: `Authorization: Bearer <tu token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`
   - Cuerpo: `{"ref":"main"}`
3. GitHub responde `204` si la llamada funcionó; la ejecución aparece en **Actions**.

El freno de 5,5 h evita que más ejecuciones gasten cuota de Open-Meteo: el pronóstico se recalcula como máximo unas 4 veces al día.

El flujo "Mantener activo" hace un commit mínimo al mes, porque GitHub desactiva los flujos programados de repositorios públicos tras 60 días sin actividad.

## Configuración

- `config/puntos.json`: puntos por provincia, lugares guardados y rutas (con minutos aproximados entre puntos).
- `config/umbrales.json`: umbrales del INAMHI por región (versionados con fecha y fuente) y cortes de probabilidad.

Para agregar un lugar o una ruta, edita `config/puntos.json` y haz push: el flujo recalcula y publica.

## Desarrollo

```bash
python -m unittest discover -s tests -v      # pruebas del pipeline, sin red
node --test tests/logica.test.js             # pruebas de la lógica de la web
python tools/demo.py site/data               # datos de DEMOSTRACIÓN para revisar la interfaz
python -m pipeline.run --salida site/data    # datos reales (requiere internet)
```

## Limitaciones conocidas

- Celdas del ensamble de ~25 km: subestiman los aguaceros locales en los Andes.
- Los niveles usan umbrales del INAMHI por región y cortes sin calibrar.
- Tiempos de viaje aproximados; no evalúa deslaves ni el estado de la vía (consulta el ECU 911).
- La lluvia de estaciones se interpreta como acumulada en la hora que termina en la fecha indicada (por confirmar con el INAMHI).

## Licencias y atribución

Datos de Open-Meteo y ECMWF bajo CC BY 4.0. Sentinel-2 cloudless 2024 by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0. Imágenes de NASA GIBS/EOSDIS. Estaciones: INAMHI. Calles: © OpenStreetMap. Leaflet (BSD-2) y tipografía Overpass (SIL OFL 1.1) incluidas en `site/vendor` y `site/fuentes`. Uso personal, no comercial.
