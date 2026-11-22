#!/usr/bin/env python3
"""
Avaliação da busca: roda perguntas com respostas conhecidas e mede a qualidade.

  acerto@1  -> % de perguntas em que o 1º resultado é um versículo esperado
  acerto@5  -> % em que algum esperado aparece entre os 5 primeiros
  MRR       -> média de 1/posição do 1º acerto (1.0 = sempre em 1º lugar)

Compara três modos: só palavras (BM25), só sentido (semântica) e híbrido.

Uso:
  python avaliar.py              # resumo
  python avaliar.py --detalhes   # mostra cada pergunta
  python avaliar.py --varrer     # testa vários pesos da busca por palavra
"""

import argparse
import contextlib
import io

from biblia_busca import PESOS, Buscador

# (pergunta, passagens que contam como resposta certa)
# Formatos aceitos: "João 3:16", "Mateus 6:25-34" (intervalo) e "1 Samuel 17" (capítulo inteiro).
CASOS = [
    # --- temas (aqui a busca por sentido deve ajudar) ---
    ("passagens sobre perdão", ["Mateus 6:12-15", "Marcos 11:25", "Efésios 4:32", "Colossenses 3:13",
        "Mateus 18:21-35", "Lucas 6:37", "Lucas 17:3-4", "1 João 1:9", "Salmos 32:1", "Salmos 130:4"]),
    ("quantas vezes devo perdoar meu irmão", ["Mateus 18:21-22", "Lucas 17:3-4"]),
    ("o que Jesus ensinou sobre o divórcio", ["Mateus 19:3-9", "Mateus 5:31-32", "Marcos 10:2-12", "Lucas 16:18"]),
    ("não tenha medo", ["Isaías 41:10", "Isaías 41:13", "Josué 1:9", "1 João 4:18", "Salmos 23:4", "Salmos 27:1",
        "Salmos 56:3-4", "Deuteronômio 31:6-8", "Mateus 10:31", "Lucas 12:32", "João 14:27", "2 Timóteo 1:7",
        "Salmos 118:6", "Hebreus 13:6", "Isaías 43:1"]),
    ("preocupação com o futuro", ["Mateus 6:25-34", "Filipenses 4:6-7", "1 Pedro 5:7", "Provérbios 27:1",
        "Tiago 4:13-15", "Jeremias 29:11"]),
    ("ansiedade", ["Filipenses 4:6-7", "1 Pedro 5:7", "Mateus 6:25-34", "Salmos 94:19", "Provérbios 12:25", "Salmos 55:22"]),
    ("Deus ama o mundo", ["João 3:16-17", "1 João 4:9-10", "Romanos 5:8"]),
    ("o que é o amor", ["1 Coríntios 13:4-8", "1 Coríntios 13:13", "1 João 4:7-8", "1 João 4:16", "João 15:13", "Romanos 13:10"]),
    ("definição de fé", ["Hebreus 11:1", "Hebreus 11:6", "Romanos 10:17"]),
    ("fé sem obras", ["Tiago 2:14-26"]),
    ("salvos pela graça", ["Efésios 2:5-9", "Atos 15:11", "Tito 3:5-7", "Romanos 3:24"]),
    ("como orar", ["Mateus 6:5-13", "Lucas 11:1-4", "Filipenses 4:6", "1 Tessalonicenses 5:17", "Romanos 8:26"]),
    ("pedir sabedoria a Deus", ["Tiago 1:5", "Provérbios 2:6", "1 Reis 3:9", "2 Crônicas 1:10"]),
    ("criação do mundo", ["Gênesis 1", "Gênesis 2:1-4", "João 1:3", "Hebreus 11:3", "Romanos 1:20", "Salmos 33:6",
        "Colossenses 1:16", "Neemias 9:6", "Apocalipse 4:11"]),
    ("confiar em Deus", ["Provérbios 3:5-6", "Salmos 37:3-5", "Salmos 56:3-4", "Isaías 26:3-4", "Jeremias 17:7",
        "Salmos 62:8", "Salmos 9:10", "Naum 1:7", "Salmos 125:1"]),
    ("Deus é refúgio nas dificuldades", ["Salmos 46:1", "Salmos 9:9", "Salmos 18:2", "Salmos 91:1-2", "Naum 1:7", "Salmos 62:8"]),
    ("descanso para os cansados", ["Mateus 11:28-29", "Isaías 40:29-31", "Hebreus 4:9-11", "Salmos 23:2"]),
    ("amar os inimigos", ["Mateus 5:44", "Lucas 6:27-35", "Romanos 12:20", "Provérbios 25:21"]),
    ("arrependimento", ["Atos 3:19", "Atos 2:38", "2 Crônicas 7:14", "Lucas 15:7", "Lucas 15:10", "Mateus 3:2",
        "Mateus 3:8", "Mateus 4:17", "2 Pedro 3:9", "Lucas 5:32", "Atos 17:30", "Lucas 13:3", "2 Coríntios 7:10", "Atos 26:20"]),
    ("o filho que voltou para o pai", ["Lucas 15:11-32"]),
    ("Jesus é o único caminho", ["João 14:6", "Atos 4:12", "1 Timóteo 2:5", "João 10:9"]),
    ("responder com calma numa discussão", ["Provérbios 15:1", "Provérbios 15:18", "Tiago 1:19", "Colossenses 4:6",
        "Provérbios 29:11", "Provérbios 17:27"]),
    ("Deus tem um plano para mim", ["Jeremias 29:11", "Romanos 8:28", "Provérbios 16:9", "Provérbios 19:21",
        "Salmos 138:8", "Efésios 2:10", "Filipenses 1:6", "Salmos 32:8"]),
    ("o fruto do Espírito", ["Gálatas 5:22-23"]),
    ("a armadura de Deus", ["Efésios 6:10-18"]),
    # --- histórias e nomes (aqui a busca por palavra deve ajudar) ---
    ("Davi e Golias", ["1 Samuel 17"]),
    ("Daniel na cova dos leões", ["Daniel 6"]),
    ("Jonas e o grande peixe", ["Jonas 1:17", "Jonas 2"]),
    ("nascimento de Jesus", ["Mateus 1:18-25", "Lucas 2:1-20"]),
    ("os dez mandamentos", ["Êxodo 20:1-17", "Deuteronômio 5:6-21", "Êxodo 34:28", "Deuteronômio 4:13", "Deuteronômio 10:4"]),
    ("Moisés abre o mar vermelho", ["Êxodo 14"]),
    ("ressurreição de Lázaro", ["João 11"]),
    ("o bom samaritano", ["Lucas 10:25-37"]),
    ("a torre de Babel", ["Gênesis 11:1-9"]),
    ("Noé e o dilúvio", ["Gênesis 6", "Gênesis 7", "Gênesis 8", "Gênesis 9"]),
    ("Melquisedeque", ["Gênesis 14:18-20", "Salmos 110:4", "Hebreus 5:6", "Hebreus 5:10", "Hebreus 6:20", "Hebreus 7:1-17"]),
    ("bem-aventurados os pobres de espírito", ["Mateus 5:3"]),
    # --- frases exatas, erros de digitação e referências ---
    ("perdao dos pecados", ["1 João 1:9", "Atos 3:19", "2 Crônicas 7:14", "Colossenses 1:14", "Efésios 1:7",
        "Atos 2:38", "Atos 10:43", "Atos 26:18", "Mateus 26:28", "Lucas 24:47", "Marcos 1:4", "Lucas 3:3",
        "Salmos 32:1", "Salmos 32:5", "Salmos 103:3", "Salmos 103:12", "Hebreus 9:22", "Atos 13:38", "Lucas 1:77"]),
    ("setenta vezes sete", ["Mateus 18:22", "Gênesis 4:24"]),
    ("vale da sombra da morte", ["Salmos 23:4"]),
    ("Pai nosso que estás nos céus", ["Mateus 6:9", "Lucas 11:2"]),
    ("aves do céu não semeiam", ["Mateus 6:26", "Lucas 12:24"]),
    ("tudo posso naquele que me fortalece", ["Filipenses 4:13"]),
    ("salms 23", ["Salmos 23:1"]),
    ("jo 3 16", ["João 3:16"]),
]


def _aceitos(esperados):
    """Expande "Livro 6:25-34" em versículos e "Livro 17" em capítulo."""
    import re
    refs, caps = set(), set()
    for e in esperados:
        m = re.match(r"^(.+?) (\d+)(?::(\d+)(?:-(\d+))?)?$", e)
        livro, cap, v1, v2 = m.group(1), int(m.group(2)), m.group(3), m.group(4)
        if v1 is None:
            caps.add((livro, cap))
        else:
            for v in range(int(v1), int(v2 or v1) + 1):
                refs.add(f"{livro} {cap}:{v}")
    return refs, caps


def _certo(r, aceitos):
    refs, caps = aceitos
    return r.ref in refs or (r.livro, r.cap) in caps


MODOS = {
    "só palavras (BM25)": ("bm25",),
    "só sentido (semântica)": ("sem",),
    "híbrido (RRF)": ("bm25", "sem"),
}


def varrer(b: Buscador):
    print(f"\nMotor semântico: {b.motor.nome}  |  {len(CASOS)} perguntas")
    print(f"Peso da semântica fixo em 1.0; variando o peso da busca por palavra (BM25).")
    print(f"Peso atual no código: bm25 = {PESOS['bm25']}\n")
    print(f"  {'peso bm25':<10} {'acerto@1':>9} {'acerto@5':>9} {'MRR':>6}")
    print("  " + "-" * 37)
    melhor = None
    for w in (0.0, 0.25, 0.5, 0.75, 1.0):
        r1, r5, mrr, _ = avaliar(b, ("bm25", "sem"), pesos={"bm25": w, "sem": 1.0})
        print(f"  {w:<10} {r1:>8.0f}% {r5:>8.0f}% {mrr:>6.2f}")
        if melhor is None or (mrr, r5) > melhor[1:]:
            melhor = (w, mrr, r5)
    print(f"\n  Melhor nesta amostra: bm25 = {melhor[0]}")
    print("  (com poucas perguntas a diferença pode ser acaso; confirme com mais casos)\n")


def avaliar(b: Buscador, modos, detalhes=False, rerank=False, pesos=None):
    a1 = a5 = mrr = 0.0
    falhas = []
    for pergunta, esperados in CASOS:
        with contextlib.redirect_stdout(io.StringIO()):
            res = b.buscar(pergunta, k=10, verbose=False, modos=modos, rerank=rerank, pesos=pesos)
        refs = [r.ref for r in res]
        aceitos = _aceitos(esperados)
        pos = next((i for i, r in enumerate(res, 1) if _certo(r, aceitos)), None)
        if pos:
            mrr += 1 / pos
            a1 += pos == 1
            a5 += pos <= 5
        if not pos or pos > 5:
            falhas.append((pergunta, refs[:3]))
        if detalhes:
            marca = "✔" if pos == 1 else ("~" if pos and pos <= 5 else "✘")
            print(f"  {marca} {pergunta:<40} 1º acerto: {pos or '-':<3} topo: {refs[0] if refs else '-'}")
    n = len(CASOS)
    return 100 * a1 / n, 100 * a5 / n, mrr / n, falhas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--detalhes", action="store_true")
    ap.add_argument("--rerank", action="store_true", help="avalia também o híbrido + reranker")
    ap.add_argument("--varrer", action="store_true", help="compara pesos da busca por palavra")
    a = ap.parse_args()

    b = Buscador()
    if a.varrer:
        varrer(b)
        return
    print(f"\nMotor semântico: {b.motor.nome}  |  {len(CASOS)} perguntas\n")
    print(f"  {'modo':<26} {'acerto@1':>9} {'acerto@5':>9} {'MRR':>6}")
    print("  " + "-" * 53)
    modos = dict(MODOS)
    resultados = {}
    for nome, m in modos.items():
        if a.detalhes:
            print(f"\n  [{nome}]")
        resultados[nome] = avaliar(b, m, a.detalhes)
        if a.detalhes:
            print()
    if a.rerank:
        resultados["híbrido + rerank"] = avaliar(b, ("bm25", "sem"), a.detalhes, rerank=True)
    if a.detalhes:
        print(f"  {'modo':<26} {'acerto@1':>9} {'acerto@5':>9} {'MRR':>6}")
        print("  " + "-" * 53)
    for nome, (r1, r5, mrr, _) in resultados.items():
        print(f"  {nome:<26} {r1:>8.0f}% {r5:>8.0f}% {mrr:>6.2f}")

    falhas = resultados["híbrido (RRF)"][3]
    if falhas:
        print("\n  Perguntas em que o híbrido NÃO achou a resposta no top 5:")
        for p, topo in falhas:
            print(f"    - {p!r}  →  veio: {', '.join(topo) or 'nada'}")
    print()


if __name__ == "__main__":
    main()
