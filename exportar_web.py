#!/usr/bin/env python3
"""
Prepara a pasta web/ para o app do celular:

  1. web/biblia.json -> livros, versículos, sinônimos, pesos
     web/emb.bin     -> embeddings dos versículos (int8)
  2. web/models/...  -> modelo E5 em formato ONNX (baixado uma vez, ~118 MB)

O índice precisa ter sido criado com o modelo neural:
  python biblia_busca.py indexar biblia_almeida.json
"""

import argparse
import json
import pickle
import shutil
import sqlite3
import sys
from pathlib import Path

import numpy as np

import biblia_busca as bb

WEB = Path(__file__).parent / "web"
REPO_ONNX = "Xenova/multilingual-e5-small"     # mesmo modelo E5, convertido p/ ONNX
NOME_LOCAL = "multilingual-e5-small"
ARQS_MODELO = ["config.json", "tokenizer.json", "tokenizer_config.json",
               "special_tokens_map.json", "onnx/model_quantized.onnx"]
OPCIONAIS = {"special_tokens_map.json"}


def exportar_dados(permitir_lsa: bool):
    meta = bb.indice_atual()
    if not meta or not bb.DB_PATH.exists():
        sys.exit("Índice não encontrado. Rode: python biblia_busca.py indexar biblia_almeida.json")
    if meta["lsa"] is not None and not permitir_lsa:
        sys.exit("O índice atual foi feito com o motor reserva (LSA).\n"
                 "Recrie com o modelo neural:  python biblia_busca.py indexar biblia_almeida.json")

    db = sqlite3.connect(bb.DB_PATH)
    linhas = list(db.execute("SELECT livro, cap, ver, texto FROM versiculo ORDER BY id"))
    emb = np.load(bb.EMB_PATH).astype(np.float32)
    assert len(linhas) == len(emb), "índice e embeddings fora de sincronia; rode indexar de novo"

    # Estrutura compacta: livros -> nº de versículos por capítulo; textos numa lista só.
    livros, textos, atual = [], [], None
    for livro, cap, ver, texto in linhas:
        if livro != atual:
            atual = livro
            abrevs = next(a for n, a in bb.LIVROS if n == livro)
            livros.append({"nome": livro, "abrevs": abrevs, "caps": []})
        caps = livros[-1]["caps"]
        while len(caps) < cap:
            caps.append(0)
        caps[cap - 1] += 1
        textos.append(texto)

    versoes = exportar_versoes(linhas)
    atrib = Path(__file__).with_name("ATRIBUICAO.txt")
    dados = {
        "versao": "Bíblia Livre (Almeida 1819, rev. 2018)",
        "atribuicao": atrib.read_text(encoding="utf-8") if atrib.exists() else "",
        "modelo": NOME_LOCAL,
        "motor": meta["motor"],
        "dims": int(emb.shape[1]),
        "livros": livros,
        "textos": textos,
        "versoes": versoes,
        "alias_extra": {"jo": "João"},
        "sinonimos": bb.SINONIMOS,
        "stopwords": sorted(bb.STOPWORDS),
        "pesos": bb.PESOS,
        "rrf_k": bb.RRF_K,
    }
    WEB.mkdir(exist_ok=True)
    (WEB / "biblia.json").write_text(json.dumps(dados, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    # embeddings em int8 (4x menor que float32, quase a mesma qualidade no ranking)
    q = np.clip(np.round(emb * 127), -127, 127).astype(np.int8)
    (WEB / "emb.bin").write_bytes(q.tobytes())
    (WEB / "dados.json").unlink(missing_ok=True)   # formato antigo
    mb = lambda f: (WEB / f).stat().st_size / 1e6
    print(f"✔ web/biblia.json ({mb('biblia.json'):.1f} MB): {len(livros)} livros, {len(textos)} versículos")
    print(f"✔ web/emb.bin ({mb('emb.bin'):.1f} MB): embeddings {emb.shape[0]} × {emb.shape[1]}")


def exportar_versoes(linhas):
    """Cada versão vira web/versoes/<id>.json com os textos alinhados aos índices da Almeida
    (mesma posição = mesmo livro/capítulo/versículo; null onde a versão não tem o versículo)."""
    nomes = [n for n, _ in bb.LIVROS]
    chave = {(nomes.index(lv), c, v): i for i, (lv, c, v, _) in enumerate(linhas)}
    pasta_web = WEB / "versoes"
    shutil.rmtree(pasta_web, ignore_errors=True)
    pasta_web.mkdir(parents=True)
    lista = [{"id": "almeida", "sigla": "ALM", "nome": "Almeida (Bíblia Livre 1819, rev. 2018)", "idioma": "pt", "testamento": "ambos"}]
    ordem = ["nbv", "ntb", "blt", "tft", "wlc", "byz", "jps", "kjv", "rv1909", "lsg"]
    arquivos = sorted((Path(__file__).parent / "versoes").glob("*.json"),
                      key=lambda f: ordem.index(f.stem) if f.stem in ordem else 99)
    for f in arquivos:
        d = json.loads(f.read_text(encoding="utf-8"))
        textos, extras = [None] * len(linhas), 0
        for b, c, v, t in d["versos"]:
            i = chave.get((b, c, v))
            if i is None:   # versículo que a Almeida não tem: junta ao anterior do mesmo capítulo
                extras += 1
                ant = max((chave[(b, c, x)] for x in range(v - 1, 0, -1) if (b, c, x) in chave), default=None)
                if ant is not None:
                    textos[ant] = (textos[ant] or "") + " " + t
                continue
            textos[i] = t
        tst = d.get("testamento", "ambos")
        dentro = [i for i, (lv, *_ ) in enumerate(linhas)
                  if tst == "ambos" or (tst == "at") == (nomes.index(lv) < 39)]
        faltam = sum(textos[i] is None for i in dentro)
        (pasta_web / f"{d['id']}.json").write_text(json.dumps(
            {k: d[k] for k in ("id", "sigla", "nome", "idioma", "atribuicao")} | {"textos": textos, "testamento": d.get("testamento", "ambos")},
            ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        lista.append({k: d[k] for k in ("id", "sigla", "nome", "idioma")} | {"atribuicao": d["atribuicao"], "testamento": d.get("testamento", "ambos")})
        parte = {"at": " (só Antigo Testamento)", "nt": " (só Novo Testamento)"}.get(tst, "")
        print(f"✔ versão {d['sigla']}{parte}: {len(dentro) - faltam} versículos"
              + (f" ({faltam} unidos ao vizinho)" if faltam else "") + (f", {extras} extras juntados" if extras else ""))
    return lista


def baixar_modelo():
    destino = WEB / "models" / NOME_LOCAL
    faltando = [a for a in ARQS_MODELO if not (destino / a).exists() and a not in OPCIONAIS]
    if not faltando:
        print("✔ modelo ONNX já está em web/models/ (não precisa baixar)")
        return
    print(f"Baixando o modelo ONNX ({REPO_ONNX}, ~118 MB, só na primeira vez)...")
    from huggingface_hub import hf_hub_download
    for arq in ARQS_MODELO:
        try:
            caminho = hf_hub_download(REPO_ONNX, arq)
        except Exception as e:
            if arq in OPCIONAIS:
                continue
            sys.exit(f"✘ Falha ao baixar {arq}: {e}")
        (destino / arq).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(caminho, destino / arq)
        print(f"   {arq}")
    print("✔ modelo ONNX pronto em web/models/")


FORA_DA_LISTA = {"app.zip", "termux.sh", "arquivos.json", "sw.js"}


def empacotar(zip_termux: bool = True):
    """arquivos.json: o que o botão 'Baixar' guarda no aparelho.
    app.zip: cópia do app inteiro para instalar no Termux do celular."""
    import time
    import zipfile
    lista = [{"p": "./", "t": (WEB / "index.html").stat().st_size}]
    for f in sorted(WEB.rglob("*")):
        rel = f.relative_to(WEB).as_posix()
        if f.is_file() and rel not in FORA_DA_LISTA and not rel.startswith("lib/LICENSE"):
            lista.append({"p": rel, "t": f.stat().st_size})
    total = sum(a["t"] for a in lista)
    (WEB / "arquivos.json").write_text(json.dumps({"versao": time.strftime("%Y-%m-%d %H:%M"), "total": total,
                                                   "arquivos": lista}), encoding="utf-8")
    print(f"✔ web/arquivos.json: {len(lista)} arquivos, {total / 1e6:.0f} MB para guardar no aparelho")
    if not zip_termux:
        return
    destino = WEB / "app.zip"
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED, compresslevel=3) as z:
        for f in sorted(WEB.rglob("*")):
            if f.is_file() and f.name not in ("app.zip", "termux.sh"):
                z.write(f, "web/" + f.relative_to(WEB).as_posix())
        z.write(Path(__file__).with_name("servidor.py"), "servidor.py")
    print(f"✔ web/app.zip ({destino.stat().st_size / 1e6:.0f} MB) para instalar pelo Termux")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--sem-modelo", action="store_true", help="não baixa o modelo ONNX")
    ap.add_argument("--permitir-lsa", action="store_true", help=argparse.SUPPRESS)
    ap.add_argument("--sem-zip", action="store_true", help="não gera o app.zip do Termux")
    a = ap.parse_args()
    exportar_dados(a.permitir_lsa)
    if not a.sem_modelo:
        baixar_modelo()
    empacotar(not a.sem_zip)
