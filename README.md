# Bíblia IA

Bíblia completa (Almeida) com leitura, planos de leitura e busca inteligente que roda no próprio celular.

## Publicar: Android, Windows, Linux e site

```bash
bash publicar_github.sh
```

O script (no notebook) cria o repositório no seu GitHub, gera a chave de assinatura do Android em `~/.biblia-ia/` (**faça backup**), guarda a chave como segredo do repositório, ativa o GitHub Pages e envia o projeto. A compilação roda na nuvem (`.github/workflows/construir.yml`, uns 20 a 30 min):

| Saída | Onde |
|---|---|
| Android: `Biblia-IA-android.apk` | Releases |
| Windows: instalador `.exe` | Releases |
| Linux: `.AppImage` e `.deb` | Releases |
| Site | `https://USUARIO.github.io/biblia-ia/` |

Nova versão depois de mudanças: `bash publicar_github.sh --versao 1.0.1`.

Como cada plataforma funciona:
- **Android** (`capacitor.config.json`, Capacitor 8): o app web vai dentro do APK com tudo (texto, versões, IA). A voz usa o plugin nativo `@capacitor-community/text-to-speech`, porque o WebView do Android não tem a voz do navegador.
- **Windows/Linux** (`desktop/`, Electron): o app é servido por um protocolo próprio seguro (`app://`). Teste local: `cd desktop && npm install && npm start`.
- **Site** (`preparar_site.py`): o modelo de IA não vai junto (passa do limite de 100 MB do GitHub); vem do Hugging Face e fica guardado no navegador. O botão “Baixar a Bíblia completa” funciona (HTTPS).
- `web/config.js` muda por plataforma: `modeloRemoto` (site), `releases` (link de download) e `apoio: false` (versão sem Pix, para a Play Store).

## Começar

```bash
bash testar.sh     # 1ª vez: instala tudo, baixa o modelo e indexa a Bíblia (alguns minutos)
bash celular.sh    # prepara o app e mostra o endereço/QR code para abrir no celular
```

O celular precisa estar no **mesmo Wi-Fi** do notebook. Abra o endereço no Chrome. Para parar: Ctrl+C.

## O app

- **Ler**: Gênesis a Apocalipse, escolha de livro e capítulo, anterior/próximo, tamanho da letra. Ele lembra onde você parou. Toque num versículo para copiar ou ver passagens semelhantes.
- **Buscar**: palavra, frase, tema ou referência ("jo 3 16", "salms 23"). Tocar num resultado abre o capítulo com o versículo destacado. "≈ passagens semelhantes" mostra textos parecidos em outros livros (ex.: os paralelos dos Evangelhos).
- **Planos**: Gênesis ao Apocalipse no seu ritmo, Bíblia em 1 semana, em 1 mês e em 1 ano. Os dias são divididos pelo tamanho do texto, não pelo número de capítulos. O progresso fica salvo no celular.
- **▶ Ouvir**: lê o capítulo com a voz do Android (speechSynthesis), versículo por versículo, destacando na tela e seguindo para o próximo capítulo. Voz e velocidade na aba Mais.
- **Mais**: baixar tudo para usar sem internet, configurar a voz e ver o estado da IA.
- **Versões** (botão ao lado do capítulo): Almeida (Bíblia Livre), Nova Bíblia Viva, NTB e BLT (português de hoje; as duas últimas só NT), Tradução para Tradutores, **hebraico original** (Códice de Leningrado, só AT, lido da direita para a esquerda), **grego original** (Texto Bizantino, só NT), **Tanakh judaico JPS 1917** (só AT), King James, Reina-Valera 1909 e Louis Segond 1910. Busca, áudio (na voz do idioma) e passagens semelhantes funcionam em todas. Toque num versículo › “Comparar versões”.
- **Ordem judaica**: no seletor de livros, “Ordem judaica (Tanakh)” mostra Torá, Neviim e Ketuvim.

## Guardar o app no celular (sem internet)

O Chrome só deixa guardar um site no aparelho se ele vier de HTTPS ou de `localhost`. Pelo Wi-Fi do notebook não dá. Por isso, pelo Termux:

1. No notebook: `bash celular.sh`. O terminal mostra um comando `curl -O http://IP:8000/termux.sh && bash termux.sh IP:8000`.
2. No Termux do celular: rode esse comando. Ele baixa o app (~150 MB) para `~/biblia-app` e abre um servidor em `localhost:8080`.
3. No Chrome do celular: `http://localhost:8080` › aba **Mais** › **Baixar a Bíblia completa**.
4. Menu do Chrome › **Adicionar à tela inicial**. Daí em diante abre sem internet e sem o Termux.

Para abrir o servidor do Termux de novo (ex.: para atualizar): `bash ~/biblia-app/iniciar.sh`.

## Como a busca funciona

1. **Referência?** "livro capítulo:versículo" vai direto ao texto.
2. **Palavras (BM25)**, em 3 níveis: frase exata, depois todas as palavras, depois qualquer palavra. Ignora acentos, corrige erros de digitação e expande sinônimos (`SINONIMOS`).
3. **Sentido**: o modelo E5 transforma a pergunta num vetor e compara com os 31.102 versículos (cada um junto com os vizinhos).
4. **Fusão RRF** com pesos (`PESOS`). Quando há frase exata, a busca por palavra ganha mais peso.

## Comandos úteis

```bash
source venv/bin/activate
python biblia_busca.py interativo     # buscar pelo terminal
python avaliar.py --detalhes          # 45 perguntas com resposta conhecida
python avaliar.py --varrer            # testa pesos da busca por palavra
```

## Arquivos

- `biblia_almeida.json`: texto completo (veja `ATRIBUICAO.txt`)
- `versoes/`: outras versões; `preparar_versoes.py` converte/baixa
- `biblia_busca.py`: indexação e busca (Python)
- `avaliar.py`: medição da qualidade
- `exportar_web.py`: gera `web/biblia.json`, `web/emb.bin`, `web/arquivos.json` (lista do download) e `web/app.zip` (para o Termux) e baixa o modelo ONNX para `web/models/`
- `servidor.py`: entrega `web/` para o celular (`--local` no Termux)
- `web/termux.sh`: instala o app no Termux do celular
- `web/`: o app (HTML + JS; IA com Transformers.js + ONNX Runtime WebAssembly)

## Observações

- Pelo IP da rede o Chrome não guarda o modelo: ao abrir, ele baixa de novo pelo Wi-Fi (alguns segundos). Pelo Termux (`localhost`) e com o botão Baixar, tudo fica guardado.
- O progresso dos planos fica salvo no navegador, ligado ao endereço. Pelo IP do notebook e pelo `localhost:8080` são progressos separados. Use sempre o mesmo.
- A voz depende do motor de voz do Android. Se não houver voz em português: Configurações › Acessibilidade › Saída de texto para voz.
- Se o celular não abrir a página, confira o Wi-Fi e se o firewall do notebook libera a porta 8000.

## Texto bíblico

Bíblia Livre (Almeida 1819, rev. 2018), licença CC BY 4.0 Brasil. Atribuição completa em `ATRIBUICAO.txt` e dentro do app ("Sobre o texto").
