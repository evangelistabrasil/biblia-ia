#!/usr/bin/env bash
# Publica a Bíblia IA no GitHub: cria o repositório, configura a assinatura do Android,
# ativa o site (GitHub Pages) e dispara a compilação de Android, Windows e Linux.
#
#   bash publicar_github.sh              # repositório "biblia-ia"
#   bash publicar_github.sh outro-nome
#   bash publicar_github.sh --versao 1.0.1   # publica uma nova versão (Release) depois de mudanças
set -euo pipefail
cd "$(dirname "$0")"
AZUL='\033[1;34m'; VERDE='\033[1;32m'; AMARELO='\033[1;33m'; VERMELHO='\033[1;31m'; FIM='\033[0m'
passo() { echo -e "\n${AZUL}==> $1${FIM}"; }
ok()    { echo -e "${VERDE}✔ $1${FIM}"; }
aviso() { echo -e "${AMARELO}! $1${FIM}"; }
erro()  { echo -e "${VERMELHO}✘ $1${FIM}"; exit 1; }

NOME="biblia-ia"; VERSAO="1.0.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --versao) VERSAO="$2"; shift 2 ;;
    *) NOME="$1"; shift ;;
  esac
done
CHAVES="$HOME/.biblia-ia"

passo "1/6 Ferramentas"
command -v git >/dev/null || erro "Falta o git:  sudo apt install -y git"
command -v gh  >/dev/null || erro "Falta o GitHub CLI:  sudo apt install -y gh   (depois rode este script de novo)"
command -v keytool >/dev/null || erro "Falta o keytool (Java):  sudo apt install -y openjdk-17-jre-headless"
ok "git, gh e keytool"

passo "2/6 Login no GitHub"
if ! gh auth status >/dev/null 2>&1; then
  echo "   Vai abrir o login do GitHub (escolha HTTPS e 'Login with a web browser')."
  gh auth login -h github.com -p https -w -s workflow
fi
# a permissão 'workflow' é necessária para enviar a compilação automática (.github/workflows)
gh auth status 2>&1 | grep -q "workflow" || gh auth refresh -h github.com -s workflow
gh auth setup-git >/dev/null
USUARIO=$(gh api user -q .login)
ok "conectado como $USUARIO"

passo "3/6 Chave de assinatura do Android"
mkdir -p "$CHAVES"; chmod 700 "$CHAVES"
if [ ! -f "$CHAVES/biblia.jks" ]; then
  SENHA=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  keytool -genkeypair -v -keystore "$CHAVES/biblia.jks" -alias biblia -keyalg RSA -keysize 4096 -validity 36500 \
    -storepass "$SENHA" -keypass "$SENHA" -dname "CN=Evangelista P. Silva, O=Biblia IA, C=BR" >/dev/null 2>&1
  echo "$SENHA" > "$CHAVES/senha.txt"; chmod 600 "$CHAVES/senha.txt" "$CHAVES/biblia.jks"
  ok "chave criada em $CHAVES"
  aviso "FAÇA BACKUP da pasta $CHAVES (pendrive/nuvem privada). Sem ela você não consegue publicar atualizações do APK."
else
  ok "usando a chave existente em $CHAVES"
fi

passo "4/6 Repositório $USUARIO/$NOME"
# Se um envio anterior falhou (nada chegou ao GitHub ainda), recomeça o histórico do zero,
# para que nenhum arquivo removido depois continue escondido em commits antigos.
# (sinal local: depois de um envio bem-sucedido existe a referência origin/main)
if [ -d .git ] && ! git rev-parse --verify -q refs/remotes/origin/main >/dev/null; then
  rm -rf .git
  aviso "o envio anterior não chegou ao GitHub; recomeçando o histórico local"
fi
[ -d .git ] || git init -q -b main
# A biblioteca de IA é baixada na compilação; aqui ela nunca entra (o detector de segredos do GitHub a confunde)
grep -qx "web/lib/transformers.min.js" .gitignore 2>/dev/null || echo "web/lib/transformers.min.js" >> .gitignore
grep -q "huggingface/transformers@" .github/workflows/construir.yml \
  || erro "Arquivos desatualizados: apague os .zip antigos de Downloads, baixe o novo e extraia de novo."
git add -A
git rm -q --cached --ignore-unmatch web/lib/transformers.min.js
git -c user.name="${GIT_NOME:-Evangelista P. Silva}" -c user.email="${GIT_EMAIL:-$USUARIO@users.noreply.github.com}" \
  commit -q -m "Bíblia IA $VERSAO" || true
if git ls-files --error-unmatch web/lib/transformers.min.js >/dev/null 2>&1; then
  erro "web/lib/transformers.min.js ainda está no envio; rode: rm -rf .git && bash publicar_github.sh"
fi
ok "envio sem a biblioteca de IA ($(git ls-files | wc -l) arquivos)"
if ! gh repo view "$USUARIO/$NOME" >/dev/null 2>&1; then
  gh repo create "$NOME" --public --description "Bíblia com leitura, planos, áudio e busca com IA no aparelho" >/dev/null
  ok "repositório criado: https://github.com/$USUARIO/$NOME"
else
  ok "repositório já existe"
fi
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$USUARIO/$NOME.git"

passo "5/6 Segredos da assinatura e site"
base64 -w0 "$CHAVES/biblia.jks" | gh secret set KEYSTORE_B64 -R "$USUARIO/$NOME"
gh secret set KEYSTORE_SENHA -R "$USUARIO/$NOME" < "$CHAVES/senha.txt"
ok "segredos configurados (a chave não vai para o código)"
# Chave Pix do cartão "Apoie este projeto": você digita uma vez; fica como segredo do repositório.
if ! gh secret list -R "$USUARIO/$NOME" 2>/dev/null | grep -q "^PIX_CHAVE"; then
  read -r -p "   Chave Pix para o cartão de apoio (Enter para não mostrar o cartão): " PIX || true
  if [ -n "${PIX:-}" ]; then
    printf "%s" "$PIX" | gh secret set PIX_CHAVE -R "$USUARIO/$NOME"
    ok "chave Pix guardada (para trocar: gh secret set PIX_CHAVE -R $USUARIO/$NOME)"
  else
    aviso "sem chave Pix: o cartão de apoio não aparece no app"
  fi
fi

passo "6/6 Enviando e compilando"
git push -q -u origin main
gh api -X POST "repos/$USUARIO/$NOME/pages" -f build_type=workflow >/dev/null 2>&1 \
  || gh api -X PUT "repos/$USUARIO/$NOME/pages" -f build_type=workflow >/dev/null 2>&1 || true
ok "site (GitHub Pages) ativado"
if git rev-parse "v$VERSAO" >/dev/null 2>&1; then
  aviso "a versão v$VERSAO já existe; para publicar outra use:  bash publicar_github.sh --versao 1.0.1"
else
  git tag "v$VERSAO" && git push -q origin "v$VERSAO"
  ok "versão v$VERSAO enviada (vai virar uma Release com os instaladores)"
fi

echo -e "\n${VERDE}Pronto! A compilação leva uns 20 a 30 minutos.${FIM}"
echo "   Acompanhar:   https://github.com/$USUARIO/$NOME/actions   (ou:  gh run watch -R $USUARIO/$NOME)"
echo "   Instaladores: https://github.com/$USUARIO/$NOME/releases/latest"
echo "   Site:         https://$USUARIO.github.io/$NOME/"
