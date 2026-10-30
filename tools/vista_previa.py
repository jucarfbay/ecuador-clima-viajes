"""Arma una vista previa de una sola página (para publicar como artifact) a partir de site/ y datos de demostración.

El artifact solo admite estilos propios, así que se incrustan estilos.css y leaflet.css. Las teselas del mapa
(EOX, NASA GIBS, CARTO) se bloquean en la vista previa; en GitHub Pages sí cargan.
"""
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def main(leaflet_css: str, destino: str = "site_demo"):
    d = Path(destino)
    html = (RAIZ / "site/index.html").read_text(encoding="utf-8")
    cuerpo = re.search(r"<body>(.*)</body>", html, re.S).group(1)
    cuerpo = cuerpo.replace('<script src="app.js"></script>', '<script src="app.js"></script>')
    estilos = (RAIZ / "site/estilos.css").read_text(encoding="utf-8")
    pagina = (
        "<title>Alerta de lluvias Ecuador</title>\n"
        f"<style>\n{Path(leaflet_css).read_text(encoding='utf-8')}\n</style>\n"
        f"<style>\n{estilos}\n</style>\n"
        f"{cuerpo.strip()}\n"
    )
    (d / "index.html").write_text(pagina, encoding="utf-8")
    (d / "app.js").write_text((RAIZ / "site/app.js").read_text(encoding="utf-8"), encoding="utf-8")
    print("Vista previa en", d / "index.html")


if __name__ == "__main__":
    main(*sys.argv[1:])
