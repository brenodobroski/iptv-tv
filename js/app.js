/* ============================================================
   Meu IPTV — versão TV webOS (azul) + TMDB
   - Login com http:// fixo | TMDB | busca com teclado nativo
   - TV ao vivo: mini player no painel; OK no canal toca no mini;
     OK no mini = tela cheia; Voltar volta e continua tocando;
     SEGURAR OK no canal = favoritar
   - Séries: blur no fundo, card "próximo ep" com contagem nos
     últimos 10s, episódio 100% visto com selo na lista
   ============================================================ */
'use strict';

const $ = id => document.getElementById(id);

/* ---------------- ESTADO GLOBAL ---------------- */
let credenciais = { host: '', user: '', pass: '' };
let db = { live: [], vod: [], series: [] };
let cats = { live: [], vod: [], series: [] };
let dataLoaded = false;

let secaoAtual = 'home';
let catAtual = null;
let dadosAtuais = [];
let mediaAtual = null;
let videoAtual = null;
let buscaAberta = false;
let hls = null;                 // hls.js do player em tela cheia
let miniHls = null;             // hls.js do mini player ao vivo
let canalMini = null;           // dados do canal tocando no mini
let controlesTimer = null;

function destruirHls() {
  if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
}

/* OK do controle: nem sempre chega como e.key === 'Enter' */
function ehTeclaOK(e) {
  return e.key === 'Enter' || e.keyCode === 13 || e.which === 13;
}

/* ---------------- TMDB ---------------- */
const TMDB_KEY = 'c5ec5dbd66ea50ce62b096dca322543c';
const TMDB_CACHE_KEY = 'iptv_tmdb_cache_v2';
const TMDB_TTL = 7 * 24 * 60 * 60 * 1000;
let tmdbCache = carregarJSON(TMDB_CACHE_KEY, {});

function salvarTmdbCache() {
  try { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(tmdbCache)); } catch (e) {}
}

function limparNomeMidia(nome) {
  if (!nome) return '';
  let n = String(nome);
  n = n.replace(/\[.*?\]|\(.*?\)/g, ' ');
  n = n.replace(/\b(4k|uhd|fhd|hd|sd|hdtv|web-?dl|webrip|bluray|bdrip|rip|dublado|legendado|dual|audio|nacional|extended|remux|hevc|x264|x265|h264|h265|10bit|2160p|1080p|720p|480p|vod)\b/gi, ' ');
  n = n.replace(/\s{2,}/g, ' ').trim();
  return n;
}

async function buscarTMDB(nomeOriginal, tipo) {
  const nome = limparNomeMidia(nomeOriginal);
  if (!nome) return null;
  const mediaType = tipo === 'series' ? 'tv' : 'movie';
  const chave = mediaType + ':' + nome.toLowerCase();
  const hit = tmdbCache[chave];
  if (hit && (Date.now() - hit.t) < TMDB_TTL) return hit.v;

  let resultado = null;
  try {
    const url = 'https://api.themoviedb.org/3/search/' + mediaType +
      '?api_key=' + TMDB_KEY + '&query=' + encodeURIComponent(nome) + '&language=pt-BR';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('tmdb_erro');
    const dados = await resp.json();
    if (dados.results && dados.results.length > 0) {
      const r = dados.results[0];
      resultado = {
        id: r.id,
        titulo: r.title || r.name || '',
        sinopse: r.overview || '',
        poster: r.poster_path ? 'https://image.tmdb.org/t/p/w500' + r.poster_path : null,
        backdrop: r.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + r.backdrop_path : null,
        nota: r.vote_average ? r.vote_average.toFixed(1) : null,
        ano: (r.release_date || r.first_air_date || '').substring(0, 4)
      };
    }
  } catch (e) { return null; }

  tmdbCache[chave] = { v: resultado, t: Date.now() };
  salvarTmdbCache();
  return resultado;
}

function enriquecerCard(card, item) {
  buscarTMDB(item.name, secaoAtual).then(info => {
    if (!info) return;
    const img = card.querySelector('img');
    if (img && info.poster) { img.onerror = null; img.src = info.poster; }
    if (info.ano && !card.querySelector('.card-ano')) {
      const tag = document.createElement('span');
      tag.className = 'card-ano';
      tag.textContent = info.ano;
      card.appendChild(tag);
    }
  }).catch(() => {});
}

/* ---------------- ARMAZENAMENTO ---------------- */
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

/* ---------------- FALLBACK DE IMAGEM ---------------- */
const SVG_FALLBACK = 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="100%" height="100%" fill="#121214"/><text x="50%" y="50%" fill="#52525b" font-family="sans-serif" font-size="22" font-weight="bold" text-anchor="middle">Sem imagem</text></svg>'
);
window.imgErro = el => { el.onerror = null; el.src = SVG_FALLBACK; };

/* ---------------- PROXY (provedor tem Cloudflare: direto = 403) ---------------- */
function montarUrlProxy(url) {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'http://localhost:8000/api/proxy?url=' + encodeURIComponent(url);
  }
  // Mesma origem do app: funciona tanto no Cloudflare Pages (produção)
  // quanto em qualquer outro domínio onde o frontend for hospedado.
  return location.origin + '/api/proxy?url=' + encodeURIComponent(url);
}

async function fetchAPI(action, params = '') {
  const alvo = credenciais.host + '/player_api.php?username=' + credenciais.user +
               '&password=' + credenciais.pass + '&action=' + action + params;
  const resp = await fetch(montarUrlProxy(alvo));
  if (!resp.ok) throw new Error('erro_rede');
  return resp.json();
}

/* ---------------- hls.js compartilhado ---------------- */
const HLS_CONFIG = {
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  liveSyncDurationCount: 5,
  maxLiveSyncPlaybackRate: 1.3,
  fragLoadingMaxRetry: 8,
  manifestLoadingMaxRetry: 4,
  levelLoadingMaxRetry: 4
};

function criarHls(videoEl, urlFinal, ehPrincipal) {
  const inst = new Hls(HLS_CONFIG);
  inst.loadSource(urlFinal);
  inst.attachMedia(videoEl);
  inst.on(Hls.Events.ERROR, (ev, data) => {
    if (!data || !data.fatal) return;
    try {
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) inst.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) inst.recoverMediaError();
      else if (ehPrincipal) mostrarErroPlayer();
      else pararMini();
    } catch (e) {}
  });
  return inst;
}

/* ---------------- CACHE DE CATÁLOGO ---------------- */
const CHAVE_CACHE = 'iptv_catalog_cache_v1';
const CACHE_MAX = 12 * 60 * 60 * 1000;

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
  pararMini();
  secaoAtual = 'home';
  renderizarHome();
  mostrarTela('screen-home');
  focarPrimeiro($('screen-home'));
}

function irParaSecao(secao) {
  pararMini();
  secaoAtual = secao;
  catAtual = null;
  termoBusca = '';
  $('search-input').value = '';
  fecharBusca(true);
  renderizarBrowse();
  mostrarTela('screen-browse');
  focarPrimeiro($('screen-browse'));
}

function voltarMenu() {
  forcarPararVideo();
  pararMini();
  entrarNoMenu();
}

/* ============================================================
   HOME
   ============================================================ */
function renderizarHome() {
  const agora = new Date();
  $('home-relogio').textContent =
    String(agora.getHours()).padStart(2, '0') + ':' + String(agora.getMinutes()).padStart(2, '0');

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
      if (item.aba && item.aba !== 'live') {
        buscarTMDB(item.name.split(' — ')[0], item.aba).then(info => {
          const el = card.querySelector('img');
          if (el && info && info.backdrop) el.src = info.backdrop;
        }).catch(() => {});
      }
    });
  }
}

function escapar(txt) {
  return String(txt == null ? '' : txt).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   BROWSE
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

/* ---- Grade de filmes/séries ---- */
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
    if (token !== renderToken) return;
    const frag = document.createDocumentFragment();
    const fim = Math.min(indice + LOTE, dados.length);
    for (let i = indice; i < fim; i++) frag.appendChild(criarCard(dados[i]));
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
    if (e.target.closest('.card-fav')) {
      alternarFavorito(id, secaoAtual, card);
      return;
    }
    abrirDetalhes(id, secaoAtual);
  });

  enriquecerCard(card, item);
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
  renderizarCategorias();
  if (catAtual === 'fav') aplicarFiltro();
  if (mediaAtual && (mediaAtual.id === id)) atualizarBotaoFavDetail();
}

/* ============================================================
   TV AO VIVO — lista, EPG e MINI PLAYER
   ============================================================ */
const epgFila = [];
let epgRodando = 0;
const EPG_MAX = 2;

function pararMini() {
  if (miniHls) { try { miniHls.destroy(); } catch (e) {} miniHls = null; }
  const v = $('live-mini');
  if (v) { v.pause(); v.removeAttribute('src'); try { v.load(); } catch (e) {} }
  canalMini = null;
}

function tocarMini(url, dados) {
  pararMini();
  canalMini = dados;
  const v = $('live-mini');
  v.volume = 1;
  const urlFinal = montarUrlProxy(url);
  if (urlFinal.indexOf('.m3u8') !== -1 && window.Hls && Hls.isSupported()) {
    miniHls = criarHls(v, urlFinal, false);
  } else {
    v.src = urlFinal;
  }
  v.play().catch(() => {});
}

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

function selecionarCanal(row, item) {
  document.querySelectorAll('.canal-row.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
  assistirCanal(item);
}

function criarLinhaCanal(item) {
  const id = item.stream_id;
  const row = document.createElement('button');
  row.className = 'canal-row';
  row.setAttribute('data-id', id);
  const img = item.stream_icon || SVG_FALLBACK;
  row.innerHTML =
    '<img src="' + img + '" onerror="imgErro(this)" loading="lazy">' +
    '<span class="canal-nome">' + escapar(item.name) + '</span>';

  // Clique do mouse = tocar no mini player
  row.addEventListener('click', () => selecionarCanal(row, item));

  // OK do controle: apertar rápido = assistir | SEGURAR (~0,7s) = favoritar
  row.addEventListener('keydown', (e) => {
    if (!ehTeclaOK(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat || row._pressTimer) return;
    row._longPress = false;
    row._pressTimer = setTimeout(() => {
      row._pressTimer = null;
      row._longPress = true;
      alternarFavorito(id, 'live', null);
      const agoraFav = favoritos.live.includes(id);
      toast(agoraFav ? '★ Adicionado aos favoritos' : 'Removido dos favoritos');
    }, 700);
  });
  row.addEventListener('keyup', (e) => {
    if (!ehTeclaOK(e)) return;
    e.stopPropagation();
    if (row._pressTimer) {
      clearTimeout(row._pressTimer);
      row._pressTimer = null;
      selecionarCanal(row, item);
    }
    row._longPress = false;
  });

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
  const pedido = epgFila.pop();
  epgFila.length = 0;
  epgRodando++;
  try {
    const data = await fetchAPI('get_short_epg', '&stream_id=' + pedido.id);
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
      });
      caixa.innerHTML = html;
    } else {
      caixa.textContent = 'Programação indisponível.';
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

/* OK no canal = toca no MINI player (não abre tela cheia) */
function assistirCanal(item) {
  const url = urlCanal(item);
  tocarMini(url, { id: item.stream_id, name: item.name, url: url, aba: 'live', logo: item.stream_icon });
  toast(item.name);
}

/* ============================================================
   TELA DE DETALHES
   ============================================================ */
let episodiosFlat = [];
let temporadaAtual = null;
let telaAntesDoPlayer = 'screen-home';

function abrirDetalhes(id, secao) {
  const item = (db[secao] || []).find(i => String(i.series_id || i.stream_id) === String(id));
  if (!item) return;
  mediaAtual = { id: item.series_id || item.stream_id, secao, dados: item };

  $('detail-bg').style.backgroundImage = '';
  $('detail-poster').src = item.stream_icon || item.cover || SVG_FALLBACK;
  $('detail-title').textContent = item.name || '';
  $('detail-meta').textContent = '';
  $('detail-desc').textContent = '';
  $('episodes-list').innerHTML = '';
  $('seasons-row').innerHTML = '';
  $('seasons-row').classList.add('hidden');
  episodiosFlat = [];

  mostrarTela('screen-detail');
  focarPrimeiro($('screen-detail'));

  const hist = historico[mediaAtual.id];
  const pct = hist && hist.percent ? Math.round(hist.percent * 100) : 0;

  if (secao === 'series') {
    carregarInfoSerie(item);
  } else {
    $('detail-desc').textContent = 'Filme disponível no seu provedor.';
    $('btn-play-label').textContent = (pct > 0 && pct < 95) ? 'Continuar (' + pct + '%)' : 'Assistir';
  }
  atualizarBotaoFavDetail();

  buscarTMDB(item.name, secao).then(info => {
    if (!info || !mediaAtual || mediaAtual.id !== (item.series_id || item.stream_id)) return;
    if (info.backdrop) $('detail-bg').style.backgroundImage = 'url(' + info.backdrop + ')';
    if (info.poster) { $('detail-poster').onerror = null; $('detail-poster').src = info.poster; }
    if (info.titulo) $('detail-title').textContent = info.titulo;
    if (info.sinopse) $('detail-desc').textContent = info.sinopse;
    const partes = [];
    if (info.nota && info.nota !== '0.0') partes.push('★ ' + info.nota);
    if (info.ano) partes.push(info.ano);
    if (pct > 0 && pct < 95) partes.push('Assistido ' + pct + '%');
    if (partes.length) $('detail-meta').textContent = partes.join('  •  ');
  }).catch(() => {});
}

async function carregarInfoSerie(item) {
  $('detail-desc').textContent = 'Carregando informações...';
  try {
    const info = await fetchAPI('get_series_info', '&series_id=' + item.series_id);
    const caixa = $('episodes-list');

    let sinopse = '';
    try {
      const primeiroEp = info && info.episodes ? Object.values(info.episodes)[0] : null;
      if (primeiroEp && primeiroEp[0] && primeiroEp[0].info && primeiroEp[0].info.plot) {
        sinopse = primeiroEp[0].info.plot;
      }
    } catch (e) {}
    if (!sinopse && info && info.info) sinopse = info.info.plot || '';
    $('detail-desc').textContent = sinopse || 'Série disponível no seu provedor.';

    if (!info || !info.episodes) {
      caixa.innerHTML = '<div class="grid-vazio">Nenhum episódio encontrado.</div>';
      return;
    }

    const temps = Object.keys(info.episodes).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    temps.forEach(t => {
      (info.episodes[t] || []).forEach(ep => {
        episodiosFlat.push({ temporada: t, ep: ep });
      });
    });

    const barra = $('seasons-row');
    barra.innerHTML = '';
    if (temps.length > 1) {
      barra.classList.remove('hidden');
      temps.forEach(t => {
        const b = document.createElement('button');
        b.className = 'season-btn';
        b.textContent = 'T' + t;
        b.addEventListener('click', () => {
          temporadaAtual = t;
          barra.querySelectorAll('.season-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          renderizarEpisodios(info.episodes[t]);
        });
        barra.appendChild(b);
      });
    }

    temporadaAtual = temps[0];
    const btnT0 = barra.querySelector('.season-btn');
    if (btnT0) btnT0.classList.add('active');
    renderizarEpisodios(info.episodes[temporadaAtual]);

    const ultimo = episodiosFlat
      .map(e => e.ep.id)
      .map(eid => historico[eid])
      .filter(Boolean)
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    $('btn-play-label').textContent = ultimo ? 'Continuar: ' + ultimo.name : 'Assistir';
  } catch (e) {
    $('detail-desc').textContent = 'Falha ao carregar episódios.';
  }
}

function renderizarEpisodios(episodios) {
  const caixa = $('episodes-list');
  caixa.innerHTML = '';
  if (!episodios || episodios.length === 0) {
    caixa.innerHTML = '<div class="grid-vazio">Nenhum episódio nesta temporada.</div>';
    return;
  }
  episodios.forEach(ep => {
    const id = ep.id || ep.episode_id;
    const nomeEp = ep.title ? decodificarEPG(ep.title) : ('Episódio ' + (ep.episode_num || ''));
    const assistido = completados.has(String(id));
    const linha = document.createElement('button');
    linha.className = 'ep-row' + (assistido ? ' assistido' : '');
    const capa = (ep.info && ep.info.movie_image) ? ep.info.movie_image : SVG_FALLBACK;
    linha.innerHTML =
      '<img src="' + capa + '" onerror="imgErro(this)" loading="lazy">' +
      '<div class="ep-info">' +
        '<div class="ep-titulo">E' + (ep.episode_num || '?') + ' — ' + escapar(nomeEp) + '</div>' +
        (ep.info && ep.info.duration ? '<div class="ep-sub">' + escapar(ep.info.duration) + '</div>' : '') +
      '</div>' +
      (assistido ? '<span class="ep-check">✓ 100% visto</span>' : '');
    linha.addEventListener('click', () => playEpisodio(ep));
    caixa.appendChild(linha);
  });
}

function playEpisodio(ep) {
  const id = ep.id || ep.episode_id;
  const ext = (ep.container_extension || 'mp4');
  const url = credenciais.host + '/series/' + credenciais.user + '/' + credenciais.pass +
              '/' + id + '.' + ext;
  const nomeEp = ep.title ? decodificarEPG(ep.title) : ('Episódio ' + (ep.episode_num || ''));
  const capa = (ep.info && ep.info.movie_image) || (mediaAtual && mediaAtual.dados.cover) || '';
  abrirPlayer(url, {
    id: id,
    name: (mediaAtual ? mediaAtual.dados.name + ' — ' : '') + nomeEp,
    url: url,
    aba: 'series',
    logo: capa
  });
}

function atualizarBotaoFavDetail() {
  if (!mediaAtual) return;
  const fav = favoritos[mediaAtual.secao].includes(mediaAtual.id);
  $('btn-fav-label').textContent = fav ? 'Remover Favorito' : 'Favorito';
}

function voltarDoDetalhe() {
  if (secaoAtual === 'home') { entrarNoMenu(); return; }
  mostrarTela('screen-browse');
  focarPrimeiro($('screen-browse'));
}

/* ============================================================
   PLAYER (tela cheia)
   ============================================================ */
function urlFilme(item) {
  const ext = item.container_extension || 'mp4';
  return credenciais.host + '/movie/' + credenciais.user + '/' + credenciais.pass +
         '/' + item.stream_id + '.' + ext;
}

let proximoEpTimer = null;
let proximoEpRestante = 0;

function mostrarCardProximoEp() {
  if (!videoAtual || videoAtual.aba !== 'series') return;
  const proximo = proximoEpisodioDisponivel();
  if (!proximo) return;
  if (!$('proximo-ep-card').classList.contains('hidden')) return;
  const nomeEp = proximo.title ? decodificarEPG(proximo.title) : ('Episódio ' + (proximo.episode_num || ''));
  const capa = (proximo.info && proximo.info.movie_image) ||
               (mediaAtual && mediaAtual.dados.cover) || SVG_FALLBACK;
  $('proximo-ep-img').src = capa;
  $('proximo-ep-nome').textContent =
    (mediaAtual ? mediaAtual.dados.name + ' — ' : '') +
    'E' + (proximo.episode_num || '?') + ' ' + nomeEp;
  proximoEpRestante = 8;
  $('proximo-ep-count').textContent = proximoEpRestante;
  $('proximo-ep-card').classList.remove('hidden');
  clearInterval(proximoEpTimer);
  proximoEpTimer = setInterval(() => {
    proximoEpRestante--;
    if (proximoEpRestante <= 0) {
      clearInterval(proximoEpTimer);
      proximoEpTimer = null;
      tocarProximoEpisodio();
    } else {
      $('proximo-ep-count').textContent = proximoEpRestante;
    }
  }, 1000);
}

function esconderCardProximoEp() {
  clearInterval(proximoEpTimer);
  proximoEpTimer = null;
  const card = $('proximo-ep-card');
  if (card) card.classList.add('hidden');
}

function abrirPlayer(url, dados) {
  telaAntesDoPlayer = document.querySelector('.screen.active') ?
    document.querySelector('.screen.active').id : 'screen-home';
  videoAtual = dados;
  const video = $('video');

  $('player-erro').classList.add('hidden');
  $('player-carregando').classList.remove('hidden');
  esconderCardProximoEp();

  mostrarTela('screen-player');
  video.volume = 1;

  if (dados.aba === 'live') $('player-controls').classList.add('hidden');
  else mostrarControles();

  destruirHls();
  const urlFinal = montarUrlProxy(url);
  const ehHls = urlFinal.indexOf('.m3u8') !== -1;

  if (ehHls && window.Hls && Hls.isSupported()) {
    hls = criarHls(video, urlFinal, true);
  } else {
    video.src = urlFinal;
  }

  const hist = historico[dados.id];
  const aoCarregar = () => {
    if (hist && hist.percent > 0.02 && hist.percent < 0.95 && video.duration) {
      try { video.currentTime = hist.percent * video.duration; } catch (e) {}
    }
    $('player-carregando').classList.add('hidden');
    video.removeEventListener('loadedmetadata', aoCarregar);
  };
  video.addEventListener('loadedmetadata', aoCarregar);
  video.play().catch(() => {});
}

function mostrarErroPlayer() {
  $('player-carregando').classList.add('hidden');
  $('player-erro-msg').textContent = 'Não foi possível reproduzir.';
  $('player-erro').classList.remove('hidden');
  focarPrimeiro($('player-erro'));
}

function registrarProgresso() {
  if (!videoAtual) return;
  const video = $('video');
  if (!video.duration || !isFinite(video.duration)) return;
  const percent = video.currentTime / video.duration;
  if (percent > 0.95 && video.duration > 60) {
    marcarCompleto(videoAtual.id);
    delete historico[videoAtual.id];
    salvarHistorico();
    return;
  }
  historico[videoAtual.id] = {
    id: videoAtual.id,
    name: videoAtual.name,
    url: videoAtual.url,
    aba: videoAtual.aba,
    logo: videoAtual.logo || '',
    timestamp: Date.now(),
    percent: percent,
    duration: video.duration
  };
  salvarHistorico();
}

function sairDoPlayer() {
  const dados = videoAtual;
  registrarProgresso();
  forcarPararVideo();
  esconderControles();
  esconderCardProximoEp();
  videoAtual = null;
  if (telaAntesDoPlayer === 'screen-detail') {
    mostrarTela('screen-detail');
    focarPrimeiro($('screen-detail'));
  } else if (telaAntesDoPlayer === 'screen-browse') {
    mostrarTela('screen-browse');
    focarPrimeiro($('screen-browse'));
    // Ao vivo: ao voltar da tela cheia, continua tocando no mini player
    if (dados && dados.aba === 'live' && secaoAtual === 'live') {
      tocarMini(dados.url, dados);
    }
  } else {
    entrarNoMenu();
  }
}

function forcarPararVideo() {
  destruirHls();
  const video = $('video');
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  try { video.load(); } catch (e) {}
}

function proximoEpisodioDisponivel() {
  if (!videoAtual || videoAtual.aba !== 'series' || episodiosFlat.length === 0) return null;
  const idx = episodiosFlat.findIndex(e => String(e.ep.id || e.ep.episode_id) === String(videoAtual.id));
  if (idx >= 0 && idx < episodiosFlat.length - 1) return episodiosFlat[idx + 1].ep;
  return null;
}

function tocarProximoEpisodio() {
  const proximo = proximoEpisodioDisponivel();
  if (proximo) playEpisodio(proximo);
}

let toastTimer = null;
function toast(msg) {
  const el = $('player-toast');
  el.textContent = msg;
  el.classList.add('visivel');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visivel'), 2500);
}

/* ============================================================
   CONTROLES DO PLAYER (filmes/séries — nunca ao vivo)
   ============================================================ */
function mostrarControles() {
  if (!videoAtual || videoAtual.aba === 'live') return;
  $('player-controls').classList.remove('hidden');
  clearTimeout(controlesTimer);
  controlesTimer = setTimeout(() => $('player-controls').classList.add('hidden'), 6000);
}

function esconderControles() {
  clearTimeout(controlesTimer);
  $('player-controls').classList.add('hidden');
}

function alternarPlayPause() {
  const video = $('video');
  if (!video) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
  mostrarControles();
}

function voltar10() {
  const video = $('video');
  if (!video || !video.duration) return;
  video.currentTime = Math.max(0, video.currentTime - 10);
  mostrarControles();
}

function avancar10() {
  const video = $('video');
  if (!video || !video.duration) return;
  video.currentTime = Math.min(video.duration, video.currentTime + 10);
  mostrarControles();
}

function formatarTempo(seg) {
  if (!seg || !isFinite(seg)) return '0:00';
  const s = Math.floor(seg % 60);
  const m = Math.floor(seg / 60) % 60;
  const h = Math.floor(seg / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return (h > 0 ? h + ':' : '') + mm + ':' + ss;
}

function atualizarBarraControles() {
  if (!videoAtual || videoAtual.aba === 'live') return;
  const video = $('video');
  if (!video) return;
  const dur = video.duration;
  if (dur && isFinite(dur)) {
    $('pc-progresso').style.width = Math.min(100, (video.currentTime / dur) * 100) + '%';
    $('pc-total').textContent = formatarTempo(dur);
  }
  $('pc-atual').textContent = formatarTempo(video.currentTime);
}

/* ============================================================
   BUSCA — teclado NATIVO da TV
   ============================================================ */
function abrirBusca() {
  buscaAberta = true;
  $('search-bar').classList.remove('hidden');
  const input = $('search-input');
  input.value = termoBusca;
  input.focus();
}

function fecharBusca(silencioso) {
  buscaAberta = false;
  $('search-bar').classList.add('hidden');
  if (silencioso !== true) {
    $('btn-buscar').focus();
  }
}

/* ============================================================
   CONFIGURAÇÕES
   ============================================================ */
function abrirSettings() {
  $('settings-user').textContent = credenciais.user ?
    (credenciais.user + ' @ ' + credenciais.host.replace(/^https?:\/\//, '')) : 'Sem conta conectada';
  $('settings-status').textContent = '';
  mostrarTela('screen-settings');
  focarPrimeiro($('screen-settings'));
}

function fecharSettings() {
  entrarNoMenu();
}

function fazerLogout() {
  ['iptv_user', 'iptv_pass', 'iptv_dns', 'iptv_profile'].forEach(k => localStorage.removeItem(k));
  localStorage.removeItem(CHAVE_CACHE);
  credenciais = { host: '', user: '', pass: '' };
  db = { live: [], vod: [], series: [] };
  cats = { live: [], vod: [], series: [] };
  dataLoaded = false;
  forcarPararVideo();
  pararMini();
  mostrarTela('screen-login');
  focarPrimeiro($('screen-login'));
}

/* ============================================================
   NAVEGAÇÃO POR CONTROLE REMOTO
   ============================================================ */
function focavel(el) {
  if (!el || el.disabled) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function focarPrimeiro(tela) {
  if (!tela) return;
  const alvo = tela.querySelector('button, input, [tabindex]');
  if (alvo && focavel(alvo)) { alvo.focus(); return; }
  const todos = tela.querySelectorAll('button, input, [tabindex]');
  for (const el of todos) {
    if (focavel(el)) { el.focus(); return; }
  }
}

function focarPrimeiroItem() {
  const primeiro = $('items-container').querySelector('button.card, button.canal-row');
  if (primeiro) primeiro.focus();
}

function moverFoco(direcao) {
  const ativo = document.activeElement;
  if (!ativo || ativo === document.body) {
    const tela = document.querySelector('.screen.active');
    if (tela) focarPrimeiro(tela);
    return;
  }
  if (ativo.tagName === 'INPUT' && buscaAberta) return;

  const todos = Array.from(document.querySelectorAll('.screen.active button, .screen.active input, .screen.active [tabindex]')).filter(focavel);
  if (todos.length === 0) return;
  const rA = ativo.getBoundingClientRect();
  const cxA = rA.left + rA.width / 2, cyA = rA.top + rA.height / 2;
  let melhor = null, melhorDist = Infinity;

  todos.forEach(el => {
    if (el === ativo) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = cx - cxA, dy = cy - cyA;
    let valido = false, dist = Infinity;
    if (direcao === 'left' && dx < -10) { valido = true; dist = Math.abs(dx) + Math.abs(dy) * 3; }
    if (direcao === 'right' && dx > 10) { valido = true; dist = Math.abs(dx) + Math.abs(dy) * 3; }
    if (direcao === 'up' && dy < -10) { valido = true; dist = Math.abs(dy) + Math.abs(dx) * 3; }
    if (direcao === 'down' && dy > 10) { valido = true; dist = Math.abs(dy) + Math.abs(dx) * 3; }
    if (valido && dist < melhorDist) { melhorDist = dist; melhor = el; }
  });

  if (melhor) melhor.focus();
}

function acaoVoltar() {
  if (buscaAberta) { fecharBusca(); return; }
  if ($('screen-settings').classList.contains('active')) { fecharSettings(); return; }
  if ($('screen-player').classList.contains('active')) { sairDoPlayer(); return; }
  if ($('screen-detail').classList.contains('active')) { voltarDoDetalhe(); return; }
  if ($('screen-browse').classList.contains('active')) { voltarMenu(); return; }
}

document.addEventListener('keydown', (e) => {
  // Voltar (webOS = 461, Tizen = 10009, navegador = Escape/Backspace)
  if (e.keyCode === 461 || e.keyCode === 10009 || e.key === 'Escape' ||
      e.key === 'GoBack' || e.key === 'XF86Back' ||
      (e.key === 'Backspace' && !buscaAberta)) {
    e.preventDefault();
    acaoVoltar();
    return;
  }

  // Busca aberta com input focado: OK confirma; demais teclas vão pro IME nativo
  if (buscaAberta && document.activeElement === $('search-input')) {
    if (ehTeclaOK(e)) {
      e.preventDefault();
      fecharBusca();
    }
    return;
  }

  // ---- DENTRO DO PLAYER ----
  if ($('screen-player').classList.contains('active')) {
    const mapaPlayer = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

    // Tela de ERRO: setas navegam entre "Tentar novamente" e "Voltar"
    if (!$('player-erro').classList.contains('hidden')) {
      e.preventDefault();
      if (mapaPlayer[e.key]) moverFoco(mapaPlayer[e.key]);
      else if (ehTeclaOK(e) && document.activeElement && document.activeElement.click) {
        document.activeElement.click();
      }
      return;
    }

    const ehVod = videoAtual && videoAtual.aba !== 'live';
    if (!ehVod) return; // ao vivo: só assiste; Voltar sai
    e.preventDefault();

    // Card "próximo episódio": CIMA foca nele (OK toca na hora), BAIXO volta pro vídeo
    const pec = $('proximo-ep-card');
    if (pec && !pec.classList.contains('hidden')) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (document.activeElement === pec) {
          pec.blur();
        } else {
          pec.focus();
        }
        return;
      }
      if (document.activeElement === pec && ehTeclaOK(e)) {
        pec.click();
        return;
      }
    }

    mostrarControles();
    if (ehTeclaOK(e)) {
      if (document.activeElement && document.activeElement.tagName === 'BUTTON' &&
          document.activeElement.classList.contains('pc-btn')) {
        document.activeElement.click();
      } else {
        alternarPlayPause();
      }
    }
    else if (e.key === 'ArrowLeft') voltar10();
    else if (e.key === 'ArrowRight') avancar10();
    return;
  }

  // ---- OK / ENTER (botão do meio do controle): aciona o elemento focado ----
  if (ehTeclaOK(e)) {
    e.preventDefault();
    let alvo = document.activeElement;
    if (!alvo || alvo === document.body || typeof alvo.click !== 'function') {
      const tela = document.querySelector('.screen.active');
      if (tela) focarPrimeiro(tela);
      alvo = document.activeElement;
    }
    if (alvo && typeof alvo.click === 'function') alvo.click();
    return;
  }

  // ---- SETAS: navegação espacial ----
  const mapa = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (mapa[e.key]) {
    e.preventDefault();
    moverFoco(mapa[e.key]);
  }
});

/* ============================================================
   LOGIN + INICIALIZAÇÃO
   ============================================================ */
function fazerLogin() {
  let dns = $('login-dns').value.trim();
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value.trim();
  $('login-erro').textContent = '';

  if (!dns || !user || !pass) {
    $('login-erro').textContent = 'Preencha DNS, usuário e senha.';
    return;
  }
  dns = dns.replace(/^https?:\/\//i, '');   // evita http:// duplicado se colar
  dns = 'http://' + dns.replace(/\/+$/, '');

  credenciais.host = dns;
  credenciais.user = user;
  credenciais.pass = pass;

  localStorage.setItem('iptv_dns', dns);
  localStorage.setItem('iptv_user', user);
  localStorage.setItem('iptv_pass', pass);

  carregarCatalogo();
}

function iniciar() {
  // Login
  $('btn-login').addEventListener('click', fazerLogin);
  [$('login-dns'), $('login-user'), $('login-pass')].forEach(inp => {
    inp.addEventListener('keydown', (e) => { if (ehTeclaOK(e)) fazerLogin(); });
  });

  // Menu
  document.querySelectorAll('.menu-tile').forEach(btn => {
    btn.addEventListener('click', () => irParaSecao(btn.getAttribute('data-goto')));
  });

  // Browse
  $('btn-settings').addEventListener('click', abrirSettings);
  $('btn-voltar-menu').addEventListener('click', voltarMenu);
  $('btn-buscar').addEventListener('click', abrirBusca);
  $('btn-search-close').addEventListener('click', () => fecharBusca());
  $('search-input').addEventListener('input', (e) => {
    termoBusca = e.target.value.trim();
    aplicarFiltro();
  });

  // Mini player: OK (ou clique) = tela cheia
  const miniWrap = $('live-mini-wrap');
  if (miniWrap) {
    miniWrap.addEventListener('click', () => {
      if (!canalMini) return;
      const dados = canalMini;
      pararMini();
      abrirPlayer(dados.url, dados);
    });
  }

  // Settings
  $('btn-atualizar-catalogo').addEventListener('click', atualizarCatalogo);
  $('btn-logout').addEventListener('click', fazerLogout);
  $('btn-settings-fechar').addEventListener('click', fecharSettings);

  // Detalhes
  $('btn-detail-voltar').addEventListener('click', voltarDoDetalhe);
  $('btn-play').addEventListener('click', () => {
    if (!mediaAtual) return;
    if (mediaAtual.secao === 'series') {
      const comHist = episodiosFlat
        .filter(e => historico[e.ep.id || e.ep.episode_id])
        .sort((a, b) => (historico[b.ep.id || b.ep.episode_id].timestamp || 0) -
                         (historico[a.ep.id || a.ep.episode_id].timestamp || 0));
      const alvo = comHist.length ? comHist[0].ep : (episodiosFlat[0] && episodiosFlat[0].ep);
      if (alvo) playEpisodio(alvo);
    } else {
      const item = mediaAtual.dados;
      const url = urlFilme(item);
      abrirPlayer(url, {
        id: item.stream_id, name: item.name, url: url, aba: 'vod',
        logo: item.stream_icon || ''
      });
    }
  });
  $('btn-fav-detail').addEventListener('click', () => {
    if (!mediaAtual) return;
    alternarFavorito(mediaAtual.id, mediaAtual.secao, null);
  });

  // Player
  $('btn-retry').addEventListener('click', () => {
    if (videoAtual) abrirPlayer(videoAtual.url, videoAtual);
  });
  $('btn-voltar-player').addEventListener('click', sairDoPlayer);
  const cardProximo = $('proximo-ep-card');
  if (cardProximo) cardProximo.addEventListener('click', tocarProximoEpisodio);
  $('btn-playpause').addEventListener('click', alternarPlayPause);
  $('btn-rew').addEventListener('click', voltar10);
  $('btn-fwd').addEventListener('click', avancar10);

  const video = $('video');
  video.addEventListener('error', () => {
    if (!videoAtual) return;
    mostrarErroPlayer();
  });
  video.addEventListener('waiting', () => $('player-carregando').classList.remove('hidden'));
  video.addEventListener('playing', () => {
    $('player-carregando').classList.add('hidden');
    $('player-erro').classList.add('hidden');
  });
  video.addEventListener('timeupdate', () => {
    atualizarBarraControles();
    if (video.duration && video.currentTime > 5) registrarProgresso();
    // Últimos 10s de um episódio: mostra o card de próximo com contagem
    if (videoAtual && videoAtual.aba === 'series' && video.duration && isFinite(video.duration)) {
      const restante = video.duration - video.currentTime;
      if (restante > 0 && restante <= 10) mostrarCardProximoEp();
    }
  });
  video.addEventListener('play', () => {
    $('icon-play').classList.add('hidden');
    $('icon-pause').classList.remove('hidden');
  });
  video.addEventListener('pause', () => {
    $('icon-play').classList.remove('hidden');
    $('icon-pause').classList.add('hidden');
  });
  video.addEventListener('click', () => {
    if (videoAtual && videoAtual.aba !== 'live') {
      if ($('player-controls').classList.contains('hidden')) mostrarControles();
      else esconderControles();
    }
  });
  video.addEventListener('ended', () => {
    registrarProgresso();
    if (videoAtual && videoAtual.aba === 'series') {
      if (proximoEpisodioDisponivel()) {
        toast('Episódio finalizado');
        mostrarCardProximoEp();
      } else {
        toast('Fim da série');
      }
    }
  });

  // Relógio da home
  setInterval(() => {
    if ($('screen-home').classList.contains('active')) renderizarHome();
  }, 30000);

  // Entrada
  const salvoDns = localStorage.getItem('iptv_dns');
  const salvoUser = localStorage.getItem('iptv_user');
  const salvoPass = localStorage.getItem('iptv_pass');
  if (salvoDns && salvoUser && salvoPass) {
    credenciais.host = salvoDns;
    credenciais.user = salvoUser;
    credenciais.pass = salvoPass;
    carregarCatalogo();
  } else {
    mostrarTela('screen-login');
    focarPrimeiro($('screen-login'));
  }
}

document.addEventListener('DOMContentLoaded', iniciar);