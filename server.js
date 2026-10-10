// Group Project Tracker - Node.js backend (Node >= 18). Data: data/db.json + data/uploads/
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; }); } catch {}
const E = process.env, PORT = E.PORT || 3000, SECRET = E.APP_SECRET || 'dev-secret-change-me';
const DB = path.join(__dirname, 'data'), F = path.join(DB, 'db.json');
fs.mkdirSync(path.join(DB, 'uploads'), { recursive: true });
let D = { users: [], tasks: [], meetings: [], docs: [], chat: [], acts: [] };
/* Storage: PostgreSQL when DATABASE_URL is set (survives restarts/redeploys), otherwise local files in data/ */
let pool = null, chain = Promise.resolve();
async function init() {
  if (E.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: E.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(E.DATABASE_URL) ? false : { rejectUnauthorized: false } });
    await pool.query('CREATE TABLE IF NOT EXISTS kv(k text PRIMARY KEY, v jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS files(id text PRIMARY KEY, data bytea NOT NULL)');
    const r = await pool.query("SELECT v FROM kv WHERE k='state'");
    if (r.rows[0]) D = Object.assign(D, r.rows[0].v);
    console.log('Storage: PostgreSQL (' + D.users.length + ' users loaded)');
  } else {
    try { D = Object.assign(D, JSON.parse(fs.readFileSync(F, 'utf8'))); } catch {}
    console.warn('Storage: local files in data/ (NOT permanent on Render free plan - set DATABASE_URL)');
  }
  if (!E.APP_SECRET) console.warn('WARNING: set APP_SECRET to a long random string');
}
const save = () => {
  if (pool) { const s = JSON.stringify(D); chain = chain.then(() => pool.query("INSERT INTO kv(k,v) VALUES('state',$1) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v", [s])).catch(e => console.error('DB save failed:', e.message)); }
  else { fs.writeFileSync(F + '.tmp', JSON.stringify(D)); fs.renameSync(F + '.tmp', F); }
};
const putFile = async (i, buf) => pool ? pool.query('INSERT INTO files(id,data) VALUES($1,$2)', [i, buf]) : fs.writeFileSync(path.join(DB, 'uploads', i), buf);
const getFile = async i => pool ? (await pool.query('SELECT data FROM files WHERE id=$1', [i])).rows[0].data : fs.readFileSync(path.join(DB, 'uploads', i));
const id = () => crypto.randomBytes(6).toString('hex');
const S = (x, n) => String(x ?? '').trim().slice(0, n);
const dk = ts => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const EM = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, PH = /^\+?[0-9]{10,15}$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };
const bad = (m, c = 400) => { throw { c, m }; };
const act = (u, type, d) => { D.acts.push({ t: Date.now(), u, type, d }); if (D.acts.length > 5000) D.acts.shift(); };

/* auth */
const hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
const sign = u => { const b = Buffer.from(JSON.stringify({ u, e: Date.now() + 7 * 864e5 })).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = t => { try { const [b, s] = t.split('.'); const h = crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); if (h.length !== s.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(s))) return; const p = JSON.parse(Buffer.from(b, 'base64url')); return p.e > Date.now() ? D.users.find(x => x.id === p.u) : undefined; } catch {} };
const tries = {};
const limited = ip => { const n = (tries[ip] = (tries[ip] || []).filter(t => Date.now() - t < 9e5)); n.push(Date.now()); return n.length > 10; };

/* notifications: Gmail first, SMS (Twilio) as fallback */
let mailer = null;
try { if (E.GMAIL_USER && E.GMAIL_APP_PASSWORD) mailer = require('nodemailer').createTransport({ service: 'gmail', auth: { user: E.GMAIL_USER, pass: E.GMAIL_APP_PASSWORD } }); } catch (e) { console.warn('nodemailer unavailable:', e.message); }
const smsOn = !!(E.TWILIO_SID && E.TWILIO_TOKEN && E.TWILIO_FROM);
async function email(to, subject, text) { if (!mailer) throw new Error('Gmail not configured'); await mailer.sendMail({ from: E.GMAIL_USER, to, subject, text }); }
async function sms(to, text) {
  if (!smsOn) throw new Error('SMS not configured');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${E.TWILIO_SID}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(E.TWILIO_SID + ':' + E.TWILIO_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: E.TWILIO_FROM, Body: text }) });
  if (!r.ok) throw new Error('Twilio error ' + r.status);
}

/* routes */
const R = [], on = (m, p, f, pub) => R.push([m, new RegExp('^' + p + '$'), f, pub]);
const isL = u => u.role === 'leader';

on('POST', '/api/signup', b => {
  const n = S(b.name, 40), e = S(b.email, 80).toLowerCase(), ph = S(b.phone, 20).replace(/[\s-]/g, '');
  if (n.length < 2) bad('Name must be 2-40 characters');
  if (!EM.test(e)) bad('Invalid email address');
  if (!PH.test(ph)) bad('Invalid mobile number (10-15 digits)');
  if (String(b.password || '').length < 8) bad('Password must be at least 8 characters');
  if (D.users.some(x => x.email === e || x.phone === ph)) bad('Email or phone already registered', 409);
  const s = crypto.randomBytes(8).toString('hex'), u = { id: id(), name: n, email: e, phone: ph, salt: s, hash: hp(b.password, s), role: 'member', joined: Date.now() };
  D.users.push(u); act(u.id, 'post', 'joined the team'); save(); return { token: sign(u.id) };
}, 1);
on('POST', '/api/login', (b, u, m, q) => {
  if (limited(q.socket.remoteAddress)) bad('Too many attempts, try later', 429);
  const x = D.users.find(z => z.email === S(b.email, 80).toLowerCase());
  if (!x || hp(b.password, x.salt) !== x.hash) bad('Wrong email or password', 401);
  return { token: sign(x.id) };
}, 1);
on('GET', '/api/state', (b, u) => {
  const L = isL(u), vis = D.docs.filter(d => d.vis === 'public' || d.u === u.id || L);
  return {
    me: u.id, notify: { gmail: !!mailer, sms: smsOn },
    users: D.users.map(x => ({ id: x.id, name: x.name, role: x.role, joined: x.joined, ...(L || x.id === u.id ? { email: x.email, phone: x.phone } : {}) })),
    tasks: D.tasks, meetings: D.meetings, chat: D.chat, acts: D.acts.slice(-2000),
    docs: vis.map(({ sha, ...d }) => ({ ...d, sha })), hidden: D.docs.length - vis.length
  };
});

/* leadership: everyone joins as member; first self-declaration wins, afterwards only the leader can hand over */
on('POST', '/api/leader/claim', (b, u) => {
  if (D.users.some(x => x.role === 'leader')) bad('A leader already exists. Only the leader can transfer leadership.', 403);
  u.role = 'leader'; act(u.id, 'modify', 'declared self as leader'); save(); return {};
});
on('POST', '/api/leader/transfer', (b, u) => {
  if (!isL(u)) bad('Only the leader can transfer leadership', 403);
  const t = D.users.find(x => x.id === b.to); if (!t || t.id === u.id) bad('Choose another member');
  u.role = 'member'; t.role = 'leader'; act(u.id, 'modify', 'transferred leadership to ' + t.name); save(); return {};
});
on('POST', '/api/member/(\\w+)/remove', (b, u, m) => {
  if (!isL(u)) bad('Only the leader can remove members', 403);
  const t = D.users.find(x => x.id === m[1]); if (!t || t.id === u.id) bad('Cannot remove this member');
  D.tasks.forEach(k => { if (k.who === t.id) k.who = u.id; });
  D.users = D.users.filter(x => x.id !== t.id); act(u.id, 'modify', 'removed member ' + t.name); save(); return {};
});

/* tasks */
on('POST', '/api/task', (b, u) => {
  const t = S(b.title, 80), who = S(b.who, 20), due = S(b.due, 10);
  if (t.length < 3) bad('Task title needs 3-80 characters');
  if (!D.users.some(x => x.id === who)) bad('Choose an assignee');
  if (!isL(u) && who !== u.id) bad('Members can only assign tasks to themselves', 403);
  if (!/^\d{4}-\d\d-\d\d$/.test(due) || due < dk(Date.now())) bad('Due date cannot be in the past');
  if (D.tasks.some(x => x.who === who && x.due === due && x.title.toLowerCase() === t.toLowerCase())) bad('Duplicate task', 409);
  D.tasks.push({ id: id(), title: t, who, due, p: 0, created: Date.now(), by: u.id }); act(u.id, 'post', 'task: ' + t); save(); return {};
});
on('PATCH', '/api/task/(\\w+)', (b, u, m) => {
  const t = D.tasks.find(x => x.id === m[1]); if (!t) bad('Task not found', 404);
  if (t.who !== u.id && !isL(u)) bad('Only the assignee or leader can update progress', 403);
  const p = Math.round(Number(b.p)); if (!(p >= 0 && p <= 100)) bad('Progress must be 0-100');
  t.p = p; act(u.id, 'modify', `"${t.title}" -> ${p}%`); save(); return {};
});
on('POST', '/api/task/(\\w+)/delete', (b, u, m) => {
  if (!isL(u)) bad('Leader only', 403);
  D.tasks = D.tasks.filter(x => x.id !== m[1]); act(u.id, 'modify', 'deleted a task'); save(); return {};
});

/* meetings + announcement (Gmail, falling back to SMS per member) */
on('POST', '/api/meeting', (b, u) => {
  if (!isL(u)) bad('Only the leader can schedule meetings', 403);
  const t = S(b.title, 80), g = S(b.agenda, 300), at = new Date(b.at);
  if (t.length < 3) bad('Title needs 3-80 characters');
  if (isNaN(at) || at <= new Date()) bad('Meeting must be in the future');
  if (!g) bad('Add an agenda or link');
  D.meetings.push({ id: id(), title: t, at: at.toISOString(), agenda: g, by: u.id, ann: null }); act(u.id, 'post', 'meeting: ' + t); save(); return {};
});
on('POST', '/api/meeting/(\\w+)/announce', async (b, u, m) => {
  if (!isL(u)) bad('Leader only', 403);
  const mt = D.meetings.find(x => x.id === m[1]); if (!mt) bad('Meeting not found', 404);
  const text = `Meeting: ${mt.title} on ${S(b.when, 40) || mt.at}. ${mt.agenda}`, res = [];
  for (const x of D.users) {
    let st;
    try { await email(x.email, 'Meeting: ' + mt.title, text); st = 'Gmail sent'; }
    catch (e1) {
      try { await sms(x.phone, text); st = 'SMS sent (Gmail failed: ' + e1.message + ')'; }
      catch (e2) { st = (!mailer && !smsOn) ? 'Dev mode: logged to server console' : 'FAILED: ' + e1.message + ' / ' + e2.message; if (!mailer && !smsOn) console.log(`[notify -> ${x.name} ${x.email} ${x.phone}] ${text}`); }
    }
    res.push({ u: x.id, status: st });
  }
  mt.ann = { t: Date.now(), res }; act(u.id, 'post', 'announced ' + mt.title); save(); return { res };
});

/* evidence documents */
on('POST', '/api/doc', async (b, u) => {
  const t = S(b.title, 80), x = S(b.desc, 400), d = S(b.date, 10), vis = b.vis === 'private' ? 'private' : 'public', tk = S(b.task, 20);
  if (t.length < 3) bad('Title needs 3-80 characters');
  if (!/^\d{4}-\d\d-\d\d$/.test(d) || d > dk(Date.now()) || d < dk(Date.now() - 30 * 864e5)) bad('Date must be within the last 30 days and not in the future');
  if (x.length < 10) bad('Description must be at least 10 characters');
  if (tk && !D.tasks.some(z => z.id === tk)) bad('Linked task not found');
  if (D.docs.some(o => o.u === u.id && o.title.toLowerCase() === t.toLowerCase() && o.date === d)) bad('Duplicate submission', 409);
  const doc = { id: id(), title: t, date: d, desc: x, vis, u: u.id, ts: Date.now(), task: tk, views: [] };
  if (b.link) { if (!/^https:\/\/[^\s]+\.[^\s]+$/.test(b.link)) bad('Evidence link must be a valid https URL'); doc.link = b.link; }
  else {
    const name = S(b.name, 100), ext = (name.split('.').pop() || '').toLowerCase(), buf = Buffer.from(String(b.data || ''), 'base64');
    if (!MIME[ext]) bad('Only png, jpg, pdf, txt allowed');
    if (!buf.length || buf.length > 3e5) bad('File must be 1 byte to 300 KB');
    const sig = { png: [137, 80, 78, 71], jpg: [255, 216, 255], jpeg: [255, 216, 255], pdf: [37, 80, 68, 70] }[ext];
    if (sig ? !sig.every((z, i) => buf[i] === z) : buf.subarray(0, 512).includes(0)) bad('File content does not match its type');
    Object.assign(doc, { name, size: buf.length, mime: MIME[ext], sha: crypto.createHash('sha256').update(buf).digest('hex') });
    await putFile(doc.id, buf);
  }
  D.docs.push(doc); act(u.id, 'post', 'evidence: ' + t); save(); return {};
});
on('GET', '/api/doc/(\\w+)/open', async (b, u, m) => {
  const d = D.docs.find(x => x.id === m[1]);
  if (!d || (d.vis === 'private' && d.u !== u.id && !isL(u))) bad('Not available', 403);
  if (!d.views.some(v => v.u === u.id)) d.views.push({ u: u.id, t: Date.now() });
  act(u.id, 'view', 'evidence: ' + d.title); save();
  return d.link ? { url: d.link } : { raw: await getFile(d.id), type: d.mime };
});

/* chat with read receipts */
on('POST', '/api/chat', (b, u) => {
  const t = S(b.text, 500); if (!t) bad('Message is empty');
  D.chat.push({ id: id(), u: u.id, t: Date.now(), text: t, seen: [u.id] }); act(u.id, 'chat', t.slice(0, 40)); save(); return {};
});
on('POST', '/api/chat/seen', (b, u) => {
  let n = 0; D.chat.forEach(c => { if (!c.seen.includes(u.id)) { c.seen.push(u.id); n++; } });
  if (n) { act(u.id, 'view', n + ' chat message(s)'); save(); } return {};
});

/* server */
const json = (r, c, o) => { r.writeHead(c, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
const body = q => new Promise((ok, no) => { let b = '', n = 0; q.on('data', c => { n += c.length; if (n > 2e6) { no({ c: 413, m: 'Body too large' }); q.destroy(); } else b += c; }); q.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no({ c: 400, m: 'Invalid JSON' }); } }); });
const srv = http.createServer(async (q, r) => {
  try {
    const p = new URL(q.url, 'http://x').pathname;
    if (!p.startsWith('/api/')) { r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return r.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))); }
    for (const [m, re, f, pub] of R) {
      const mt = re.exec(p); if (m !== q.method || !mt) continue;
      let u; if (!pub) { u = verify((q.headers.authorization || '').slice(7)); if (!u) return json(r, 401, { error: 'Please log in' }); }
      const o = await f(m === 'GET' ? {} : await body(q), u, mt, q);
      if (o && o.raw) { r.writeHead(200, { 'Content-Type': o.type, 'X-Content-Type-Options': 'nosniff' }); return r.end(o.raw); }
      return json(r, 200, o || { ok: 1 });
    }
    json(r, 404, { error: 'Not found' });
  } catch (e) { if (e.c) json(r, e.c, { error: e.m }); else { console.error(e); json(r, 500, { error: 'Server error' }); } }
});
init().then(() => srv.listen(PORT, () => console.log('Group Project Tracker running on port ' + PORT))).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
