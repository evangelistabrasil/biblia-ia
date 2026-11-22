#!/usr/bin/env bash
# Prepara a Bíblia completa com IA e abre um servidor para testar no celular pelo Wi-Fi.
#   bash celular.sh
set -euo pipefail
cd "$(dirname "$0")"
AZUL='\033[1;34m'; VERDE='\033[1;32m'; VERMELHO='\033[1;31m'; FIM='\033[0m'
passo() { echo -e "\n${AZUL}==> $1${FIM}"; }
erro()  { echo -e "${VERMELHO}✘ $1${FIM}"; exit 1; }

[[ -d venv ]] || erro "Rode primeiro: bash testar.sh"
# shellcheck disable=SC1091
source venv/bin/activate
python -c 'import sentence_transformers' 2>/dev/null || erro "Modelo neural não instalado. Rode: bash testar.sh"

passo "1/4 Índice da Bíblia completa (31.102 versículos)"
echo "   Na 1ª vez leva alguns minutos (a barra mostra o progresso). Depois é reaproveitado."
python biblia_busca.py indexar biblia_almeida.json --se-necessario

passo "2/4 Avaliação rápida da busca (45 perguntas)"
python avaliar.py

passo "3/4 Versões e exportação para o app (web/)"
python preparar_versoes.py
python -m pip install --quiet qrcode
python exportar_web.py

passo "4/4 Servidor"
echo -e "${VERDE}✔ Tudo pronto.${FIM}"
python servidor.py 8000
