#!/usr/bin/env python3
"""Monta a pasta _site/ (GitHub Pages) a partir de web/.

  python preparar_site.py --releases https://github.com/USUARIO/REPO/releases/latest

No site o modelo de IA não vai junto (passa do limite de 100 MB por arquivo do GitHub):
ele é baixado do Hugging Face pelo navegador e fica guardado no aparelho.
"""
import argparse
import json
import shutil
import time
from pathlib import Path

WEB, SITE = Path("web"), Path("_site")
FORA = {"app.zip", "termux.sh", "arquivos.json"}

ap = argparse.ArgumentParser()
ap.add_argument("--releases", default="")
a = ap.parse_args()

shutil.rmtree(SITE, ignore_errors=True)
shutil.copytree(WEB, SITE, ignore=lambda d, nomes: [n for n in nomes if n in FORA or (Path(d) == WEB and n == "models")])
cfg = {"modeloRemoto": True}
if a.releases:
    cfg["releases"] = a.releases
(SITE / "config.js").write_text("window.BIBLIA_CONFIG = " + json.dumps(cfg) + ";\n", encoding="utf-8")
(SITE / ".nojekyll").write_text("")
lista = [{"p": "./", "t": (SITE / "index.html").stat().st_size}]
for f in sorted(SITE.rglob("*")):
    rel = f.relative_to(SITE).as_posix()
    if f.is_file() and rel not in ("sw.js", ".nojekyll") and not rel.startswith("lib/LICENSE"):
        lista.append({"p": rel, "t": f.stat().st_size})
total = sum(x["t"] for x in lista)
(SITE / "arquivos.json").write_text(json.dumps({"versao": time.strftime("%Y-%m-%d %H:%M"), "total": total, "arquivos": lista}))
maior = max(SITE.rglob("*"), key=lambda f: f.stat().st_size if f.is_file() else 0)
print(f"✔ _site/: {len(lista)} arquivos, {total / 1e6:.0f} MB (maior: {maior.name}, {maior.stat().st_size / 1e6:.0f} MB)")
