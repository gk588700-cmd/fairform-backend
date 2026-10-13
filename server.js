'use strict';
/**
 * FairForm AI backend
 * - Mock login (any ID / name / password, nothing real is stored)
 * - Virtual waiting room (queue) with real positions
 * - Session-aware rate limiter: allow / warn / temporarily slow
 * - Operator endpoints: view sessions + history, change rules, clear a warning
 * Everything lives in memory (fictional data only). Restarting the server resets it.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '100kb' }));

// Allows the page to be opened from Live Server / file:// too (demo only)
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Rules (operator can change these at runtime from the Admin page)    */
/* ------------------------------------------------------------------ */
const config = {
  windowSec: 60,    // time window used to count requests
  warnAt: 3,        // this many requests inside the window -> WARN
  slowAt: 5,        // this many requests inside the window -> SLOW
  penalty: 5,       // places a slowed student is pushed back in the queue
  scriptedMs: 800,  // two requests closer together than this look scripted -> SLOW
};
const BASE_AHEAD = 14;            // fictional students already waiting
const TICK_MS = 1800;             // one queue place is processed every tick
const READY_TTL_MS = 5 * 60 * 1000; // a ready turn expires after 5 minutes

const SERVICES = {
  exam: {
    name: 'Exam Registration',
    required: ['examType', 'examSemester', 'regulation', 'subjectCodes', 'subjectNames', 'examMode'],
  },
  scholarship: {
    name: 'Scholarship Application',
    required: ['category', 'cgpa', 'income', 'residence', 'accountHolder', 'bankName', 'ifsc', 'reason'],
  },
  course: {
    name: 'Course Enrollment',
    required: ['enrollmentCategory', 'courseCode', 'courseTitle', 'credits', 'preferredSemester', 'batch', 'learningMode', 'prerequisites', 'reason'],
  },
};
const COMMON_REQUIRED = ['fullName', 'studentId', 'registerNumber', 'dob', 'gender', 'email', 'mobile', 'department', 'degree', 'year', 'semester', 'section'];

/* ------------------------------------------------------------------ */
/* In-memory state                                                     */
/* ------------------------------------------------------------------ */
const students = new Map(); // studentId -> { id, name, course, actions[], scriptedUntil, lastActionAt, ticket, submissions[] }
const tokens = new Map();   // token -> studentId
const history = [];         // { t, studentId, action, decision, count, operator? }
let totalRequests = 0;

/* ------------------------------------------------------------------ */
/* Fairness monitor                                                    */
/* ------------------------------------------------------------------ */
function prune(st, now) {
  const w = config.windowSec * 1000;
  st.actions = st.actions.filter((t) => now - t < w);
}

function currentDecision(st, now = Date.now()) {
  prune(st, now);
  const n = st.actions.length;
  if (n >= config.slowAt || now < st.scriptedUntil) return 'slow';
  if (n >= config.warnAt) return 'warn';
  return 'allow';
}

function decisionInfo(st) {
  const decision = currentDecision(st);
  const n = st.actions.length;
  let message = '';
  if (decision === 'warn') {
    message = `You've made ${n} requests in ${config.windowSec}s. Please slow down - more requests will trigger a temporary slowdown.`;
  } else if (decision === 'slow') {
    message = 'Temporary slowdown: repeated or unusually fast requests were detected. Your place was moved back; it clears automatically when the window passes, or an operator can clear it.';
  }
  return { decision, message };
}

/** Records one counted action (join / submit) and returns the decision. */
function record(st, action) {
  const now = Date.now();
  prune(st, now);
  const prev = st.actions[st.actions.length - 1];
  const scripted = prev !== undefined && now - prev < config.scriptedMs;
  st.actions.push(now);
  st.lastActionAt = now;
  if (scripted) st.scriptedUntil = now + config.windowSec * 1000;
  const decision = currentDecision(st, now);
  totalRequests++;
  history.push({ t: now, studentId: st.id, action, decision, count: st.actions.length });
  if (history.length > 500) history.shift();
  return { decision, scripted };
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */
setInterval(() => {
  const now = Date.now();
  for (const st of students.values()) {
    const t = st.ticket;
    if (!t) continue;
    if (t.ready) {
      if (now - t.readyAt > READY_TTL_MS) st.ticket = null; // turn expired
      continue;
    }
    t.position = Math.max(1, t.position - 1);
    if (t.position === 1) { t.ready = true; t.readyAt = now; }
  }
}, TICK_MS);

function queueView(st) {
  const t = st.ticket;
  if (!t) return null;
  let message = 'Processing requests in arrival order. Please keep this tab open.';
  if (t.ready) message = 'Your turn is ready. You can now continue to the application form.';
  else if (t.penalty) message = 'A temporary slowdown moved you back in the queue.';
  return {
    service: t.service,
    position: t.position,
    ahead: t.position - 1,
    ready: t.ready,
    penalty: t.penalty,
    status: t.ready ? 'Ready' : 'In queue',
    message,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function publicUser(st) {
  return { id: st.id, name: st.name, course: st.course };
}

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const id = tokens.get(token);
  const st = id && students.get(id);
  if (!st) return res.status(401).json({ error: 'Please log in again.' });
  req.token = token;
  req.student = st;
  next();
}

function validateSubmission(st, service, details) {
  const svc = SERVICES[service];
  if (!svc) return { error: 'Unknown service.' };
  if (!details || typeof details !== 'object') return { error: 'Missing form details.' };
  const clean = {};
  for (const [k, v] of Object.entries(details)) {
    if (typeof v === 'string' || typeof v === 'number') clean[k] = String(v).trim().slice(0, 1000);
  }
  for (const f of [...COMMON_REQUIRED, ...svc.required]) {
    if (!clean[f]) return { error: `Missing required field: ${f}` };
  }
  if (clean.studentId !== st.id) return { error: 'Student ID does not match your login.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.email)) return { error: 'Invalid email address.' };
  if (!/^[0-9]{10}$/.test(clean.mobile)) return { error: 'Mobile number must be 10 digits.' };
  if (service === 'scholarship') {
    const c = Number(clean.cgpa);
    if (!(c >= 0 && c <= 10)) return { error: 'CGPA must be between 0 and 10.' };
    if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(clean.ifsc)) return { error: 'Invalid IFSC code.' };
  }
  return { clean };
}

/* ------------------------------------------------------------------ */
/* Student routes                                                      */
/* ------------------------------------------------------------------ */
app.post('/api/login', (req, res) => {
  const { id, name, password } = req.body || {};
  const sid = String(id || '').trim();
  const sname = String(name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(sid)) {
    return res.status(400).json({ error: 'Student ID may only contain letters, numbers, - and _ (max 30).' });
  }
  if (!sname || sname.length > 80) return res.status(400).json({ error: 'Enter your name (max 80 characters).' });
  if (!password) return res.status(400).json({ error: 'Enter a password.' });

  let st = students.get(sid);
  if (!st) {
    st = { id: sid, name: sname, course: '', actions: [], scriptedUntil: 0, lastActionAt: 0, ticket: null, submissions: [] };
    students.set(sid, st);
  } else {
    st.name = sname;
  }
  const token = crypto.randomUUID();
  tokens.set(token, sid);
  res.json({ token, user: publicUser(st) });
});

app.post('/api/logout', auth, (req, res) => {
  tokens.delete(req.token);
  req.student.ticket = null;
  res.json({ ok: true });
});

app.put('/api/profile', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const course = String((req.body || {}).course || '').trim();
  if (!name || name.length > 80) return res.status(400).json({ error: 'Enter your name (max 80 characters).' });
  if (course.length > 120) return res.status(400).json({ error: 'Course is too long.' });
  req.student.name = name;
  req.student.course = course;
  res.json({ user: publicUser(req.student) });
});

app.get('/api/me/stats', auth, (req, res) => {
  const st = req.student;
  const decision = decisionInfo(st); // also prunes the window
  res.json({
    limit: config.slowAt,
    remaining: Math.max(0, config.slowAt - st.actions.length),
    submissions: st.submissions.length,
    decision,
  });
});

app.post('/api/queue/join', auth, (req, res) => {
  const st = req.student;
  const service = (req.body || {}).service;
  if (!SERVICES[service]) return res.status(400).json({ error: 'Unknown service.' });

  const { decision } = record(st, 'join');
  const penalty = decision === 'slow' ? config.penalty : 0;

  let waiting = 0;
  for (const other of students.values()) {
    if (other !== st && other.ticket && !other.ticket.ready) waiting++;
  }
  // Joining again replaces the old ticket and goes to the back of the line
  st.ticket = {
    service,
    position: BASE_AHEAD + waiting + 1 + penalty,
    penalty,
    ready: false,
    readyAt: 0,
  };
  res.json({ decision: decisionInfo(st), queue: queueView(st) });
});

app.get('/api/queue/status', auth, (req, res) => {
  const q = queueView(req.student);
  if (!q) return res.status(404).json({ error: 'You are not in a queue.' });
  res.json({ ...q, decision: decisionInfo(req.student) });
});

app.post('/api/queue/leave', auth, (req, res) => {
  req.student.ticket = null;
  res.json({ ok: true });
});

app.post('/api/submit', auth, (req, res) => {
  const st = req.student;
  const { service, details } = req.body || {};
  const t = st.ticket;
  if (!t || !t.ready || t.service !== service) {
    return res.status(403).json({ error: 'Your turn is not ready. Please join the queue first.' });
  }
  const v = validateSubmission(st, service, details);
  if (v.error) return res.status(400).json({ error: v.error });

  const { scripted } = record(st, 'submit');
  if (scripted) {
    return res.status(429).json({ error: 'Submissions are arriving too quickly. Please wait a moment and try again.' });
  }

  const reference = `FF-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  st.submissions.push({ reference, service: SERVICES[service].name, date: new Date().toISOString(), details: v.clean });
  st.ticket = null;
  res.json({ reference, service: SERVICES[service].name });
});

app.get('/api/submissions', auth, (req, res) => {
  const submissions = req.student.submissions
    .map(({ reference, service, date }) => ({ reference, service, date }))
    .reverse();
  res.json({ submissions });
});

/* ------------------------------------------------------------------ */
/* Operator routes (demo: any logged-in session can open Admin)        */
/* ------------------------------------------------------------------ */
app.get('/api/admin/overview', auth, (req, res) => {
  const now = Date.now();
  const sessions = [...students.values()].map((st) => {
    const decision = currentDecision(st, now);
    return {
      id: st.id,
      name: st.name,
      requests: st.actions.length,
      decision,
      queue: st.ticket ? (st.ticket.ready ? 'Ready' : `#${st.ticket.position}`) : '-',
      lastActionAt: st.lastActionAt || null,
    };
  });

  const series = Array(12).fill(0); // 12 buckets x 10s = last 2 minutes
  for (const h of history) {
    if (h.operator) continue;
    const idx = Math.floor((now - h.t) / 10000);
    if (idx >= 0 && idx < 12) series[11 - idx]++;
  }

  res.json({
    config,
    totals: {
      sessions: sessions.length,
      inQueue: sessions.filter((s) => s.queue !== '-').length,
      flagged: sessions.filter((s) => s.decision !== 'allow').length,
      requests: totalRequests,
    },
    series,
    sessions,
    history: history.slice(-15).reverse().map((h) => ({ t: h.t, studentId: h.studentId, action: h.action, decision: h.decision })),
  });
});

app.put('/api/admin/config', auth, (req, res) => {
  const b = req.body || {};
  const next = {
    windowSec: Number(b.windowSec),
    warnAt: Number(b.warnAt),
    slowAt: Number(b.slowAt),
    penalty: Number(b.penalty),
    scriptedMs: Number(b.scriptedMs),
  };
  const ok = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!ok(next.windowSec, 5, 3600)) return res.status(400).json({ error: 'Window must be 5-3600 seconds.' });
  if (!ok(next.warnAt, 1, 100)) return res.status(400).json({ error: 'Warn threshold must be 1-100.' });
  if (!ok(next.slowAt, 1, 100) || next.slowAt <= next.warnAt) return res.status(400).json({ error: 'Slow threshold must be higher than the warn threshold.' });
  if (!ok(next.penalty, 0, 50)) return res.status(400).json({ error: 'Slowdown must be 0-50 places.' });
  if (!ok(next.scriptedMs, 0, 5000)) return res.status(400).json({ error: 'Scripted limit must be 0-5000 ms.' });
  Object.assign(config, next);
  res.json({ config });
});

// Operator clears a mistaken warning/slowdown (reversible)
app.post('/api/admin/clear/:id', auth, (req, res) => {
  const st = students.get(req.params.id);
  if (!st) return res.status(404).json({ error: 'Unknown student.' });
  st.actions = [];
  st.scriptedUntil = 0;
  const t = st.ticket;
  if (t && !t.ready && t.penalty) {
    t.position = Math.max(1, t.position - t.penalty);
    t.penalty = 0;
    if (t.position === 1) { t.ready = true; t.readyAt = Date.now(); }
  }
  history.push({ t: Date.now(), studentId: st.id, action: 'cleared by operator', decision: 'allow', count: 0, operator: true });
  if (history.length > 500) history.shift();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => res.status(400).json({ error: 'Bad request.' }));

app.listen(PORT, () => console.log(`FairForm backend running at http://localhost:${PORT}`));
