(() => {
'use strict';

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  me: null, settings: null, vapid: '', gemini: true,
  conv: null, convs: [], notes: [], inbox: [], unread: 0,
  busy: false, weatherText: '', weatherCity: '', view: 'chat', canRegister: false, firstRun: false, registerMode: false,
};

async function api(path, opts = {}) {
  try {
    return await backend.request(path, opts.method || 'GET', opts.body || null);
  } catch (e) {
    if (e && e.code === 401 && !opts.noAuthRedirect) {
      showLogin();
      throw new Error('Uygulama kilitlendi. Parolanı gir.');
    }
    throw e;
  }
}

/* Tarayıcının confirm/prompt'u yerine kendi pencerem */
function ask(text, { input = false, ok = 'Tamam' } = {}) {
  return new Promise((resolve) => {
    const d = $('#askDialog'), i = $('#askInput');
    $('#askText').textContent = text;
    $('#askOk').textContent = ok;
    i.hidden = !input; i.value = '';
    d.returnValue = '';
    d.onclose = () => {
      d.onclose = null;
      resolve(d.returnValue === 'ok' ? (input ? i.value : true) : (input ? '' : false));
    };
    d.showModal();
    if (input) i.focus();
  });
}
$('#askDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2800);
}

function fmtTime(ts) {
  const d = new Date(ts), n = new Date();
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === n.toDateString()) return hm;
  return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) + ' ' + hm;
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  try { if (window.Android) window.Android.setBars(t !== 'light'); } catch { /* yoksay */ }
  $('meta[name="theme-color"]').content = t === 'light' ? '#FBF1DE' : '#1E1411';
}

/* Güvenli, küçük Markdown çevirici (önce kaçış, sonra biçim) */
function md(src) {
  const blocks = [];
  const t = esc(src).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c) => {
    blocks.push(c.replace(/\n$/, ''));
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (s) => s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join('<br>'))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of t.split('\n')) {
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { flushPara(); flushList(); html += line.trim(); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { flushList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') { flushList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^#{1,4}\s+(.*)$/))) { flushPara(); flushList(); html += `<h4>${inline(m[1])}</h4>`; }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre><code>${blocks[i]}</code></pre>`);
}
const stripMd = (s) => String(s).replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/* ------------------------------------------------------------------ */
/* Giriş / Çıkış                                                       */
/* ------------------------------------------------------------------ */
async function showLogin() {
  stopVoice();
  state.me = null;
  $('#shell').hidden = true;
  $('#login').hidden = false;
  try {
    const st = await api('/status', { noAuthRedirect: true });
    state.canRegister = st.canRegister;
    state.firstRun = st.firstRun;
    state.needsInvite = st.needsInvite;
  } catch { /* yoksay */ }
  renderLoginMode();
  setTimeout(() => { try { $('#loginForm').elements[state.firstRun ? 'username' : 'password'].focus(); } catch { /* yoksay */ } }, 150);
}

function renderLoginMode() {
  const reg = state.firstRun;
  state.registerMode = reg;
  const f = $('#loginForm');
  $('#nameField').hidden = !reg;
  f.elements.username.required = reg;
  $('#loginBtn').textContent = reg ? 'Hesabı oluştur' : 'Aç';
  $('#loginLede').textContent = reg
    ? 'İlk açılış: adını ve en az 8 karakterli bir parola yaz. Uygulamayı her açtığında bu parola sorulur.'
    : 'Notların, sohbetlerin ve takip ettiklerin burada seni bekliyor.';
  f.elements.password.autocomplete = reg ? 'new-password' : 'current-password';
  f.elements.password.minLength = reg ? 8 : 0;
  $('#loginError').textContent = '';
}


$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#loginError').textContent = '';
  $('#loginBtn').disabled = true;
  try {
    const me = await api(state.registerMode ? '/register' : '/login', {
      method: 'POST', noAuthRedirect: true,
      body: {
        username: f.get('username'), password: f.get('password'), remember: !!f.get('remember'), invite: f.get('invite') || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
    e.target.reset();
    await enter(me);
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    $('#loginBtn').disabled = false;
  }
});

async function logout() {
  try { await api('/logout', { method: 'POST', noAuthRedirect: true }); } catch { /* yoksay */ }
  showLogin();
}

async function enter(me) {
  state.me = me.user;
  state.settings = me.settings;
  state.gemini = me.geminiConfigured;
  applyTheme(state.settings.theme);
  $('#login').hidden = true;
  $('#shell').hidden = false;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && tz !== state.settings.timezone) {
    api('/settings', { method: 'PUT', body: { timezone: tz } }).then((r) => { state.settings = r.settings; }).catch(() => {});
  }

  state.conv = null;
  renderEmpty();
  const open = window.Android ? window.Android.takeOpen() : '';
  setView(open === 'inbox' ? 'inbox' : 'chat');
  loadConvs(); loadNotes(); loadInbox(); loadWeather();
  if (!state.gemini) { setView('settings'); toast('Başlamak için Gemini anahtarını ekle.'); }
}

/* ------------------------------------------------------------------ */
/* Görünümler                                                          */
/* ------------------------------------------------------------------ */
const TITLES = { chat: 'Kehribar', notes: 'Notlar', inbox: 'Gelenler', settings: 'Ayarlar' };

function setView(v) {
  state.view = v;
  for (const name of Object.keys(TITLES)) $('#view-' + name).hidden = name !== v;
  $$('.tab').forEach((t) => (t.dataset.view === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  $('#topTitle').textContent = TITLES[v];
  $('#shell').classList.toggle('nochat', v !== 'chat');
  if (v === 'settings') renderSettings();
  if (v === 'inbox') { loadInbox(true); }
  if (v === 'notes') loadNotes();
  if (v === 'chat') scrollDown();
}
$$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

/* ------------------------------------------------------------------ */
/* Sohbet                                                              */
/* ------------------------------------------------------------------ */
const box = $('#messages');
const scrollDown = () => { box.scrollTop = box.scrollHeight; };

function msgEl(m) {
  const d = document.createElement('article');
  d.className = 'msg ' + m.role;
  if (m.role === 'user') d.innerHTML = `<p>${esc(m.content).replace(/\n/g, '<br>')}</p>`;
  else {
    const src = (m.sources || []).slice(0, 5)
      .map((s) => `<a href="${esc(s.uri)}" target="_blank" rel="noopener noreferrer">${esc(s.title || 'Kaynak')}</a>`).join('');
    const android = /android/i.test(navigator.userAgent);
    const acts = (m.actions || []).slice(0, 3).map((a) => {
      const href = android && a.intent && String(a.intent).startsWith('intent:') ? a.intent : a.web;
      if (!/^(https?:|tel:)/.test(String(href)) && !String(href).startsWith('intent:')) return '';
      const ext = /^https?:/.test(href);
      return `<a class="action" href="${esc(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(a.label)}</a>`;
    }).join('');
    d.innerHTML = `<div class="prose">${md(m.content)}</div>${acts ? `<div class="actions">${acts}</div>` : ''}${src ? `<div class="sources">${src}</div>` : ''}`;
  }
  return d;
}

const greetWord = () => {
  const h = new Date().getHours();
  return h < 5 ? 'İyi geceler' : h < 12 ? 'Günaydın' : h < 18 ? 'İyi günler' : 'İyi akşamlar';
};

function renderEmpty() {
  const name = state.settings && state.settings.display_name;
  const dateStr = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  const daily = state.notes.filter((n) => n.daily).slice(0, 3);
  const watched = state.notes.filter((n) => n.watch && n.last_status).slice(0, 1);
  box.innerHTML = `
    <div class="home">
      <div class="sun" aria-hidden="true"></div>
      <p class="home-date">${esc(dateStr)}</p>
      <h3 class="home-hello">${greetWord()}${name ? ',<br>' + esc(name) : ''}</h3>
      ${state.weatherText ? `<div class="home-card weather"><span class="home-card-label">${esc(state.weatherCity || 'Hava')}</span><p>${esc(state.weatherText)}</p></div>` : ''}
      ${daily.length ? `<div class="home-card"><span class="home-card-label">Bugün için</span><ul class="home-list">${daily.map((n) => `<li>${esc(n.title || (n.body || '').slice(0, 60))}</li>`).join('')}</ul></div>` : ''}
      ${watched.length ? `<div class="home-card"><span class="home-card-label">Takipte</span><p><strong>${esc(watched[0].title || 'Not')}</strong><br>${esc(watched[0].last_status.slice(0, 140))}</p></div>` : ''}
      ${state.unread ? `<button class="home-card link" data-go="inbox"><span class="home-card-label">Gelenler</span><p>${state.unread} yeni mesajın var</p></button>` : ''}
      <p class="home-ask">Ne yapalım?</p>
      <div class="chips">
        <button class="chip" data-q="Bugün için notlarımı özetle">Notlarımı özetle</button>
        <button class="chip" data-q="Bugün öne çıkan haberler neler?">Bugünün haberleri</button>
        <button class="chip" data-q="Sesi yüzde 70 yap">Sesi %70 yap</button>
        <button class="chip" data-q="Feneri aç">Feneri aç</button>
        <button class="chip" data-q="Yakındaki eczaneleri haritada göster">Yakındaki eczaneler</button>
        <button class="chip" data-q="Bugün hava nasıl olacak, ne giymeliyim?">Ne giymeliyim?</button>
      </div>
    </div>`;
}
function refreshHome() { if ($('.home', box) && !state.busy) renderEmpty(); }
box.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) return setView(g.dataset.go);
  const c = e.target.closest('.chip');
  if (c) sendMessage(c.dataset.q);
});

function setSending(on) { $('#sendBtn').disabled = on; }

async function sendMessage(text, { voice = false } = {}) {
  text = String(text || '').trim();
  if (state.busy || !text) return null;
  state.busy = true;
  setSending(true);
  $('.empty', box)?.remove();
  box.append(msgEl({ role: 'user', content: text }));
  const typing = document.createElement('div');
  typing.className = 'typing';
  typing.innerHTML = '<i></i><i></i><i></i>';
  box.append(typing);
  scrollDown();
  try {
    const r = await api('/chat', { method: 'POST', body: { conversationId: state.conv, message: text, voice } });
    typing.remove();
    state.conv = r.conversationId;
    box.append(msgEl({ role: 'assistant', content: r.reply, sources: r.sources, actions: r.actions }));
    scrollDown();
    loadConvs();
    return r;
  } catch (e) {
    typing.remove();
    const d = document.createElement('p');
    d.className = 'msg err';
    d.textContent = e.message + ' Mesajı tekrar gönderebilirsin.';
    box.append(d);
    scrollDown();
    return null;
  } finally {
    state.busy = false;
    setSending(false);
  }
}

const input = $('#input');
const autoGrow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; };
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = input.value;
  input.value = '';
  autoGrow();
  sendMessage(t);
});

function newChat() {
  state.conv = null;
  renderEmpty();
  closeDrawer();
  setView('chat');
}
$('#newChat').addEventListener('click', newChat);

/* ---- Sohbet geçmişi ---- */
async function loadConvs() {
  try { state.convs = (await api('/conversations')).conversations; renderConvs(); } catch { /* yoksay */ }
}
function renderConvs() {
  const el = $('#convList');
  if (!state.convs.length) { el.innerHTML = '<li class="empty-list" style="padding:20px">Henüz sohbet yok.</li>'; return; }
  el.innerHTML = state.convs.map((c) => `
    <li>
      <button class="conv-open ${c.id === state.conv ? 'current' : ''}" data-open="${c.id}">
        <span class="conv-title">${esc(c.title || 'Sohbet')}</span>
        <span class="conv-date">${fmtTime(c.updated_at)}</span>
      </button>
      <button class="conv-del" data-del="${c.id}" aria-label="Sohbeti sil">
        <svg viewBox="0 0 24 24" width="20" height="20" class="ic"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>
      </button>
    </li>`).join('');
}
$('#convList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  const del = e.target.closest('[data-del]');
  try {
    if (open) {
      const r = await api('/conversations/' + open.dataset.open);
      state.conv = Number(open.dataset.open);
      box.innerHTML = '';
      r.messages.forEach((m) => box.append(msgEl(m)));
      closeDrawer(); setView('chat'); scrollDown();
    } else if (del) {
      if (!(await ask('Bu sohbet kalıcı olarak silinsin mi?', { ok: 'Sil' }))) return;
      await api('/conversations/' + del.dataset.del, { method: 'DELETE' });
      if (state.conv === Number(del.dataset.del)) newChat();
      await loadConvs();
      toast('Sohbet silindi.');
    }
  } catch (err) { toast(err.message); }
});
async function deleteAllConvs() {
  if (!(await ask('Tüm sohbetler kalıcı olarak silinsin mi? Notların silinmez.', { ok: 'Hepsini sil' }))) return;
  try {
    await api('/conversations', { method: 'DELETE' });
    newChat(); await loadConvs();
    toast('Tüm sohbetler silindi.');
  } catch (err) { toast(err.message); }
}
$('#deleteAllConvs').addEventListener('click', deleteAllConvs);

function openDrawer() { $('#drawer').inert = false; $('#drawer').classList.add('open'); $('#scrim').hidden = false; loadConvs(); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').inert = true; $('#scrim').hidden = true; }
$('#openDrawer').addEventListener('click', openDrawer);
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);

/* ---- Hava ---- */
async function loadWeather() {
  try {
    const w = await api('/weather');
    state.weatherText = w.enabled ? w.text : '';
    state.weatherCity = w.enabled ? w.city : '';
  } catch { state.weatherText = ''; }
  refreshHome();
}

/* ------------------------------------------------------------------ */
/* Sesli konuşma (tarayıcı dinler → Gemini yanıtlar → Gemini konuşur)  */
/* ------------------------------------------------------------------ */
const voice = { on: false, endSpeak: null, silent: 0 };

function setVoiceState(st, text) {
  $('#voice').dataset.state = st;
  $('#voiceStatus').textContent = { listening: 'Dinliyorum', thinking: 'Düşünüyorum', speaking: 'Konuşuyorum', idle: 'Dokun ve konuş' }[st];
  if (text !== undefined) $('#voiceText').textContent = text;
}

function startVoice() {
  if (!window.Android) return;
  setView('chat');
  voice.on = true; voice.silent = 0;
  $('#voice').hidden = false;
  document.body.classList.add('lock');
  listen();
}

function stopVoice() {
  voice.on = false;
  try { if (window.Android) { window.Android.stopListening(); window.Android.stopSpeak(); } } catch { /* yoksay */ }
  if (voice.endSpeak) voice.endSpeak();
  $('#voice').hidden = true;
  document.body.classList.remove('lock');
}

function listen() {
  if (!voice.on) return;
  setVoiceState('listening', '');
  window.Android.startListening();
}

async function handleSpeech(text) {
  const said = String(text || '').trim();
  if (!said) return onSilence();
  voice.silent = 0;
  setVoiceState('thinking', said);
  const r = await sendMessage(said, { voice: true });
  if (!voice.on) return;
  if (!r) { setVoiceState('idle', 'Bir hata oldu. Tekrar denemek için küreye dokun.'); return; }
  setVoiceState('speaking', r.reply);
  await speak(r.reply);
  if (voice.on) listen();
}

function onSilence() {
  if (++voice.silent >= 3) { setVoiceState('idle', 'Sessizlik oldu. Devam etmek için küreye dokun.'); return; }
  listen();
}

// Android'den gelen konuşma tanıma olayları
window.__stt = (type, text) => {
  if (!voice.on) return;
  if (type === 'partial') setVoiceState('listening', text);
  else if (type === 'final') handleSpeech(text);
  else if (type === 'silence') onSilence();
  else if (type === 'denied') { toast('Mikrofon izni gerekli. İzin verip küreye dokun.'); setVoiceState('idle', 'Mikrofon izninden sonra küreye dokun.'); }
  else setVoiceState('idle', 'Ses tanıma çalışmadı. Küreye dokunup tekrar dene.');
};
window.__ttsDone = () => { if (voice.ttsDone) voice.ttsDone(); };

async function speak(text) {
  const clean = stripMd(text);
  try {
    const url = await backend.tts(clean);
    await new Promise((resolve) => {
      const a = new Audio(url);
      const done = () => { voice.endSpeak = null; resolve(); };
      voice.endSpeak = () => { a.pause(); done(); };
      a.onended = done; a.onerror = done;
      a.play().catch(done);
    });
  } catch {
    // Gemini sesi alınamazsa telefonun kendi Türkçe sesi
    await new Promise((resolve) => {
      const done = () => { voice.ttsDone = null; voice.endSpeak = null; resolve(); };
      voice.ttsDone = done;
      voice.endSpeak = () => { window.Android.stopSpeak(); done(); };
      window.Android.speak(clean);
    });
  }
}

$('#voiceBtn').addEventListener('click', startVoice);
$('#voiceClose').addEventListener('click', stopVoice);
$('#voiceOrb').addEventListener('click', () => {
  const st = $('#voice').dataset.state;
  if (st === 'speaking' && voice.endSpeak) voice.endSpeak();      // lafı kes
  else if (st === 'idle') { voice.silent = 0; listen(); }
});

/* ------------------------------------------------------------------ */
/* Notlar                                                              */
/* ------------------------------------------------------------------ */
let editing = null;

async function loadNotes() {
  try { state.notes = (await api('/notes')).notes; renderNotes(); refreshHome(); } catch { /* yoksay */ }
}
function renderNotes() {
  const el = $('#notesList');
  if (!state.notes.length) { el.innerHTML = '<li class="empty-list">Henüz not yok. İlk notunu yaz; istersen her sabah hatırlatayım.</li>'; return; }
  el.innerHTML = state.notes.map((n) => `
    <li>
      <button class="note-row" data-id="${n.id}">
        <span class="note-title">${esc(n.title || 'Başlıksız not')}</span>
        ${n.body ? `<span class="note-body">${esc(n.body)}</span>` : ''}
        ${(n.daily || n.watch) ? `<span class="note-tags">${n.daily ? '<i>Her gün hatırlatılır</i>' : ''}${n.watch ? '<i>Takipte</i>' : ''}</span>` : ''}
        ${n.watch && n.last_status ? `<span class="note-status">${esc(n.last_status.slice(0, 180))}${n.last_status.length > 180 ? '…' : ''}</span>` : ''}
      </button>
    </li>`).join('');
}
$('#notesList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]');
  if (b) openNote(Number(b.dataset.id));
});
$('#newNote').addEventListener('click', () => openNote(null));

function showNoteStatus() {
  const s = $('#noteStatus');
  if (editing && editing.watch && editing.last_status) {
    s.hidden = false;
    s.innerHTML = `${esc(editing.last_status)}<small>Son kontrol: ${editing.last_check ? fmtTime(editing.last_check) : '—'}</small>`;
  } else { s.hidden = true; s.textContent = ''; }
}

function openNote(id) {
  editing = id ? state.notes.find((n) => n.id === id) : null;
  const n = editing || { title: '', body: '', daily: false, watch: false };
  const el = $('#noteForm').elements;
  el.ntitle.value = n.title; el.nbody.value = n.body;
  el.ndaily.checked = !!n.daily; el.nwatch.checked = !!n.watch;
  $('#noteDialogTitle').textContent = editing ? 'Notu düzenle' : 'Yeni not';
  $('#noteDelete').hidden = !editing;
  $('#noteCheck').hidden = !editing;
  showNoteStatus();
  $('#noteDialog').showModal();
}

$('#noteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = e.target.elements;
  const body = { title: el.ntitle.value.trim(), body: el.nbody.value.trim(), daily: el.ndaily.checked, watch: el.nwatch.checked };
  if (!body.title && !body.body) return toast('Önce bir şeyler yaz.');
  try {
    if (editing) await api('/notes/' + editing.id, { method: 'PUT', body });
    else await api('/notes', { method: 'POST', body });
    $('#noteDialog').close();
    await loadNotes();
    toast('Not kaydedildi.');
  } catch (err) { toast(err.message); }
});

$('#noteDelete').addEventListener('click', async () => {
  if (!editing || !(await ask('Bu not silinsin mi?', { ok: 'Sil' }))) return;
  try {
    await api('/notes/' + editing.id, { method: 'DELETE' });
    $('#noteDialog').close();
    await loadNotes();
    toast('Not silindi.');
  } catch (err) { toast(err.message); }
});

$('#noteCheck').addEventListener('click', async () => {
  if (!editing) return;
  const b = $('#noteCheck');
  b.disabled = true; b.textContent = 'Kontrol ediliyor…';
  try {
    const r = await api('/notes/' + editing.id + '/check', { method: 'POST' });
    editing.watch = true; editing.last_status = r.text || editing.last_status; editing.last_check = r.last_check;
    $('#noteForm').elements.nwatch.checked = true;
    showNoteStatus();
    toast(r.changed ? 'Yeni bilgi bulundu.' : 'Değişiklik yok.');
    loadNotes();
  } catch (err) { toast(err.message); }
  finally { b.disabled = false; b.textContent = 'Şimdi kontrol et'; }
});

$('#noteCancel').addEventListener('click', () => $('#noteDialog').close());
$('#noteDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

/* ------------------------------------------------------------------ */
/* Gelenler                                                            */
/* ------------------------------------------------------------------ */
function setBadge(n) {
  state.unread = n;
  const b = $('#inboxBadge');
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : n;
  try { n ? navigator.setAppBadge && navigator.setAppBadge(n) : navigator.clearAppBadge && navigator.clearAppBadge(); } catch { /* yoksay */ }
}

async function loadInbox(markRead = false) {
  try {
    const r = await api('/inbox');
    state.inbox = r.items;
    setBadge(r.unread);
    renderInbox();
    refreshHome();
    if (markRead && r.unread) {
      await api('/inbox/read', { method: 'POST' });
      setBadge(0);
    }
  } catch { /* yoksay */ }
}
function renderInbox() {
  const el = $('#inboxList');
  if (!state.inbox.length) { el.innerHTML = '<li class="empty-list">Henüz mesaj yok. Günlük özet ve takip sonuçları burada görünür.</li>'; return; }
  const kind = { daily: 'Günlük özet', watch: 'Takip' };
  el.innerHTML = state.inbox.map((i) => `
    <li class="inbox-item ${i.read ? '' : 'unread'}">
      <div class="inbox-title">${esc(i.title)}</div>
      <div class="inbox-meta">${kind[i.kind] || 'Mesaj'} · ${fmtTime(i.created_at)}</div>
      <div class="inbox-body">${esc(i.body)}</div>
    </li>`).join('');
}
$('#clearInbox').addEventListener('click', async () => {
  if (!(await ask('Gelen kutusu temizlensin mi?', { ok: 'Temizle' }))) return;
  try { await api('/inbox', { method: 'DELETE' }); await loadInbox(); toast('Gelenler temizlendi.'); } catch (err) { toast(err.message); }
});

/* ------------------------------------------------------------------ */
/* Ayarlar                                                             */
/* ------------------------------------------------------------------ */
const VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Orus'];
const sw = (k, label, on) => `<label class="row"><span>${label}</span><input type="checkbox" role="switch" class="switch" data-k="${k}" ${on ? 'checked' : ''}></label>`;

function renderSettings() {
  const s = state.settings;
  $('#settingsBody').innerHTML = `
    <h2>Yapay zekâ</h2>
    <label class="field">Gemini API anahtarı
      <input type="password" data-k="gemini_key" value="" placeholder="${s.has_key ? 'Kayıtlı ' + esc(s.key_hint) + ' (değiştirmek için yaz)' : 'AIza… anahtarını yapıştır'}" autocomplete="off" autocapitalize="none" spellcheck="false">
    </label>
    <p class="hint">Ücretsiz anahtarı tarayıcıdan aistudio.google.com/apikey adresinden alabilirsin. Anahtar yalnızca bu telefonda saklanır.</p>

    <h2>Profil</h2>
    <label class="field">Adın<input data-k="display_name" value="${esc(s.display_name)}" maxlength="40" autocomplete="given-name"></label>
    <label class="field">Şehir (hava durumu için)<input data-k="city" value="${esc(s.city)}" maxlength="80" placeholder="Örn. İzmir"></label>
    <p class="hint">Saat dilimi: ${esc(s.timezone)}</p>

    <h2>Görünüm</h2>
    <div class="seg" role="group" aria-label="Tema">
      <button data-theme-set="dark" aria-pressed="${s.theme === 'dark'}">Gece</button>
      <button data-theme-set="light" aria-pressed="${s.theme === 'light'}">Gün</button>
    </div>

    <h2>Günlük özet</h2>
    ${sw('daily_enabled', 'Her gün özet gönder', s.daily_enabled)}
    <label class="row"><span>Saat</span><input type="time" data-k="daily_time" value="${esc(s.daily_time)}"></label>
    ${sw('weather_enabled', 'Özete hava durumunu ekle', s.weather_enabled)}

    <h2>Takip</h2>
    ${sw('watch_enabled', 'Takipteki notları kendiliğinden kontrol et', s.watch_enabled)}
    <label class="row"><span>Kontrol sıklığı</span>
      <select data-k="watch_hours" data-num>
        ${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${s.watch_hours === h ? 'selected' : ''}>${h} saatte bir</option>`).join('')}
      </select>
    </label>
    <div class="row"><span>Sessiz saatler</span>
      <span class="times">
        <input type="time" data-k="quiet_start" value="${esc(s.quiet_start)}" aria-label="Başlangıç">
        <input type="time" data-k="quiet_end" value="${esc(s.quiet_end)}" aria-label="Bitiş">
      </span>
    </div>
    <p class="hint">Sessiz saatlerde takip kontrolü yapılmaz. Günlük özet seçtiğin saatte gelir.</p>

    <h2>Bildirimler ve arka plan</h2>
    <p class="hint">Günlük özet ve takip kontrolleri, Android'in izin verdiği ölçüde arka planda yaklaşık 15 dakikada bir çalışır. Telefonun pil tasarrufu uygulamayı kısıtlarsa gecikebilir.</p>
    <div class="btns">
      <button class="btn" id="notifPerm">Bildirim izni</button>
      <button class="btn" id="batteryOpt">Pil kısıtlamasını kaldır</button>
    </div>

    <h2>Ses</h2>
    <label class="row"><span>Kehribar'ın sesi</span>
      <select data-k="voice_name">${VOICES.map((v) => `<option ${s.voice_name === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </label>

    <h2>Telefon komutları</h2>
    <p class="hint">Yaz ya da söyle: "Sesi %70 yap", "WhatsApp'ı aç", "Feneri yak", "Parlaklığı %40 yap", "Rahatsız Etme'yi aç", "Sabah 7.30'a alarm kur". Bazı komutlar ilk seferde Android'in izin ekranını açar; izin verip komutu tekrar söyle.</p>

    <h2>Hesap</h2>
    <form id="pwForm">
      <label class="field">Mevcut parola<input name="current" type="password" autocomplete="current-password" required></label>
      <label class="field">Yeni parola (en az 8 karakter)<input name="next" type="password" autocomplete="new-password" minlength="8" required></label>
      <div class="btns"><button class="btn" type="submit">Parolayı değiştir</button></div>
    </form>
    <div class="btns"><button class="btn" id="logoutBtn">Uygulamayı kilitle</button></div>

    <h2>Veri</h2>
    <div class="btns">
      <button class="btn danger-quiet" id="wipeConvs">Tüm sohbetleri sil</button>
      <button class="btn danger-quiet" id="deleteAccount">Hesabımı ve tüm verilerimi sil</button>
    </div>
    <p class="hint">Hesap: ${esc(state.me.username)}. Veriler yalnızca bu telefonda durur.</p>`;
}

const sb = $('#settingsBody');

sb.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-k]');
  if (!el) return;
  const k = el.dataset.k;
  const v = el.type === 'checkbox' ? el.checked : el.hasAttribute('data-num') ? Number(el.value) : el.value;
  if (k === 'gemini_key' && !String(v).trim()) return;
  try {
    const r = await api('/settings', { method: 'PUT', body: { [k]: v } });
    state.settings = r.settings;
    toast('Kaydedildi.');
    if (k === 'gemini_key') { state.gemini = true; renderSettings(); }
    if (k === 'city' || k === 'weather_enabled') loadWeather();
    if (k === 'display_name') refreshHome();
  } catch (err) {
    toast(err.message);
    renderSettings();
  }
});

sb.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-theme-set]');
  if (t) {
    try {
      const r = await api('/settings', { method: 'PUT', body: { theme: t.dataset.themeSet } });
      state.settings = r.settings; applyTheme(r.settings.theme); renderSettings();
    } catch (err) { toast(err.message); }
    return;
  }
  const id = e.target.id;
  if (id === 'notifPerm') window.Android.requestNotifPermission();
  else if (id === 'batteryOpt') window.Android.openBatterySettings();
  else if (id === 'logoutBtn') logout();
  else if (id === 'wipeConvs') deleteAllConvs();
  else if (id === 'deleteAccount') {
    if (!(await ask('Hesabın, notların ve tüm sohbetlerin bu telefondan kalıcı olarak silinecek. Emin misin?', { ok: 'Devam' }))) return;
    const pw = await ask('Onaylamak için parolanı yaz:', { input: true, ok: 'Hesabı sil' });
    if (!pw) return;
    try {
      await api('/account/delete', { method: 'POST', body: { password: pw } });
      showLogin();
    } catch (err) { toast(err.message); }
  }
});

sb.addEventListener('submit', async (e) => {
  if (e.target.id !== 'pwForm') return;
  e.preventDefault();
  const f = e.target.elements;
  try {
    await api('/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
    e.target.reset();
    toast('Parola değiştirildi.');
  } catch (err) { toast(err.message); }
});

/* ------------------------------------------------------------------ */
/* Android olayları ve başlangıç                                       */
/* ------------------------------------------------------------------ */
let hiddenAt = 0;
const LOCK_AFTER = 5 * 60e3;

window.__pause = () => { hiddenAt = Date.now(); };
window.__resume = () => {
  if (!state.me) return;
  if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER) {   // 5 dakikadan uzun arka plandaysa kilitle
    hiddenAt = 0;
    backend.lock();
    showLogin();
    return;
  }
  hiddenAt = 0;
  const open = window.Android.takeOpen();
  loadInbox(state.view === 'inbox'); loadWeather(); loadNotes();
  if (open === 'inbox') setView('inbox');
};
window.__back = () => {
  if (!$('#voice').hidden) { stopVoice(); return true; }
  const dlg = $$('dialog').find((d) => d.open);
  if (dlg) { dlg.close(); return true; }
  if ($('#drawer').classList.contains('open')) { closeDrawer(); return true; }
  if (state.me && state.view !== 'chat') { setView('chat'); return true; }
  if (state.me && state.conv) { newChat(); return true; }
  return false;
};

(function boot() {
  applyTheme(localStorage.getItem('theme') || 'light');
  if (!window.Android) {
    document.body.innerHTML = '<p style="padding:28px;font:17px system-ui">Kehribar yalnızca Android uygulaması içinde çalışır.</p>';
    return;
  }
  showLogin();
})();
})();
