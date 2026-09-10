/* ============================================================
   Meu IPTV — versão TV com visual web (azul) + TMDB
   - Pôsteres/backdrops/títulos do TMDB (cache 7 dias)
   - Busca abre o teclado NATIVO da TV (input focado, sem teclado virtual)
   ============================================================ */
'use strict';

const $ = id => document.getElementById(id);

/* ---------------- ESTADO GLOBAL ---------------- */
let credenciais = { host: '', user: '', pass: '' };
let db = { live: [], vod: [], series: [] };
let cats = { live: [], vod: [], series: [] };
let dataLoaded = false;

let secaoAtual = 'home';        // home | live | vod | series
let catAtual = null;
let dadosAtuais = [];
let canalSelecionado = null;
let mediaAtual = null;
let videoAtual = null;
let buscaAberta = false;

/* ---------------- TMDB ---------------- */
const TMDB_KEY = 'c5ec5dbd66ea50ce62b096dca322543c';
const TMDB_CACHE_KEY = 'iptv_tmdb_cache_v2';
const TMDB_TTL = 7 * 24 * 60 * 60 * 1000; // 7 dias
let tmdbCache = carregarJSON(TMDB_CACHE_KEY, {});

function salvarTmdbCache() {
  try { localStorage.setItem(TMDB_CACHE_KEY, JSON.stringify(tmdbCache)); } catch (e) {}
}

/* Limpa sujeira típica do nome no provedor: [4K], (2023), qualidade etc. */
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
        original: r.original_title || r.original_name || '',
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

/* Enriquece um card de filme/série com poster/ano do TMDB (sem bloquear a grade) */
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

/* ---------------- API Xtream (via proxy do deploy) ---------------- */
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
  secaoAtual = 'home';
  renderizarHome();
  mostrarTela('screen-home');
  focarPrimeiro($('screen-home'));
}

function irParaSecao(secao) {
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
      // capa do TMDB quando disponível
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

  // TMDB: troca o poster pela arte oficial + adiciona ano
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


/* ============================================================
   TELA DE DETALHES (com backdrop/título/sinopse do TMDB)
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

  // TMDB: backdrop, poster oficial, título limpo, nota, ano e sinopse
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
      '</div>';
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
   PLAYER
   ============================================================ */
function urlFilme(item) {
  const ext = item.container_extension || 'mp4';
  return credenciais.host + '/movie/' + credenciais.user + '/' + credenciais.pass +
         '/' + item.stream_id + '.' + ext;
}

function abrirPlayer(url, dados) {
  telaAntesDoPlayer = document.querySelector('.screen.active') ?
    document.querySelector('.screen.active').id : 'screen-home';
  videoAtual = dados;
  const video = $('video');

  $('player-erro').classList.add('hidden');
  $('player-carregando').classList.remove('hidden');
  $('btn-proximo-ep').classList.add('hidden');

  mostrarTela('screen-player');
  video.focus();

  video.src = montarUrlProxy(url);

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
  registrarProgresso();
  forcarPararVideo();
  videoAtual = null;
  if (telaAntesDoPlayer === 'screen-detail') {
    mostrarTela('screen-detail');
    focarPrimeiro($('screen-detail'));
  } else if (telaAntesDoPlayer === 'screen-browse') {
    mostrarTela('screen-browse');
    focarPrimeiro($('screen-browse'));
  } else {
    entrarNoMenu();
  }
}

function forcarPararVideo() {
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

function mostrarBotaoProximoEp() {
  const proximo = proximoEpisodioDisponivel();
  if (!proximo) return;
  $('btn-proximo-ep').classList.remove('hidden');
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
   BUSCA — abre o teclado NATIVO da TV
   (input focado; nenhum teclado virtual na tela)
   ============================================================ */
function abrirBusca() {
  buscaAberta = true;
  $('search-bar').classList.remove('hidden');
  const input = $('search-input');
  input.value = termoBusca;
  input.focus(); // <- a TV abre o IME/teclado nativo aqui
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
  mostrarTela('screen-login');
  focarPrimeiro($('screen-login'));
}

/* ============================================================
   NAVEGAÇÃO POR CONTROLE REMOTO / TECLADO
   ============================================================ */
function focavel(el) {
  if (!el || el.disabled) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function focarPrimeiro(tela) {
  if (!tela) return;
  const alvo = tela.querySelector('button, input, li[tabindex]');
  if (alvo && focavel(alvo)) { alvo.focus(); return; }
  const todos = tela.querySelectorAll('button, input, li[tabindex]');
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
  // Se estiver digitando na busca, as setas ficam com o IME da TV
  if (ativo.tagName === 'INPUT' && buscaAberta) return;

  const todos = Array.from(document.querySelectorAll('.screen.active button, .screen.active input, .screen.active li[tabindex]')).filter(focavel);
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
  // Voltar (Tizen = 10009, webOS = 461, navegador = Escape/Backspace)
  if (e.keyCode === 10009 || e.keyCode === 461 || e.key === 'Escape' ||
      (e.key === 'Backspace' && !buscaAberta)) {
    e.preventDefault();
    acaoVoltar();
    return;
  }

  // Enquanto a busca está aberta e o input focado, Enter confirma e fecha o teclado
  if (buscaAberta && document.activeElement === $('search-input')) {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      fecharBusca();
    }
    return; // demais teclas vão para o IME nativo da TV
  }

  const mapa = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (mapa[e.key]) {
    if (!$('screen-player').classList.contains('active')) {
      e.preventDefault();
      moverFoco(mapa[e.key]);
    }
    return;
  }

  if (e.key === 'Enter') {
    if (document.activeElement && document.activeElement.click) {
      document.activeElement.click();
    }
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
  if (!/^https?:\/\//i.test(dns)) dns = 'http://' + dns;
  dns = dns.replace(/\/+$/, '');

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
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fazerLogin(); });
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

  // Busca: digitação abre o teclado nativo; o filtro aplica em tempo real
  $('search-input').addEventListener('input', (e) => {
    termoBusca = e.target.value.trim();
    aplicarFiltro();
  });

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
  $('btn-proximo-ep').addEventListener('click', tocarProximoEpisodio);

  const video = $('video');
  video.addEventListener('error', () => {
    if (!videoAtual) return;
    $('player-carregando').classList.add('hidden');
    $('player-erro-msg').textContent = 'Não foi possível reproduzir.';
    $('player-erro').classList.remove('hidden');
    focarPrimeiro($('player-erro'));
  });
  video.addEventListener('waiting', () => $('player-carregando').classList.remove('hidden'));
  video.addEventListener('playing', () => {
    $('player-carregando').classList.add('hidden');
    $('player-erro').classList.add('hidden');
  });
  video.addEventListener('timeupdate', () => {
    if (video.duration && video.currentTime > 5) registrarProgresso();
  });
  video.addEventListener('ended', () => {
    registrarProgresso();
    if (videoAtual && videoAtual.aba === 'series') {
      const proximo = proximoEpisodioDisponivel();
      if (proximo) {
        mostrarBotaoProximoEp();
        toast('Episódio finalizado');
        setTimeout(() => { if (videoAtual) tocarProximoEpisodio(); }, 4000);
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