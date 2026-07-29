const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cuantos tickers distintos procesamos como maximo por corrida.
const MAX_TICKERS = 15;

// Cuantos articulos de noticias generales miramos para descubrir tickers.
const NEWS_FEED_LIMIT = 500;

// Cuantas horas hacia atras consideramos una noticia "fresca".
// Todo lo mas viejo que esto se descarta antes de analizar.
const FRESHNESS_HOURS = 12;

// 1) Trae el feed general de noticias (sin filtrar por ticker) y arma
//    un mapa de que tickers aparecen mencionados y con que frecuencia.
async function discoverTickers() {
  const url = `https://api.massive.com/v2/reference/news?limit=${NEWS_FEED_LIMIT}&order=desc&sort=published_utc&apiKey=${process.env.MASSIVE_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const allArticles = data.results || [];

  const cutoff = Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000;
  const articles = allArticles.filter((a) => {
    if (!a.published_utc) return false;
    return new Date(a.published_utc).getTime() >= cutoff;
  });

  const byTicker = {};

  for (const article of articles) {
    const tickers = article.tickers || [];
    for (const t of tickers) {
      if (!byTicker[t]) byTicker[t] = [];
      byTicker[t].push(article);
    }
  }

  const sorted = Object.entries(byTicker).sort((a, b) => b[1].length - a[1].length);
  return sorted.slice(0, MAX_TICKERS);
}

// 2) Nombre de la empresa y exchange, vía referencia de Massive
async function getTickerInfo(ticker) {
  try {
    const url = `https://api.massive.com/v3/reference/tickers/${ticker}?apiKey=${process.env.MASSIVE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const r = data.results;
    if (!r) return { company: ticker, exch: '', market_cap: null };
    return { company: r.name || ticker, exch: r.primary_exchange || '', market_cap: r.market_cap || null };
  } catch (err) {
    return { company: ticker, exch: '', market_cap: null };
  }
}

// 3) Precio EN VIVO (ultima operacion) + variacion % vs cierre anterior.
async function getPrice(ticker) {
  try {
    const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${process.env.MASSIVE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const t = data.ticker;
    if (!t) return { price: null, change_pct: null, day_open: null, day_high: null, day_low: null, day_volume: null };
    const price = (t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || null;
    const change_pct = t.todaysChangePerc != null ? t.todaysChangePerc : null;
    const day = t.day || {};
    return {
      price,
      change_pct,
      day_open: day.o || null,
      day_high: day.h || null,
      day_low: day.l || null,
      day_volume: day.v || null,
    };
  } catch (err) {
    return { price: null, change_pct: null, day_open: null, day_high: null, day_low: null, day_volume: null };
  }
}

// 4) Velas intradiarias para el mini-grafico
async function getSpark(ticker) {
  try {
    const to = new Date().toISOString().slice(0, 10);
    const url = `https://api.massive.com/v2/aggs/ticker/${ticker}/range/5/minute/${to}/${to}?adjusted=true&sort=asc&limit=50&apiKey=${process.env.MASSIVE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const bars = data.results || [];
    return bars.map((b) => b.c);
  } catch (err) {
    return [];
  }
}

exports.handler = async function () {
  const results = [];

  // Limpieza: borra senales viejas que ya no se actualizaron
  // en las ultimas 24hs, para que no se acumulen para siempre.
  const staleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('signals').delete().lt('updated_at', staleCutoff);

  let discovered;
  try {
    discovered = await discoverTickers();
  } catch (err) {
    console.error('Error descubriendo tickers desde noticias:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  for (const [ticker, articles] of discovered) {
    try {
      const headlines = articles.slice(0, 3).map((a) => a.title).join('\n');
      const mostRecent = articles[0];

      const { company, exch, market_cap } = await getTickerInfo(ticker);

      const sentimentResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Analiza estas noticias recientes sobre ${company} (${ticker}):\n${headlines}\n\nRespondé SOLO con un JSON, sin texto adicional ni markdown, con este formato exacto:\n{"sentiment":"pos|neg|neu","score":0-100,"headline":"resumen breve en español de la noticia mas relevante, en tus propias palabras"}\n\n"sentiment" = si el contenido de la noticia sugiere una reacción de mercado probablemente alcista (pos), bajista (neg), o neutra/mixta (neu) para esta acción. Esto es una lectura del tono de la noticia, NO una predicción garantizada de precio.\nEl "score" representa que tan relevante/atencion-generadora es la noticia.`,
          },
        ],
      });

      const raw = sentimentResp.content[0].text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);

      const { price, change_pct, day_open, day_high, day_low, day_volume } = await getPrice(ticker);
      const spark = await getSpark(ticker);

      results.push({
        ticker,
        exch,
        company,
        headline: parsed.headline,
        sentiment: parsed.sentiment,
        score: parsed.score,
        vol: Math.min(100, articles.length * 15),
        price,
        change_pct,
        day_open,
        day_high,
        day_low,
        day_volume,
        market_cap,
        published_at: mostRecent.published_utc || null,
        spark,
        url: mostRecent.article_url || null,
        image_url: mostRecent.image_url || null,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Error procesando ${ticker}:`, err.message);
    }
  }

  if (results.length > 0) {
    await supabase.from('signals').upsert(results, { onConflict: 'ticker' });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ updated: results.length, discovered: discovered.length }),
  };
};
