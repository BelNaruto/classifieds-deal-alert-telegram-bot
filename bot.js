// Zero-dependency Telegram bot (Node 18+). Long polling, no webhooks needed.
const TG = process.env.TELEGRAM_TOKEN;
const KEY = process.env.RAPIDAPI_KEY;
const HOST = process.env.RAPIDAPI_HOST || 'classifieds-listings-api.p.rapidapi.com';
const POLL = Number(process.env.POLL_SECONDS || 180) * 1000;
if (!TG || !KEY) { console.error('Set TELEGRAM_TOKEN and RAPIDAPI_KEY (see .env.example)'); process.exit(1); }

const api = async (path, params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  const r = await fetch(`https://${HOST}${path}?${qs}`, { headers: { 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST } });
  const body = await r.json();
  if (!r.ok || body.error) throw new Error(body.message || body.error || r.status);
  return body.data;
};
const tg = (method, body) => fetch(`https://api.telegram.org/bot${TG}/${method}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const say = (chat_id, text) => tg('sendMessage', { chat_id, text, disable_web_page_preview: true });

const eur = (l) => (l.price == null ? '?' : `${l.price} ${l.currency || 'EUR'}`);
const line = (l) => `${eur(l)} [${l.source}] ${l.title.slice(0, 60)}\n${l.url}`;
const parse = (args) => {            // "iphone 13 max=400 sources=olx,wallapop"
  const o = { words: [] };
  for (const a of args) { const m = a.match(/^(max|min|sources)=(.+)$/); if (m) o[m[1]] = m[2]; else o.words.push(a); }
  return { query: o.words.join(' '), maxPrice: o.max, minPrice: o.min, sources: o.sources };
};

const watchers = new Map();           // chat_id -> { params, seen:Set }

const commands = {
  async start(chat) {
    return say(chat, [
      'Second-hand deal bot (OLX, Wallapop, Leboncoin, Custojusto, Facebook Marketplace)',
      '/cheapest iphone 13 max=400   cheapest listings right now',
      '/compare iphone 13            min/avg/max per source',
      '/search sofa sources=olx      plain search',
      '/watch ps5 max=300            alert me about NEW listings',
      '/stop                         stop alerts',
      '',
      'Support: Telegram @pintoflow',
    ].join('\n'));
  },
  async cheapest(chat, args) {
    const d = await api('/api/search/cheapest', { ...parse(args), limit: 8 });
    return say(chat, d.listings.slice(0, 8).map(line).join('\n\n') || 'Nothing found');
  },
  async search(chat, args) {
    const d = await api('/api/search', { ...parse(args), limit: 8 });
    return say(chat, d.listings.slice(0, 8).map(line).join('\n\n') || 'Nothing found');
  },
  async compare(chat, args) {
    const d = await api('/api/search/compare', { ...parse(args), limit: 20 });
    const rows = Object.entries(d.bySource).map(([s, v]) => `${s}: ${v.count} listings, min ${v.min} / avg ${Math.round(v.avg)} / max ${v.max}`);
    return say(chat, ['Price by source', ...rows, `Overall min ${d.overall.min}, avg ${Math.round(d.overall.avg)}`].join('\n'));
  },
  async watch(chat, args) {
    const params = { ...parse(args), limit: 30 };
    if (!params.query) return say(chat, 'Usage: /watch iphone 13 max=400');
    const first = await api('/api/search/cheapest', params);
    watchers.set(chat, { params, seen: new Set(first.listings.map((l) => l.id)) });
    return say(chat, `Watching "${params.query}". You will be pinged about new listings (checks every ${POLL / 1000}s).`);
  },
  async stop(chat) { watchers.delete(chat); return say(chat, 'Stopped.'); },
};

async function pollWatchers() {
  for (const [chat, w] of watchers) {
    try {
      const d = await api('/api/search/cheapest', w.params);
      const fresh = d.listings.filter((l) => !w.seen.has(l.id));
      fresh.forEach((l) => w.seen.add(l.id));
      if (fresh.length) await say(chat, `New listings:\n\n${fresh.slice(0, 5).map(line).join('\n\n')}`);
    } catch (e) { console.error('watch error', e.message); }
  }
}
setInterval(pollWatchers, POLL);

(async () => {
  let offset = 0;
  console.log('bot running');
  for (;;) {
    try {
      const u = await tg('getUpdates', { timeout: 50, offset });
      for (const up of u.result || []) {
        offset = up.update_id + 1;
        const m = up.message; if (!m || !m.text) continue;
        const [cmd, ...args] = m.text.trim().split(/\s+/);
        const fn = commands[cmd.replace(/^\//, '').replace(/@.*/, '')];
        if (fn) fn(m.chat.id, args).catch((e) => say(m.chat.id, 'Error: ' + e.message));
      }
    } catch (e) { console.error(e.message); await new Promise((r) => setTimeout(r, 3000)); }
  }
})();
