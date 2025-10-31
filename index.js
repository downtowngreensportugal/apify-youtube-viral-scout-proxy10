const { Actor, log } = require('apify');
const { ApifyClient } = require('apify-client');

log.info('YouTube Viral Scout Proxy v0.3.5 — start');

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

function parseDateAny(x) {
  if (!x) return null;
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

async function pollRunUntilDone(client, runId, pollSeconds=5, timeoutSeconds=300) {
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
    if (((Date.now() - start)/1000) > timeoutSeconds) {
      throw new Error(`Polling timed out after ${timeoutSeconds}s`);
    }
    await wait(pollSeconds * 1000);
  }
}

function normalizeForwardInput(fi) {
  if (!fi || typeof fi !== 'object') return {};
  const out = { ...fi };
  // Accept "searchQuery" or "query" as string and convert to "searchQueries: []"
  if (typeof out.searchQuery === 'string' && !Array.isArray(out.searchQueries)) {
    out.searchQueries = [out.searchQuery];
    delete out.searchQuery;
  }
  if (typeof out.query === 'string' && !Array.isArray(out.searchQueries)) {
    out.searchQueries = [out.query];
    delete out.query;
  }
  // If user passed a single string directly in forwardInput, wrap it
  if (typeof fi === 'string') {
    return { searchQueries: [fi], maxResults: 25, maxResultsShorts: 0, maxResultStreams: 0 };
  }
  return out;
}

Actor.main(async () => {
  try {
    const input = await Actor.getInput() || {};
    let {
      upstreamApifyToken,
      forwardInput = {"searchQueries":["microgreens"],"maxResults":25,"maxResultsShorts":0,"maxResultStreams":0},
      lastHours = 24,
      topN = 5,
      minViews = 0,
      scoreWeights = { views: 0.6, likes: 0.25, comments: 0.15 },
      maxDatasetItems = 1000,
      pollSeconds = 5,
      pollTimeoutSeconds = 300,
    } = input;

    forwardInput = normalizeForwardInput(forwardInput);
    if (!forwardInput.searchQueries && forwardInput.searchQuery) {
      forwardInput.searchQueries = Array.isArray(forwardInput.searchQuery) ? forwardInput.searchQuery : [forwardInput.searchQuery];
      delete forwardInput.searchQuery;
    }
    if (!Array.isArray(forwardInput.searchQueries) || forwardInput.searchQueries.length === 0) {
      forwardInput.searchQueries = ["microgreens"];
    }
    if (typeof forwardInput.maxResults !== 'number') forwardInput.maxResults = 25;
    if (typeof forwardInput.maxResultsShorts !== 'number') forwardInput.maxResultsShorts = 0;
    if (typeof forwardInput.maxResultStreams !== 'number') forwardInput.maxResultStreams = 0;

    const upstreamToken = upstreamApifyToken || process.env.UPSTREAM_APIFY_TOKEN;
    if (!upstreamToken) {
      log.warning('UPSTREAM_APIFY_TOKEN não definido; a tentar sem token (apenas para actors públicos).');
    }
    const client = new ApifyClient({ token: upstreamToken });

    const CANDIDATES = [
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
      .sort((a,b) => b.score - a.score)
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

    await Actor.setValue('OUTPUT', { ok: true, count: filtered.length, topN, lastHours, items: filtered });
    log.info('Concluído com sucesso (v0.3.5).');
  } catch (err) {
    log.error(`Erro não tratado: ${err?.message}`);
    await Actor.setValue('OUTPUT', {
      ok: false,
      error: String(err?.message || err),
      stack: String(err?.stack || ''),
      hint: 'Confirma UPSTREAM_APIFY_TOKEN nas env vars e o schema do forwardInput: use searchQueries: [...].'
    });
    throw err;
  }
});
