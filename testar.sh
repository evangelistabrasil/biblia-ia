#!/usr/bin/env bash
# Instala, indexa e testa a busca híbrida da Bíblia.
#
#   bash testar.sh            -> completo, com modelo neural (baixa ~1 GB na 1ª vez)
#   bash testar.sh --leve     -> sem modelo neural (rápido, motor reserva)
#
# Pode rodar quantas vezes quiser: o que já estiver instalado é reaproveitado.

set -euo pipefail
cd "$(dirname "$0")"

VERDE='\033[1;32m'; AMARELO='\033[1;33m'; VERMELHO='\033[1;31m'; AZUL='\033[1;34m'; FIM='\033[0m'
passo() { echo -e "\n${AZUL}==> $1${FIM}"; }
ok()    { echo -e "${VERDE}✔ $1${FIM}"; }
aviso() { echo -e "${AMARELO}! $1${FIM}"; }
erro()  { echo -e "${VERMELHO}✘ $1${FIM}"; exit 1; }

LEVE=0
[[ "${1:-}" == "--leve" ]] && LEVE=1

# ---------------------------------------------------------------- 1. checagens
passo "1/5 Verificando o sistema"
for f in biblia_busca.py avaliar.py biblia_almeida.json; do
    [[ -f "$f" ]] || erro "Arquivo $f não encontrado nesta pasta ($(pwd))."
done
command -v python3 >/dev/null || erro "python3 não instalado. Rode: sudo apt install python3"
python3 -c 'import sys; exit(sys.version_info < (3, 9))' || erro "Precisa de Python 3.9 ou mais novo."
python3 -c 'import sqlite3; c=sqlite3.connect(":memory:"); c.execute("create virtual table t using fts5(x)")' \
    || erro "O SQLite do seu Python não tem FTS5."
ok "Python $(python3 -c 'import platform; print(platform.python_version())') com SQLite FTS5"

# ---------------------------------------------------------------- 2. ambiente virtual
passo "2/5 Ambiente virtual (pasta venv/)"
if [[ ! -d venv ]]; then
    python3 -m venv venv 2>/dev/null || erro "Falta o módulo venv. Rode: sudo apt install python3-venv  e depois rode este script de novo."
    ok "venv criado"
else
    ok "venv já existe, reaproveitando"
fi
# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --quiet --upgrade pip

# ---------------------------------------------------------------- 3. dependências
passo "3/5 Instalando dependências"
python -m pip install --quiet numpy scikit-learn
ok "numpy e scikit-learn"

NEURAL=0
if [[ $LEVE -eq 1 ]]; then
    aviso "Modo --leve: pulando o modelo neural."
elif python -c 'import sentence_transformers' 2>/dev/null; then
    NEURAL=1; ok "sentence-transformers já instalado"
else
    echo "   Instalando PyTorch (versão só CPU, ~200 MB) e sentence-transformers..."
    if python -m pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu \
       && python -m pip install --quiet sentence-transformers; then
        NEURAL=1; ok "sentence-transformers instalado"
    else
        aviso "Não deu para instalar o modelo neural. Seguindo com o motor reserva."
    fi
fi

# ---------------------------------------------------------------- 4. indexação
passo "4/5 Criando o índice (biblia.db + embeddings)"
if [[ $NEURAL -eq 1 ]]; then
    echo "   Na 1ª vez o modelo (~470 MB) é baixado e a Bíblia inteira é indexada (alguns minutos)."
    python biblia_busca.py indexar biblia_almeida.json --se-necessario
else
    python biblia_busca.py indexar biblia_almeida.json --lsa --se-necessario
fi

# ---------------------------------------------------------------- 5. testes
passo "5/5 Testes"
echo -e "\n${AZUL}-- Buscas de exemplo --${FIM}"
for q in "jo 3 16" "salms 23:1" "o que Jesus ensinou sobre o divórcio" "não tenha medo" "Davi e Golias"; do
    echo -e "\n${VERDE}\$ buscar \"$q\"${FIM}"
    python biblia_busca.py buscar "$q" -k 3
done

echo -e "\n${AZUL}-- Avaliação (45 perguntas com resposta conhecida) --${FIM}"
python avaliar.py

echo -e "${VERDE}Tudo pronto!${FIM} Para continuar testando:"
echo "   source venv/bin/activate"
echo "   bash celular.sh                          # app no celular (Ler, Buscar, Planos)"
echo "   python biblia_busca.py interativo        # busca livre (Enter vazio sai)"
echo "   python avaliar.py --detalhes             # resultado pergunta por pergunta"
[[ $NEURAL -eq 1 ]] && echo "   python avaliar.py --rerank               # testa o reranker (baixa mais ~500 MB)"
echo
