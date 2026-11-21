#!/usr/bin/env node
/* GMusic server — міні-сервер, сумісний з Piped API, на основі yt-dlp.
 *
 * Запуск:   node server.js            (потрібні Node 18+ і yt-dlp у PATH)
 * Порт:     PORT=8787
 * HTTPS:    cloudflared tunnel --url http://localhost:8787   → отримаєте https://xxxx.trycloudflare.com
 * У GMusic: Налаштування → «Свій сервер YouTube» → вставте цю https-адресу.
 *
 * Змінні середовища (необов'язково):
 *   PUBLIC_URL   зовнішня https-адреса сервера (якщо за проксі не видно протокол)
 *   COOKIES_FILE файл cookies.txt для yt-dlp (допомагає, якщо YouTube просить «підтвердити, що ви не бот»)
 *   ALLOW_ORIGIN дозволений origin для CORS (за замовчуванням *), напр. https://devalfastudios.github.io
 *   YTDLP        шлях до yt-dlp
 */
const http = require('http');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const PORT = +process.env.PORT || 8787;
const YTDLP = process.env.YTDLP || 'yt-dlp';
const COOKIES = process.env.COOKIES_FILE || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const ORIGIN = process.env.ALLOW_ORIGIN || '*';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const ID_RE = /^[\w-]{11}$/;

function ytdlp(args, timeout) {
  return new Promise((resolve, reject) => {
    const a = ['--no-warnings', '--ignore-config', ...(COOKIES ? ['--cookies', COOKIES] : []), ...args];
    execFile(YTDLP, a, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).slice(0, 300))) : resolve(out));
  });
}

// простий кеш з TTL + захист від дублювання паралельних запитів
function memo(ttl, fn) {
  const cache = new Map(), inflight = new Map();
  const get = key => {
    const c = cache.get(key);
    if (c && Date.now() - c.t < ttl) return Promise.resolve(c.v);
    if (inflight.has(key)) return inflight.get(key);
    const p = fn(key).then(v => { cache.set(key, { t: Date.now(), v }); return v; }).finally(() => inflight.delete(key));
    inflight.set(key, p); return p;
  };
  get.drop = key => cache.delete(key);
  return get;
}

const searchCached = memo(10 * 60e3, async q => {
  const out = await ytdlp([`ytsearch25:${q}`, '--flat-playlist', '-J'], 25000);
  const j = JSON.parse(out);
  return {
    items: (j.entries || []).filter(e => e && ID_RE.test(e.id || '')).map(e => ({
      url: '/watch?v=' + e.id, type: 'stream', title: e.title || '',
      uploaderName: e.channel || e.uploader || '', duration: Math.round(e.duration || 0),
      thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`, views: e.view_count || 0
    }))
  };
});

const infoCached = memo(20 * 60e3, async id => {
  const out = await ytdlp(['-f', 'bestaudio[ext=m4a]/bestaudio/best', '-J', '--no-playlist', 'https://www.youtube.com/watch?v=' + id], 45000);
  const j = JSON.parse(out);
  if (!j.url) throw new Error('no url');
  const headers = { ...(j.http_headers || {}) };
  delete headers['Accept-Encoding']; delete headers.Host; delete headers.host;
  return {
    url: j.url, headers, title: j.title || '', uploader: j.uploader || j.channel || '', duration: j.duration || 0,
    abr: j.abr || 128, mime: j.ext === 'webm' ? 'audio/webm' : (j.ext === 'm4a' || j.ext === 'mp4') ? 'audio/mp4' : 'audio/mpeg'
  };
});

function cors(extra) {
  return { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Range, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges', ...extra };
}
const json = (res, code, obj) => { res.writeHead(code, cors({ 'Content-Type': 'application/json; charset=utf-8' })); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors()); return res.end(); }
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const base = PUBLIC_URL || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0] + '://' + req.headers.host);

    if (p === '/') { res.writeHead(200, cors({ 'Content-Type': 'text/plain' })); return res.end('GMusic server OK'); }

    if (p === '/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 200);
      if (!q) return json(res, 200, { items: [] });
      return json(res, 200, await searchCached(q));
    }
    if (p === '/suggestions' || p === '/trending') return json(res, 200, []);

    let m = /^\/streams\/([\w-]{11})$/.exec(p);
    if (m) {
      const id = m[1], info = await infoCached(id);
      return json(res, 200, {
        title: info.title, uploader: info.uploader, duration: info.duration,
        thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        audioStreams: [{ url: `${base}/audio/${id}`, bitrate: Math.round(info.abr * 1000), mimeType: info.mime, videoOnly: false }],
        videoStreams: [], relatedStreams: []
      });
    }

    m = /^\/audio\/([\w-]{11})$/.exec(p);
    if (m) {
      const id = m[1];
      let info = await infoCached(id);
      const headers = { 'User-Agent': UA, ...info.headers };
      if (req.headers.range) headers.Range = req.headers.range;
      let up = await fetch(info.url, { headers });
      if (!up.ok && up.status !== 206) {                       // посилання могло протухнути — оновлюємо один раз
        infoCached.drop(id); info = await infoCached(id);
        up = await fetch(info.url, { headers: { ...headers, ...info.headers } });
      }
      if (!up.ok && up.status !== 206) { res.writeHead(502, cors()); return res.end('upstream ' + up.status); }
      const h = { 'Content-Type': info.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) h[k] = up.headers.get(k);
      res.writeHead(up.status, cors(h));
      const body = Readable.fromWeb(up.body);
      res.on('close', () => body.destroy());
      body.on('error', () => res.destroy());
      return body.pipe(res);
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(req.url, '→', e.message);
    if (!res.headersSent) json(res, 500, { error: String(e.message).slice(0, 200) }); else res.destroy();
  }
});
server.listen(PORT, () => console.log('GMusic server: http://localhost:' + PORT));
