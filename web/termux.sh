#!/data/data/com.termux/files/usr/bin/bash
# Instala o app Bíblia IA no próprio celular, pelo Termux.
#   bash termux.sh IP-DO-NOTEBOOK:8000
set -e
ORIGEM="$1"
if [ -z "$ORIGEM" ]; then echo "Uso: bash termux.sh IP-DO-NOTEBOOK:8000"; exit 1; fi
command -v python >/dev/null 2>&1 || pkg install -y python
command -v unzip  >/dev/null 2>&1 || pkg install -y unzip
mkdir -p ~/biblia-app && cd ~/biblia-app
echo "Baixando o app do notebook (~150 MB)..."
curl -f --progress-bar -o app.zip "http://$ORIGEM/app.zip"
unzip -oq app.zip && rm -f app.zip
printf '#!/data/data/com.termux/files/usr/bin/bash\ncd ~/biblia-app && python servidor.py 8080 --pasta web --local\n' > iniciar.sh
chmod +x iniciar.sh
echo
echo "✔ App guardado em ~/biblia-app"
echo "  Das próximas vezes, para abrir o servidor:  bash ~/biblia-app/iniciar.sh"
bash iniciar.sh
