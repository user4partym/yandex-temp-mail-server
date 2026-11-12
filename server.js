// Temp Mail Inbox — backend server (Render ke liye)
// Providers: Yandex (Man50or1@yandex.com) aur Gmail (mrzacky.tk@gmail.com).
// Har provider ka apna base email + app password hota hai (env vars se, code me
// password kabhi nahi likhna). Har visitor ko alag +tag address milta hai, jaise
// man50or1+uvhxb6@yandex.com ya mrzacky.tk+abc123@gmail.com.
// Sab mail us provider ke inbox me aati hai. Server har mail ke To header se +tag
// nikal kar us tag wale visitor ko dikhata hai. Mail kabhi delete nahi karni,
// sirf read karna hai.
// ADMIN: Admin Login (app password se) + email pool — admin panel se base email
// badlo ya pool me multiple accounts rakho; naya temp mail pool se RANDOM account
// par banta hai (pool khali ho to default base). Pool/data.json Render free par
// restart par kho sakta hai — durable setup env vars se aata hai.

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(cors()); // CORS open — artifact / frontend kahin se bhi call kar sake
app.use(express.json({ limit: '1mb' }));

// Static site (Temp Mail app) — Render se hi serve karo (GitHub Pages band hai):
// public/index.html (site), public/version.json (APK update check), public/*.apk
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Providers ----------
const PROVIDERS = {
  yandex: { host: 'imap.yandex.com', domain: 'yandex.com', spamFallback: 'Spam' },
  gmail: { host: 'imap.gmail.com', domain: 'gmail.com', spamFallback: '[Gmail]/Spam' },
};

function normProvider(p) {
  const v = String(p || 'yandex').trim().toLowerCase();
  return PROVIDERS[v] ? v : 'yandex';
}

// Messages/aliases ko provider ke hisab se alag rakho:
// Yandex purani keys waisi hi (tag), Gmail keys 'gmail:tag' se shuru hoti hain.
function msgKey(provider, tag) {
  return provider === 'gmail' ? `gmail:${tag}` : tag;
}

// ---------- Data (memory + data.json + env vars) ----------
// data.json sirf server ke paas rehta hai. Render free par file ephemeral hai,
// restart par data.json wala setup kho sakta hai — is liye durable setup
// Render ke env vars se aata hai:
//   Yandex: YANDEX_BASE_EMAIL / YANDEX_APP_PASSWORD
//   Gmail:  GMAIL_BASE_EMAIL / GMAIL_APP_PASSWORD
// Password kabhi kisi response me wapas nahi bhejna.
let data = { setup: null, aliases: [], messages: {}, seen: [], pool: [], rotation: {} };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        data.setup = raw.setup || null;
        data.aliases = Array.isArray(raw.aliases) ? raw.aliases : [];
        data.messages = raw.messages && typeof raw.messages === 'object' ? raw.messages : {};
        data.seen = Array.isArray(raw.seen) ? raw.seen : [];
        data.pool = Array.isArray(raw.pool) ? raw.pool : [];
        data.rotation = raw.rotation && typeof raw.rotation === 'object' ? raw.rotation : {};
      }
    }
  } catch (e) {
    console.log('data.json load nahi hua, khaali shuru kar raha hun:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.log('data.json save nahi hua:', e.message);
  }
}

loadData();

// Env vars (Render dashboard me ek dafa set karo — restart par bhi rehte hain,
// code me kabhi password nahi likhna):
const ENV_SETUP = (process.env.YANDEX_BASE_EMAIL && process.env.YANDEX_APP_PASSWORD)
  ? { baseEmail: String(process.env.YANDEX_BASE_EMAIL).trim().toLowerCase(), appPassword: String(process.env.YANDEX_APP_PASSWORD).trim() }
  : null;
const GMAIL_ENV_SETUP = (process.env.GMAIL_BASE_EMAIL && process.env.GMAIL_APP_PASSWORD)
  ? { baseEmail: String(process.env.GMAIL_BASE_EMAIL).trim().toLowerCase(), appPassword: String(process.env.GMAIL_APP_PASSWORD).trim() }
  : null;

function effectiveSetup(provider) {
  const p = normProvider(provider);
  // Admin panel (data.setup) PEHLE — panel se badli hui email foran laagu ho.
  // Env vars sirf fallback hain (pehli setup / panel change na hone par).
  // Pehle env pehle tha, is liye panel "Setup saved ✓" dikhata tha par email
  // badalti nahi thi — yehi bug tha.
  if (p === 'gmail') {
    if (data.setup && data.setup.gmail) return data.setup.gmail;
    if (GMAIL_ENV_SETUP) return GMAIL_ENV_SETUP;
    return null;
  }
  if (data.setup && data.setup.yandex) return data.setup.yandex;
  if (ENV_SETUP) return ENV_SETUP;
  if (data.setup && data.setup.yandex) return data.setup.yandex;
  // Purana single-setup format (sirf Yandex): { baseEmail, appPassword }
  if (data.setup && data.setup.baseEmail && String(data.setup.baseEmail).endsWith('@yandex.com')) return data.setup;
  return null;
}

// Purani / expired aliases aur un ki messages saaf karo (60 minute ke baad)
function pruneExpired() {
  const now = Date.now();
  const before = data.aliases.length;
  data.aliases = data.aliases.filter((a) => new Date(a.expiresAt).getTime() > now);
  if (data.aliases.length !== before) {
    const live = new Set(data.aliases.map((a) => msgKey(a.provider || 'yandex', a.tag)));
    for (const key of Object.keys(data.messages)) {
      if (!live.has(key)) delete data.messages[key];
    }
    saveData();
  }
}
setInterval(pruneExpired, 5 * 60 * 1000);
pruneExpired();

function isConfigured(provider) {
  const s = effectiveSetup(provider);
  return !!(s && s.baseEmail && s.appPassword);
}

// ---------- Admin login + email pool ----------
// Admin login = Yandex ya Gmail ka app password (jo setup me save hai),
// ya Render env ADMIN_PASSWORD (dedicated admin password).
// Login par random token milta hai (sirf server memory me rehta hai;
// restart par logout ho jata hai).
const adminTokens = new Set();
let loginFailCount = 0;
let loginLockUntil = 0;

function hashPw(pw) { return crypto.createHash('sha256').update(String(pw || '')).digest(); }

function adminPasswordMatches(pw) {
  if (!pw) return false;
  const h = hashPw(pw);
  // Dedicated admin password (Render env ADMIN_PASSWORD) — app passwords ke ilawa bhi chalega.
  const adminPw = String(process.env.ADMIN_PASSWORD || '').trim();
  if (adminPw && crypto.timingSafeEqual(h, hashPw(adminPw))) return true;
  for (const p of ['yandex', 'gmail']) {
    const s = effectiveSetup(p);
    if (s && s.appPassword && crypto.timingSafeEqual(h, hashPw(s.appPassword))) return true;
  }
  // Env wale purane app passwords bhi login karwate hain — panel se email/
  // password badalne ke baad bhi lockout na ho (purana password bhi chalega).
  for (const s of [ENV_SETUP, GMAIL_ENV_SETUP]) {
    if (s && s.appPassword && crypto.timingSafeEqual(h, hashPw(s.appPassword))) return true;
  }
  return false;
}

function adminTokenFrom(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function requireAdmin(req, res, next) {
  const token = adminTokenFrom(req);
  if (token && adminTokens.has(token)) return next();
  return res.status(401).json({ error: 'Admin login required — pehle Admin Login karo' });
}

// Setup badalna sirf admin kar sakta hai — jab koi provider configured ho.
// Bilkul pehli setup (kuch configured nahi) khuli rehti hai.
function requireAdminIfConfigured(req, res, next) {
  if (isConfigured('yandex') || isConfigured('gmail')) return requireAdmin(req, res, next);
  return next();
}

// Pool: admin ke diye hue extra accounts (provider + baseEmail + appPassword).
// Naya temp mail pool se RANDOM account par banta hai.
function poolFor(provider) {
  return (data.pool || []).filter((e) => e.provider === normProvider(provider));
}

// ---------- Auto-rotation: ek email par 3 naye temp mail, phir agli email ----------
// Facebook IDs ke liye: ek base email par 3 IDs bante hain, phir list ki agli
// email khud use hone lagti hai. Gin ti POST /api/alias (New Email) par hoti
// hai — restore (purana code dobara kholna) gin ti me nahi aata. State
// data.json me rehti hai (Render restart/deploy par reset ho sakti hai —
// phir pehli email se dobara shuru hoti hai).
const ROTATION_LIMIT = 3;

function rotationState(provider) {
  const p = normProvider(provider);
  if (!data.rotation || typeof data.rotation !== 'object') data.rotation = {};
  if (!data.rotation[p] || typeof data.rotation[p] !== 'object') data.rotation[p] = { index: 0, used: 0 };
  return data.rotation[p];
}

// Admin panel + alias response ke liye: abhi kaun si email chal rahi hai,
// us par kitne ban chuke, list me kitni bachi hain. Password kabhi nahi.
function rotationStatus(provider) {
  const p = normProvider(provider);
  const entries = poolFor(p);
  if (!entries.length) {
    const s = effectiveSetup(p);
    return { active: s ? s.baseEmail : null, used: 0, limit: ROTATION_LIMIT, remaining: 0, total: 0, poolEmpty: true };
  }
  const st = rotationState(p);
  const idx = Math.max(0, Math.min(st.index, entries.length - 1));
  st.index = idx;
  const used = Math.max(0, Math.min(st.used, ROTATION_LIMIT));
  return {
    active: entries[idx].baseEmail,
    used,
    limit: ROTATION_LIMIT,
    remaining: entries.length - 1 - idx,
    total: entries.length,
    poolEmpty: false,
  };
}

function pickAccount(provider) {
  const p = normProvider(provider);
  const entries = poolFor(p);
  if (entries.length) {
    const st = rotationState(p);
    // Index hamesha list ke andar rakho (entry delete hone par clamp).
    if (st.index >= entries.length) { st.index = entries.length - 1; st.used = 0; }
    if (st.index < 0) st.index = 0;
    // 3 poore ho gaye aur agli email hai to rotate karo.
    if (st.used >= ROTATION_LIMIT && st.index < entries.length - 1) {
      st.index += 1;
      st.used = 0;
    }
    const e = entries[st.index];
    st.used += 1; // is email par ek aur naya temp mail ban gaya
    saveData();
    return { baseEmail: e.baseEmail, appPassword: e.appPassword, poolId: e.id };
  }
  const s = effectiveSetup(p);
  return s ? { baseEmail: s.baseEmail, appPassword: s.appPassword, poolId: null } : null;
}

// Sync ke liye account: alias ka snapshot pehle (pool account), phir default setup.
function resolveAccount(provider, tag) {
  const p = normProvider(provider);
  const alias = data.aliases.find((a) => a.tag === String(tag || '').trim().toLowerCase() && (a.provider || 'yandex') === p);
  if (alias && alias.account && alias.account.baseEmail && alias.account.appPassword) {
    return { baseEmail: alias.account.baseEmail, appPassword: alias.account.appPassword, poolId: alias.account.poolId || null };
  }
  const s = effectiveSetup(p);
  return s ? { baseEmail: s.baseEmail, appPassword: s.appPassword, poolId: null } : null;
}

// Alias client ko bhejte waqt account (password) kabhi nahi bhejna.
function publicAlias(a) {
  if (!a) return a;
  return { address: a.address, tag: a.tag, code: a.code, expiresAt: a.expiresAt, createdAt: a.createdAt, provider: a.provider, restored: !!a.restored, poolId: a.poolId || null };
}

function publicSetup() {
  const y = effectiveSetup('yandex');
  const g = effectiveSetup('gmail');
  return {
    configured: !!(y && y.baseEmail && y.appPassword),
    baseEmail: y ? y.baseEmail : null,
    hasAppPassword: !!(y && y.appPassword),
    providers: {
      yandex: { configured: !!(y && y.baseEmail && y.appPassword), baseEmail: y ? y.baseEmail : null, hasAppPassword: !!(y && y.appPassword) },
      gmail: { configured: !!(g && g.baseEmail && g.appPassword), baseEmail: g ? g.baseEmail : null, hasAppPassword: !!(g && g.appPassword) },
    },
  };
}

function randomTag() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let tag = '';
  for (let i = 0; i < 6; i++) tag += chars[Math.floor(Math.random() * chars.length)];
  return tag;
}

function tagFromAddress(address) {
  if (!address) return null;
  const m = String(address).match(/\+([a-z0-9]{6})@/i);
  return m ? m[1].toLowerCase() : null;
}

function extractOtp(text) {
  if (!text) return null;
  // 4-8 digit code, jo lambi number ka hissa na ho
  const m = String(text).match(/(?<![0-9])(\d{4,8})(?![0-9])/);
  return m ? m[1] : null;
}

// ---------- Routes ----------

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'temp-mail-server', setup: publicSetup() });
});

// GET /api/setup -> per-provider status (password kabhi nahi)
app.get('/api/setup', (req, res) => {
  res.json(publicSetup());
});

// POST /api/setup {provider, baseEmail, appPassword} -> save karo (admin only, jab configured ho)
app.post('/api/setup', requireAdminIfConfigured, (req, res) => {
  const provider = normProvider(req.body && req.body.provider);
  const domain = '@' + PROVIDERS[provider].domain;
  const baseEmail = String(req.body && req.body.baseEmail ? req.body.baseEmail : '').trim().toLowerCase();
  const appPassword = String(req.body && req.body.appPassword ? req.body.appPassword : '').trim();
  if (!baseEmail || !baseEmail.includes('@') || !baseEmail.endsWith(domain)) {
    return res.status(400).json({ error: `Sahi ${provider === 'gmail' ? 'Gmail' : 'Yandex'} base email dalo, jaise ${provider === 'gmail' ? 'mrzacky.tk@gmail.com' : 'man50or1@yandex.com'}` });
  }
  if (!appPassword) {
    return res.status(400).json({ error: 'App password dalo — ye login password nahi, App Password hota hai' });
  }
  // Purana single-setup format ho to us ko yandex ke neeche le aao
  if (data.setup && data.setup.baseEmail) {
    data.setup = { yandex: { baseEmail: data.setup.baseEmail, appPassword: data.setup.appPassword } };
  }
  if (!data.setup || typeof data.setup !== 'object') data.setup = {};
  data.setup[provider] = { baseEmail, appPassword };
  saveData();
  res.json({ ...publicSetup(), provider });
});

// POST /api/alias {provider} -> naya random 6-char tag, 60-min expiry.
// Pool me us provider ke accounts hon to RANDOM account par banta hai.
app.post('/api/alias', (req, res) => {
  const provider = normProvider((req.body && req.body.provider) || (req.query && req.query.provider));
  const account = pickAccount(provider);
  if (!account) {
    return res.status(400).json({ error: provider === 'gmail' ? 'Pehle Gmail setup karo (base email + app password)' : 'Pehle Setup me apna Yandex base email dalo' });
  }
  pruneExpired();
  let tag = randomTag();
  const used = new Set(data.aliases.filter((a) => (a.provider || 'yandex') === provider).map((a) => a.tag));
  while (used.has(tag)) tag = randomTag();
  const local = account.baseEmail.split('@')[0];
  const address = `${local}+${tag}@${PROVIDERS[provider].domain}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const alias = { address, tag, code: tag, expiresAt, createdAt: new Date().toISOString(), provider, poolId: account.poolId, account: { baseEmail: account.baseEmail, appPassword: account.appPassword, poolId: account.poolId } };
  data.aliases.push(alias);
  const key = msgKey(provider, tag);
  if (!data.messages[key]) data.messages[key] = [];
  saveData();
  res.json({ ...publicAlias(alias), rotation: rotationStatus(provider) });
});

// GET /api/alias/:code?provider=gmail -> alias dhoondo; na mile to code se dobara banao.
// Render free par restart/deploy ke baad data.json kho jata hai, is liye purana
// code record me na bhi ho to inbox phir bhi khulna chahiye — mail mailbox me
// hoti hai, sync us ko +tag se dobara parh leta hai. Is liye alias dobara bana
// kar save kar do (60 minute ki nayi expiry ke sath).
app.get('/api/alias/:code', (req, res) => {
  pruneExpired();
  const provider = normProvider(req.query && req.query.provider);
  const code = String(req.params.code || '').trim().toLowerCase();
  let alias = data.aliases.find((a) => a.tag === code && (a.provider || 'yandex') === provider);
  if (!alias && /^[a-z0-9]{6}$/.test(code) && isConfigured(provider)) {
    const base = effectiveSetup(provider).baseEmail;
    const local = base.split('@')[0];
    alias = {
      address: `${local}+${code}@${PROVIDERS[provider].domain}`,
      tag: code,
      code,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
      provider,
      restored: true,
      poolId: null,
      account: { baseEmail: effectiveSetup(provider).baseEmail, appPassword: effectiveSetup(provider).appPassword, poolId: null },
    };
    data.aliases.push(alias);
    const key = msgKey(provider, code);
    if (!data.messages[key]) data.messages[key] = [];
    saveData();
  }
  if (!alias) {
    return res.status(404).json({ error: 'Is code par koi address nahi mila' });
  }
  res.json(publicAlias(alias));
});

// Spam folder dhoondo — provider kabhi kabhi mail ko Spam me daal deta hai.
// listMailboxes se Junk wala ya naam se Spam wala folder dhoondo, na mile to fallback try karo.
async function findSpamMailbox(client, fallback) {
  try {
    const boxes = await client.listMailboxes();
    const all = [];
    const walk = (list) => {
      for (const b of list || []) {
        all.push(b);
        if (b.children) walk(b.children);
      }
    };
    walk(boxes);
    const junk = all.find((b) => {
      const name = String(b.name || '').toLowerCase();
      const p = String(b.path || '').toLowerCase();
      const special = (b.specialUse || []).map((s) => String(s).toLowerCase());
      return special.some((s) => s.includes('junk')) || name === 'spam' || p === 'spam' || name.includes('spam');
    });
    if (junk) return junk.path;
  } catch (e) {
    console.log('Mailbox list nahi mili:', e.message);
  }
  return fallback;
}

// POST /api/sync {tag, provider} -> provider ke IMAP se INBOX + Spam parho, +tag ke hisab se save karo
app.post('/api/sync', async (req, res) => {
  const provider = normProvider((req.body && req.body.provider) || (req.query && req.query.provider));
  const tag = String((req.body && req.body.tag) || '').trim().toLowerCase();
  const key = msgKey(provider, tag);
  const totalForTag = () => (data.messages[key] ? data.messages[key].length : 0);

  const account = resolveAccount(provider, tag);
  if (!account) {
    return res.json({ status: 'no_credentials', newCount: 0, total: totalForTag(), error: provider === 'gmail' ? 'Pehle Gmail setup karo (base email + app password)' : 'Pehle Setup me apna Yandex base email aur app password dalo' });
  }

  const setup = account;
  const client = new ImapFlow({
    host: PROVIDERS[provider].host,
    port: 993,
    secure: true,
    auth: { user: setup.baseEmail, pass: setup.appPassword },
    logger: false,
  });

  const seenSet = new Set(data.seen);

  // Ek mailbox (INBOX ya Spam) se aakhri 50 mail parho, +tag wali save karo.
  // folderLabel: 'inbox' ya 'spam' — spam wali mail par Spam nishan lagta hai.
  async function fetchMailbox(mailboxPath, folderLabel) {
    const lock = await client.mailboxOpen(mailboxPath);
    const total = lock.exists || 0;
    let count = 0;
    if (total <= 0) return count;
    // Sirf pehle 50 recent mail parho — purani mail nahi chahiye
    const from = Math.max(1, total - 49);
    const range = `${from}:*`;

    for await (const msg of client.fetch(range, { envelope: true, source: true, uid: true })) {
      try {
        const parsed = await simpleParser(msg.source);
        const toAddr = (parsed.to && parsed.to.value && parsed.to.value[0] && parsed.to.value[0].address)
          || (msg.envelope && msg.envelope.to && msg.envelope.to[0] && msg.envelope.to[0].address)
          || '';
        const msgTag = tagFromAddress(toAddr);
        if (!msgTag) continue; // +tag nahi — ye temp mail nahi hai, skip karo

        const messageId = parsed.messageId || `uid-${msg.uid}`;
        const dedupeKey = provider === 'gmail' ? `gmail:${msgTag}:${messageId}` : `${msgTag}:${messageId}`;
        if (seenSet.has(dedupeKey)) continue; // pehle se save hai

        const text = parsed.text || '';
        const html = parsed.html || null;
        const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0])
          ? (parsed.from.value[0].name ? `${parsed.from.value[0].name} <${parsed.from.value[0].address}>` : parsed.from.value[0].address)
          : (msg.envelope && msg.envelope.from && msg.envelope.from[0] ? msg.envelope.from[0].address : '');
        const item = {
          id: dedupeKey,
          tag: msgTag,
          provider,
          to: toAddr,
          from: fromAddr,
          subject: parsed.subject || '(No subject)',
          date: parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString(),
          text,
          html,
          otp: extractOtp(text),
          read: false,
          uid: msg.uid,
          folder: folderLabel,
          spam: folderLabel === 'spam',
        };
        const storeKey = msgKey(provider, msgTag);
        if (!data.messages[storeKey]) data.messages[storeKey] = [];
        data.messages[storeKey].push(item);
        // Newest first rakho
        data.messages[storeKey].sort((a, b) => new Date(b.date) - new Date(a.date));
        seenSet.add(dedupeKey);
        data.seen.push(dedupeKey);
        if (msgTag === tag) count++;
      } catch (e) {
        console.log('Ek mail parse nahi hui, skip:', e.message);
      }
    }
    return count;
  }

  let newCount = 0;
  try {
    await client.connect();
    newCount += await fetchMailbox('INBOX', 'inbox');
    // Spam folder bhi parho — provider kabhi kabhi mail ko spam me daal deta hai.
    // Spam folder na mile ya error aaye to Inbox wala result phir bhi wapas do.
    try {
      const spamPath = await findSpamMailbox(client, PROVIDERS[provider].spamFallback);
      if (spamPath) newCount += await fetchMailbox(spamPath, 'spam');
    } catch (e) {
      console.log('Spam folder nahi parha ja saka, skip:', e.message);
    }

    await client.logout();
    saveData();
    return res.json({ status: 'ok', newCount, total: totalForTag() });
  } catch (err) {
    try { await client.logout(); } catch (e) { /* already closed */ }
    // Error ho to saaf batao, kabhi mail invent mat karo
    return res.json({ status: 'connect_failed', newCount: 0, total: totalForTag(), error: String((err && err.message) || err) });
  }
});

// GET /api/messages/:tag?provider=gmail -> us tag ki mail list, newest first
app.get('/api/messages/:tag', (req, res) => {
  const provider = normProvider(req.query && req.query.provider);
  const tag = String(req.params.tag || '').trim().toLowerCase();
  const list = (data.messages[msgKey(provider, tag)] || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ tag, provider, messages: list, total: list.length });
});

// GET /api/message/:tag/:id?provider=gmail -> ek mail ka full body, read mark karo
app.get('/api/message/:tag/:id', (req, res) => {
  const provider = normProvider(req.query && req.query.provider);
  const tag = String(req.params.tag || '').trim().toLowerCase();
  const id = decodeURIComponent(String(req.params.id || ''));
  const list = data.messages[msgKey(provider, tag)] || [];
  const msg = list.find((m) => m.id === id);
  if (!msg) {
    return res.status(404).json({ error: 'Mail nahi mili' });
  }
  msg.read = true;
  saveData();
  res.json(msg);
});

// ---------- Admin login + email pool ----------
// POST /api/admin/login {password} -> admin password (ya app password) sahi ho to token do.
// 5 ghalat koshishon par 5 minute ka lock.
app.post('/api/admin/login', (req, res) => {
  const now = Date.now();
  if (now < loginLockUntil) {
    return res.status(429).json({ error: 'Bohat dafa ghalat password — 5 minute baad dobara try karo' });
  }
  const pw = String((req.body && req.body.password) || '');
  if (!pw) return res.status(400).json({ error: 'Password dalo' });
  if (!adminPasswordMatches(pw)) {
    loginFailCount++;
    if (loginFailCount >= 5) { loginLockUntil = now + 5 * 60 * 1000; loginFailCount = 0; }
    return res.status(401).json({ error: 'Ghalat password' });
  }
  loginFailCount = 0;
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ ok: true, token });
});

// GET /api/admin/status -> token sahi hai ya nahi
app.get('/api/admin/status', (req, res) => {
  const token = adminTokenFrom(req);
  res.json({ loggedIn: !!(token && adminTokens.has(token)) });
});

// Pool list (password kabhi nahi bhejni)
function publicPool() {
  return (data.pool || []).map((e) => ({ id: e.id, provider: e.provider, baseEmail: e.baseEmail, createdAt: e.createdAt }));
}

// GET /api/admin/pool -> list dikhao (rotation status ke saath)
app.get('/api/admin/pool', requireAdmin, (req, res) => {
  res.json({ pool: publicPool(), rotation: { yandex: rotationStatus('yandex'), gmail: rotationStatus('gmail') } });
});

// POST /api/admin/pool {provider, baseEmail, appPassword} -> list me add karo
app.post('/api/admin/pool', requireAdmin, (req, res) => {
  const provider = normProvider(req.body && req.body.provider);
  const domain = '@' + PROVIDERS[provider].domain;
  const baseEmail = String(req.body && req.body.baseEmail ? req.body.baseEmail : '').trim().toLowerCase();
  const appPassword = String(req.body && req.body.appPassword ? req.body.appPassword : '').trim();
  if (!baseEmail || !baseEmail.includes('@') || !baseEmail.endsWith(domain)) {
    return res.status(400).json({ error: `Sahi ${provider === 'gmail' ? 'Gmail' : 'Yandex'} email dalo` });
  }
  if (!appPassword) return res.status(400).json({ error: 'App password dalo — us email ka inbox parhne ke liye chahiye' });
  if (!Array.isArray(data.pool)) data.pool = [];
  const existing = data.pool.find((e) => e.provider === provider && e.baseEmail === baseEmail);
  if (existing) {
    existing.appPassword = appPassword;
  } else {
    if (data.pool.length >= 20) return res.status(400).json({ error: 'List me zyada se zyada 20 emails rakh sakte ho' });
    data.pool.push({ id: crypto.randomBytes(6).toString('hex'), provider, baseEmail, appPassword, createdAt: new Date().toISOString() });
  }
  saveData();
  res.json({ ok: true, pool: publicPool(), rotation: { yandex: rotationStatus('yandex'), gmail: rotationStatus('gmail') } });
});

// DELETE /api/admin/pool/:id -> list se hatao
app.delete('/api/admin/pool/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '');
  const list = data.pool || [];
  const idx = list.findIndex((e) => e.id === id);
  if (idx >= 0) {
    // Rotation adjust karo: current entry delete hui to us ki gin ti reset;
    // us se pehle wali delete hui to index ek peeche.
    const st = rotationState(list[idx].provider);
    if (idx < st.index) st.index -= 1;
    else if (idx === st.index) st.used = 0;
    if (st.index < 0) st.index = 0;
  }
  data.pool = list.filter((e) => e.id !== id);
  saveData();
  res.json({ ok: true, pool: publicPool(), rotation: { yandex: rotationStatus('yandex'), gmail: rotationStatus('gmail') } });
});

// 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ye endpoint nahi hai' });
});

app.listen(PORT, () => {
  console.log(`Temp Mail server chal raha hai, port ${PORT}`);
  console.log(`Setup — Yandex: ${isConfigured('yandex')}${ENV_SETUP ? ' (env vars se)' : ''}, Gmail: ${isConfigured('gmail')}${GMAIL_ENV_SETUP ? ' (env vars se)' : ''}`);
});
