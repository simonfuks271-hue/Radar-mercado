const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Watchlist inicial. Se puede ampliar despues - escanear "todo el mercado mundial"
// en tiempo real no es viable de entrada, arrancamos con un universo curado
// de tickers grandes/liquidos de distintas regiones y lo vamos ampliando.
const WATCHLIST = [
  { ticker: 'AAPL', exch: 'NASDAQ', company: 'Apple Inc' },
  { ticker: 'NVDA', exch: 'NASDAQ', company: 'Nvidia Corp' },
  { ticker: 'MSFT', exch: 'NASDAQ', company: 'Microsoft Corp' },
  { ticker: 'GOOGL', exch: 'NASDAQ', company: 'Alphabet Inc' },
  { ticker: 'AMZN', exch: 'NASDAQ', company: 'Amazon.com Inc' },
  { ticker: 'TSLA', exch: 'NASDAQ', company: 'Tesla Inc' },
  { ticker: 'META', exch: 'NASDAQ', company: 'Meta Platforms' },
  { ticker: 'BABA', exch: 'NYSE', company: 'Alibaba Group' },
  { ticker: 'MELI', exch: 'NASDAQ', company: 'MercadoLibre' },
  { ticker: 'PBR', exch: 'NYSE', company: 'Petrobras' },
  { ticker: 'JPM', exch: 'NYSE', company: 'JPMorgan Chase' },
  { ticker: 'XOM', exch: 'NYSE', company: 'Exxon Mobil' },
];

exports.handler = async function () {
  const results = [];

  for (const stock of WATCHLIST) {
    try {
      const newsUrl = `https://api.massive.com/v2/reference/news?ticker=${stock.ticker}&limit=3&apiKey=${process.env.MASSIVE_API_KEY}`;
      const newsRes = await fetch(newsUrl);
      const newsData = await newsRes.json();
      const articles = newsData.results || [];
      if (articles.length === 0) continue;

      const headlines = articles.map((a) => a.title).join('\n');

      const sentimentResp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Analiza estas noticias recientes sobre ${stock.company} (${stock.ticker}):\n${headlines}\n\nRespondé SOLO con un JSON, sin texto adicional ni markdown, con este formato exacto:\n{"sentiment":"pos|neg|neu","score":0-100,"headline":"resumen breve en español de la noticia mas relevante, en tus propias palabras"}\n\nEl "score" representa que tan relevante/atencion-generadora es la noticia (no una prediccion de precio).`,
          },
        ],
      });

      const raw = sentimentResp.content[0].text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);

      results.push({
        ticker: stock.ticker,
        exch: stock.exch,
        company: stock.company,
        headline: parsed.headline,
        sentiment: parsed.sentiment,
        score: parsed.score,
        vol: Math.min(100, articles.length * 25),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`Error procesando ${stock.ticker}:`, err.message);
    }
  }

  if (results.length > 0) {
    await supabase.from('signals').upsert(results, { onConflict: 'ticker' });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ updated: results.length }),
  };
};
