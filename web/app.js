// Bíblia IA: leitura completa, planos de leitura e busca híbrida com IA no aparelho.
// A busca segue a mesma lógica do biblia_busca.py (BM25 em 3 níveis + embeddings E5 + RRF).

// Autor e apoio ao projeto. A chave Pix vem da compilação (segredo PIX_CHAVE do GitHub, gravado
// no config.js); sem ela o cartão de apoio não aparece. Versão da Play Store: config { apoio: false }.
const CFG = window.BIBLIA_CONFIG || {};
// Versão da Play Store (config { loja: "play" }): sem Pix (regra de pagamentos da loja) e sem baixar APK por fora (a loja atualiza).
const LOJA = CFG.loja === "play";
const APOIO = { autor: "Evangelista P. Silva", pix: CFG.pix || "", mostrar: CFG.apoio !== false && !!CFG.pix && !LOJA };
// Onde o app está rodando: APK (Capacitor), Windows/Linux (Electron) ou navegador/site
const NATIVO = !!window.Capacitor?.isNativePlatform?.();
const DESKTOP = /Electron/i.test(navigator.userAgent);
const INSTALADO = NATIVO || DESKTOP;   // tudo já vem dentro do app: não precisa do botão "Baixar"

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const semAcento = (s) => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
const tokens = (s) => s.match(/[\p{L}\p{N}_]+/gu) || [];
const limpar = (s) => s.replace(/[[\]]/g, "");
const italico = (s) => esc(s).replace(/\[([^\]]*)\]/g, "<i>$1</i>");

let B;                      // biblia.json
let N = 0;                  // nº de versículos
let LV, CP, VS;             // livro / capítulo / versículo de cada índice
let CAPS = [];              // capítulos em ordem: {b, c, ini, fim, chars, palavras}
let capId = [];             // capId[b][c-1] -> índice em CAPS
let EMB = null;             // Int8Array N × dims
let IDX = null;             // índice de palavras (BM25) da versão atual
const IDXS = {};            // índices por versão
const VER = {};             // versões carregadas: id -> {sigla, nome, idioma, textos}
const STOP_IDIOMA = {       // palavras muito comuns, por idioma (as do português vêm do biblia.json)
  en: "the and of to in a that is for it he his unto i be with they not all them him shall was which my me but ye you this from on as by are have thou thee thy there their what who how does do did say says said verse verses bible passage about",
  es: "el la los las de del y que en a un una por con para se su sus lo al no es mi me te como sobre mas o versiculo biblia dice",
  fr: "le la les de des du et que qui en a un une par pour sur se sa son ses ne pas il elle est au aux dans ce cette je tu nous vous l d qu s n verset bible",
};
const estado = { modo: "hibrido", embed: null, view: null, cap: 0, plano: null, semDe: null, ultima: "" };

// ============================================================ armazenamento local
const CHAVE = "biblia-ia-v1";
let S = { cap: 0, fonte: 19, planos: {} };
try { Object.assign(S, JSON.parse(localStorage.getItem(CHAVE) || "{}")); } catch {}
const salvar = () => { try { localStorage.setItem(CHAVE, JSON.stringify(S)); } catch {} };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}

// ============================================================ dados
function prepararTexto() {
  N = B.textos.length;
  LV = new Uint8Array(N); CP = new Uint16Array(N); VS = new Uint16Array(N);
  let i = 0;
  B.livros.forEach((lv, b) => {
    capId[b] = [];
    lv.caps.forEach((n, c) => {
      const ini = i; let chars = 0, palavras = 0;
      for (let v = 1; v <= n; v++, i++) {
        LV[i] = b; CP[i] = c + 1; VS[i] = v;
        chars += B.textos[i].length; palavras += B.textos[i].split(" ").length;
      }
      capId[b][c] = CAPS.length;
      CAPS.push({ b, c: c + 1, ini, fim: i, chars, palavras });
    });
  });
  B.alias = {};
  B.livros.forEach((lv) => {
    B.alias[semAcento(lv.nome).replace(/ /g, "")] = lv.nome;
    for (const a of lv.abrevs) B.alias[a] = lv.nome;
  });
  Object.assign(B.alias, B.alias_extra);
  B.livroIdx = Object.fromEntries(B.livros.map((l, b) => [l.nome, b]));
  B.stop = new Set(B.stopwords);
}
const versaoAtual = () => VER[S.versao] || VER.almeida;
const txt = (i) => { const t = versaoAtual().textos[i]; return t ?? null; };
const txtOu = (i) => txt(i) ?? B.textos[i];
const capSemTexto = (id) => { for (let i = CAPS[id].ini; i < CAPS[id].fim; i++) if (txt(i) != null) return false; return true; };
async function carregarVersao(id) {
  if (VER[id]) return VER[id];
  const info = B.versoes.find((v) => v.id === id);
  if (!info) throw new Error("versão desconhecida: " + id);
  const r = await fetch(`versoes/${id}.json`);
  if (!r.ok) throw new Error(`versoes/${id}.json: ${r.status}`);
  const d = await r.json();
  return (VER[id] = { ...info, textos: d.textos, atribuicao: d.atribuicao });
}
async function trocarVersao(id) {
  try { await carregarVersao(id); } catch (e) { return toast("Não consegui abrir a versão: " + e.message); }
  S.versao = id; salvar();
  IDX = null;
  pararAudio();
  const y = window.scrollY;
  abrirCapitulo(estado.cap, null, false); window.scrollTo(0, y);
  $("#btnVersao").textContent = versaoAtual().sigla;
  if (estado.view === "buscar") estado.semDe !== null ? mostrarSemelhantes(estado.semDe) : executarBusca();
}
const nomeCap = (id) => `${B.livros[CAPS[id].b].nome} ${CAPS[id].c}`;
const refDe = (i) => `${B.livros[LV[i]].nome} ${CP[i]}:${VS[i]}`;

function prepararIndice(v = versaoAtual()) {
  if (v === versaoAtual() && IDX) return IDX;
  if (IDXS[v.id]) return v === versaoAtual() ? (IDX = IDXS[v.id]) : IDXS[v.id];
  const post = new Map(), len = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    if (v.textos[i] == null) continue;
    const tk = tokens(semAcento(limpar(v.textos[i])));
    len[i] = tk.length;
    const tf = new Map();
    for (const t of tk) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let p = post.get(t);
      if (!p) post.set(t, (p = []));
      p.push(i, f);
    }
  }
  let soma = 0; for (let i = 0; i < N; i++) soma += len[i];
  const vocab = [...post.keys()].sort();
  const pt = v.idioma === "pt";
  const idx = { post, len, avgdl: soma / N, vocab, vocabSet: new Set(vocab), textos: v.textos, versao: v,
    stop: pt ? B.stop : new Set(tokens(semAcento(STOP_IDIOMA[v.idioma] || ""))), sinonimos: pt ? B.sinonimos : {} };
  IDXS[v.id] = idx;
  if (v === versaoAtual()) IDX = idx;
  return idx;
}

// ============================================================ similaridade de palavras (como o difflib)
function blocos(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0, bi = 0, bj = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) { best = prev[j]; bi = i - best; bj = j - best; }
      diag = tmp;
    }
  }
  if (!best) return 0;
  return best + blocos(a.slice(0, bi), b.slice(0, bj)) + blocos(a.slice(bi + best), b.slice(bj + best));
}
function parecidos(t, lista, n, corte) {
  const out = [];
  for (const w of lista) {
    if ((2 * Math.min(t.length, w.length)) / (t.length + w.length) < corte) continue;
    const r = (2 * blocos(t, w)) / (t.length + w.length);
    if (r >= corte) out.push([r, w]);
  }
  return out.sort((x, y) => y[0] - x[0]).slice(0, n).map((x) => x[1]);
}

// ============================================================ referência "jo 3 16"
const REF = /^\s*([1-3]?)\s*([a-zA-ZÀ-ÿ]+)\.?\s+(\d{1,3})(?:\s*[:.,\s]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?\s*$/;
function referencia(q) {
  const m = q.match(REF);
  if (!m) return null;
  const chave = (m[1] || "") + semAcento(m[2]);
  let livro = B.alias[chave];
  if (!livro) {
    const p = parecidos(chave, Object.keys(B.alias), 1, 0.8);
    if (!p.length) return null;
    livro = B.alias[p[0]];
  }
  const b = B.livroIdx[livro], c = +m[3];
  const id = capId[b]?.[c - 1];
  if (id === undefined) return [];
  const v1 = m[4] ? +m[4] : null, v2 = m[5] ? +m[5] : v1;
  const out = [];
  for (let i = CAPS[id].ini; i < CAPS[id].fim; i++) if (v1 === null || (VS[i] >= v1 && VS[i] <= v2)) out.push(i);
  return out;
}

// ============================================================ busca por palavra (3 níveis)
function analisar(q, X = IDX) {
  const { vocabSet, vocab, stop, sinonimos } = X;
  const termos = [], corr = {}, grupos = [];
  for (const t of tokens(semAcento(q))) {
    if (stop.has(t) || t.length < 2) continue;
    let grupo = [];
    if (sinonimos[t]) {
      const extra = sinonimos[t].flatMap((f) => f.split(" ")).filter((w) => vocabSet.has(w) && !stop.has(w));
      if (extra.length) { corr[t] = extra; grupo.push(...extra); }
      if (vocabSet.has(t)) grupo.push(t);
    } else if (!vocabSet.has(t) && t.length >= 5) {
      const p = parecidos(t, vocab, 3, 0.8);
      if (p.length) corr[t] = p;
      grupo.push(...(p.length ? p : [t]));
    } else grupo.push(t);
    if (grupo.length) { grupos.push(grupo); termos.push(...grupo); }
  }
  return { termos: [...new Set(termos)], corr, grupos };
}

function formas(t, X) { // termo com 5+ letras vale como prefixo (igual ao FTS5 "t"*)
  const { vocab, vocabSet } = X;
  if (t.length < 5) return vocabSet.has(t) ? [t] : [];
  let lo = 0, hi = vocab.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (vocab[m] < t) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < vocab.length && vocab[i].startsWith(t); i++) out.push(vocab[i]);
  return out;
}

function docsDoTermo(t, X) { // Map doc -> tf (somando as formas do prefixo)
  const m = new Map();
  for (const w of formas(t, X)) {
    const p = X.post.get(w);
    for (let k = 0; k < p.length; k += 2) m.set(p[k], (m.get(p[k]) || 0) + p[k + 1]);
  }
  return m;
}

function bm25(termos, grupos, frase, n, X = IDX) {
  const { len, avgdl } = X, k1 = 1.2, b = 0.75;
  const porTermo = new Map(termos.map((t) => [t, docsDoTermo(t, X)]));
  const score = new Map();
  for (const docs of porTermo.values()) {
    const idf = Math.log((N - docs.size + 0.5) / (docs.size + 0.5) + 1);
    for (const [d, tf] of docs) score.set(d, (score.get(d) || 0) + (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len[d]) / avgdl)));
  }
  const ordenar = (ids) => ids.sort((x, y) => score.get(y) - score.get(x) || x - y);
  const niveis = [];
  // nível 1: frase exata
  const ft = tokens(semAcento(frase)); // frase exata: todas as palavras, até "o" e "é"
  let achouFrase = false;
  if (ft.length >= 2 && ft.every((t) => X.post.has(t))) {
    let cand = null;
    for (const t of ft) {
      const p = X.post.get(t), s = new Set();
      for (let k = 0; k < p.length; k += 2) if (!cand || cand.has(p[k])) s.add(p[k]);
      cand = s;
    }
    const hits = [...cand].filter((d) => {
      const tk = tokens(semAcento(limpar(X.textos[d])));
      for (let i = 0; i + ft.length <= tk.length; i++) if (ft.every((t, j) => tk[i + j] === t)) return true;
      return false;
    });
    if (hits.length) { achouFrase = true; niveis.push(hits.sort((x, y) => (score.get(y) || 0) - (score.get(x) || 0) || x - y)); }
  }
  // nível 2: todas as palavras (uma alternativa de cada grupo)
  if (grupos.length >= 2) {
    const tem = (d, g) => g.some((t) => porTermo.get(t)?.has(d));
    niveis.push(ordenar([...score.keys()].filter((d) => grupos.every((g) => tem(d, g)))));
  }
  // nível 3: qualquer palavra
  niveis.push(ordenar([...score.keys()]));
  const out = [], vistos = new Set();
  for (const nv of niveis) for (const d of nv) {
    if (out.length >= n) break;
    if (!vistos.has(d)) { vistos.add(d); out.push(d); }
  }
  return { ids: out, achouFrase };
}

// ============================================================ busca por sentido
function topN(score, n, excluir) {
  const ids = [];
  for (let i = 0; i < score.length; i++) if (!excluir || !excluir(i)) ids.push(i);
  ids.sort((x, y) => score[y] - score[x]);
  return ids.slice(0, n);
}
function produto(v) { // v: vetor da consulta (Float32 ou Int8)
  const dim = B.dims, s = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let acc = 0; const o = i * dim;
    for (let j = 0; j < dim; j++) acc += EMB[o + j] * v[j];
    s[i] = acc;
  }
  return s;
}

function fundir(listas, pesos, k) {
  const fus = new Map();
  for (const [nome, ids] of Object.entries(listas)) ids.forEach((i, p) => {
    if (!fus.has(i)) fus.set(i, { i, score: 0, fontes: {} });
    const r = fus.get(i);
    r.score += pesos[nome] / (B.rrf_k + p + 1);
    r.fontes[nome === "bm25pt" ? "bm25" : nome] = Math.min(r.fontes[nome === "bm25pt" ? "bm25" : nome] || 1e9, p + 1);
  });
  return [...fus.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

async function buscar(q, k = 20) {
  prepararIndice();
  const outra = versaoAtual().id !== "almeida";
  const ref = referencia(q);
  if (ref && ref.length) return { res: ref.map((i) => ({ i, fontes: { ref: 1 } })), corr: {} };
  const { termos, corr, grupos } = analisar(q);
  const qSem = q + (Object.keys(corr).length ? " " + Object.values(corr).flat().join(" ") : "");
  const n = Math.max(k * 3, 50), listas = {}, pesos = { ...B.pesos };
  const usaSem = estado.modo !== "bm25" && estado.embed && EMB;
  if (estado.modo !== "sem" || !usaSem) {
    const r = bm25(termos, grupos, q, n);
    listas.bm25 = r.ids;
    if (r.achouFrase) pesos.bm25 = Math.max(pesos.bm25, 2.0); // frase exata: confiar mais na palavra
    if (outra) { // lendo em outra língua: também procura as palavras na Almeida (pergunta em português)
      const XA = prepararIndice(VER.almeida), a = analisar(q, XA), ra = bm25(a.termos, a.grupos, q, n, XA);
      listas.bm25pt = ra.ids; pesos.bm25pt = ra.achouFrase ? 2.0 : pesos.bm25;
      for (const [w, c] of Object.entries(a.corr)) corr[w] = corr[w] || c;
    }
  }
  if (usaSem) listas.sem = topN(produto(await estado.embed(qSem)), n);
  return { res: fundir(listas, pesos, k), corr, semIA: !usaSem && estado.modo !== "bm25" };
}

// Passagens semelhantes: usa o embedding já guardado do versículo (não precisa do modelo).
function semelhantes(i, k = 20) {
  prepararIndice();
  const b = LV[i], c = CP[i];
  const fora = (j) => LV[j] === b && CP[j] === c; // tira o próprio capítulo
  const listas = {};
  if (EMB) listas.sem = topN(produto(EMB.subarray(i * B.dims, (i + 1) * B.dims)), 60, fora);
  const { termos } = analisar(limpar(txtOu(i)));
  listas.bm25 = bm25(termos, [], "", 120).ids.filter((j) => !fora(j)).slice(0, 60);
  return fundir(listas, { bm25: 0.5, sem: 1.0 }, k);
}

// ============================================================ LEITOR
function abrirCapitulo(id, destaque = null, salvarPos = true) {
  id = Math.max(0, Math.min(CAPS.length - 1, id));
  if (!voz.avancando) pararAudio(); // o usuário trocou de capítulo: para a leitura em voz alta
  estado.cap = id;
  const C = CAPS[id], lv = B.livros[C.b];
  $("#btnRef").textContent = nomeCap(id);
  let h = `<h2>${esc(lv.nome)} ${C.c}</h2><p class="sub">${lv.caps.length > 1 ? `Capítulo ${C.c} de ${lv.caps.length}` : "Capítulo único"} · ${Math.max(1, Math.round(C.palavras / 200))} min de leitura</p>`;
  const V = versaoAtual();
  let semCap = true;
  for (let i = C.ini; i < C.fim; i++) if (txt(i) != null) { semCap = false; break; }
  if (semCap) h += `<p class="aviso-v">${esc(V.sigla)} tem só o ${V.testamento === "at" ? "Antigo" : "Novo"} Testamento. Mostrando a Almeida neste capítulo.</p>`;
  const rtl = !semCap && V.idioma === "he";
  h += `<div class="texto" ${rtl ? 'dir="rtl" lang="he"' : V.idioma === "el" && !semCap ? 'lang="el"' : ""}>`;
  for (let i = C.ini; i < C.fim; i++) {
    const t = semCap ? B.textos[i] : txt(i);
    if (t == null) continue; // versículo que esta versão junta ao vizinho
    h += `<p class="vs" id="v${VS[i]}" data-i="${i}" tabindex="0"><sup>${VS[i]}</sup>${italico(t)}</p>`;
  }
  h += `</div>`;
  $("#capitulo").innerHTML = h;
  if (salvarPos && !estado.plano) { S.cap = id; salvar(); }
  atualizarNavCap();
  if (destaque !== null) {
    const el = $("#v" + VS[destaque]);
    requestAnimationFrame(() => { el.scrollIntoView({ block: "center" }); el.classList.add("destaque"); setTimeout(() => el.classList.remove("destaque"), 2500); });
  } else window.scrollTo(0, 0);
}

function atualizarNavCap() {
  const p = estado.plano;
  $("#planoBarra").hidden = !p;
  if (!p) {
    $("#ant").disabled = estado.cap === 0;
    $("#ant").textContent = "‹ Anterior";
    $("#prox").disabled = estado.cap === CAPS.length - 1;
    $("#prox").textContent = "Próximo ›";
    return;
  }
  const P = PLANOS.find((x) => x.id === p.id);
  const ult = p.pos === p.fila.length - 1;
  $("#planoTxt").textContent = P.dias
    ? `${P.nome} · Dia ${p.dia + 1} · capítulo ${p.pos + 1} de ${p.fila.length}`
    : `${P.nome} · ${nomeCap(p.fila[0])}`;
  $("#ant").disabled = p.pos === 0;
  $("#ant").textContent = "‹ Anterior";
  $("#prox").disabled = false;
  $("#prox").textContent = ult ? (P.dias ? `✓ Concluir dia ${p.dia + 1}` : "✓ Lido, próximo capítulo") : "Próximo do plano ›";
}

function navegar(delta) {
  const p = estado.plano;
  if (!p) return abrirCapitulo(estado.cap + delta);
  if (delta < 0) { p.pos--; return abrirCapitulo(p.fila[p.pos]); }
  if (p.pos < p.fila.length - 1) { p.pos++; return abrirCapitulo(p.fila[p.pos]); }
  concluirDiaPlano();
}

// ---------- seletor de livro / capítulo
function abrirSeletor(b = null) {
  const atualB = CAPS[estado.cap].b;
  if (b === null) {
    $("#selTitulo").textContent = "Escolha o livro";
    const bt = (i) => `<button type="button" data-b="${i}" class="${i === atualB ? "atual" : ""}">${esc(B.livros[i].nome)}</button>`;
    const grade = (ids) => `<div class="grade">${ids.map(bt).join("")}</div>`;
    const judaica = S.ordem === "judaica";
    const at = judaica
      ? `<p class="secao">Torá (Lei)</p>${grade(TANAKH.tora)}<p class="secao">Neviim (Profetas)</p>${grade(TANAKH.neviim)}<p class="secao">Ketuvim (Escritos)</p>${grade(TANAKH.ketuvim)}`
      : `<p class="secao">Antigo Testamento</p>${grade([...Array(39).keys()])}`;
    $("#selConteudo").innerHTML =
      `<div class="ordem" role="group" aria-label="Ordem dos livros"><button type="button" data-ordem="crista" aria-pressed="${!judaica}">Ordem cristã</button><button type="button" data-ordem="judaica" aria-pressed="${judaica}">Ordem judaica (Tanakh)</button></div>` +
      at + `<p class="secao">${judaica ? "Brit Hadashá (Novo Testamento)" : "Novo Testamento"}</p>${grade([...Array(27).keys()].map((i) => i + 39))}` +
      `<details class="sobre"><summary>Sobre o texto</summary><pre>${esc(B.atribuicao)}</pre></details>`;
  } else {
    $("#selTitulo").textContent = B.livros[b].nome;
    $("#selConteudo").innerHTML = `<p class="secao">Capítulos</p><div class="grade caps">${B.livros[b].caps
      .map((_, c) => `<button type="button" data-id="${capId[b][c]}" class="${capId[b][c] === estado.cap ? "atual" : ""}">${c + 1}</button>`).join("")}</div>`;
  }
  $("#seletor").scrollTop = 0;
  if ($("#seletor").hidden) { $("#seletor").hidden = false; history.pushState({ v: estado.view, ov: "seletor" }, ""); }
}

const NOME_IDIOMA = { pt: "Português", en: "Inglês", es: "Espanhol", fr: "Francês", he: "Hebraico", el: "Grego" };
// ---------- folha genérica (versões, comparar)
function abrirFolha2(html) {
  $("#folha2").innerHTML = html;
  $("#fundo").hidden = $("#folha2").hidden = false;
  history.pushState({ v: estado.view, ov: "folha2" }, "");
}
function htmlVersoes() {
  return `<strong>Versão e letra</strong><div class="listaV">${B.versoes.map((v) =>
    `<button type="button" class="opV ${v.id === versaoAtual().id ? "atual" : ""}" data-versao="${v.id}"><b>${esc(v.sigla)}</b> ${esc(v.nome)}<small>${esc(NOME_IDIOMA[v.idioma] || v.idioma)}${v.testamento === "at" ? " · só Antigo Testamento" : v.testamento === "nt" ? " · só Novo Testamento" : ""}</small></button>`).join("")}</div>
    <div class="fontes2"><span>Tamanho da letra</span><button type="button" data-fonte="-1" aria-label="Diminuir letra">A−</button><button type="button" data-fonte="1" aria-label="Aumentar letra">A+</button></div>
    <button type="button" class="btn sec" data-fechar="1">Fechar</button>`;
}
async function compararVersoes(i) {
  abrirFolha2(`<strong>${esc(refDe(i))} em todas as versões</strong><p class="mut">Carregando…</p>`);
  const vs = [];
  for (const v of B.versoes) { try { vs.push(await carregarVersao(v.id)); } catch {} }
  if ($("#folha2").hidden) return;
  $("#folha2").innerHTML = `<strong>${esc(refDe(i))} em todas as versões</strong><div class="comp">${vs.map((v) =>
    `<div><span class="tag">${esc(v.sigla)}</span><p ${v.idioma === "he" && v.textos[i] != null ? 'dir="rtl" lang="he"' : ""}>${v.textos[i] == null
      ? `<i>${(v.testamento === "at" && LV[i] >= 39) || (v.testamento === "nt" && LV[i] < 39) ? "(esta versão não tem este Testamento)" : "(unido ao versículo vizinho nesta versão)"}</i>`
      : italico(v.textos[i])}</p></div>`).join("")}</div>
    <button type="button" class="btn sec" data-fechar="1">Fechar</button>`;
}

// Ordem dos livros na Bíblia hebraica (índices da ordem cristã)
const TANAKH = {
  tora: [0, 1, 2, 3, 4],
  neviim: [5, 6, 8, 9, 10, 11, 22, 23, 25, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38],
  ketuvim: [18, 19, 17, 21, 7, 24, 20, 16, 26, 14, 15, 12, 13],
};

// ---------- folha de ações do versículo
let folhaI = null;
function abrirFolha(i) {
  folhaI = i;
  $("#folhaRef").textContent = refDe(i);
  $("#folhaTxt").innerHTML = italico(txtOu(i));
  $("#fundo").hidden = $("#folha").hidden = false;
  history.pushState({ v: estado.view, ov: "folha" }, "");
}
function fecharOverlays() { $("#seletor").hidden = $("#folha").hidden = $("#folha2").hidden = $("#fundo").hidden = true; }

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; } catch {}
  const ta = document.createElement("textarea"); ta.value = texto; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  ta.remove(); return ok;
}

// ============================================================ BUSCA (interface)
function renderResultados({ res, corr, semIA }, ms) {
  const info = [];
  if (corr && Object.keys(corr).length)
    info.push("expandido: " + Object.entries(corr).map(([a, b]) => `<b>${esc(a)}</b> → ${esc(b.join(", "))}`).join("; "));
  info.push(`${res.length} resultado(s) em ${ms.toFixed(0)} ms` + (versaoAtual().id !== "almeida" ? ` · texto da ${esc(versaoAtual().sigla)}` : ""));
  if (semIA) info.push("IA ainda carregando: só palavras");
  $("#info").innerHTML = info.join(" · ");
  if (res.length && res[0].fontes.ref) {
    const i = res[0].i, id = capId[LV[i]][CP[i] - 1];
    const alvo = res.length === CAPS[id].fim - CAPS[id].ini ? nomeCap(id) : (res.length === 1 ? refDe(i) : `${refDe(i)}-${VS[res[res.length - 1].i]}`);
    $("#origem").innerHTML = `<button type="button" class="abrir" data-abrir="${i}">📖 Abrir ${esc(alvo)} no leitor</button>`;
  }
  $("#lista").innerHTML = res.length ? res.map(({ i, fontes }) => {
    const tags = [];
    if (fontes.ref) tags.push(`<span class="tag">referência</span>`);
    if (fontes.bm25) tags.push(`<span class="tag p">palavra #${fontes.bm25}</span>`);
    if (fontes.sem) tags.push(`<span class="tag s">sentido #${fontes.sem}</span>`);
    return `<li class="res" data-i="${i}" tabindex="0"><div class="ref"><strong>${esc(refDe(i))}</strong>${tags.join("")}</div>
      <p class="txt">${italico(txtOu(i))}</p>
      <div class="acoes"><button type="button" class="sem" data-sem="${i}" aria-label="Passagens semelhantes a ${esc(refDe(i))}">≈ passagens semelhantes</button></div></li>`;
  }).join("") : `<li class="vazio">Nada encontrado. Tente outras palavras.</li>`;
}

async function executarBusca() {
  const q = $("#q").value.trim();
  estado.ultima = q; estado.semDe = null; $("#origem").innerHTML = "";
  if (!q) { $("#info").textContent = ""; $("#lista").innerHTML = `<li class="vazio">Digite uma palavra, um tema ou uma referência.</li>`; return; }
  const t = performance.now();
  try {
    const r = await buscar(q);
    if (q === estado.ultima) renderResultados(r, performance.now() - t);
  } catch (e) { console.error(e); $("#info").textContent = "Erro na busca: " + e.message; }
}

function mostrarSemelhantes(i) {
  estado.semDe = i; estado.ultima = "";
  const t = performance.now();
  const res = semelhantes(i);
  $("#origem").innerHTML = `<div class="origem"><span class="tag">passagens semelhantes a</span><br><strong>${esc(refDe(i))}</strong><p>${italico(txtOu(i))}</p></div>`;
  renderResultados({ res, corr: {}, semIA: !EMB }, performance.now() - t);
  if (!EMB) $("#info").innerHTML += " · dados da IA ainda carregando: só palavras";
  ir("buscar"); window.scrollTo(0, 0);
}

// ============================================================ PLANOS
const PLANOS = [
  { id: "livre", nome: "Gênesis ao Apocalipse", desc: "Leitura diária no seu ritmo, capítulo por capítulo, sem prazo.", dias: null },
  { id: "semana", nome: "A Bíblia em 1 semana", desc: "Leitura intensiva em 7 dias.", dias: 7 },
  { id: "mes", nome: "A Bíblia em 1 mês", desc: "30 dias de leitura.", dias: 30 },
  { id: "ano", nome: "A Bíblia em 1 ano", desc: "365 dias, um pouco por dia.", dias: 365 },
];
const cacheDias = {};
function diasDoPlano(P) {
  if (cacheDias[P.id]) return cacheDias[P.id];
  if (!P.dias) return (cacheDias[P.id] = CAPS.map((_, i) => [i]));
  // Divide por tamanho do texto (não por nº de capítulos): Salmos 117 e Salmos 119 pesam diferente.
  const NC = CAPS.length, dias = [];
  let i = 0, resto = CAPS.reduce((s, c) => s + c.chars, 0);
  for (let d = 0; d < P.dias; d++) {
    const alvo = resto / (P.dias - d), dia = [];
    let soma = 0;
    while (i < NC) {
      const w = CAPS[i].chars;
      if (dia.length && (soma + w / 2 > alvo || NC - i <= P.dias - d - 1)) break;
      dia.push(i); soma += w; i++;
    }
    dias.push(dia); resto -= soma;
  }
  while (i < NC) dias[dias.length - 1].push(i++);
  return (cacheDias[P.id] = dias);
}

function rotuloDia(ids) {
  const seg = [];
  for (const id of ids) {
    const { b, c } = CAPS[id], u = seg[seg.length - 1];
    if (u && u.b === b && u.fim === c - 1) u.fim = c; else seg.push({ b, ini: c, fim: c });
  }
  const s = (x) => `${B.livros[x.b].nome} ${x.ini}${x.fim > x.ini ? "–" + x.fim : ""}`;
  if (seg.length <= 3) return seg.map(s).join("; ");
  const a = seg[0], z = seg[seg.length - 1];
  return `${B.livros[a.b].nome} ${a.ini} até ${B.livros[z.b].nome} ${z.fim}`;
}
const minutos = (ids) => Math.round(ids.reduce((s, id) => s + CAPS[id].palavras, 0) / 200);
function duracao(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h} h${r ? " " + r + " min" : ""}`;
}
const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const diasEntre = (a, b) => Math.round((new Date(b + "T12:00") - new Date(a + "T12:00")) / 864e5);

function progresso(P) {
  const st = S.planos[P.id];
  const dias = diasDoPlano(P);
  if (!st) return { st: null, dias, feitos: new Set(), pct: 0 };
  const feitos = new Set(st.feitos);
  return { st, dias, feitos, pct: Math.floor((100 * feitos.size) / dias.length) };
}

function renderPlanos() {
  const totalMin = minutos(CAPS.map((_, i) => i));
  $("#planosConteudo").innerHTML = `<p class="det meta" style="margin-top:16px">A Bíblia inteira tem ${CAPS.length} capítulos, cerca de ${duracao(totalMin)} de leitura (200 palavras por minuto).</p>` +
    PLANOS.map((P) => {
      const { st, pct, feitos, dias } = progresso(P);
      const porDia = P.dias ? `≈ ${duracao(Math.round(totalMin / P.dias))} por dia` : "1 capítulo por vez, ≈ 4 min cada";
      const status = !st ? "Ainda não começou" : P.dias ? `${feitos.size} de ${dias.length} dias lidos` : `${feitos.size} de ${dias.length} capítulos lidos`;
      return `<div class="plano" data-p="${P.id}" tabindex="0" role="button"><h3>${esc(P.nome)}</h3>
        <p>${esc(P.desc)} ${porDia}.<br>${status}</p><div class="pct">${st ? pct + "%" : ""}<small>${st ? "concluído" : ""}</small></div>
        ${st ? `<div class="barra"><span style="width:${pct}%"></span></div>` : ""}</div>`;
    }).join("") +
    `<details class="sobre"><summary>Sobre o texto</summary><pre>${esc(B.atribuicao)}</pre></details><p class="credito">Made by ${esc(APOIO.autor)}</p>`;
}

function renderPlano(id) {
  const P = PLANOS.find((x) => x.id === id);
  const { st, dias, feitos, pct } = progresso(P);
  const totalMin = minutos(CAPS.map((_, i) => i));
  let h = `<div class="det"><h2>${esc(P.nome)}</h2><p class="meta">${esc(P.desc)} ${P.dias ? `${P.dias} dias · ≈ ${duracao(Math.round(totalMin / P.dias))} por dia` : `${CAPS.length} capítulos`}</p>`;
  if (P.id === "semana") h += `<p class="aviso">É um desafio grande: são cerca de ${duracao(Math.round(totalMin / 7))} de leitura por dia.</p>`;
  if (!st) {
    h += `<div class="hoje"><p class="rot">${P.dias ? "Dia 1" : "Primeiro capítulo"}</p><p class="cap">${esc(rotuloDia(dias[0]))}</p>
      <button type="button" class="btn" data-acao="comecar" data-p="${P.id}">Começar hoje</button></div>`;
  } else {
    const prox = dias.findIndex((_, d) => !feitos.has(d));
    if (P.dias) {
      const hoje = Math.min(dias.length - 1, Math.max(0, diasEntre(st.inicio, hojeISO())));
      const atrasados = dias.slice(0, hoje).filter((_, d) => !feitos.has(d)).length;
      if (prox === -1) h += `<div class="hoje"><p class="cap">Plano concluído! 🎉</p></div>`;
      else {
        const alvo = feitos.has(hoje) ? prox : hoje;
        h += `<div class="hoje"><p class="rot">${alvo === hoje ? "Leitura de hoje" : "Próxima leitura"} · Dia ${alvo + 1} de ${dias.length} · ≈ ${duracao(minutos(dias[alvo]))}</p>
          <p class="cap">${esc(rotuloDia(dias[alvo]))}</p>
          <button type="button" class="btn" data-acao="ler" data-p="${P.id}" data-d="${alvo}">Ler o dia ${alvo + 1}</button>
          ${atrasados ? `<p class="aviso">Você tem ${atrasados} dia(s) atrasado(s). O primeiro é o dia ${prox + 1}.</p>` : ""}</div>`;
      }
    } else if (prox === -1) h += `<div class="hoje"><p class="cap">Você leu a Bíblia inteira! 🎉</p></div>`;
    else h += `<div class="hoje"><p class="rot">Continuar de onde parou · ${pct}% lido</p><p class="cap">${esc(nomeCap(prox))}</p>
      <button type="button" class="btn" data-acao="ler" data-p="${P.id}" data-d="${prox}">Continuar a leitura</button></div>`;
    h += `<p class="meta">Começou em ${new Date(st.inicio + "T12:00").toLocaleDateString("pt-BR")} · ${feitos.size} de ${dias.length} ${P.dias ? "dias" : "capítulos"} lidos</p>`;
  }
  h += `<button type="button" class="btn sec" data-acao="voltar">‹ Todos os planos</button>`;
  // Lista de dias (no plano livre, por livro, para não ficar gigante)
  if (P.dias) {
    const hoje = st ? Math.max(0, diasEntre(st.inicio, hojeISO())) : -1;
    h += `<div class="dias">${dias.map((ids, d) => `<div class="dia ${feitos.has(d) ? "feito" : ""} ${d === hoje ? "hj" : ""}">
      <button type="button" class="ck" data-acao="marcar" data-p="${P.id}" data-d="${d}" aria-label="Marcar dia ${d + 1} como lido" aria-pressed="${feitos.has(d)}">✓</button>
      <button type="button" class="txtd" data-acao="ler" data-p="${P.id}" data-d="${d}">Dia ${d + 1}: ${esc(rotuloDia(ids))}<small>≈ ${duracao(minutos(ids))}${st ? " · " + new Date(new Date(st.inicio + "T12:00").getTime() + d * 864e5).toLocaleDateString("pt-BR", { day: "numeric", month: "short" }) : ""}</small></button></div>`).join("")}</div>`;
  } else {
    h += `<div class="dias">${B.livros.map((lv, b) => {
      const ids = capId[b], lidos = ids.filter((id) => feitos.has(id)).length;
      return `<div class="dia ${lidos === ids.length ? "feito" : ""}"><span class="ck" aria-hidden="true" style="display:grid;place-items:center">✓</span>
        <button type="button" class="txtd" data-acao="ler" data-p="livre" data-d="${ids.find((id) => !feitos.has(id)) ?? ids[0]}">${esc(lv.nome)}<small>${lidos} de ${ids.length} capítulos lidos</small></button></div>`;
    }).join("")}</div>`;
  }
  if (st) h += `<p style="margin-top:20px"><button type="button" class="btn sec" data-acao="reiniciar" data-p="${P.id}">Recomeçar este plano</button></p>`;
  $("#planosConteudo").innerHTML = h + "</div>";
  estado.planoAberto = id;
}

function lerPlano(pid, d) {
  const P = PLANOS.find((x) => x.id === pid);
  if (!S.planos[pid]) { S.planos[pid] = { inicio: hojeISO(), feitos: [] }; salvar(); }
  const fila = diasDoPlano(P)[d];
  estado.plano = { id: pid, dia: d, fila, pos: 0 };
  ir("ler");
  abrirCapitulo(fila[0]);
}

function concluirDiaPlano() {
  const p = estado.plano, P = PLANOS.find((x) => x.id === p.id);
  const st = S.planos[p.id];
  if (!st.feitos.includes(p.dia)) st.feitos.push(p.dia);
  salvar();
  if (!P.dias) { // plano livre: segue para o próximo capítulo não lido
    S.cap = p.fila[0]; salvar();
    const prox = diasDoPlano(P).findIndex((_, d) => !st.feitos.includes(d));
    if (prox === -1) { estado.plano = null; toast("Você leu a Bíblia inteira! 🎉"); return abrirCapitulo(p.fila[0]); }
    toast(`${nomeCap(p.fila[0])} marcado como lido`);
    estado.plano = { id: "livre", dia: prox, fila: [prox], pos: 0 };
    return abrirCapitulo(prox);
  }
  toast(`Dia ${p.dia + 1} concluído ✓`);
  estado.plano = null;
  ir("planos"); renderPlano(p.id); window.scrollTo(0, 0);
}

// ============================================================ navegação entre áreas
function ir(v, push = true) {
  if (estado.view === v) return;
  estado.view = v;
  for (const s of ["ler", "buscar", "planos", "mais"]) $("#v-" + s).hidden = s !== v;
  document.querySelectorAll("#abas button").forEach((b) => b.setAttribute("aria-current", b.dataset.v === v ? "page" : "false"));
  if (v === "planos" && !estado.planoAberto) renderPlanos();
  if (v === "mais") renderMais();
  if (push) history.pushState({ v }, "");
}

window.addEventListener("popstate", (e) => {
  const st = e.state || { v: "ler" };
  if (!$("#seletor").hidden && st.ov !== "seletor") $("#seletor").hidden = true;
  if (!$("#folha").hidden && st.ov !== "folha") { $("#folha").hidden = $("#fundo").hidden = true; }
  if (!$("#folha2").hidden && st.ov !== "folha2") { $("#folha2").hidden = $("#fundo").hidden = true; }
  ir(st.v, false);
});

// ============================================================ IA
function iaStatus(txt, cls = "") {
  $("#ia").textContent = txt; $("#iaBox").className = "iabox " + cls;
  $("#iaDeNovo").hidden = cls !== "erro";
  estado.iaTxt = txt; estado.iaCls = cls;
  if (estado.view === "mais") renderMais();
}

async function carregarEmbeddings() {
  try {
    const r = await fetch("emb.bin");
    if (!r.ok) throw new Error("emb.bin " + r.status);
    EMB = new Int8Array(await r.arrayBuffer());
    if (EMB.length !== N * B.dims) throw new Error("emb.bin com tamanho inesperado");
  } catch (e) { EMB = null; console.error(e); estado.iaErro = String(e?.message || e); iaStatus("Dados da IA não encontrados: só palavras", "erro"); return false; }
  return true;
}

async function carregarIA() {
  if (estado.iaCarregando || estado.embed) return;
  estado.iaCarregando = true;
  try { await carregarIA2(); } finally { estado.iaCarregando = false; }
}
async function carregarIA2() {
  if (!EMB && !(await carregarEmbeddings())) return;
  iaStatus("IA: carregando o modelo…");
  try {
    const { pipeline, env } = await import("./lib/transformers.min.js");
    if (CFG.modeloRemoto) {
      // Site: o modelo (118 MB) vem do Hugging Face e fica guardado no navegador (Cache API)
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.useBrowserCache = typeof caches !== "undefined";
      env.useWasmCache = false;
    } else {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = "models/"; // caminho relativo: URL completa (http://) é ignorada pela biblioteca
      env.useBrowserCache = false;     // quem guarda o modelo no aparelho é o botão "Baixar" (service worker)
      env.useWasmCache = false;
    }
    env.backends.onnx.wasm.wasmPaths = {
      mjs: new URL("lib/ort-wasm-simd-threaded.asyncify.mjs", location.href).href,
      wasm: new URL("lib/ort-wasm-simd-threaded.asyncify.wasm", location.href).href,
    };
    const t0 = performance.now();
    const extrator = await pipeline("feature-extraction", CFG.modeloRemoto ? "Xenova/" + B.modelo : B.modelo, {
      dtype: "q8",
      progress_callback: (p) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx") && p.total)
          iaStatus(`IA: carregando o modelo ${Math.round((100 * p.loaded) / p.total)}%`);
      },
    });
    const embed = async (texto) => (await extrator("query: " + texto, { pooling: "mean", normalize: true })).data;
    await embed("teste"); // aquece; só liga a IA se isto funcionar
    estado.embed = embed;
    iaStatus(`IA ativa no aparelho ✓ (pronta em ${((performance.now() - t0) / 1000).toFixed(1)} s)`, "ok");
    if (estado.ultima) executarBusca();
  } catch (e) {
    console.error(e);
    estado.iaErro = String(e?.message || e);
    iaStatus("IA não carregou: buscando só por palavras", "erro");
  }
}

// ============================================================ LEITURA EM VOZ ALTA (voz do Android)
const voz = { token: 0, i: null, ativo: false, pausado: false, avancando: false };
// No APK o WebView do Android não tem speechSynthesis: usamos o plugin nativo de voz (TextToSpeech)
const TTS_NATIVO = NATIVO ? window.Capacitor?.Plugins?.TextToSpeech : null;
const temVoz = !!TTS_NATIVO || ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
const PREF_LANG = { pt: /pt[-_]BR/i, en: /en[-_]US/i, es: /es[-_](ES|US|MX)/i, fr: /fr[-_]FR/i, he: /(he|iw)[-_]IL/i, el: /el[-_]GR/i };
const PREFIXOS = { he: ["he", "iw"] };
// Capítulo sem texto nesta versão (ex.: hebraico no NT): lê a Almeida, em português
const idiomaAtual = () => (capSemTexto(estado.cap) ? "pt" : versaoAtual().idioma || "pt");
function vozesPt(lang = idiomaAtual()) {
  const pre = PREFIXOS[lang] || [lang];
  if (TTS_NATIVO || !temVoz) return []; // no APK o Android escolhe a voz do idioma
  return speechSynthesis.getVoices().filter((v) => pre.some((p) => v.lang.toLowerCase().startsWith(p)));
}
const pararFala = () => { if (TTS_NATIVO) TTS_NATIVO.stop().catch(() => {}); else if (temVoz) speechSynthesis.cancel(); };
function escolherVoz(lang = idiomaAtual()) {
  const vs = vozesPt(lang), pref = PREF_LANG[lang] || /./;
  S.vozes = S.vozes || {};
  return vs.find((v) => v.voiceURI === (S.vozes[lang] || (lang === "pt" ? S.voz : null))) ||
    vs.find((v) => pref.test(v.lang) && /google/i.test(v.name)) || vs.find((v) => pref.test(v.lang)) || vs[0] || null;
}
const LANG_TAG = { pt: "pt-BR", en: "en-US", es: "es-ES", fr: "fr-FR", he: "he-IL", el: "el-GR" };
// "SENHOR" em maiúsculas pode ser soletrado por algumas vozes: vira "Senhor" só na fala
const paraFala = (t) => t.replace(/\b(\p{Lu})(\p{Lu}+)\b/gu, (_, a, r) => a + r.toLowerCase());
function falar(texto, depois) {
  if (TTS_NATIVO) {
    const tok = voz.token;
    TTS_NATIVO.speak({ text: paraFala(texto), lang: LANG_TAG[idiomaAtual()] || "pt-BR", rate: S.velocidade || 1, pitch: 1, volume: 1 })
      .then(() => { if (tok === voz.token) depois(); })
      .catch((e) => { if (tok === voz.token && voz.ativo) { pararAudio(); toast("A voz falhou: " + (e?.message || e)); } });
    return;
  }
  const u = new SpeechSynthesisUtterance(paraFala(texto)), v = escolherVoz();
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = LANG_TAG[idiomaAtual()] || "pt-BR";
  u.rate = S.velocidade || 1;
  const tok = voz.token;
  u.onend = () => { if (tok === voz.token) depois(); };
  u.onerror = (e) => {
    if (tok !== voz.token || e.error === "interrupted" || e.error === "canceled") return;
    pararAudio(); toast("A voz falhou: " + e.error);
  };
  speechSynthesis.speak(u);
}
function marcarLendo(i) {
  document.querySelectorAll(".vs.lendo").forEach((x) => x.classList.remove("lendo"));
  const el = document.querySelector(`.vs[data-i="${i}"]`);
  if (el) { el.classList.add("lendo"); if (S.acompanhar !== false) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  $("#playerTxt").textContent = "Lendo " + refDe(i);
}
function lerVersiculo(i) {
  const C0 = CAPS[estado.cap];
  const semCap = capSemTexto(estado.cap);           // versão sem este Testamento: lê a Almeida
  while (!semCap && txt(i) == null && i + 1 < C0.fim) i++; // pula versículos que a versão uniu ao vizinho
  voz.i = i; marcarLendo(i);
  falar(limpar(txtOu(i)), () => {
    const C = CAPS[estado.cap];
    if (i + 1 < C.fim) lerVersiculo(i + 1); else fimDoCapitulo();
  });
}
function ouvir(i = null) {
  if (!temVoz) return toast("Este navegador não tem leitura em voz alta");
  voz.token++; pararFala();
  const C = CAPS[estado.cap];
  voz.ativo = true; voz.pausado = false;
  document.body.classList.add("tocando"); $("#player").hidden = false; $("#plPausa").textContent = "❚❚";
  $("#btnOuvir").textContent = "■ Parar";
  if (i === null || i === C.ini) {
    voz.i = C.ini; $("#playerTxt").textContent = "Lendo " + nomeCap(estado.cap);
    const anuncio = { en: `Chapter ${C.c}.`, es: `Capítulo ${C.c}.`, fr: `Chapitre ${C.c}.`, he: `פרק ${C.c}.`, el: `Κεφάλαιο ${C.c}.` }[idiomaAtual()] || `${B.livros[C.b].nome}, capítulo ${C.c}.`;
    falar(anuncio, () => lerVersiculo(C.ini));
  } else lerVersiculo(i);
}
function fimDoCapitulo() {
  if (S.continuar === false) return pararAudio();
  const p = estado.plano;
  let prox = null;
  if (p) { if (p.pos < p.fila.length - 1) { p.pos++; prox = p.fila[p.pos]; } }
  else if (estado.cap < CAPS.length - 1) prox = estado.cap + 1;
  if (prox === null) { pararAudio(); if (p) toast("Fim da leitura do dia. Toque em Concluir."); return; }
  voz.avancando = true; abrirCapitulo(prox); voz.avancando = false;
  ouvir();
}
function pausarAudio() {
  if (!voz.ativo) return;
  if (voz.pausado) { voz.pausado = false; $("#plPausa").textContent = "❚❚"; voz.token++; pararFala(); return lerVersiculo(voz.i); }
  // pause() do Android é instável: cancelamos e guardamos o versículo para continuar dele
  voz.pausado = true; voz.token++; pararFala();
  $("#plPausa").textContent = "▶"; $("#playerTxt").textContent = "Pausado em " + refDe(voz.i);
}
function pararAudio() {
  if (!voz.ativo) return;
  voz.ativo = false; voz.pausado = false; voz.token++;
  pararFala();
  document.body.classList.remove("tocando"); $("#player").hidden = true;
  $("#btnOuvir").textContent = "▶ Ouvir";
  document.querySelectorAll(".vs.lendo").forEach((x) => x.classList.remove("lendo"));
}

// ============================================================ USAR SEM INTERNET (download completo)
const CACHE_APP = "biblia-ia-app";
const podeGuardar = () => self.isSecureContext && "serviceWorker" in navigator && typeof caches !== "undefined";
const mb = (b) => (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + " MB";

// Baixa (ou atualiza) tudo para o cache do aparelho. Na atualização só baixa os arquivos que mudaram
// (cada arquivo tem uma impressão digital "h" no arquivos.json).
async function baixarTudo(silencioso = false) {
  const bt = $("#btnBaixar"); if (bt && !silencioso) bt.disabled = true;
  const prog = () => $("#offProg"), txt = (t) => { const el = $("#offTxt"); if (el && !silencioso) el.textContent = t; };
  try {
    await navigator.serviceWorker.register("sw.js");
    const lista = await (await fetch("arquivos.json", { cache: "no-store" })).json();
    const cache = await caches.open(CACHE_APP);
    const antigos = (S.offline && S.offline.hashes) || {};
    const faltam = [];
    for (const a of lista.arquivos) {
      if (a.h && antigos[a.p] === a.h && (await cache.match(new Request(a.p)))) continue; // não mudou
      faltam.push(a);
    }
    const total = faltam.reduce((x, a) => x + a.t, 0);
    let feito = 0;
    for (const a of faltam) {
      const r = await fetch(a.p, { cache: "no-store" });
      if (!r.ok) throw new Error(`${a.p}: ${r.status}`);
      const leitor = r.body.getReader(), partes = [];
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        partes.push(value); feito += value.length;
        const pg = prog(); if (pg && !silencioso) pg.style.width = Math.min(100, (100 * feito) / (total || 1)) + "%";
        txt(`Baixando… ${mb(feito)} de ${mb(total)}`);
      }
      await cache.put(new Request(a.p), new Response(new Blob(partes), { headers: { "Content-Type": r.headers.get("Content-Type") || "" } }));
    }
    // tira do cache arquivos que deixaram de existir
    const atuais = new Set(lista.arquivos.map((a) => new URL(a.p, location.href).href));
    for (const req of await cache.keys()) if (!atuais.has(req.url)) await cache.delete(req);
    try { await navigator.storage?.persist?.(); } catch {}
    S.offline = { versao: lista.versao, publicado: lista.data, total: lista.total, data: hojeISO(),
      hashes: Object.fromEntries(lista.arquivos.map((a) => [a.p, a.h])) };
    salvar();
    if (!silencioso) toast("Bíblia guardada no aparelho ✓");
    else if (faltam.length) { estado.atualizado = true; toast("Bíblia IA atualizada ✓ (vale na próxima abertura)"); }
  } catch (e) {
    console.error(e); if (!silencioso) toast("O download falhou: " + e.message);
  }
  if (estado.view === "mais") renderMais();
}

// Site/navegador com a Bíblia guardada: se o site publicou uma versão nova, atualiza sozinho em segundo plano.
async function autoAtualizarGuardado() {
  if (INSTALADO || !podeGuardar() || !S.offline || !navigator.onLine) return;
  try {
    const l = await (await fetch("arquivos.json", { cache: "no-store" })).json();
    if (l.versao && l.versao !== S.offline.versao) await baixarTudo(true);
  } catch {} // sem internet: segue com a cópia guardada
}

// APK (Android) e .deb (Linux): consulta a última versão publicada no GitHub e oferece o download.
// Windows e AppImage se atualizam sozinhos (electron-updater); o site se atualiza sozinho.
const novaVersao = (a, b) => { // a > b ?
  const pa = String(a).replace(/^v/, "").split(".").map(Number), pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const ATUALIZA_SOZINHO = new URLSearchParams(location.search).get("atualizacao") === "auto";
async function verificarNovaVersao() {
  if (!INSTALADO || LOJA || ATUALIZA_SOZINHO || !CFG.repo || !CFG.versao || !navigator.onLine) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${CFG.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return;
    const tag = (await r.json()).tag_name;
    if (tag && novaVersao(tag, CFG.versao)) {
      estado.nova = tag.replace(/^v/, "");
      estado.linkNova = NATIVO ? `https://github.com/${CFG.repo}/releases/latest/download/Biblia-IA-android.apk`
                               : `https://github.com/${CFG.repo}/releases/latest`;
      toast(`Nova versão ${estado.nova} disponível: veja na aba Mais`);
      const m = $("#abas button[data-v=mais]"); if (m) m.classList.add("tem-aviso");
      if (estado.view === "mais") renderMais();
    }
  } catch {}
}

async function apagarDownload() {
  try { await caches.delete(CACHE_APP); } catch {}
  delete S.offline; salvar(); renderMais(); toast("Dados baixados apagados");
}

// ---------- Site: reconhece o sistema de quem abriu e oferece o app certo ----------
const SISTEMA = (() => {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux/i.test(ua) && !/CrOS/i.test(ua)) return "linux";
  return null;   // iPhone, Mac, Chromebook: não há app próprio, fica no site
})();
const NOME_SISTEMA = { android: "Android", windows: "Windows", linux: "Linux" };
const DICA_INSTALAR = {
  android: "Depois de baixar, toque no arquivo .apk e confirme “Instalar”. Se o celular pedir, permita instalar apps desta fonte.",
  windows: "Depois de baixar, abra o arquivo .exe. Se aparecer “O Windows protegeu o computador”, clique em “Mais informações” e depois em “Executar assim mesmo”.",
  linux: "Depois de baixar, dê permissão e abra: chmod +x Biblia-IA-*.AppImage && ./Biblia-IA-*.AppImage",
};
let LINKS_APP = null;

// Links diretos dos instaladores da última versão (o nome do arquivo muda a cada versão, então pergunta ao GitHub).
async function linksDoApp() {
  if (LINKS_APP) return LINKS_APP;
  const L = { android: CFG.releases, windows: CFG.releases, linux: CFG.releases, deb: null };
  if (CFG.repo) {
    L.android = `https://github.com/${CFG.repo}/releases/latest/download/Biblia-IA-android.apk`;
    try {
      const r = await fetch(`https://api.github.com/repos/${CFG.repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (r.ok) for (const a of (await r.json()).assets || []) {
        const n = a.name, u = a.browser_download_url;
        if (/\.apk$/i.test(n)) L.android = u;
        else if (/\.exe$/i.test(n)) L.windows = u;
        else if (/\.AppImage$/i.test(n)) L.linux = u;
        else if (/\.deb$/i.test(n)) L.deb = u;
      }
    } catch {}
  }
  return (LINKS_APP = L);
}

function htmlLinksApp(L) {
  const todos = `<a class="btn sec" href="${esc(CFG.releases)}" target="_blank" rel="noopener">Todos os instaladores</a>`;
  if (!L || !SISTEMA) return `<div class="bts">${L ? "" : `<a class="btn" href="${esc(CFG.releases)}" target="_blank" rel="noopener">Baixar para Android, Windows ou Linux</a>`}${L ? todos : ""}</div>`;
  const outros = Object.keys(NOME_SISTEMA).filter((s) => s !== SISTEMA)
    .map((s) => `<a class="btn sec" data-baixar href="${esc(L[s])}">${NOME_SISTEMA[s]}</a>`).join("");
  return `<div class="bts"><a class="btn" data-baixar href="${esc(L[SISTEMA])}">⬇ Baixar para ${NOME_SISTEMA[SISTEMA]}</a>
    ${SISTEMA === "linux" && L.deb ? `<a class="btn sec" data-baixar href="${esc(L.deb)}">Baixar .deb (Debian, Ubuntu, Parrot)</a>` : ""}</div>
    <p class="mut">${esc(DICA_INSTALAR[SISTEMA])}</p>
    <p class="mut">Outros sistemas:</p><div class="bts bts3">${outros}</div>`;
}

// Janelinha que aparece sozinha no site (uma vez a cada 7 dias se a pessoa disser "Agora não").
async function oferecerApp() {
  if (!CFG.releases || INSTALADO || !SISTEMA) return;
  if (matchMedia("(display-mode: standalone)").matches) return;           // já abriu como app da tela inicial
  if (Date.now() - (S.ofertaApp || 0) < 7 * 864e5) return;
  const L = await linksDoApp();
  if (!$("#folha").hidden || !$("#folha2").hidden || !$("#seletor").hidden) return;  // não atrapalha quem já está lendo algo
  S.ofertaApp = Date.now(); salvar();
  const nome = NOME_SISTEMA[SISTEMA];
  abrirFolha2(`<strong>Baixar o app Bíblia IA para ${nome}?</strong>
    <p class="mut" style="font:15px/1.5 var(--sans);margin:6px 0 12px">Reconhecemos que você está usando ${nome}. O app tem tudo dentro: funciona sem internet e se atualiza sozinho.</p>
    <div class="bts">
      <a class="btn" data-baixar href="${esc(L[SISTEMA])}">⬇ Baixar para ${nome}</a>
      ${SISTEMA === "linux" && L.deb ? `<a class="btn sec" data-baixar href="${esc(L.deb)}">Baixar .deb (Debian, Ubuntu, Parrot)</a>` : ""}
      <button class="btn sec" type="button" data-fechar="1">Agora não, continuar no site</button>
    </div>
    <p class="mut" style="font:13px/1.5 var(--sans);margin:12px 0 0">${esc(DICA_INSTALAR[SISTEMA])} <a href="${esc(CFG.releases)}" target="_blank" rel="noopener">Outros sistemas</a></p>`);
}

function renderMais() {
  // --- offline
  let h;
  $("#cardBaixarApp").hidden = !CFG.releases || INSTALADO;
  if (CFG.releases && !INSTALADO) {
    $("#linksApp").innerHTML = htmlLinksApp(LINKS_APP);
    if (!LINKS_APP) linksDoApp().then((L) => { $("#linksApp").innerHTML = htmlLinksApp(L); });
  }
  if (INSTALADO) {
    h = `<p class="estado-ok">✓ Tudo já está instalado neste aparelho</p><p class="mut">Texto, versões, dados da busca e modelo de IA vêm dentro do app. Funciona sem internet.</p>`;
  } else if (!podeGuardar()) {
    h = `<p>Para guardar no aparelho, o Chrome exige que o app seja aberto de um endereço seguro (HTTPS) ou do próprio celular (<code>localhost</code>). Pelo Wi-Fi do notebook (<code>${esc(location.host)}</code>) ele não deixa.</p>
      <p><strong>Como fazer agora, pelo Termux:</strong></p>
      <ol><li>Com o notebook rodando <code>bash celular.sh</code>, abra o Termux no celular.</li>
      <li>Rode o comando que aparece no terminal do notebook (<code>curl -O …/termux.sh && bash termux.sh …</code>).</li>
      <li>Abra <code>http://localhost:8080</code> no Chrome, venha nesta aba e toque em “Baixar”.</li>
      <li>No menu do Chrome, toque em “Adicionar à tela inicial”. Pronto: abre sem internet e sem o Termux.</li></ol>
      <p class="mut">Na versão APK isso não será necessário.</p>`;
  } else if (S.offline) {
    h = `<p class="estado-ok">✓ Tudo guardado neste aparelho (${mb(S.offline.total)})</p>
      <p class="mut">Versão publicada em ${esc(S.offline.publicado || S.offline.versao)}. Funciona sem internet e se atualiza sozinha. Dica: no menu do Chrome, “Adicionar à tela inicial”.</p>
      <div class="prog"><span id="offProg" style="width:100%"></span></div><p class="mut" id="offTxt"></p>
      <button type="button" class="btn" id="btnBaixar">Atualizar (baixar de novo)</button>
      <button type="button" class="btn sec" id="btnApagar" style="margin-top:8px">Apagar dados baixados</button>`;
  } else {
    h = `<p>Toque para baixar tudo uma vez só. Depois, a leitura, os planos, o áudio e a busca com IA funcionam sem internet.</p>
      <div class="prog"><span id="offProg"></span></div><p class="mut" id="offTxt"></p>
      <button type="button" class="btn" id="btnBaixar">Baixar a Bíblia completa</button>`;
  }
  $("#offConteudo").innerHTML = h;
  if (!INSTALADO && podeGuardar() && !S.offline) fetch("arquivos.json", { cache: "no-store" }).then((r) => r.json())
    .then((l) => { const b = $("#btnBaixar"); if (b && !b.disabled) b.textContent = `Baixar a Bíblia completa (${mb(l.total)})`; }).catch(() => {});
  // --- versão e atualizações
  const ver = CFG.versao ? `Versão ${esc(CFG.versao)}` : "Versão de desenvolvimento";
  let at;
  if (estado.nova) at = `<p class="aviso">Nova versão ${esc(estado.nova)} disponível.</p>
      <a class="btn" style="display:grid;place-items:center;text-decoration:none" href="${esc(estado.linkNova)}" target="_blank" rel="noopener">${NATIVO ? "Baixar e instalar a nova versão" : "Abrir a página de download"}</a>
      ${NATIVO ? `<p class="mut">Depois de baixar, toque no arquivo e confirme “Atualizar”. Seus planos de leitura e a posição salva continuam.</p>` : ""}`;
  else if (LOJA) at = `<p class="mut">As atualizações chegam automaticamente pela Play Store.</p>`;
  else if (ATUALIZA_SOZINHO) at = `<p class="mut">Este app se atualiza sozinho: baixa as novidades em segundo plano e instala quando você fechar.</p>`;
  else if (INSTALADO) at = `<p class="mut">O app confere se há versão nova sempre que abre com internet.</p>`;
  else at = `<p class="mut">O site está sempre na versão mais nova${S.offline ? "; a cópia guardada no aparelho também se atualiza sozinha" : ""}.</p>`;
  $("#atualConteudo").innerHTML = `<p><strong>${ver}</strong></p>${at}`;
  // --- voz
  if (!temVoz) $("#vozConteudo").innerHTML = `<p>Este navegador não oferece leitura em voz alta.</p>`;
  else {
    const vs = vozesPt(), atual = escolherVoz();
    $("#vozConteudo").innerHTML = (TTS_NATIVO ? `<p class="mut">Usa a voz padrão do Android para cada idioma. Para trocar a voz: Configurações › Acessibilidade › Saída de texto para voz.</p>` : vs.length ? `<label>Voz <select id="selVoz">${vs.map((v) =>
      `<option value="${esc(v.voiceURI)}" ${atual && v.voiceURI === atual.voiceURI ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("")}</select></label>`
      : `<p class="mut">Nenhuma voz para ${esc(NOME_IDIOMA[idiomaAtual()] || idiomaAtual())} encontrada. No Android: Configurações › Acessibilidade › Saída de texto para voz › Instalar dados de voz.</p>`) +
      `<label>Velocidade <input id="velVoz" type="range" min="0.6" max="1.6" step="0.1" value="${S.velocidade || 1}"><span id="velTxt">${(S.velocidade || 1).toFixed(1)}×</span></label>
      <label><input id="chkCont" type="checkbox" ${S.continuar !== false ? "checked" : ""}> Continuar no próximo capítulo</label>
      <label><input id="chkAcomp" type="checkbox" ${S.acompanhar !== false ? "checked" : ""}> Acompanhar o versículo na tela</label>
      <button type="button" class="btn sec" id="btnTestarVoz">Testar a voz</button>`;
  }
  // --- IA
  $("#iaMais").innerHTML = `<span class="${estado.iaCls === "ok" ? "estado-ok" : ""}">${esc(estado.iaTxt || "IA: aguardando…")}</span>` +
    (estado.iaErro ? `<br><span class="mut">Detalhe: ${esc(estado.iaErro)}</span>` : "") +
    (estado.iaCls === "erro" ? `<br><button type="button" class="btn sec" id="btnIAdeNovo" style="margin-top:8px">Tentar carregar de novo</button>` : "");
  $("#cardApoio").hidden = !APOIO.mostrar;
  if (APOIO.mostrar) $("#apoioConteudo").innerHTML = `<p>Este app é gratuito e sem anúncios. Se quiser ajudar com as despesas de servidor e hospedagem, qualquer valor é bem-vindo.</p>
    <p class="pix"><span class="mut">Chave Pix</span><br><strong>${esc(APOIO.pix)}</strong><br><span class="mut">${esc(APOIO.autor)}</span></p>
    <button type="button" class="btn" id="btnPix">Copiar chave Pix</button>`;
  $("#sobreTxt").textContent = B.atribuicao + B.versoes.filter((v) => v.atribuicao).map((v) => "\n\n" + v.nome + ":\n" + v.atribuicao).join("");
  $("#vozIdioma").textContent = `Versão atual: ${versaoAtual().nome}. A voz segue o idioma da versão.`;
}

// ============================================================ início
function ligarEventos() {
  document.querySelectorAll("#abas button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.v === "planos") estado.planoAberto = null;
    if (b.dataset.v === estado.view && b.dataset.v === "planos") renderPlanos();
    ir(b.dataset.v);
    if (b.dataset.v === "buscar") setTimeout(() => !$("#q").value && $("#q").focus(), 50);
  }));
  // leitor
  $("#btnRef").addEventListener("click", () => abrirSeletor());
  $("#selFechar").addEventListener("click", () => history.back());
  $("#selConteudo").addEventListener("click", (e) => {
    const bt = e.target.closest("button"); if (!bt) return;
    if (bt.dataset.ordem) { S.ordem = bt.dataset.ordem; salvar(); return abrirSeletor(); }
    if (bt.dataset.b !== undefined) {
      const b = +bt.dataset.b;
      if (B.livros[b].caps.length === 1) { estado.plano = null; history.back(); abrirCapitulo(capId[b][0]); }
      else abrirSeletor(b);
    } else if (bt.dataset.id !== undefined) { estado.plano = null; history.back(); abrirCapitulo(+bt.dataset.id); }
  });
  $("#ant").addEventListener("click", () => navegar(-1));
  $("#prox").addEventListener("click", () => navegar(1));
  $("#planoSair").addEventListener("click", () => { estado.plano = null; atualizarNavCap(); S.cap = estado.cap; salvar(); });
  const fonte = (d) => { S.fonte = Math.max(15, Math.min(28, S.fonte + d)); document.documentElement.style.setProperty("--fs", S.fonte + "px"); salvar(); };
  $("#btnVersao").addEventListener("click", () => abrirFolha2(htmlVersoes()));
  $("#folha2").addEventListener("click", (e) => {
    if (e.target.closest("a[data-baixar]")) { toast("Baixando… veja as notificações / downloads"); setTimeout(() => history.back(), 400); return; }
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.fechar) history.back();
    else if (b.dataset.fonte) fonte(+b.dataset.fonte);
    else if (b.dataset.versao) { history.back(); trocarVersao(b.dataset.versao); }
  });
  $("#folhaComparar").addEventListener("click", () => { const i = folhaI; $("#folha").hidden = true; history.replaceState({ v: estado.view }, ""); compararVersoes(i); });
  document.documentElement.style.setProperty("--fs", S.fonte + "px");
  const tocarVs = (e) => { const p = e.target.closest(".vs"); if (p && (e.type === "click" || e.key === "Enter")) abrirFolha(+p.dataset.i); };
  $("#capitulo").addEventListener("click", tocarVs);
  $("#capitulo").addEventListener("keydown", tocarVs);
  // folha
  $("#fundo").addEventListener("click", () => history.back());
  $("#folhaFechar").addEventListener("click", () => history.back());
  $("#folhaSem").addEventListener("click", () => { const i = folhaI; $("#folha").hidden = $("#fundo").hidden = true; mostrarSemelhantes(i); });
  $("#folhaCopiar").addEventListener("click", async () => {
    const ok = await copiar(`${limpar(txtOu(folhaI))} (${refDe(folhaI)}, ${versaoAtual().sigla})`);
    toast(ok ? "Versículo copiado" : "Não foi possível copiar");
  });
  // busca
  let timer;
  $("#f").addEventListener("submit", (e) => { e.preventDefault(); $("#q").blur(); executarBusca(); });
  $("#q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(executarBusca, 350); });
  $("#chips").addEventListener("click", (e) => { if (e.target.tagName === "BUTTON") { $("#q").value = e.target.textContent; executarBusca(); } });
  document.querySelectorAll(".modos button").forEach((b) => b.addEventListener("click", () => {
    estado.modo = b.dataset.m;
    document.querySelectorAll(".modos button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    if (estado.semDe === null) executarBusca();
  }));
  $("#origem").addEventListener("click", (e) => {
    const b = e.target.closest("[data-abrir]"); if (!b) return;
    const i = +b.dataset.abrir; estado.plano = null; ir("ler"); abrirCapitulo(capId[LV[i]][CP[i] - 1], i);
  });
  const tocarRes = (e) => {
    const sem = e.target.closest("[data-sem]");
    if (sem) { e.stopPropagation(); return mostrarSemelhantes(+sem.dataset.sem); }
    const li = e.target.closest("li.res");
    if (li && (e.type === "click" || e.key === "Enter")) {
      const i = +li.dataset.i;
      estado.plano = null; ir("ler"); abrirCapitulo(capId[LV[i]][CP[i] - 1], i);
    }
  };
  $("#lista").addEventListener("click", tocarRes);
  $("#lista").addEventListener("keydown", tocarRes);
  // voz
  $("#btnOuvir").addEventListener("click", () => (voz.ativo ? pararAudio() : ouvir()));
  $("#plPausa").addEventListener("click", pausarAudio);
  $("#plParar").addEventListener("click", pararAudio);
  $("#folhaOuvir").addEventListener("click", () => { const i = folhaI; history.back(); setTimeout(() => ouvir(i), 50); });
  if (temVoz && !TTS_NATIVO) { speechSynthesis.cancel(); speechSynthesis.addEventListener?.("voiceschanged", () => estado.view === "mais" && renderMais()); }
  // IA
  $("#iaDeNovo").addEventListener("click", () => { estado.iaErro = null; carregarIA(); });
  // aba Mais
  $("#v-mais").addEventListener("click", (e) => {
    const id = e.target.id;
    if (id === "btnBaixar") baixarTudo();
    else if (id === "btnApagar") apagarDownload();
    else if (id === "btnIAdeNovo") { estado.iaErro = null; carregarIA(); }
    else if (id === "btnPix") copiar(APOIO.pix).then((ok) => toast(ok ? "Chave Pix copiada" : "Não foi possível copiar"));
    else if (id === "btnTestarVoz") { if (temVoz) { voz.token++; pararFala(); falar(limpar(txtOu(0)), () => {}); } }
  });
  $("#v-mais").addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "selVoz") { S.vozes = S.vozes || {}; S.vozes[idiomaAtual()] = t.value; }
    else if (t.id === "chkCont") S.continuar = t.checked;
    else if (t.id === "chkAcomp") S.acompanhar = t.checked;
    salvar();
  });
  $("#v-mais").addEventListener("input", (e) => {
    if (e.target.id === "velVoz") { S.velocidade = +e.target.value; $("#velTxt").textContent = S.velocidade.toFixed(1) + "×"; salvar(); }
  });
  // planos
  $("#planosConteudo").addEventListener("click", (e) => {
    const card = e.target.closest(".plano");
    if (card) { renderPlano(card.dataset.p); window.scrollTo(0, 0); return; }
    const bt = e.target.closest("[data-acao]"); if (!bt) return;
    const { acao, p } = bt.dataset, d = +bt.dataset.d;
    if (acao === "voltar") { estado.planoAberto = null; renderPlanos(); }
    else if (acao === "comecar") { S.planos[p] = { inicio: hojeISO(), feitos: [] }; salvar(); renderPlano(p); }
    else if (acao === "ler") lerPlano(p, d);
    else if (acao === "marcar") {
      if (!S.planos[p]) S.planos[p] = { inicio: hojeISO(), feitos: [] };
      const f = S.planos[p].feitos, k = f.indexOf(d);
      if (k >= 0) f.splice(k, 1); else f.push(d);
      salvar(); const y = window.scrollY; renderPlano(p); window.scrollTo(0, y);
    } else if (acao === "reiniciar") {
      if (bt.dataset.conf) { delete S.planos[p]; salvar(); renderPlano(p); toast("Plano recomeçado"); }
      else { bt.dataset.conf = "1"; bt.textContent = "Toque de novo para confirmar"; }
    }
  });
  $("#planosConteudo").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("plano")) e.target.click(); });
}

async function iniciar() {
  try {
    const r = await fetch("biblia.json");
    if (!r.ok) throw new Error(r.status);
    B = await r.json();
  } catch (e) {
    $("#carregaTxt").textContent = "Não achei biblia.json. Rode bash celular.sh no notebook.";
    return;
  }
  prepararTexto();
  document.querySelectorAll(".credito").forEach((el) => (el.textContent = "Made by " + APOIO.autor));
  VER.almeida = { ...B.versoes[0], textos: B.textos };
  if (S.versao && S.versao !== "almeida") { try { await carregarVersao(S.versao); } catch { S.versao = "almeida"; } }
  if (!VER[S.versao]) S.versao = "almeida";
  ligarEventos();
  $("#btnVersao").textContent = versaoAtual().sigla;
  history.replaceState({ v: "ler" }, "");
  ir("ler", false);
  abrirCapitulo(Math.min(S.cap || 0, CAPS.length - 1), null, false);
  $("#carregando").hidden = true;
  $("#lista").innerHTML = `<li class="vazio">Digite uma palavra, um tema ou uma referência.</li>`;
  setTimeout(() => { prepararIndice(); if (!window.__semIA) carregarIA(); else carregarEmbeddings(); }, 50);
  setTimeout(() => { autoAtualizarGuardado(); verificarNovaVersao(); }, 4000); // depois que tudo abriu
  setTimeout(oferecerApp, 1500);
  window.__app = { novaVersao, verificarNovaVersao, autoAtualizarGuardado, B, estado, buscar, semelhantes, refDe, diasDoPlano, PLANOS, CAPS, rotuloDia, minutos, voz, trocarVersao, VER, txtOu, S, get EMB() { return EMB; } }; // usado nos testes
  if (!INSTALADO && "serviceWorker" in navigator && self.isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
}

iniciar();
