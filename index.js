const { Actor, log } = require('apify');
const { ApifyClient } = require('apify-client');

log.info('YouTube Viral Scout Proxy v0.3.6 — start');

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

function parseDateAny(x) {
  if (!x) return null;
  if (x instanceof Date) return isNaN(x.getTime()) ? null : x;
  if (typeof x === 'number') return new Date(x);
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
}
function hoursSince(date) {
  const now = Date.now();
  return Math.max(1, (now - date.getTime()) / 36e5);
}
function normalize(item) {
  const url = item.url || item.videoUrl || (item.id ? `https://www.youtube.com/watch?v=${item.id}` : '');
  const title = item.title || item.videoTitle || '';
  const channel = item.channelName || item.channel || item.author || '';
  const views = Number(item.viewCount || item.views || 0) || 0;
  const likes = Number(item.likes || item.likeCount || 0) || 0;
  const comments = Number(item.commentCount || item.comments || 0) || 0;
  const publishedRaw = item.date || item.publishedAt || item.uploadDate || item.time || item.publishedAtText;
  const publishedAt = parseDateAny(publishedRaw) || new Date();
  return { url, title, channel, views, likes, comments, publishedAt: publishedAt.toISOString(), _ageH: hoursSince(publishedAt), raw: item };
}

async function pollRunUntilDone(client, runId, pollSeconds = 5, timeoutSeconds = 300) {
  const start = Date.now();
  while (true) {
    const run = await client.run(runId).get();
    const status = run?.status || run?.data?.status;
    log.info(`Run status: ${status}`);
    if (status === 'SUCCEEDED' || status === 'FINISHED' || status === 'SUCCEED') return run;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      const msg = run?.statusMessage || run?.data?.statusMessage || 'no statusMessage';
      throw new Error(`Upstream run ended with status: ${status}. Message: ${msg}`);
    }
    if (((Date.now() - start) / 1000) > timeoutSeconds) {
      throw new Error(`Polling timed out after ${timeoutSeconds}s`);
    }
    await wait(pollSeconds * 1000);
  }
}

// Converte formatos aceitáveis para lastHours
function deriveLastHours(uploadDate, fallbackHours = 24) {
  if (uploadDate == null) return fallbackHours;
  // Se vier número (ex.: 24), assume já em horas
  if (typeof uploadDate === 'number' && isFinite(uploadDate)) {
    return Math.max(1, Math.floor(uploadDate));
  }
  // Se vier string tipo "2025-10-30T00:00:00Z" ou "2025-10-30"
  const d = parseDateAny(uploadDate);
  if (d) return Math.max(1, Math.round(hoursSince(d)));
  // Se não deu para interpretar, usa fallback
  return fallbackHours;
}

function normalizeForwardInput(fi) {
  if (!fi || typeof fi !== 'object') return {};
  const out = { ...fi };
  // Aceita "searchQuery" ou "query" como string e converte para array "searchQueries"
  if (typeof out.searchQuery === 'string' && !Array.isArray(out.searchQueries)) {
    out.searchQueries = [out.searchQuery];
    delete out.searchQuery;
  }
  if (typeof out.query === 'string' && !Array.isArray(out.searchQueries)) {
    out.searchQueries = [out.query];
    delete out.query;
  }
  // Se o utilizador passou uma string diretamente em forwardInput, envolver
  if (typeof fi === 'string') {
    return { searchQueries: [fi], maxResults: 25, maxResultsShorts: 0, maxResultStreams: 0 };
  }
  return out;
}

Actor.main(async () => {
  try {
    const input = await Actor.getInput() || {};

    // 🔁 Compat: aceitar também searchKeywords / uploadDate no nível de raiz
    // - searchKeywords: string ("ai videos") | array (["ai","microgreens"])
    // - uploadDate: number (horas) OU data (ISO / string) → converte para lastHours
    let {
      upstreamApifyToken,
      forwardInput,
      searchKeywords,       // novo: compat externa
      uploadDate,           // novo: compat externa
      lastHours,            // se vier definido, respeitamos; senão derivamos do uploadDate (ou 24)
      topN = 5,
      minViews = 0,
      scoreWeights = { views: 0.6, likes: 0.25, comments: 0.15 },
      maxDatasetItems = 1000,
      pollSeconds = 5,
      pollTimeoutSeconds = 300,
      upstreamActorIds,     // opcional: permitir override dos candidatos
    } = input;

    // Default forwardInput se não vier
    if (!forwardInput) {
      forwardInput = { searchQueries: ['microgreens'], maxResults: 25, maxResultsShorts: 0, maxResultStreams: 0 };
    }

    // Mapear searchKeywords (root) → forwardInput.searchQueries
    if (searchKeywords) {
      const arr = Array.isArray(searchKeywords)
        ? searchKeywords
        : String(searchKeywords).split(',').map(s => s.trim()).filter(Boolean);
      if (!forwardInput || typeof forwardInput !== 'object') forwardInput = {};
      forwardInput.searchQueries = arr.length ? arr : ['microgreens'];
    }

    // Normalizar forwardInput (aceita "searchQuery"/"query" antigos)
    forwardInput = normalizeForwardInput(forwardInput);
    if (!Array.isArray(forwardInput.searchQueries) || forwardInput.searchQueries.length === 0) {
      forwardInput.searchQueries = ['microgreens'];
    }
    if (typeof forwardInput.maxResults !== 'number') forwardInput.maxResults = 25;
    if (typeof forwardInput.maxResultsShorts !== 'number') forwardInput.maxResultsShorts = 0;
    if (typeof forwardInput.maxResultStreams !== 'number') forwardInput.maxResultStreams = 0;

    // Derivar lastHours a partir de uploadDate se não vier explícito
    if (lastHours == null) {
      lastHours = deriveLastHours(uploadDate, 24);
    } else {
      // garantir mínimo
      lastHours = Math.max(1, Number(lastHours) || 24);
    }

    const upstreamToken = upstreamApifyToken || process.env.UPSTREAM_APIFY_TOKEN;
    if (!upstreamToken) {
      log.warning('UPSTREAM_APIFY_TOKEN não definido; a tentar sem token (apenas para actors públicos).');
    }
    const client = new ApifyClient({ token: upstreamToken });

    const CANDIDATES = Array.isArray(upstreamActorIds) && upstreamActorIds.length
      ? upstreamActorIds
      : [
          'streamers/youtube-scraper',
          'streamers/youtube-videos-scraper',
          'runtime/youtube-channel-scraper',
        ];

    let run = null, lastErr = null, usedId = null;
    for (const id of CANDIDATES) {
      try {
        log.info(`A tentar lançar actor: ${id}`);
        run = await client.actor(id).start(forwardInput);
        usedId = id;
        break;
      } catch (e) {
        lastErr = e;
        log.warning(`Falhou ${id}: ${e?.message}`);
      }
    }
    if (!run) throw new Error(`Nenhum actor YouTube disponível. Último erro: ${lastErr?.message}`);
    log.info(`Actor iniciado: ${usedId}`);

    const runId = run?.id || run?.data?.id;
    if (!runId) throw new Error('Não foi possível obter o runId (start).');
    const finished = await pollRunUntilDone(client, runId, pollSeconds, pollTimeoutSeconds);

    const datasetId = finished?.defaultDatasetId || finished?.data?.defaultDatasetId;
    if (!datasetId) throw new Error('Não foi possível obter defaultDatasetId da run finalizada.');

    log.info('A obter itens do dataset...', { datasetId });
    const { items } = await client.dataset(datasetId).listItems({ clean: true, limit: maxDatasetItems });
    log.info(`Itens recebidos: ${items?.length || 0}`);

    const filtered = (items || []).map(normalize)
      .filter(i => i.views >= minViews)
      .filter(i => i._ageH <= lastHours)
      .map(i => {
        const score = (i.views / i._ageH) * scoreWeights.views
          + (i.likes / i._ageH) * scoreWeights.likes
          + (i.comments / i._ageH) * scoreWeights.comments;
        return { ...i, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);

    for (const it of filtered) {
      await Actor.pushData({
        run_date: new Date().toISOString(),
        url: it.url,
        title: it.title,
        channel: it.channel,
        views: it.views,
        likes: it.likes,
        comments: it.comments,
        publishedAt: it.publishedAt,
        score: it.score,
      });
    }

    await Actor.setValue('OUTPUT', {
      ok: true,
      count: filtered.length,
      topN,
      lastHours,
      items: filtered,
      usedUpstream: usedId,
      inputEcho: {
        searchQueries: forwardInput.searchQueries,
        maxResults: forwardInput.maxResults,
        maxResultsShorts: forwardInput.maxResultsShorts,
        maxResultStreams: forwardInput.maxResultStreams,
      }
    });
    log.info('Concluído com sucesso (v0.3.6).');
  } catch (err) {
    log.error(`Erro não tratado: ${err?.message}`);
    await Actor.setValue('OUTPUT', {
      ok: false,
      error: String(err?.message || err),
      stack: String(err?.stack || ''),
      hint: 'Pode enviar searchKeywords (string/array) e uploadDate (horas ou data ISO). Internamente mapeamos para forwardInput.searchQueries e lastHours.'
    });
    throw err;
  }
});
