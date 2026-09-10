/* ============================================================
   Meu IPTV — versão TV
   App leve para Smart TVs antigas: sem video.js, sem TMDB,
   navegação 100% por controle remoto (D-pad, OK, Voltar).
   ============================================================ */
'use strict';

const $ = id => document.getElementById(id);

/* ---------------- ESTADO GLOBAL ---------------- */
let credenciais = { host: '', user: '', pass: '' };
let db = { live: [], vod: [], series: [] };
let cats = { live: [], vod: [], series: [] };
let dataLoaded = false;

let secaoAtual = 'home';        // home | live | vod | series
let catAtual = null;            // categoria selecionada no browse
let dadosAtuais = [];           // itens exibidos no browse
let canalSelecionado = null;    // canal com mini-preview (ao vivo)
let mediaAtual = null;          // objeto de mídia aberto na tela de detalhes
let videoAtual = null;          // metadados do vídeo em reprodução

/* ---------------- ARMAZENAMENTO (mesmas chaves da versão antiga) ---------------- */
function carregarJSON(chave, padrao) {
  try { return JSON.parse(localStorage.getItem(chave)) || padrao; }
  catch (e) { return padrao; }
}
let favoritos = carregarJSON('iptv_api_favs_v3', null);
if (!favoritos || Array.isArray(favoritos) || !favoritos.live) {
  favoritos = { live: [], vod: [], series: [] };
}
let historico = carregarJSON('iptv_api_history', {});
let completados = new Set(carregarJSON('iptv_api_completos', []).map(String));

function salvarFavoritos() {
  try { localStorage.setItem('iptv_api_favs_v3', JSON.stringify(favoritos)); } catch (e) {}
}
function salvarHistorico() {
  try { localStorage.setItem('iptv_api_history', JSON.stringify(historico)); } catch (e) {}
}
function marcarCompleto(id) {
  completados.add(String(id));
  try { localStorage.setItem('iptv_api_completos', JSON.stringify(Array.from(completados))); } catch (e) {}
}

/* ---------------- FALLBACK DE IMAGEM (SVG embutido, sem requisição) ---------------- */
const SVG_FALLBACK = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="100%" height="100%" fill="#1d1d24"/><text x="50%" y="50%" fill="#52525b" font-family="sans-serif" font-size="22" font-weight="bold" text-anchor="middle">Sem imagem</text></svg>'
);
window.imgErro = el => { el.onerror = null; el.src = SVG_FALLBACK; };

/* ---------------- API (Xtream Codes via proxy do próprio deploy) ---------------- */
function montarUrlProxy(url) {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') {
    return 'http://localhost:8000/api/proxy?url=' + encodeURIComponent(url);
  }
  return '/api/proxy?url=' + encodeURIComponent(url);
}

async function fetchAPI(action, params = '') {
  const alvo = credenciais.host + '/player_api.php?username=' + credenciais.user +
               '&password=' + credenciais.pass + '&action=' + action + params;
  const resp = await fetch(montarUrlProxy(alvo));
  if (!resp.ok) throw new Error('erro_rede');
  return resp.json();
}

/* ---------------- CACHE DE CATÁLOGO ---------------- */
const CHAVE_CACHE = 'iptv_catalog_cache_v1';
const CACHE_MAX = 12 * 60 * 60 * 1000; // 12h

function lerCacheCatalogo() {
  try {
    const bruto = localStorage.getItem(CHAVE_CACHE);
    if (!bruto) return null;
    const cache = JSON.parse(bruto);
    if (!cache || !cache.db || !cache.cats) return null;
    if (Date.now() - cache.timestamp > CACHE_MAX) return null;
    if (cache.host !== credenciais.host || cache.user !== credenciais.user) return null;
    return cache;
  } catch (e) { return null; }
}

function salvarCacheCatalogo() {
  try {
    localStorage.setItem(CHAVE_CACHE, JSON.stringify({
      timestamp: Date.now(), host: credenciais.host, user: credenciais.user, db, cats
    }));
  } catch (e) {}
}

function aplicarCatalogo(novoDb, novosCats) {
  db.live = novoDb.live || []; db.vod = novoDb.vod || []; db.series = novoDb.series || [];
  cats.live = novosCats.live || []; cats.vod = novosCats.vod || []; cats.series = novosCats.series || [];
  dataLoaded = true;
}

async function baixarCatalogo() {
  const [cLive, sLive, cVod, sVod, cSer, sSer] = await Promise.all([
    fetchAPI('get_live_categories'), fetchAPI('get_live_streams'),
    fetchAPI('get_vod_categories'), fetchAPI('get_vod_streams'),
    fetchAPI('get_series_categories'), fetchAPI('get_series')
  ]);
  return {
    db: { live: sLive, vod: sVod, series: sSer },
    cats: { live: cLive, vod: cVod, series: cSer }
  };
}

function mostrarLoader(texto) {
  $('loader-texto').textContent = texto || 'Carregando...';
  $('loader').classList.remove('hidden');
}
function esconderLoader() { $('loader').classList.add('hidden'); }

async function carregarCatalogo() {
  const cache = lerCacheCatalogo();
  if (cache) {
    aplicarCatalogo(cache.db, cache.cats);
    entrarNoMenu();
    return;
  }
  mostrarLoader('Baixando catálogo...');
  try {
    const fresco = await baixarCatalogo();
    aplicarCatalogo(fresco.db, fresco.cats);
    salvarCacheCatalogo();
    entrarNoMenu();
  } catch (e) {
    esconderLoader();
    $('login-erro').textContent = 'Falha ao conectar. Verifique DNS, usuário e senha.';
    mostrarTela('screen-login');
  }
}

async function atualizarCatalogo() {
  const status = $('settings-status');
  status.textContent = 'Baixando catálogo novo...';
  try {
    const fresco = await baixarCatalogo();
    aplicarCatalogo(fresco.db, fresco.cats);
    salvarCacheCatalogo();
    status.textContent = 'Catálogo atualizado!';
    if (secaoAtual !== 'home') renderizarBrowse();
  } catch (e) {
    status.textContent = 'Falha ao atualizar. Tente novamente.';
  }
}

/* ---------------- GERENCIADOR DE TELAS ---------------- */
function mostrarTela(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function entrarNoMenu() {
  esconderLoader();
  secaoAtual = 'home';
  renderizarHome();
  mostrarTela('screen-home');
  focarPrimeiro($('screen-home'));
}

function irParaSecao(secao) {
  secaoAtual = secao;
  catAtual = null;
  renderizarBrowse();
  mostrarTela('screen-browse');
  focarPrimeiro($('screen-browse'));
}

function voltarMenu() {
  forcarPararVideo();
  entrarNoMenu();
}

/* ============================================================
   TELA INICIAL
   ============================================================ */
function renderizarHome() {
  // Relógio
  const agora = new Date();
  $('home-relogio').textContent =
    String(agora.getHours()).padStart(2, '0') + ':' + String(agora.getMinutes()).padStart(2, '0');

  // Continuar assistindo (todos os tipos, ordenado por mais recente)
  const continuar = Object.values(historico).sort((a, b) => b.timestamp - a.timestamp).slice(0, 12);
  const wrap = $('home-continue');
  const row = $('home-continue-row');
  row.innerHTML = '';
  if (continuar.length === 0) {
    wrap.classList.add('hidden');
  } else {
    wrap.classList.remove('hidden');
    continuar.forEach(item => {
      const card = document.createElement('button');
      card.className = 'cont-card';
      const img = item.logo || SVG_FALLBACK;
      const pct = item.percent ? Math.round(item.percent * 100) : 0;
      card.innerHTML =
        '<img src="' + img + '" onerror="imgErro(this)" loading="lazy">' +
        '<div class="cont-nome">' + escapar(item.name) + '</div>' +
        '<div class="cont-barra"><i style="width:' + pct + '%"></i></div>';
      card.addEventListener('click', () => abrirPlayer(item.url, item));
      row.appendChild(card);
    });
  }
}

function escapar(txt) {
  return String(txt == null ? '' : txt).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   TELA DE NAVEGAÇÃO (ao vivo / filmes / séries)
   ============================================================ */
function renderizarBrowse() {
  $('browse-titulo').textContent =
    secaoAtual === 'live' ? 'TV ao Vivo' : secaoAtual === 'vod' ? 'Filmes' : 'Séries';

  renderizarCategorias();
  aplicarFiltro();

  const painelEpg = $('epg-panel');
  if (secaoAtual === 'live') painelEpg.classList.remove('hidden');
  else painelEpg.classList.add('hidden');
}

function renderizarCategorias() {
  const lista = $('cat-list');
  lista.innerHTML = '';

  if (secaoAtual === 'live') {
    lista.appendChild(criarItemCat('all', 'Todos os Canais', db.live.length));
    lista.appendChild(criarItemCat('fav', 'Favoritos', favoritos.live.length));
    cats.live.forEach(c => {
      const n = db.live.filter(i => String(i.category_id) === String(c.category_id)).length;
      lista.appendChild(criarItemCat(c.category_id, c.category_name, n));
    });
  } else {
    const itensHistorico = Object.values(historico).filter(i => i.aba === secaoAtual).length;
    lista.appendChild(criarItemCat('todos', 'Todos', db[secaoAtual].length));
    if (itensHistorico > 0) lista.appendChild(criarItemCat('history', 'Continuar Assistindo', itensHistorico));
    lista.appendChild(criarItemCat('fav', 'Favoritos', favoritos[secaoAtual].length));
    cats[secaoAtual].forEach(c => {
      const n = db[secaoAtual].filter(i => String(i.category_id) === String(c.category_id)).length;
      lista.appendChild(criarItemCat(c.category_id, c.category_name, n));
    });
  }

  // Marcar/selecionar a categoria atual (ou a primeira)
  const alvo = catAtual || (secaoAtual === 'live' ? 'all' : 'todos');
  const li = lista.querySelector('li[data-id="' + CSS.escape(String(alvo)) + '"]') || lista.firstChild;
  if (li) li.classList.add('active');
}

function criarItemCat(id, nome, contagem) {
  const li = document.createElement('li');
  li.setAttribute('data-id', id);
  li.setAttribute('tabindex', '0');
  li.textContent = nome;
  if (contagem !== undefined) {
    const badge = document.createElement('span');
    badge.className = 'cat-badge';
    badge.textContent = contagem;
    li.appendChild(badge);
  }
  li.addEventListener('click', () => {
    catAtual = id;
    renderizarCategorias();
    aplicarFiltro();
    // Move o foco pro primeiro item da grade/lista
    focarPrimeiroItem();
  });
  return li;
}

let termoBusca = '';
function aplicarFiltro() {
  let dados = db[secaoAtual] || [];

  if (secaoAtual === 'live') {
    if (catAtual === 'fav') dados = dados.filter(i => favoritos.live.includes(i.stream_id));
    else if (catAtual && catAtual !== 'all') dados = dados.filter(i => String(i.category_id) === String(catAtual));
  } else {
    if (catAtual === 'fav') dados = dados.filter(i => favoritos[secaoAtual].includes(i.series_id || i.stream_id));
    else if (catAtual === 'history') dados = Object.values(historico).filter(i => i.aba === secaoAtual).sort((a, b) => b.timestamp - a.timestamp);
    else if (catAtual && catAtual !== 'todos') dados = dados.filter(i => String(i.category_id) === String(catAtual));
  }

  if (termoBusca) {
    const t = termoBusca.toLowerCase();
    dados = dados.filter(i => (i.name || '').toLowerCase().includes(t));
  }

  dadosAtuais = dados;
  $('browse-info').textContent = dados.length + ' item(ns)' + (termoBusca ? ' para "' + termoBusca + '"' : '');

  if (secaoAtual === 'live') renderizarListaCanais(dados);
  else renderizarGradeItens(dados);
}

/* ---- Grade de filmes/séries (renderização em lotes p/ TV antiga) ---- */
const LOTE = 60;
let renderToken = 0;

function renderizarGradeItens(dados) {
  const container = $('items-container');
  container.className = 'items-container';
  container.innerHTML = '';
  cancelarLotes();
  if (dados.length === 0) {
    container.innerHTML = '<div class="grid-vazio">Nenhum item encontrado.</div>';
    return;
  }
  const token = ++renderToken;
  let indice = 0;

  function renderizarLote() {
    if (token !== renderToken) return; // categoria trocou, aborta
    const frag = document.createDocumentFragment();
    const fim = Math.min(indice + LOTE, dados.length);
    for (let i = indice; i < fim; i++) frag.appendChild(criarCard(dados[i]));
    container.appendChild(frag);
    indice = fim;
  }
  container._proximoLote = renderizarLote;
  renderizarLote();

  // Carrega mais lotes conforme rola (com sentinel + IntersectionObserver)
  const sentinela = document.createElement('div');
  sentinela.style.height = '2px';
  container.appendChild(sentinela);
  container._obs = new IntersectionObserver(entradas => {
    if (entradas[0].isIntersecting && indice < dados.length) renderizarLote();
  }, { root: container, rootMargin: '600px' });
  container._obs.observe(sentinela);
}

function cancelarLotes() {
  const container = $('items-container');
  if (container._obs) { container._obs.disconnect(); container._obs = null; }
}

function criarCard(item) {
  const id = item.series_id || item.stream_id;
  const ehFav = favoritos[secaoAtual].includes(id);
  const hist = historico[id];
  const card = document.createElement('button');
  card.className = 'card';
  card.setAttribute('data-id', id);
  const img = item.stream_icon || item.cover || SVG_FALLBACK;

  let progresso = '';
  if (hist && hist.percent && hist.percent < 0.95) {
    progresso = '<div class="card-progress"><i style="width:' + Math.round(hist.percent * 100) + '%"></i></div>';
  }

  card.innerHTML =
    '<img src="' + img + '" onerror="imgErro(this)" loading="lazy">' +
    '<span class="card-fav' + (ehFav ? ' is-fav' : '') + '">' +
      '<svg viewBox="0 0 24 24"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>' +
    '</span>' + progresso +
    '<div class="card-nome">' + escapar(item.name) + '</div>';

  card.addEventListener('click', e => {
    // Clique na estrela = favoritar; no resto = abrir detalhes
    if (e.target.closest('.card-fav')) {
      alternarFavorito(id, secaoAtual, card);
      return;
    }
    abrirDetalhes(id, secaoAtual);
  });
  return card;
}

function alternarFavorito(id, secao, cardEl) {
  const lista = favoritos[secao];
  const idx = lista.indexOf(id);
  if (idx >= 0) lista.splice(idx, 1); else lista.push(id);
  salvarFavoritos();
  if (cardEl) {
    const estrela = cardEl.querySelector('.card-fav');
    if (estrela) estrela.classList.toggle('is-fav', idx < 0);
  }
  // Se estiver vendo a lista de favoritos, recarrega
  if (catAtual === 'fav') { renderizarCategorias(); aplicarFiltro(); }
  else renderizarCategorias(); // atualiza contagem
  if (mediaAtual && (mediaAtual.id === id)) atualizarBotaoFavDetail();
}

/* ---- Lista de canais ao vivo ---- */
const epgFila = [];
let epgRodando = 0;
const EPG_MAX = 2;

function renderizarListaCanais(dados) {
  const container = $('items-container');
  container.className = 'items-container lista-canais';
  container.innerHTML = '';
  cancelarLotes();
  if (dados.length === 0) {
    container.innerHTML = '<div class="grid-vazio">Nenhum canal encontrado.</div>';
    return;
  }
  const token = ++renderToken;
  let indice = 0;

  function renderizarLote() {
    if (token !== renderToken) return;
    const frag = document.createDocumentFragment();
    const fim = Math.min(indice + 90, dados.length);
    for (let i = indice; i < fim; i++) frag.appendChild(criarLinhaCanal(dados[i]));
    container.appendChild(frag);
    indice = fim;
  }
  container._proximoLote = renderizarLote;
  renderizarLote();

  const sentinela = document.createElement('div');
  sentinela.style.height = '2px';
  container.appendChild(sentinela);
  container._obs = new IntersectionObserver(entradas => {
    if (entradas[0].isIntersecting && indice < dados.length) renderizarLote();
  }, { root: container, rootMargin: '800px' });
  container._obs.observe(sentinela);
}

function criarLinhaCanal(item) {
  const id = item.stream_id;
  const row = document.createElement('button');
  row.className = 'canal-row';
  row.setAttribute('data-id', id);
  const img = item.stream_icon || SVG_FALLBACK;
  row.innerHTML =
    '<img src="' + img + '" onerror="imgErro(this)" loading="lazy">' +
    '<span class="canal-nome">' + escapar(item.name) + '</span>' +
    '<span class="canal-prog" id="prog-' + id + '">Programação...</span>';

  row.addEventListener('click', () => {
    document.querySelectorAll('.canal-row.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    assistirCanal(item);
  });

  // Ao receber foco, mostra o EPG do canal no painel lateral
  row.addEventListener('focus', () => { agendarEpg(id, item.name); });
  return row;
}

let epgTimer = null;
function agendarEpg(id, nome) {
  clearTimeout(epgTimer);
  epgTimer = setTimeout(() => mostrarEpgCanal(id, nome), 350);
}

function mostrarEpgCanal(id, nome) {
  if (secaoAtual !== 'live') return;
  $('epg-canal').textContent = nome;
  $('epg-conteudo').textContent = 'Carregando programação...';
  epgFila.push({ id, nome });
  processarFilaEpg();
}

async function processarFilaEpg() {
  if (epgRodando >= EPG_MAX || epgFila.length === 0) return;
  const pedido = epgFila.pop();           // pega o mais recente
  epgFila.length = 0;                     // descarta os antigos (foco já mudou)
  epgRodando++;
  try {
    const data = await fetchAPI('get_short_epg', '&stream_id=' + pedido.id);
    // Só mostra se o foco ainda é o mesmo canal
    if ($('epg-canal').textContent !== pedido.nome) return;
    const caixa = $('epg-conteudo');
    if (data && data.epg_listings && data.epg_listings.length > 0) {
      let html = '';
      data.epg_listings.slice(0, 8).forEach((prog, i) => {
        const titulo = decodificarEPG(prog.title);
        const ini = prog.start ? prog.start.split(' ')[1].substring(0, 5) : '';
        const fim = prog.end ? prog.end.split(' ')[1].substring(0, 5) : '';
        html += '<div class="epg-prog' + (i === 0 ? ' agora' : '') + '">' +
                '<div class="epg-hora">' + ini + ' - ' + fim + (i === 0 ? ' • AGORA' : '') + '</div>' +
                '<div>' + escapar(titulo) + '</div></div>';
        // Atualiza também a linha do canal na lista
        if (i === 0) {
          const mini = $('prog-' + pedido.id);
          if (mini) mini.textContent = ini + ' ' + titulo;
        }
      });
      caixa.innerHTML = html;
    } else {
      caixa.textContent = 'Programação indisponível.';
      const mini = $('prog-' + pedido.id);
      if (mini) mini.textContent = 'Programação indisponível';
    }
  } catch (e) {
    if ($('epg-canal').textContent === pedido.nome) $('epg-conteudo').textContent = 'Falha ao carregar programação.';
  } finally {
    epgRodando--;
  }
}

function decodificarEPG(str) {
  if (!str) return '';
  try { return decodeURIComponent(escape(atob(str))); }
  catch (e) { return str; }
}

function urlCanal(item) {
  let url = credenciais.host + '/live/' + credenciais.user + '/' + credenciais.pass +
            '/' + item.stream_id + '.' + (item.container_extension || 'm3u8');
  url = url.replace('.ts', '.m3u8');
  return url;
}

function assistirCanal(item) {
  const url = urlCanal(item);
  abrirPlayer(url, { id: item.stream_id, name: item.name, url, aba: 'live', logo: item.stream_icon });
}
