#!/usr/bin/env python3
"""
Protótipo de busca híbrida para Bíblia offline.

  - Busca por palavras: SQLite FTS5 (BM25), ignora acentos.
  - Busca por sentido: embeddings (sentence-transformers) ou, sem modelo,
    um motor reserva TF-IDF + LSA (scikit-learn).
  - Fusão dos resultados: Reciprocal Rank Fusion (RRF).
  - Reranker opcional (cross-encoder multilíngue).
  - Reconhece referências: "jo 3 16", "João 3:16", "1co 13", "salmos 23:1-4".
  - Corrige erros de digitação usando o vocabulário do próprio texto.

Uso:
  python biblia_busca.py indexar biblia_almeida.json
  python biblia_busca.py buscar "passagens sobre perdão"
  python biblia_busca.py buscar "jo 3 16"
  python biblia_busca.py interativo
  python biblia_busca.py buscar "medo do futuro" --rerank

Formato do JSON de entrada (lista de versículos):
  [{"livro": "João", "cap": 3, "ver": 16, "texto": "..."}, ...]
"""

from __future__ import annotations

import argparse
import difflib
import json
import pickle
import re
import sqlite3
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import os

import numpy as np

DB_PATH = Path("biblia.db")
EMB_PATH = Path("biblia_emb.npy")
META_PATH = Path("biblia_meta.pkl")

MODELO_EMB = "intfloat/multilingual-e5-small"           # ~470 MB, bom em português
MODELO_RERANK = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1"
RRF_K = 60
# Peso de cada busca na fusão. A semântica costuma ser mais confiável que a
# busca por palavra; ajuste com:  python avaliar.py --varrer
PESOS = {"bm25": 0.25, "sem": 1.0}


def _preparar_offline(modelo: str):
    """Se o modelo já foi baixado, roda 100% offline (sem avisos do HF Hub)."""
    cache = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
    if (cache / ("models--" + modelo.replace("/", "--"))).exists():
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

# --------------------------------------------------------------------------
# Livros e abreviações
# --------------------------------------------------------------------------
LIVROS = [
    ("Gênesis", ["gn", "gen", "genesis"]), ("Êxodo", ["ex", "exo", "exodo"]),
    ("Levítico", ["lv", "lev", "levitico"]), ("Números", ["nm", "num", "numeros"]),
    ("Deuteronômio", ["dt", "deut", "deuteronomio"]), ("Josué", ["js", "jos", "josue"]),
    ("Juízes", ["jz", "jui", "juizes"]), ("Rute", ["rt", "rute"]),
    ("1 Samuel", ["1sm", "1sam", "1samuel"]), ("2 Samuel", ["2sm", "2sam", "2samuel"]),
    ("1 Reis", ["1rs", "1re", "1reis"]), ("2 Reis", ["2rs", "2re", "2reis"]),
    ("1 Crônicas", ["1cr", "1cro", "1cronicas"]), ("2 Crônicas", ["2cr", "2cro", "2cronicas"]),
    ("Esdras", ["ed", "esd", "esdras"]), ("Neemias", ["ne", "nee", "neemias"]),
    ("Ester", ["et", "est", "ester"]), ("Jó", ["job"]),
    ("Salmos", ["sl", "sal", "salmo", "salmos"]), ("Provérbios", ["pv", "pr", "prov", "proverbios"]),
    ("Eclesiastes", ["ec", "ecl", "eclesiastes"]), ("Cantares", ["ct", "cant", "cantares", "canticos"]),
    ("Isaías", ["is", "isa", "isaias"]), ("Jeremias", ["jr", "jer", "jeremias"]),
    ("Lamentações", ["lm", "lam", "lamentacoes"]), ("Ezequiel", ["ez", "eze", "ezequiel"]),
    ("Daniel", ["dn", "dan", "daniel"]), ("Oseias", ["os", "ose", "oseias"]),
    ("Joel", ["jl", "joel"]), ("Amós", ["am", "amos"]), ("Obadias", ["ob", "oba", "obadias"]),
    ("Jonas", ["jn", "jon", "jonas"]), ("Miqueias", ["mq", "miq", "miqueias"]),
    ("Naum", ["na", "naum"]), ("Habacuque", ["hc", "hab", "habacuque"]),
    ("Sofonias", ["sf", "sof", "sofonias"]), ("Ageu", ["ag", "ageu"]),
    ("Zacarias", ["zc", "zac", "zacarias"]), ("Malaquias", ["ml", "mal", "malaquias"]),
    ("Mateus", ["mt", "mat", "mateus"]), ("Marcos", ["mc", "mar", "marcos"]),
    ("Lucas", ["lc", "luc", "lucas"]), ("João", ["jo", "joa", "joao"]),
    ("Atos", ["at", "atos"]), ("Romanos", ["rm", "rom", "romanos"]),
    ("1 Coríntios", ["1co", "1cor", "1corintios"]), ("2 Coríntios", ["2co", "2cor", "2corintios"]),
    ("Gálatas", ["gl", "gal", "galatas"]), ("Efésios", ["ef", "efe", "efesios"]),
    ("Filipenses", ["fp", "fil", "filipenses"]), ("Colossenses", ["cl", "col", "colossenses"]),
    ("1 Tessalonicenses", ["1ts", "1tes", "1tessalonicenses"]),
    ("2 Tessalonicenses", ["2ts", "2tes", "2tessalonicenses"]),
    ("1 Timóteo", ["1tm", "1tim", "1timoteo"]), ("2 Timóteo", ["2tm", "2tim", "2timoteo"]),
    ("Tito", ["tt", "tito"]), ("Filemom", ["fm", "flm", "filemom"]),
    ("Hebreus", ["hb", "heb", "hebreus"]), ("Tiago", ["tg", "tia", "tiago"]),
    ("1 Pedro", ["1pe", "1ped", "1pedro"]), ("2 Pedro", ["2pe", "2ped", "2pedro"]),
    ("1 João", ["1jo", "1joao"]), ("2 João", ["2jo", "2joao"]), ("3 João", ["3jo", "3joao"]),
    ("Judas", ["jd", "jud", "judas"]), ("Apocalipse", ["ap", "apo", "apocalipse"]),
]


def sem_acento(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    return "".join(c for c in s if unicodedata.category(c) != "Mn").lower()


ALIAS_LIVRO: dict[str, str] = {}
for nome, abrevs in LIVROS:
    ALIAS_LIVRO[sem_acento(nome).replace(" ", "")] = nome
    for a in abrevs:
        ALIAS_LIVRO[a] = nome
ALIAS_LIVRO["jo"] = "João"   # "jo"/"jó" vira João; para Jó use "job"

STOPWORDS = set(sem_acento(w) for w in """
a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas
para pra com sem que se e ou mas como sobre ao aos à às é são foi ser ter tem há
eu tu ele ela nós vós eles elas me te lhe nos vos lhes meu minha seu sua isso isto
aquilo este esta esse essa qual quais quando onde porque mais muito também já não
ter tenha tenho temos tinha ser seja sou estar esta estou fazer faz vai
ensinou ensina disse dizer sobre algo alguem coisa coisas
passagem passagens versiculo versiculos texto textos biblia fala falam diz dizem
""".split())

# Sinônimos: liga palavras modernas ao vocabulário da tradução.
# Expanda à vontade (dá para gerar uma lista grande com um LLM no PC e revisar).
SINONIMOS = {
    "medo": ["temor", "temas", "temeria", "atemorize", "assombres"],
    "temer": ["temor", "temas", "temeria"],
    "divorcio": ["repudiar", "repudio", "separe"],
    "casamento": ["mulher", "carne", "ajuntou"],
    "ansiedade": ["ansiedade", "inquietos", "inquieteis", "cuidadosos"],
    "preocupacao": ["inquietos", "inquieteis", "cuidadosos", "ansiedade"],
    "preocupado": ["inquietos", "inquieteis", "cuidadosos"],
    "perdao": ["perdoar", "perdoai", "perdoa", "perdoe", "perdoou", "perdoarei"],
    "arrependimento": ["arrependei", "convertei", "converter"],
    "salvacao": ["salvo", "salvos", "vida eterna"],
    "dificuldade": ["angustia", "refugio", "socorro"],
    "dificuldades": ["angustia", "refugio", "socorro"],
    "tristeza": ["consolam", "aliviarei", "cansados"],
    "cansado": ["cansados", "oprimidos", "aliviarei"],
    "confiar": ["confia", "confiai"],
    "futuro": ["amanha", "fim que esperais"],
}

# --------------------------------------------------------------------------
# Referências bíblicas: "jo 3 16", "João 3:16-18", "1 co 13", "salmos 23"
# --------------------------------------------------------------------------
REF_RE = re.compile(
    r"^\s*([1-3]?)\s*([a-zA-ZÀ-ÿ]+)\.?\s+(\d{1,3})(?:\s*[:.,\s]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\s*$"
)


@dataclass
class Referencia:
    livro: str
    cap: int
    ver_ini: int | None = None
    ver_fim: int | None = None


def parse_referencia(q: str) -> Referencia | None:
    m = REF_RE.match(q)
    if not m:
        return None
    num, nome, cap, v1, v2 = m.groups()
    chave = (num or "") + sem_acento(nome)
    livro = ALIAS_LIVRO.get(chave)
    if not livro:
        # tolera erro de digitação no nome do livro ("jao", "salms")
        perto = difflib.get_close_matches(chave, list(ALIAS_LIVRO), n=1, cutoff=0.8)
        if not perto:
            return None
        livro = ALIAS_LIVRO[perto[0]]
    v1i = int(v1) if v1 else None
    return Referencia(livro, int(cap), v1i, int(v2) if v2 else v1i)


# --------------------------------------------------------------------------
# Motores de embedding
# --------------------------------------------------------------------------
class MotorEmbedding:
    nome = "base"

    def codificar_trechos(self, textos: list[str]) -> np.ndarray: ...
    def codificar_consulta(self, q: str) -> np.ndarray: ...


class MotorTransformer(MotorEmbedding):
    """Modelo neural real. Baixa o modelo na 1ª vez; depois funciona offline."""

    def __init__(self, modelo: str = MODELO_EMB):
        _preparar_offline(modelo)
        from sentence_transformers import SentenceTransformer
        self.modelo = SentenceTransformer(modelo)
        self.nome = f"transformer:{modelo}"
        self.e5 = "e5" in modelo.lower()   # modelos E5 pedem prefixos

    def codificar_trechos(self, textos):
        if self.e5:
            textos = ["passage: " + t for t in textos]
        return self.modelo.encode(textos, batch_size=64, normalize_embeddings=True,
                                  show_progress_bar=True).astype(np.float32)

    def codificar_consulta(self, q):
        if self.e5:
            q = "query: " + q
        return self.modelo.encode([q], normalize_embeddings=True)[0].astype(np.float32)


class MotorLSA(MotorEmbedding):
    """Reserva sem rede: TF-IDF de n-gramas de caracteres + SVD (LSA).
    Bem mais fraco que um modelo neural, mas mostra o fluxo funcionando."""

    nome = "lsa (reserva)"

    def __init__(self, dims: int = 128):
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.decomposition import TruncatedSVD
        self.vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5),
                                   preprocessor=sem_acento, sublinear_tf=True)
        self.svd = TruncatedSVD(n_components=dims, random_state=0)

    @staticmethod
    def _norm(m):
        n = np.linalg.norm(m, axis=-1, keepdims=True)
        return (m / np.maximum(n, 1e-9)).astype(np.float32)

    def codificar_trechos(self, textos):
        x = self.vec.fit_transform(textos)
        self.svd.n_components = min(self.svd.n_components, x.shape[1] - 1, x.shape[0] - 1)
        return self._norm(self.svd.fit_transform(x))

    def codificar_consulta(self, q):
        return self._norm(self.svd.transform(self.vec.transform([q])))[0]


def criar_motor(forcar_lsa: bool = False) -> MotorEmbedding:
    if not forcar_lsa:
        try:
            return MotorTransformer()
        except Exception as e:  # sem pacote ou sem o modelo baixado
            print(f"[aviso] modelo neural indisponível ({type(e).__name__}: {e}).\n"
                  f"        Usando motor reserva LSA.", file=sys.stderr)
    return MotorLSA()


# --------------------------------------------------------------------------
# Indexação
# --------------------------------------------------------------------------
def limpar(texto: str) -> str:
    """Tira os [colchetes] das palavras acrescentadas pelos tradutores."""
    return texto.replace("[", "").replace("]", "")


def indice_atual() -> dict | None:
    try:
        return pickle.load(open(META_PATH, "rb"))
    except Exception:
        return None


def indexar(arquivo_json: str, janela: int = 1, forcar_lsa: bool = False, se_necessario: bool = False):
    import hashlib
    fonte = Path(arquivo_json).name
    # impressão digital do conteúdo (a data do arquivo muda a cada cópia/clone; o conteúdo não)
    marca = hashlib.sha256(Path(arquivo_json).read_bytes() + str(janela).encode()).hexdigest()
    meta = indice_atual()
    if (se_necessario and meta and meta.get("fonte") == fonte and meta.get("marca") == marca
            and (meta["lsa"] is not None) == forcar_lsa and DB_PATH.exists() and EMB_PATH.exists()):
        print(f"Índice já está pronto para {Path(arquivo_json).name} ({meta['motor']}); nada a fazer.")
        return
    versos = json.loads(Path(arquivo_json).read_text(encoding="utf-8"))
    print(f"Indexando {len(versos)} versículos de {Path(arquivo_json).name}...")
    versos.sort(key=lambda v: (ordem_livro(v["livro"]), v["cap"], v["ver"]))

    DB_PATH.unlink(missing_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
        CREATE TABLE versiculo(
            id INTEGER PRIMARY KEY, livro TEXT, ordem INTEGER, cap INTEGER, ver INTEGER, texto TEXT);
        CREATE INDEX ix_ref ON versiculo(livro, cap, ver);
        CREATE VIRTUAL TABLE versiculo_fts USING fts5(
            texto, content='versiculo', content_rowid='id',
            tokenize='unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE vocab USING fts5vocab(versiculo_fts, 'row');
    """)
    for i, v in enumerate(versos, start=1):
        db.execute("INSERT INTO versiculo VALUES (?,?,?,?,?,?)",
                   (i, v["livro"], ordem_livro(v["livro"]), v["cap"], v["ver"], v["texto"]))
    db.execute("INSERT INTO versiculo_fts(versiculo_fts) VALUES('rebuild')")
    db.commit()

    # Texto para embedding: versículo + vizinhos do mesmo capítulo (dá contexto).
    trechos = []
    for i, v in enumerate(versos):
        partes = [limpar(v["texto"])]
        for d in range(1, janela + 1):
            for j in (i - d, i + d):
                if 0 <= j < len(versos) and (versos[j]["livro"], versos[j]["cap"]) == (v["livro"], v["cap"]):
                    partes.insert(0 if j < i else len(partes), limpar(versos[j]["texto"]))
        trechos.append(" ".join(partes))

    motor = criar_motor(forcar_lsa)
    t0 = time.time()
    emb = motor.codificar_trechos(trechos)
    np.save(EMB_PATH, emb)
    with open(META_PATH, "wb") as f:
        lsa = (motor.vec, motor.svd) if isinstance(motor, MotorLSA) else None
        pickle.dump({"motor": motor.nome, "lsa": lsa, "fonte": fonte, "marca": marca, "n": len(versos)}, f)
    print(f"Indexados {len(versos)} versículos | motor: {motor.nome} | "
          f"embeddings {emb.shape} em {time.time() - t0:.1f}s")


def ordem_livro(nome: str) -> int:
    for i, (n, _) in enumerate(LIVROS):
        if n == nome:
            return i
    return 999


# --------------------------------------------------------------------------
# Busca
# --------------------------------------------------------------------------
@dataclass
class Resultado:
    id: int
    livro: str
    cap: int
    ver: int
    texto: str
    score: float = 0.0
    fontes: dict = field(default_factory=dict)   # {"bm25": rank, "sem": rank, ...}

    @property
    def ref(self):
        return f"{self.livro} {self.cap}:{self.ver}"


class Buscador:
    def __init__(self):
        if not DB_PATH.exists():
            sys.exit("Índice não encontrado. Rode primeiro: python biblia_busca.py indexar <arquivo.json>")
        self.db = sqlite3.connect(DB_PATH)
        self.emb = np.load(EMB_PATH)
        meta = pickle.load(open(META_PATH, "rb"))
        if meta["lsa"] is not None:
            self.motor = MotorLSA()
            self.motor.vec, self.motor.svd = meta["lsa"]
        else:
            self.motor = MotorTransformer(meta["motor"].split(":", 1)[1])
        self.vocab = {r[0] for r in self.db.execute("SELECT term FROM vocab")}
        self.reranker = None

    # ---- auxiliares ----
    def _linhas(self, ids):
        if not ids:
            return {}
        q = f"SELECT id, livro, cap, ver, texto FROM versiculo WHERE id IN ({','.join('?' * len(ids))})"
        return {r[0]: Resultado(*r) for r in self.db.execute(q, ids)}

    def corrigir_termos(self, q: str) -> tuple[list[str], dict, list[list[str]]]:
        """Tokeniza, remove stopwords, expande sinônimos e troca palavras
        fora do vocabulário pelas formas mais parecidas que existem no texto
        (ex.: "perdao" -> perdoe, perdoa, perdoai).
        Devolve: termos (lista plana), correções e grupos (alternativas de cada palavra)."""
        termos, correcoes, grupos = [], {}, []
        for t in re.findall(r"\w+", sem_acento(q)):
            if t in STOPWORDS or len(t) < 2:
                continue
            grupo = []
            if t in SINONIMOS:
                extra = [w for frase in SINONIMOS[t] for w in frase.split()
                         if w in self.vocab and w not in STOPWORDS]
                if extra:
                    correcoes[t] = extra
                    grupo += extra
                if t in self.vocab:
                    grupo.append(t)
            elif t not in self.vocab and len(t) >= 5:   # palavras curtas erram demais
                perto = difflib.get_close_matches(t, self.vocab, n=3, cutoff=0.8)
                if perto:
                    correcoes[t] = perto
                grupo += perto or [t]
            else:
                grupo.append(t)
            if grupo:
                grupos.append(grupo)
                termos += grupo
        return termos, correcoes, grupos

    # ---- buscadores ----
    @staticmethod
    def _fts_termo(t: str) -> str:
        # prefixo (*) ajuda com plural/flexão: "perdo*" acha perdoar, perdoou...
        return f'"{t}"*' if len(t) >= 5 else f'"{t}"'

    def buscar_bm25(self, termos: list[str], k: int, grupos=None, frase: str = "") -> tuple[list[int], bool]:
        """Três níveis, nesta ordem: frase exata > todas as palavras > qualquer palavra.
        Devolve (ids, achou_frase_exata)."""
        sql = ("SELECT rowid FROM versiculo_fts WHERE versiculo_fts MATCH ? "
               "ORDER BY bm25(versiculo_fts) LIMIT ?")
        consultas = []
        toks = re.findall(r"\w+", sem_acento(frase))   # frase exata: todas as palavras, até "o" e "é"
        if len(toks) >= 2:
            consultas.append('"' + " ".join(toks) + '"')
        if grupos and len(grupos) >= 2:
            consultas.append(" AND ".join("(" + " OR ".join(map(self._fts_termo, g)) + ")" for g in grupos))
        if termos:
            consultas.append(" OR ".join(map(self._fts_termo, termos)))
        ids, vistos, achou_frase = [], set(), False
        for n, expr in enumerate(consultas):
            try:
                achados = [r[0] for r in self.db.execute(sql, (expr, k))]
            except sqlite3.OperationalError:
                continue
            if n == 0 and len(toks) >= 2 and achados:
                achou_frase = True
            for i in achados:
                if i not in vistos:
                    vistos.add(i); ids.append(i)
            if len(ids) >= k:
                break
        return ids[:k], achou_frase

    def buscar_semantica(self, q: str, k: int) -> list[int]:
        v = self.motor.codificar_consulta(q)
        sims = self.emb @ v
        top = np.argpartition(-sims, min(k, len(sims) - 1))[:k]
        top = top[np.argsort(-sims[top])]
        return [int(i) + 1 for i in top]   # ids começam em 1

    def buscar_referencia(self, ref: Referencia) -> list[Resultado]:
        sql = "SELECT id, livro, cap, ver, texto FROM versiculo WHERE livro=? AND cap=?"
        args: list = [ref.livro, ref.cap]
        if ref.ver_ini:
            sql += " AND ver BETWEEN ? AND ?"
            args += [ref.ver_ini, ref.ver_fim]
        return [Resultado(*r, score=1.0, fontes={"ref": 1}) for r in self.db.execute(sql + " ORDER BY ver", args)]

    # ---- busca principal ----
    def buscar(self, q: str, k: int = 10, rerank: bool = False, verbose: bool = True,
               modos: tuple = ("bm25", "sem"), pesos: dict | None = None) -> list[Resultado]:
        ref = parse_referencia(q)
        if ref:
            res = self.buscar_referencia(ref)
            if res:
                return res

        termos, correcoes, grupos = self.corrigir_termos(q)
        if correcoes and verbose:
            print("  expandido: " + "; ".join(f"{a} → {'/'.join(b)}" for a, b in correcoes.items()))
        # A busca semântica recebe a frase original + as correções encontradas.
        q_sem = q + (" " + " ".join(w for b in correcoes.values() for w in b) if correcoes else "")

        n = max(k * 5, 50)
        listas = {}
        pesos = dict(pesos or PESOS)
        if "bm25" in modos:
            listas["bm25"], achou_frase = self.buscar_bm25(termos, n, grupos, q)
            if achou_frase:            # frase exata encontrada: confiar mais na busca por palavra
                pesos["bm25"] = max(pesos["bm25"], 2.0)
        if "sem" in modos:
            listas["sem"] = self.buscar_semantica(q_sem, n)

        # Reciprocal Rank Fusion: score = soma 1/(K + posição)
        fusao: dict[int, Resultado] = {}
        linhas = self._linhas(sorted({i for l in listas.values() for i in l}))
        for nome, ids in listas.items():
            for pos, i in enumerate(ids, start=1):
                r = fusao.setdefault(i, linhas[i])
                r.score += pesos[nome] / (RRF_K + pos)
                r.fontes[nome] = pos
        ordenados = sorted(fusao.values(), key=lambda r: -r.score)

        if rerank:
            ordenados = self.reordenar(q, ordenados[:30])
        return ordenados[:k]

    def reordenar(self, q: str, cands: list[Resultado]) -> list[Resultado]:
        if self.reranker is None:
            try:
                _preparar_offline(MODELO_RERANK)
                from sentence_transformers import CrossEncoder
                self.reranker = CrossEncoder(MODELO_RERANK)
            except Exception as e:
                print(f"[aviso] reranker indisponível ({type(e).__name__}); mantendo ordem RRF.",
                      file=sys.stderr)
                self.reranker = False
        if not self.reranker:
            return cands
        notas = self.reranker.predict([(q, c.texto) for c in cands])
        for c, s in zip(cands, notas):
            c.score, c.fontes["rerank"] = float(s), True
        return sorted(cands, key=lambda r: -r.score)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def mostrar(res: list[Resultado], t: float):
    if not res:
        print("  (nenhum resultado)")
    for r in res:
        fontes = " ".join(f"{k}#{v}" if v is not True else k for k, v in r.fontes.items())
        print(f"  {r.ref:<18} [{fontes}]\n    {r.texto}")
    print(f"  — {len(res)} resultado(s) em {t * 1000:.0f} ms\n")


def main():
    ap = argparse.ArgumentParser(description="Busca híbrida na Bíblia (protótipo)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("indexar"); p.add_argument("arquivo")
    p.add_argument("--janela", type=int, default=1, help="versículos vizinhos no embedding")
    p.add_argument("--lsa", action="store_true", help="forçar motor reserva (sem rede)")
    p.add_argument("--se-necessario", action="store_true", help="pula se o índice já é deste arquivo")
    p = sub.add_parser("buscar"); p.add_argument("consulta"); p.add_argument("-k", type=int, default=8)
    p.add_argument("--rerank", action="store_true")
    p = sub.add_parser("interativo"); p.add_argument("--rerank", action="store_true")
    a = ap.parse_args()

    if a.cmd == "indexar":
        indexar(a.arquivo, a.janela, a.lsa, a.se_necessario)
    elif a.cmd == "buscar":
        b = Buscador(); t = time.time()
        res = b.buscar(a.consulta, a.k, a.rerank)
        mostrar(res, time.time() - t)
    else:
        b = Buscador()
        print(f"Motor: {b.motor.nome}. Digite uma busca (vazio para sair).")
        while (q := input("> ").strip()):
            t = time.time(); mostrar(b.buscar(q, 8, a.rerank), time.time() - t)


if __name__ == "__main__":
    # Roda pelo módulo importado para que o índice salvo (pickle) aponte para
    # "biblia_busca.*" e possa ser lido também pelo avaliar.py.
    import biblia_busca
    biblia_busca.main()
