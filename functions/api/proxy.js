// ============================================================================
// Proxy IPTV para Cloudflare Pages (Pages Function)
// -----------------------------------------------------------------------------
// Versão em JavaScript do antigo proxy FastAPI (api/main.py) que rodava na
// Vercel. Cloudflare Pages não executa Python/FastAPI — a alternativa nativa
// são Pages Functions (JavaScript), que é exatamente este arquivo.
//
// Deploy: basta enviar esta pasta para o Cloudflare Pages. Tudo que está em
// `functions/` vira endpoint automaticamente:
//   functions/api/proxy.js  ->  https://<seu-dominio>/api/proxy?url=...
// Não precisa de vercel.json, requirements.txt nem servidor Python.
//
// Vantagem sobre a versão Vercel: o Cloudflare faz streaming de verdade.
// O proxy antigo precisava cortar o vídeo em pedaços de 18 MB porque a
// Vercel matava a função após 60s de execução. Aqui simplesmente repassamos
// o fluxo de bytes da origem para o navegador, sem limite de duração.
// ============================================================================

// Mesma lista do proxy antigo: só repassa endpoints conhecidos da API Xtream,
// para o proxy não virar "open proxy" de qualquer site. "/hls/" é necessário
// para transmissões ao vivo com HLS adaptativo (variantes de qualidade e
// segmentos ficam em /hls/<id>-<hash>/..., não em /live/, /movie/ ou /series/).
const ALLOWED_PATH_PARTS = ["/player_api.php", "/live/", "/movie/", "/series/", "/hls/", "/xmltv.php"];

// Em produção, troque "*" pelo domínio exato do seu app (ex: "https://meuapp.pages.dev")
// para ninguém mais poder chamar este proxy a partir de outro site.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function jsonResposta(detalhe, status) {
  return Response.json({ detail: detalhe }, { status, headers: CORS_HEADERS });
}

// Resposta simples para o preflight CORS (navegador costuma não precisar para
// GET sem cabeçalhos customizados, mas deixamos pronto por garantia).
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context) {
  const { request, url: reqUrl } = context;

  // --- Validação da URL alvo ---
  const alvo = reqUrl.searchParams.get("url");
  if (!alvo) return jsonResposta("URL invalida.", 400);

  let parsed;
  try {
    parsed = new URL(alvo);
  } catch {
    return jsonResposta("URL invalida.", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    return jsonResposta("URL invalida.", 400);
  }
  if (!ALLOWED_PATH_PARTS.some((part) => parsed.pathname.includes(part))) {
    return jsonResposta("Endpoint nao permitido.", 403);
  }

  // --- Encaminha a requisição para o servidor IPTV ---
  // O cabeçalho Range é repassado quando existe: é assim que o player pede
  // pedaços específicos de vídeo (seek, retomada de filme etc.). O Cloudflare
  // mantém conexões reaproveitadas com a origem automaticamente (o pool de
  // conexões que precisávamos construir manualmente com httpx no Python).
  const headersUpstream = {};
  const range = request.headers.get("range");
  if (range) headersUpstream["Range"] = range;

  let upstream;
  try {
    upstream = await fetch(alvo, { headers: headersUpstream, redirect: "follow" });
  } catch (err) {
    return jsonResposta("Falha ao contatar o servidor IPTV.", 502);
  }

  const mediaType = upstream.headers.get("content-type") || "application/json";

  // --- Correção do erro de "Mixed Content" no player ---
  // O provedor Xtream só fala HTTP e o app roda em HTTPS, então o navegador
  // bloqueia requisições HTTP diretas. A playlist .m3u8 é lida inteira aqui
  // e cada linha que for uma URI (segmento .ts ou variante de qualidade) é
  // reescrita para passar por este mesmo proxy, recursivamente — mesmo
  // esquema do proxy Python antigo.
  const ePlaylistHls =
    mediaType.toLowerCase().includes("mpegurl") || parsed.pathname.toLowerCase().endsWith(".m3u8");

  if (ePlaylistHls && upstream.status === 200) {
    const textoOriginal = await upstream.text();
    const baseAbsoluta = reqUrl.origin + "/"; // ex: https://meuapp.pages.dev/

    const linhasReescritas = textoOriginal.split("\n").map((linha) => {
      const limpa = linha.trim();
      if (limpa && !limpa.startsWith("#")) {
        // Não é comentário/tag do m3u8 — é uma URI de segmento ou de variante.
        // new URL(uri, base) resolve relativas exatamente como o urljoin do Python.
        const uriAbsoluta = new URL(limpa, alvo).href;
        return baseAbsoluta + "api/proxy?url=" + encodeURIComponent(uriAbsoluta);
      }
      return linha;
    });

    return new Response(linhasReescritas.join("\n"), {
      status: 200,
      headers: { "content-type": mediaType, ...CORS_HEADERS },
    });
  }

  // --- Resposta direta: JSON da API, segmento .ts, filme, episódio etc. ---
  // Repassamos o corpo em STREAMING (upstream.body), sem carregar nada em
  // memória e sem limite artificial de tamanho — é o que permite filmes
  // longos e TV ao vivo sem as gambiarras de chunking da versão Vercel.
  const headersResposta = new Headers(CORS_HEADERS);
  headersResposta.set("content-type", mediaType);

  // Preserva os metadados de range quando a origem os envia (206 Partial
  // Content), para o player saber o tamanho total e a posição no vídeo.
  for (const h of ["accept-ranges", "content-range", "content-length"]) {
    const valor = upstream.headers.get(h);
    if (valor) headersResposta.set(h, valor);
  }
  // Nunca repassamos content-encoding: o Cloudflare já entrega o corpo em
  // claro ao ler/streaming, e um header de encoding sem o encoding de fato
  // quebraria o player.
  headersResposta.delete("content-encoding");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: headersResposta,
  });
}
