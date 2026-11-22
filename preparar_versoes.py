#!/usr/bin/env python3
"""
Prepara as outras versões da Bíblia para o app (pasta versoes/).

Já vêm prontas no projeto: KJV, Louis Segond 1910, Reina-Valera 1909, hebraico (WLC) e grego (Bizantino).
Esta script baixa no seu computador as que ficam em sites bloqueados no ambiente de criação:
Nova Bíblia Viva, BLT, Tradução para Tradutores e NTB (eBible.org) e o Tanakh JPS 1917 (Sefaria).

  python preparar_versoes.py                 # baixa o que faltar
  python preparar_versoes.py --refazer kjv   # reconverte uma versão a partir da fonte
"""
import argparse
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

PASTA = Path(__file__).parent / "versoes"

# Ordem dos 66 livros com os códigos USFM/OSIS
USFM = ["GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA", "1KI", "2KI", "1CH", "2CH",
        "EZR", "NEH", "EST", "JOB", "PSA", "PRO", "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS",
        "JOL", "AMO", "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL",
        "MAT", "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH",
        "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE", "2PE", "1JN", "2JN", "3JN", "JUD", "REV"]
IDX_USFM = {c: i for i, c in enumerate(USFM)}
# Códigos próprios que o eBible usa nos arquivos VPL (vistos no diagnóstico)
ALIAS_EBIBLE = {"SOL": "SNG", "EZE": "EZK", "JOE": "JOL", "NAH": "NAM", "MAR": "MRK", "JOH": "JHN",
                "PHI": "PHP", "JAM": "JAS", "1JO": "1JN", "2JO": "2JN", "3JO": "3JN"}
CONVERSOR = 2   # muda quando a conversão muda: versões salvas com conversor antigo são refeitas

# Numeração judaica (hebraico, JPS) -> numeração cristã (Almeida/KJV).
# (livro, cap_heb, v_ini, v_fim, cap_cristão, v_ini_cristão). Versículos que viram "título" ou
# metade de outro são juntados ao versículo cristão correspondente.
HEB_PARA_CRISTA = [
    (0, 32, 1, 1, 31, 55), (0, 32, 2, 33, 32, 1),
    (1, 7, 26, 29, 8, 1), (1, 8, 1, 28, 8, 5), (1, 21, 37, 37, 22, 1), (1, 22, 1, 30, 22, 2),
    (2, 5, 20, 26, 6, 1), (2, 6, 1, 23, 6, 8),
    (3, 17, 1, 15, 16, 36), (3, 17, 16, 28, 17, 1), (3, 25, 19, 19, 26, 1), (3, 30, 1, 1, 29, 40), (3, 30, 2, 17, 30, 1),
    (4, 13, 1, 1, 12, 32), (4, 13, 2, 19, 13, 1), (4, 23, 1, 1, 22, 30), (4, 23, 2, 26, 23, 1),
    (4, 28, 69, 69, 29, 1), (4, 29, 1, 28, 29, 2),
    (8, 21, 1, 1, 20, 42), (8, 21, 2, 16, 21, 1), (8, 24, 1, 1, 23, 29), (8, 24, 2, 23, 24, 1),
    (9, 19, 1, 1, 18, 33), (9, 19, 2, 44, 19, 1),
    (10, 5, 1, 14, 4, 21), (10, 5, 15, 32, 5, 1), (10, 22, 44, 44, 22, 43), (10, 22, 45, 54, 22, 44),
    (11, 12, 1, 1, 11, 21), (11, 12, 2, 22, 12, 1),
    (12, 5, 27, 41, 6, 1), (12, 6, 1, 66, 6, 16), (12, 12, 5, 5, 12, 4), (12, 12, 6, 41, 12, 5),
    (13, 1, 18, 18, 2, 1), (13, 2, 1, 17, 2, 2), (13, 13, 23, 23, 14, 1), (13, 14, 1, 14, 14, 2),
    (15, 3, 33, 38, 4, 1), (15, 4, 1, 17, 4, 7), (15, 10, 1, 1, 9, 38), (15, 10, 2, 40, 10, 1),
    (17, 40, 25, 32, 41, 1), (17, 41, 1, 26, 41, 9),
    (20, 4, 17, 17, 5, 1), (20, 5, 1, 19, 5, 2),
    (21, 7, 1, 1, 6, 13), (21, 7, 2, 14, 7, 1),
    (22, 8, 23, 23, 9, 1), (22, 9, 1, 20, 9, 2), (22, 64, 1, 11, 64, 2),
    (23, 8, 23, 23, 9, 1), (23, 9, 1, 25, 9, 2),
    (25, 21, 1, 5, 20, 45), (25, 21, 6, 37, 21, 1),
    (26, 3, 31, 33, 4, 1), (26, 4, 1, 34, 4, 4), (26, 6, 1, 1, 5, 31), (26, 6, 2, 29, 6, 1),
    (27, 2, 1, 2, 1, 10), (27, 2, 3, 25, 2, 1), (27, 12, 1, 1, 11, 12), (27, 12, 2, 15, 12, 1),
    (27, 14, 1, 1, 13, 16), (27, 14, 2, 10, 14, 1),
    (28, 3, 1, 5, 2, 28), (28, 4, 1, 21, 3, 1),
    (31, 2, 1, 1, 1, 17), (31, 2, 2, 11, 2, 1),
    (32, 4, 14, 14, 5, 1), (32, 5, 1, 14, 5, 2),
    (33, 2, 1, 1, 1, 15), (33, 2, 2, 14, 2, 1),
    (37, 2, 1, 4, 1, 18), (37, 2, 5, 17, 2, 1),
    (38, 3, 19, 24, 4, 1),
]


def para_numeracao_crista(versos, caps_cristaos):
    """versos: [[livro, cap, v, texto]] em numeração hebraica. caps_cristaos: {(livro, cap): nº de versículos}.
    Nos Salmos o título conta como versículo 1 (ou 1-2) no hebraico: vai junto do versículo 1."""
    por_cap = {}
    for b, c, v, t in versos:
        por_cap[(b, c)] = max(por_cap.get((b, c), 0), v)
    out = []
    for b, c, v, t in versos:
        nc, nv = c, v
        for (rb, rc, v1, v2, ec, ev) in HEB_PARA_CRISTA:
            if b == rb and c == rc and v1 <= v <= v2:
                nc, nv = ec, ev + (v - v1)
                break
        else:
            if b == 18 and (b, c) in caps_cristaos:          # Salmos: títulos
                dif = por_cap[(b, c)] - caps_cristaos[(b, c)]
                if dif > 0:
                    nv = max(1, v - dif)
        out.append([b, nc, nv, t])
    # versículos que caíram no mesmo lugar (título + v1, meio versículo) são juntados
    junto = {}
    for b, c, v, t in out:
        k = (b, c, v)
        junto[k] = (junto[k] + " " + t) if k in junto else t
    return [[b, c, v, t] for (b, c, v), t in junto.items()]


MIDVASH = "https://raw.githubusercontent.com/midvash/bible-data/main/versions"
VERSOES = {
    "kjv": {"sigla": "KJV", "nome": "King James Version (1769)", "idioma": "en",
            "fonte": f"{MIDVASH}/en/kjv/kjv.json", "tipo": "midvash",
            "atribuicao": "King James Version (Oxford 1769). Domínio público.\nDados: github.com/midvash/bible-data"},
    "lsg": {"sigla": "LSG", "nome": "Louis Segond (1910)", "idioma": "fr",
            "fonte": f"{MIDVASH}/fr/lsg/lsg.json", "tipo": "midvash",
            "atribuicao": "Louis Segond, revisão de 1910. Domínio público.\nDados: github.com/midvash/bible-data"},
    "rv1909": {"sigla": "RV1909", "nome": "Reina-Valera (1909)", "idioma": "es",
               "fonte": "https://raw.githubusercontent.com/seven1m/open-bibles/master/spa-rv1909.usfx.xml", "tipo": "usfx",
               "atribuicao": "Reina-Valera, revisão de 1909. Domínio público.\nDados: github.com/seven1m/open-bibles"},
    "wlc": {"sigla": "HEB", "nome": "Hebraico original (Códice de Leningrado)", "idioma": "he",
            "fonte": "https://raw.githubusercontent.com/openscriptures/morphhb/master/wlc/{livro}.xml", "tipo": "oshb",
            "testamento": "at",
            "atribuicao": "Westminster Leningrad Codex 4.20 (texto livre para copiar e distribuir), via Open Scriptures Hebrew "
                          "Bible (CC BY 4.0). Numeração convertida para a cristã.\nDados: github.com/openscriptures/morphhb"},
    "byz": {"sigla": "GRE", "nome": "Grego original (Texto Bizantino, 2018)", "idioma": "el",
            "fonte": "https://raw.githubusercontent.com/byztxt/byzantine-majority-text/master/csv-unicode/ccat/no-variants/{livro}.csv",
            "tipo": "byz", "testamento": "nt",
            "atribuicao": "The New Testament in the Original Greek: Byzantine Textform, Robinson-Pierpont 2018. Domínio público.\n"
                          "Dados: github.com/byztxt/byzantine-majority-text"},
    "jps": {"sigla": "JPS", "nome": "Tanakh judaico JPS (1917)", "idioma": "en", "tipo": "sefaria", "testamento": "at",
            "fonte": "https://storage.googleapis.com/sefaria-export/json/Tanakh/{cat}/{livro}/English/The%20Holy%20Scriptures%20A%20New%20Translation%20JPS%201917.json",
            "atribuicao": "The Holy Scriptures according to the Masoretic Text, a New Translation. Jewish Publication Society, 1917. "
                          "Domínio público. Numeração convertida para a cristã.\nDados: Sefaria (sefaria.org)"},
    "blt": {"sigla": "BLT", "nome": "Bíblia Livre Para Todos (NT)", "idioma": "pt", "tipo": "vpl", "testamento": "nt",
            "fonte": "https://ebible.org/Scriptures/porblt_vpl.zip",
            "atribuicao": "Biblia Livre Para Todos (BLT). Copyright © 2022 Free Bible Ministry, Inc. "
                          "Licença Creative Commons Atribuição-CompartilhaIgual 4.0. Dados: ebible.org"},
    "tft": {"sigla": "TFT", "nome": "Tradução para Tradutores", "idioma": "pt", "tipo": "vpl",
            "fonte": "https://ebible.org/Scriptures/portft_vpl.zip",
            "atribuicao": "A Bíblia Sagrada, Tradução para Tradutores. Copyright © 2018 Ellis W. Deibler, Jr. "
                          "Licença Creative Commons Atribuição-CompartilhaIgual 4.0. Dados: ebible.org"},
    "ntb": {"sigla": "NTB", "nome": "Nova Tradução BibliaTodo", "idioma": "pt", "tipo": "vpl",
            "fonte": "https://ebible.org/Scriptures/porbrntbt_vpl.zip",
            "atribuicao": "Nova Tradução BibliaTodo (NTB-BR). Texto © 2026 BibliaTodo LLC, que autoriza gratuitamente a "
                          "reprodução e a distribuição. Dados: ebible.org"},
    "nbv": {"sigla": "NBV", "nome": "Nova Bíblia Viva (2007)", "idioma": "pt",
            "fonte": "https://ebible.org/Scriptures/poronbv_vpl.zip", "tipo": "vpl",
            "atribuicao": ("Biblica® Open Nova Bíblia Viva™. Copyright © 2007, 2010 by Biblica, Inc. "
                           "Licença Creative Commons Atribuição-CompartilhaIgual 4.0 (CC BY-SA 4.0).\n"
                           "“Biblica” é marca registrada da Biblica, Inc. A obra original está disponível "
                           "gratuitamente em www.biblica.com e open.bible.\n"
                           "Mudanças nesta cópia: apenas conversão de formato. Dados: ebible.org (poronbv).")},
}


def baixar(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "biblia-ia/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def limpar_espacos(t: str) -> str:
    return re.sub(r"\s+", " ", t).strip()


def de_midvash(dados: bytes):
    d = json.loads(dados)
    out = []
    for b in d["books"]:
        for c in b["chapters"]:
            for v in c["verses"]:
                t = v["text"].replace("''", "'")      # alguns textos vêm com aspas duplicadas (resto de SQL)
                out.append([b["bookId"] - 1, c["chapter"], v["number"], limpar_espacos(t)])
    return out


def de_usfx(dados: bytes):
    xml = dados.decode("utf-8")
    out = []
    for m in re.finditer(r'<book id="([A-Z0-9]{3})"[^>]*>(.*?)</book>', xml, re.S):
        if m.group(1) not in IDX_USFM:
            continue
        b = IDX_USFM[m.group(1)]
        corpo = re.sub(r"<f\b.*?</f>|<x\b.*?</x>", "", m.group(2), flags=re.S)       # notas e referências
        for cm in re.finditer(r'<c id="(\d+)"\s*/>(.*?)(?=<c id=|\Z)', corpo, re.S):
            c = int(cm.group(1))
            for vm in re.finditer(r'<v id="(\d+)"\s*/>(.*?)(?=<ve\s*/>|<v id=|\Z)', cm.group(2), re.S):
                t = re.sub(r"<add>(.*?)</add>", r"[\1]", vm.group(2), flags=re.S)  # palavras acrescentadas
                t = re.sub(r"<[^>]+>", "", t)
                t = limpar_espacos(t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
                if t:
                    out.append([b, c, int(vm.group(1)), t])
    return out


def de_vpl(dados: bytes):
    """eBible VPL: linhas 'GEN 1:1 texto'."""
    z = zipfile.ZipFile(io.BytesIO(dados))
    nome = next(n for n in z.namelist() if n.lower().endswith("_vpl.txt") or n.lower().endswith(".txt") and "vpl" in n.lower())
    out = []
    for linha in z.read(nome).decode("utf-8-sig").splitlines():
        # aceita versículos juntados ("GEN 1:1-2 texto"): o texto fica no primeiro
        m = re.match(r"^([1-3A-Z]{3})\s+(\d+):(\d+)(?:-\d+)?\s+(.*)$", linha.strip())
        cod = ALIAS_EBIBLE.get(m.group(1), m.group(1)) if m else None
        if m and cod in IDX_USFM:
            t = re.sub(r"\\[a-z0-9]+\*?", "", m.group(4))          # marcas USFM que sobrarem
            t = limpar_espacos(t)
            if t:
                out.append([IDX_USFM[cod], int(m.group(2)), int(m.group(3)), t])
    return out


def caps_cristaos():
    """Nº de versículos por capítulo na Almeida (numeração cristã)."""
    import biblia_busca as bb
    nomes = [n for n, _ in bb.LIVROS]
    caps = {}
    for x in json.loads((Path(__file__).parent / "biblia_almeida.json").read_text(encoding="utf-8")):
        k = (nomes.index(x["livro"]), x["cap"])
        caps[k] = max(caps.get(k, 0), x["ver"])
    return caps


def de_midvash_heb(dados: bytes):
    versos = de_midvash(dados)
    for v in versos:
        v[3] = v[3].replace(" ׃", "׃").replace("/", "")
    return para_numeracao_crista(versos, caps_cristaos())


BYZ_ARQ = ["MAT", "MAR", "LUK", "JOH", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP", "COL", "1TH", "2TH",
           "1TI", "2TI", "TIT", "PHM", "HEB", "JAM", "1PE", "2PE", "1JO", "2JO", "3JO", "JUD", "REV"]


def baixar_byz(url_modelo: str):
    import csv
    out = []
    for i, arq in enumerate(BYZ_ARQ):
        texto = baixar(url_modelo.format(livro=arq)).decode("utf-8-sig")
        for linha in csv.DictReader(io.StringIO(texto)):
            t = limpar_espacos(linha["text"].replace("¶", ""))
            c, v = int(linha["chapter"]), int(linha["verse"])
            if arq == "ROM" and c == 14 and v >= 24:      # doxologia: no bizantino fica no fim do cap. 14
                c, v = 16, v + 1
            if t:
                out.append([39 + i, c, v, t])
    return out


SEFARIA_LIVROS = [("Torah", "Genesis"), ("Torah", "Exodus"), ("Torah", "Leviticus"), ("Torah", "Numbers"),
    ("Torah", "Deuteronomy"), ("Prophets", "Joshua"), ("Prophets", "Judges"), ("Writings", "Ruth"),
    ("Prophets", "I Samuel"), ("Prophets", "II Samuel"), ("Prophets", "I Kings"), ("Prophets", "II Kings"),
    ("Writings", "I Chronicles"), ("Writings", "II Chronicles"), ("Writings", "Ezra"), ("Writings", "Nehemiah"),
    ("Writings", "Esther"), ("Writings", "Job"), ("Writings", "Psalms"), ("Writings", "Proverbs"),
    ("Writings", "Ecclesiastes"), ("Writings", "Song of Songs"), ("Prophets", "Isaiah"), ("Prophets", "Jeremiah"),
    ("Writings", "Lamentations"), ("Prophets", "Ezekiel"), ("Writings", "Daniel"), ("Prophets", "Hosea"),
    ("Prophets", "Joel"), ("Prophets", "Amos"), ("Prophets", "Obadiah"), ("Prophets", "Jonah"), ("Prophets", "Micah"),
    ("Prophets", "Nahum"), ("Prophets", "Habakkuk"), ("Prophets", "Zephaniah"), ("Prophets", "Haggai"),
    ("Prophets", "Zechariah"), ("Prophets", "Malachi")]


def limpar_sefaria(t: str) -> str:
    t = re.sub(r'<sup class="footnote-marker">.*?</sup>|<i class="footnote">.*?</i>', "", t, flags=re.S)
    t = re.sub(r"<br\s*/?>", " ", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = re.sub(r"\{[PS]\}|\{[פס]\}", "", t)
    return limpar_espacos(t.replace("&nbsp;", " ").replace("&thinsp;", "").replace("&amp;", "&"))


def de_sefaria_livro(dados: bytes, b: int):
    d = json.loads(dados)
    out = []
    for c, cap in enumerate(d["text"], start=1):
        for v, t in enumerate(cap, start=1):
            t = limpar_sefaria(t) if isinstance(t, str) else ""
            if t:
                out.append([b, c, v, t])
    return out


def baixar_sefaria(url_modelo: str):
    from urllib.parse import quote
    out = []
    for b, (cat, livro) in enumerate(SEFARIA_LIVROS):
        print(f"      {livro}...", end="\r")
        out += de_sefaria_livro(baixar(url_modelo.format(cat=cat, livro=quote(livro))), b)
    return para_numeracao_crista(out, caps_cristaos())


OSHB_ARQ = ["Gen", "Exod", "Lev", "Num", "Deut", "Josh", "Judg", "Ruth", "1Sam", "2Sam", "1Kgs", "2Kgs", "1Chr",
            "2Chr", "Ezra", "Neh", "Esth", "Job", "Ps", "Prov", "Eccl", "Song", "Isa", "Jer", "Lam", "Ezek", "Dan",
            "Hos", "Joel", "Amos", "Obad", "Jonah", "Mic", "Nah", "Hab", "Zeph", "Hag", "Zech", "Mal"]


def de_oshb_livro(xml: str, b: int):
    out = []
    for m in re.finditer(r'<verse osisID="[^".]+\.(\d+)\.(\d+)"[^>]*>(.*?)</verse>', xml, re.S):
        t = re.sub(r"<note\b.*?</note>", "", m.group(3), flags=re.S)          # notas e leituras qerê
        t = re.sub(r"<w\b[^>]*>(.*?)</w>", lambda w: w.group(1).replace("/", ""), t, flags=re.S)
        t = re.sub(r"<[^>]+>", "", t)
        t = re.sub(r"[\u0591-\u05AF\u05BD]|׀", "", t)                # tira a cantilação, mantém as vogais
        t = limpar_espacos(t)
        t = re.sub(r"\s*־\s*", "־", t).replace(" ׃", "׃")
        if t:
            out.append([b, int(m.group(1)), int(m.group(2)), t])
    return out


def baixar_oshb(url_modelo: str):
    out = []
    for b, arq in enumerate(OSHB_ARQ):
        out += de_oshb_livro(baixar(url_modelo.format(livro=arq)).decode("utf-8"), b)
    return para_numeracao_crista(out, caps_cristaos())


CONVERSORES = {"midvash": de_midvash, "usfx": de_usfx, "vpl": de_vpl, "midvash_heb": de_midvash_heb}
BAIXADORES = {"byz": baixar_byz, "sefaria": baixar_sefaria, "oshb": baixar_oshb}   # baixam vários arquivos


def preparar(vid: str, refazer=False) -> bool:
    info = VERSOES[vid]
    destino = PASTA / f"{vid}.json"
    if destino.exists() and not refazer:
        try:
            atual = json.loads(destino.read_text(encoding="utf-8")).get("conversor", 1)
        except Exception:
            atual = 0
        if atual >= CONVERSOR or info["tipo"] in ("midvash", "usfx"):
            print(f"✔ {info['sigla']}: já está pronta")
            return True
        print(f"   {info['sigla']}: convertida com versão antiga do conversor; refazendo")
    print(f"   {info['sigla']}: baixando {info['fonte']} ...")
    try:
        if info["tipo"] in BAIXADORES:
            versos = BAIXADORES[info["tipo"]](info["fonte"])
        else:
            versos = CONVERSORES[info["tipo"]](baixar(info["fonte"]))
    except Exception as e:
        print(f"✘ {info['sigla']}: não deu para baixar/converter ({e}). O app segue sem ela.")
        return False
    livros = len({v[0] for v in versos})
    minimo = {"at": (22000, 39), "nt": (7800, 27)}.get(info.get("testamento"), (30000, 66))
    if len(versos) < minimo[0] or livros < minimo[1]:
        if info.get("testamento") is None and len(versos) >= 7800 and livros >= 27:
            info["testamento"] = "nt" if min(v[0] for v in versos) >= 39 else None
        if info.get("testamento") is None or len(versos) < 7800:
            print(f"✘ {info['sigla']}: texto incompleto ({len(versos)} versículos, {livros} livros). Ignorada.")
            return False
        print(f"   {info['sigla']}: tem só parte da Bíblia ({livros} livros); entra assim mesmo")
    PASTA.mkdir(exist_ok=True)
    saida = {k: info[k] for k in ("sigla", "nome", "idioma", "atribuicao")}
    saida["testamento"] = info.get("testamento") or "ambos"
    saida["conversor"] = CONVERSOR
    saida["id"] = vid
    saida["versos"] = versos
    destino.write_text(json.dumps(saida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"✔ {info['sigla']}: {len(versos)} versículos, {livros} livros")
    return True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refazer", nargs="*", default=[], help="reconverter estas versões")
    a = ap.parse_args()
    ok = [preparar(v, v in a.refazer) for v in VERSOES]
    sys.exit(0)
