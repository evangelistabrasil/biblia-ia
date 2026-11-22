#!/usr/bin/env python3
"""Diagnóstico das versões do eBible (NBV, NTB, BLT, TFT). Não altera nada no projeto.
   python diagnosticar_versoes.py > diag.txt
"""
import collections
import io
import re
import sys
import urllib.request
import zipfile

sys.path.insert(0, ".")
from preparar_versoes import IDX_USFM, VERSOES

for vid in ("nbv", "ntb", "blt", "tft"):
    url = VERSOES[vid]["fonte"]
    print("=" * 70, f"\n{vid.upper()}  {url}")
    try:
        dados = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "biblia-ia/1.0"}), timeout=120).read()
    except Exception as e:
        print("  ERRO ao baixar:", e); continue
    z = zipfile.ZipFile(io.BytesIO(dados))
    print("  arquivos no zip:", [(n, i.file_size) for n, i in ((i.filename, i) for i in z.infolist())])
    for nome in z.namelist():
        if not nome.lower().endswith(".txt"):
            continue
        texto = z.read(nome).decode("utf-8-sig", errors="replace")
        linhas = texto.splitlines()
        print(f"\n  --- {nome}: {len(linhas)} linhas")
        for l in linhas[:4]:
            print("   |", l[:110])
        codigos = collections.Counter()
        livros_versos = collections.Counter()
        estranhas = []
        for l in linhas:
            m = re.match(r"^\s*(\S+)\s+(\d+):(\d+)", l)
            if m:
                codigos[m.group(1)] += 1
            elif l.strip():
                estranhas.append(l)
        print("   códigos de livro (ordem do arquivo):")
        print("   ", " ".join(f"{c}:{n}" for c, n in codigos.items()))
        fora = [c for c in codigos if c not in IDX_USFM]
        print("   códigos NÃO reconhecidos:", fora)
        faltam = [c for c in IDX_USFM if c not in codigos]
        print("   livros que NÃO aparecem:", faltam)
        print(f"   linhas sem formato 'LIVRO cap:vers' ({len(estranhas)}):")
        for l in estranhas[:8]:
            print("   ?", l[:110])
        vazias = sum(1 for l in linhas if re.match(r"^\s*\S+\s+\d+:\d+\s*$", l))
        print("   versículos sem texto:", vazias)
        juntos = [l[:40] for l in linhas if re.match(r"^\s*\S+\s+\d+:\d+-\d+", l)][:5]
        print("   exemplos de versículos juntados:", juntos)
