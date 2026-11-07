(() => {
'use strict';

const A = window.Android;
const LS = window.localStorage;
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];

const rd = (k, d) => { try { const v = LS.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const wr = (k, v) => LS.setItem(k, JSON.stringify(v));
const nextId = (name) => { const n = (rd('kb_seq_' + name, 0) || 0) + 1; wr('kb_seq_' + name, n); return n; };
const E = (msg, code = 400) => Object.assign(new Error(msg), { code });
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Istanbul'; } catch { return 'Europe/Istanbul'; } };

const nf = { seq: 0, pending: {} };
window.__nf = (id, status, body) => {
  const p = nf.pending[id];
  if (p) { delete nf.pending[id]; p({ status, body }); }
};
function nativeFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const id = 'r' + (++nf.seq);
    nf.pending[id] = resolve;
    setTimeout(() => { if (nf.pending[id]) { delete nf.pending[id]; reject(E('İstek zaman aşımına uğradı.', 502)); } }, 100000);
    A.fetch(id, url, method, JSON.stringify(headers), body == null ? '' : body);
  });
}

const DEFAULTS = () => ({
  display_name: '', city: '', lat: null, lon: null, timezone: tzName(), theme: 'dark',
  daily_enabled: true, daily_time: '08:00', weather_enabled: true, watch_enabled: true, watch_hours: 6,
  quiet_start: '23:00', quiet_end: '07:00', voice_name: 'Kore', gemini_key: '', model: 'gemini-2.5-flash',
});
const getS = () => Object.assign(DEFAULTS(), rd('kb_settings', {}));
function putS(s) { wr('kb_settings', s); sync(); }
function pubS(s) {
  const { gemini_key, lat, lon, ...rest } = s;
  return { ...rest, has_key: !!gemini_key, key_hint: gemini_key ? '…' + gemini_key.slice(-4) : '' };
}

function sync() {
  if (!A) return;
  try { A.saveSnapshot(JSON.stringify({ settings: getS(), notes: rd('kb_notes', []) })); } catch { /* yoksay */ }
}

function applyQueue() {
  if (!A) return;
  let q = [];
  try { q = JSON.parse(A.drainQueue() || '[]'); } catch { /* yoksay */ }
  if (!q.length) return;
  const inbox = rd('kb_inbox', []);
  const notes = rd('kb_notes', []);
  for (const it of q) {
    if (it.type === 'inbox') {
      inbox.unshift({ id: nextId('inbox'), kind: it.kind, title: it.title, body: it.body, read: false, created_at: it.created_at });
    } else if (it.type === 'note') {
      const n = notes.find((x) => x.id === it.id);
      if (n && n.updated_at === it.ver) {
        n.last_check = it.last_check;
        if (it.last_status != null) n.last_status = it.last_status;
      }
    }
  }
  wr('kb_inbox', inbox.slice(0, 200));
  wr('kb_notes', notes);
}

const acct = () => rd('kb_account', null);
let unlocked = false, fails = 0, blockedUntil = 0;

function randSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}
const hashPw = (pw, salt) => A.hashPassword(String(pw), salt);

function mePayload() {
  const a = acct();
  const s = getS();
  return { user: { username: a.username }, settings: pubS(s), vapidPublicKey: '', geminiConfigured: !!s.gemini_key };
}

function register(b) {
  if (acct()) throw E('Bu cihazda zaten bir hesap var.', 403);
  const name = String(b.username || '').trim();
  if (!/^[\p{L}\p{N}_. -]{2,32}$/u.test(name)) throw E('Ad 2–32 karakter olmalı.');
  if (String(b.password || '').length < 8) throw E('Parola en az 8 karakter olmalı.');
  const salt = randSalt();
  wr('kb_account', { username: name, salt, hash: hashPw(b.password, salt) });
  putS({ ...DEFAULTS(), timezone: b.timezone || tzName() });
  unlocked = true;
  applyQueue();
  return mePayload();
}

function login(b) {
  const a = acct();
  if (!a) throw E('Önce hesap oluştur.', 401);
  if (Date.now() < blockedUntil) throw E(`Çok fazla deneme. ${Math.ceil((blockedUntil - Date.now()) / 1000)} sn sonra tekrar dene.`, 429);
  if (hashPw(b.password, a.salt) !== a.hash) {
    if (++fails >= 5) { blockedUntil = Date.now() + 30000; fails = 0; }
    throw E('Parola hatalı.', 401);
  }
  fails = 0;
  unlocked = true;
  applyQueue();
  sync();
  return mePayload();
}

const wCache = new Map();
async function geocode(city) {
  const r = await nativeFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=tr&format=json`);
  if (r.status !== 200) return null;
  try { const j = JSON.parse(r.body); return j.results && j.results[0] ? j.results[0] : null; } catch { return null; }
}
async function getWeather(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = wCache.get(key);
  if (hit && Date.now() - hit.t < 30 * 60e3) return hit.data;
  const url = 'https://api.open-meteo.com/v1/forecast' + `?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,apparent_temperature,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1';
  const r = await nativeFetch(url);
  if (r.status !== 200) throw E('Hava durumu alınamadı', 502);
  const data = JSON.parse(r.body);
  wCache.set(key, { t: Date.now(), data });
  return data;
}
function wmo(c) {
  if (c === 0) return 'açık';
  if (c === 1) return 'çoğunlukla açık';
  if (c === 2) return 'parçalı bulutlu';
  if (c === 3) return 'kapalı';
  if (c === 45 || c === 48) return 'sisli';
  if (c >= 51 && c <= 57) return 'çiseliyor';
  if (c >= 61 && c <= 67) return 'yağmurlu';
  if (c >= 71 && c <= 77) return 'karlı';
  if (c >= 80 && c <= 82) return 'sağanak yağışlı';
  if (c === 85 || c === 86) return 'kar sağanağı';
  if (c >= 95) return 'gök gürültülü fırtına';
  return 'değişken';
}
function weatherText(w) {
  const c = w.current, d = w.daily;
  const rain = d.precipitation_probability_max && d.precipitation_probability_max[0] != null ? d.precipitation_probability_max[0] : 0;
  return `Şu an ${Math.round(c.temperature_2m)}°C (hissedilen ${Math.round(c.apparent_temperature)}°C), ${wmo(c.weather_code)}. `
    + `Bugün ${Math.round(d.temperature_2m_min[0])}–${Math.round(d.temperature_2m_max[0])}°C, yağış ihtimali %${rain}.`;
}

async function gemini(s, { system, contents, search = true, tools = null }) {
  if (!s.gemini_key) throw E('Önce Ayarlar bölümünden Gemini anahtarını ekle.');
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.7 } };
  if (tools) { body.tools = tools; body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }; }
  else if (search) body.tools = [{ google_search: {} }];
  const r = await nativeFetch(`${GEMINI}/${s.model || 'gemini-2.5-flash'}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.gemini_key }, body: JSON.stringify(body),
  });
  if (r.status === 0) throw E('İnternet bağlantısı yok.', 502);
  let j = {};
  try { j = JSON.parse(r.body); } catch { /* yoksay */ }
  if (r.status < 200 || r.status >= 300) {
    const m = (j.error && j.error.message) || '';
    if (r.status === 429) throw E('Gemini kullanım sınırına ulaşıldı. Biraz sonra tekrar dene.', 429);
    if (/API key/i.test(m) || r.status === 401 || r.status === 403) throw E('Gemini anahtarı geçersiz görünüyor. Ayarlar\'dan kontrol et.', 502);
    throw E(m || 'Gemini yanıt vermedi.', 502);
  }
  const cand = j.candidates && j.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
  const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const seen = new Set(), sources = [];
  for (const c of chunks) {
    const w = c.web;
    if (w && /^https?:\/\//.test(w.uri || '') && !seen.has(w.uri)) { seen.add(w.uri); sources.push({ uri: w.uri, title: (w.title || '').slice(0, 80) }); }
  }
  if (!text && !calls.length) throw E('Gemini boş yanıt döndürdü. Soruyu biraz değiştirip tekrar dene.', 502);
  return { text, sources, calls };
}

async function buildSystem(s, voice) {
  const tz = s.timezone || 'Europe/Istanbul';
  let nowStr;
  try { nowStr = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'full', timeStyle: 'short', timeZone: tz }).format(new Date()); }
  catch { nowStr = new Date().toLocaleString('tr-TR'); }
  const notes = rd('kb_notes', []).slice().sort((a, b) => b.updated_at - a.updated_at).slice(0, 30);
  let w = '';
  if (s.weather_enabled && s.lat != null) { try { w = weatherText(await getWeather(s.lat, s.lon)); } catch { /* yoksay */ } }
  const L = [
    'Sen "Kehribar" adlı kişisel yapay zekâ asistanısın. Her zaman Türkçe yanıt ver; sıcak, net ve yardımsever ol.',
    'Haber, fiyat, skor, hava gibi değişebilen konularda Google Arama\'yı kullan ve kaynaklara dayan.',
    `Şu an: ${nowStr} (${tz}).`,
    'Telefon komutları (ses, parlaklık, fener, uygulama açma, alarm vb.) ayrı bir sistem tarafından yürütülür; sen sohbet et, komut yapıyormuş gibi davranma.',
  ];
  if (s.display_name) L.push(`Kullanıcının adı: ${s.display_name}.`);
  if (s.city) L.push(`Kullanıcının şehri: ${s.city}.${w ? ' Hava: ' + w : ''}`);
  if (notes.length) {
    L.push('Kullanıcının kayıtlı notları (bunlar hakkında sorarsa bu bilgilere dayan, olmayan şeyi uydurma):');
    for (const n of notes) {
      let line = `- ${n.title || 'Başlıksız'}: ${(n.body || '').slice(0, 400).replace(/\s+/g, ' ')}`;
      if (n.watch) line += ` [takipte${n.last_status ? '; son durum: ' + n.last_status.slice(0, 300).replace(/\s+/g, ' ') : ''}]`;
      if (n.daily) line += ' [her gün hatırlatılıyor]';
      L.push(line);
    }
  } else L.push('Kullanıcının henüz kayıtlı notu yok.');
  if (voice) L.push('Şu an sesli konuşma modundasın: en fazla 3 kısa cümleyle, günlük konuşma diliyle yanıt ver. Markdown, liste, emoji ve bağlantı kullanma.');
  return L.join('\n');
}

const ASCII = { 'ı': 'i', 'ş': 's', 'ç': 'c', 'ğ': 'g', 'ö': 'o', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };
const norm = (s) => String(s || '').toLocaleLowerCase('tr-TR').replace(/[ışçğöüâîû]/g, (c) => ASCII[c]).replace(/[^a-z0-9 ]/g, '').trim();
const CMD_PREFIX = ['ses', 'parlak', 'fener', 'titre', 'rahatsiz', 'sessiz', 'wifi', 'bluetooth', 'ayar', 'uygulama', 'ekran', 'alarm', 'zamanlayici', 'sayac', 'harita', 'navigasyon', 'whatsapp', 'telegram', 'kamera', 'mail'];
const CMD_EXACT = new Set(['ac', 'acin', 'acar', 'acarmisin', 'acabilirmisin', 'kapat', 'kapatir', 'kapatin', 'baslat', 'calistir', 'yak', 'sondur', 'git', 'ara', 'arar', 'arayin', 'kur', 'yap', 'yapabilir', 'otur', 'konus', 'duzenle', 'beklet']);
const looksLikeCommand = (text) => norm(text).split(/\s+/).some((t) => CMD_EXACT.has(t) || CMD_PREFIX.some((p) => t.startsWith(p)));

const STREAMS = ['music', 'ring', 'alarm', 'notification', 'system', 'call'];
const TOOLS = [{
  functionDeclarations: [
    { name: 'set_volume', description: 'Telefonun ses düzeyini yüzde olarak ayarlar.', parameters: { type: 'OBJECT', properties: { percent: { type: 'INTEGER', description: '0-100' }, stream: { type: 'STRING', enum: STREAMS, description: 'Varsayılan music' } }, required: ['percent'] } },
    { name: 'set_brightness', description: 'Ekran parlaklığını yüzde olarak ayarlar.', parameters: { type: 'OBJECT', properties: { percent: { type: 'INTEGER' } }, required: ['percent'] } },
    { name: 'toggle_flashlight', description: 'Feneri açar veya kapatır.', parameters: { type: 'OBJECT', properties: { on: { type: 'BOOLEAN' } }, required: ['on'] } },
    { name: 'vibrate', description: 'Telefonu kısa süre titretir.', parameters: { type: 'OBJECT', properties: { ms: { type: 'INTEGER' } } } },
    { name: 'open_app', description: 'Telefondaki bir uygulamayı adıyla açar.', parameters: { type: 'OBJECT', properties: { app_name: { type: 'STRING' } }, required: ['app_name'] } },
    { name: 'open_settings', description: 'Bir sistem ayarlarını açar.', parameters: { type: 'OBJECT', properties: { page: { type: 'STRING', enum: ['sound', 'wifi', 'bluetooth', 'display', 'battery', 'location', 'apps', 'main'] } }, required: ['page'] } },
    { name: 'set_do_not_disturb', description: 'Rahatsız Etme modunu açar kapatır.', parameters: { type: 'OBJECT', properties: { on: { type: 'BOOLEAN' } }, required: ['on'] } },
    { name: 'open_url', description: 'Bir web adresini açar.', parameters: { type: 'OBJECT', properties: { url: { type: 'STRING' } }, required: ['url'] } },
    { name: 'maps_search', description: 'Haritada yer arar.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
    { name: 'dial', description: 'Telefon numarasını açar.', parameters: { type: 'OBJECT', properties: { number: { type: 'STRING' } }, required: ['number'] } },
    { name: 'set_alarm', description: 'Alarm kurar.', parameters: { type: 'OBJECT', properties: { hour: { type: 'INTEGER', description: '0-23' }, minute: { type: 'INTEGER', description: '0-59' }, label: { type: 'STRING' } }, required: ['hour'] } },
    { name: 'set_timer', description: 'Zamanlayıcı kurar.', parameters: { type: 'OBJECT', properties: { seconds: { type: 'INTEGER' }, label: { type: 'STRING' } }, required: ['seconds'] } },
  ],
}];
const ROUTER_SYSTEM = [
  'Sen bir telefon komutu yönlendiricisisin.',
  'Kullanıcının SON mesajı telefonu kontrol eden açık bir komutsa uygun fonksiyonu çağır. Birden fazla komut varsa hepsini çağır.',
  'Komut değilse hiçbir fonksiyon çağırma ve yalnızca KOMUT_YOK yaz.',
].join('\n');

function runAction(name, args) {
  try { return JSON.parse(A.runAction(name, JSON.stringify(args || {}))); }
  catch { return { ok: false, message: 'Komut çalıştırılamadı.' }; }
}

async function chat(b) {
  const text = String(b.message || '').trim().slice(0, 4000);
  if (!text) throw E('Mesaj boş.');
  const s = getS();
  const convs = rd('kb_convs', []);
  let conv = b.conversationId ? convs.find((c) => c.id === Number(b.conversationId)) : null;
  if (b.conversationId && !conv) throw E('Sohbet bulunamadı.', 404);
  const msgs = conv ? rd('kb_m_' + conv.id, []) : [];
  const contents = msgs.slice(-19).concat([{ role: 'user', content: text }])
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
  while (contents.length && contents[0].role === 'model') contents.shift();

  let reply = '', sources = [];
  if (A && looksLikeCommand(text)) {
    const r = await gemini(s, { system: ROUTER_SYSTEM, contents: contents.slice(-6), tools: TOOLS }).catch(() => null);
    if (r && r.calls.length) {
      const results = r.calls.slice(0, 4).map((c) => runAction(c.name, c.args || {}));
      reply = results.map((x) => x.message).join(' ');
    }
  }
  if (!reply) {
    const system = await buildSystem(s, !!b.voice);
    ({ text: reply, sources } = await gemini(s, { system, contents, search: true }));
  }

  const t = Date.now();
  if (!conv) {
    conv = { id: nextId('conv'), title: text.replace(/\s+/g, ' ').slice(0, 48), created_at: t, updated_at: t };
    convs.push(conv);
  }
  msgs.push({ role: 'user', content: text, sources: [], actions: [], created_at: t });
  msgs.push({ role: 'assistant', content: reply, sources, actions: [], created_at: Date.now() });
  conv.updated_at = Date.now();
  wr('kb_m_' + conv.id, msgs);
  wr('kb_convs', convs);
  return { conversationId: conv.id, title: conv.title, reply, sources, actions: [] };
}

async function checkNote(n) {
  const s = getS();
  const prompt = [
    'Kullanıcının takip ettiği not:', `Başlık: ${n.title || '(yok)'}`, `Açıklama: ${n.body || '(yok)'}`, '',
    `Önceki kontrol sonucu: ${n.last_status || 'yok (ilk kontrol)'}`, '',
    'Google Arama ile bu konunun GÜNCEL durumunu araştır. Türkçe yaz.',
    'İlk kontrolse mevcut durumu en fazla 3 cümleyle özetle.',
    'İlk kontrol değilse ve önceki sonuca göre anlamlı yeni bir gelişme yoksa yalnızca şunu yaz: DEĞİŞİKLİK YOK',
    'Yeni gelişme varsa en fazla 3 cümleyle özetle.',
  ].join('\n');
  const { text } = await gemini(s, {
    system: 'Sen titiz bir durum takip asistanısın. Yalnızca Türkçe, kısa ve doğrulanabilir bilgi ver.',
    contents: [{ role: 'user', parts: [{ text: prompt }] }], search: true,
  });
  const notes = rd('kb_notes', []);
  const cur = notes.find((x) => x.id === n.id);
  const now = Date.now();
  const same = text.trim().toLocaleUpperCase('tr-TR').startsWith('DEĞİŞİKLİK YOK');
  if (cur) { cur.last_check = now; if (!same) cur.last_status = text; wr('kb_notes', notes); sync(); }
  return { changed: !same, text: same ? n.last_status : text, last_check: now };
}

async function tts(text) {
  const s = getS();
  if (!s.gemini_key) throw E('Gemini anahtarı yok.');
  const r = await nativeFetch(`${GEMINI}/${TTS_MODEL}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.gemini_key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: String(text).slice(0, 1500) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice_name || 'Kore' } } } },
    }),
  });
  if (r.status < 200 || r.status >= 300) throw E('Ses üretilemedi.', 502);
  let j; try { j = JSON.parse(r.body); } catch { throw E('Ses üretilemedi.', 502); }
  const part = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).find((p) => p.inlineData && p.inlineData.data);
  if (!part) throw E('Ses üretilemedi.', 502);
  return 'data:audio/wav;base64,' + pcmToWavB64(part.inlineData.data, 24000);
}
function pcmToWavB64(pcmB64, rate) {
  const pcm = atob(pcmB64);
  const h = new ArrayBuffer(44), v = new DataView(h);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  const hb = new Uint8Array(h);
  let hs = '';
  for (let i = 0; i < hb.length; i++) hs += String.fromCharCode(hb[i]);
  return btoa(hs + pcm);
}

const timeOk = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));

async function updateSettings(b) {
  const s = getS();
  if ('display_name' in b) s.display_name = String(b.display_name).trim().slice(0, 40);
  if ('theme' in b) { if (!['dark', 'light'].includes(b.theme)) throw E('Geçersiz tema.'); s.theme = b.theme; }
  for (const k of ['daily_enabled', 'weather_enabled', 'watch_enabled']) if (k in b) s[k] = !!b[k];
  for (const k of ['daily_time', 'quiet_start', 'quiet_end']) if (k in b) { if (!timeOk(b[k])) throw E('Saat biçimi geçersiz.'); s[k] = b[k]; }
  if ('watch_hours' in b) { const h = Number(b.watch_hours); if (![1, 3, 6, 12, 24].includes(h)) throw E('Geçersiz sıklık.'); s.watch_hours = h; }
  if ('voice_name' in b) { if (!VOICES.includes(b.voice_name)) throw E('Geçersiz ses.'); s.voice_name = b.voice_name; }
  if ('timezone' in b) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); s.timezone = b.timezone; } catch { throw E('Geçersiz saat dilimi.'); } }
  if ('gemini_key' in b) {
    const k = String(b.gemini_key).trim();
    if (k && !/^[A-Za-z0-9_-]{20,120}$/.test(k)) throw E('Bu bir Gemini anahtarına benzemiyor. Boşluk olmadan, tamamını yapıştır.');
    s.gemini_key = k;
  }
  if ('city' in b) {
    const city = String(b.city).trim().slice(0, 80);
    if (!city) { s.city = ''; s.lat = null; s.lon = null; }
    else if (city !== s.city) {
      const g = await geocode(city);
      if (!g) throw E('Bu şehri bulamadım. Şehir adını ve internet bağlantını kontrol et.');
      s.city = city; s.lat = g.latitude; s.lon = g.longitude;
    }
  }
  putS(s);
  return { settings: pubS(s) };
}

const readNote = (b) => ({
  title: String(b.title || '').trim().slice(0, 120), body: String(b.body || '').trim().slice(0, 4000),
  daily: !!b.daily, watch: !!b.watch,
});

async function request(path, method = 'GET', body = null) {
  const p = String(path).split('?')[0];
  const b = body || {};
  let m;

  if (p === '/status') { const first = !acct(); return { firstRun: first, canRegister: first, needsInvite: false }; }
  if (p === '/register' && method === 'POST') return register(b);
  if (p === '/login' && method === 'POST') return login(b);
  if (p === '/logout') { unlocked = false; return { ok: true }; }
  if (!unlocked) throw E('Uygulama kilitli.', 401);

  if (p === '/me') return mePayload();
  if (p === '/settings' && method === 'PUT') return updateSettings(b);

  if (p === '/password' && method === 'POST') {
    const a = acct();
    if (hashPw(b.current, a.salt) !== a.hash) throw E('Mevcut parola hatalı.', 401);
    if (String(b.next || '').length < 8) throw E('Yeni parola en az 8 karakter olmalı.');
    const salt = randSalt();
    wr('kb_account', { ...a, salt, hash: hashPw(b.next, salt) });
    return { ok: true };
  }
  if (p === '/account/delete' && method === 'POST') {
    const a = acct();
    if (hashPw(b.password, a.salt) !== a.hash) throw E('Parola hatalı.', 401);
    LS.clear();
    if (A) A.wipe();
    unlocked = false;
    return { ok: true };
  }

  if (p === '/notes' && method === 'GET') return { notes: rd('kb_notes', []).slice().sort((x, y) => y.updated_at - x.updated_at) };
  if (p === '/notes' && method === 'POST') {
    const n = readNote(b);
    if (!n.title && !n.body) throw E('Not boş olamaz.');
    const notes = rd('kb_notes', []);
    if (notes.length >= 200) throw E('En fazla 200 not saklayabilirsin.');
    if (n.watch && notes.filter((x) => x.watch).length >= 10) throw E('En fazla 10 notu takip edebilirsin.');
    const t = Date.now();
    notes.push({ id: nextId('note'), ...n, last_check: 0, last_status: '', created_at: t, updated_at: t });
    wr('kb_notes', notes); sync();
    return { ok: true };
  }
  if ((m = p.match(/^\/notes\/(\d+)$/))) {
    const id = Number(m[1]);
    const notes = rd('kb_notes', []);
    const i = notes.findIndex((x) => x.id === id);
    if (i < 0) throw E('Not bulunamadı.', 404);
    if (method === 'DELETE') { notes.splice(i, 1); wr('kb_notes', notes); sync(); return { ok: true }; }
    if (method === 'PUT') {
      const n = readNote(b);
      if (!n.title && !n.body) throw E('Not boş olamaz.');
      const old = notes[i];
      if (n.watch && !old.watch && notes.filter((x) => x.watch).length >= 10) throw E('En fazla 10 notu takip edebilirsin.');
      const reset = old.title !== n.title || old.body !== n.body || (!old.watch && n.watch);
      notes[i] = { ...old, ...n, updated_at: Date.now(), ...(reset ? { last_status: '', last_check: 0 } : {}) };
      wr('kb_notes', notes); sync();
      return { ok: true };
    }
  }
  if ((m = p.match(/^\/notes\/(\d+)\/check$/)) && method === 'POST') {
    const n = rd('kb_notes', []).find((x) => x.id === Number(m[1]));
    if (!n) throw E('Not bulunamadı.', 404);
    return checkNote(n);
  }

  if (p === '/conversations' && method === 'GET') {
    return { conversations: rd('kb_convs', []).slice().sort((x, y) => y.updated_at - x.updated_at).slice(0, 200).map(({ id, title, updated_at }) => ({ id, title, updated_at })) };
  }
  if (p === '/conversations' && method === 'DELETE') {
    for (const c of rd('kb_convs', [])) LS.removeItem('kb_m_' + c.id);
    wr('kb_convs', []);
    return { ok: true };
  }
  if ((m = p.match(/^\/conversations\/(\d+)$/))) {
    const id = Number(m[1]);
    const convs = rd('kb_convs', []);
    const c = convs.find((x) => x.id === id);
    if (!c) throw E('Sohbet bulunamadı.', 404);
    if (method === 'DELETE') { LS.removeItem('kb_m_' + id); wr('kb_convs', convs.filter((x) => x.id !== id)); return { ok: true }; }
    return { conversation: { id: c.id, title: c.title }, messages: rd('kb_m_' + id, []) };
  }
  if (p === '/chat' && method === 'POST') return chat(b);

  if (p === '/weather') {
    const s = getS();
    if (!s.weather_enabled || s.lat == null) return { enabled: false };
    try { return { enabled: true, city: s.city, text: weatherText(await getWeather(s.lat, s.lon)) }; } catch { return { enabled: false }; }
  }

  if (p === '/inbox' && method === 'GET') {
    applyQueue();
    const items = rd('kb_inbox', []);
    return { items: items.slice(0, 100), unread: items.filter((i) => !i.read).length };
  }
  if (p === '/inbox/read' && method === 'POST') { wr('kb_inbox', rd('kb_inbox', []).map((i) => ({ ...i, read: true }))); return { ok: true }; }
  if (p === '/inbox' && method === 'DELETE') { wr('kb_inbox', []); return { ok: true }; }

  throw E('Bulunamadı.', 404);
}

window.backend = { request, tts, applyQueue, lock() { unlocked = false; }, isUnlocked: () => unlocked };
})();
