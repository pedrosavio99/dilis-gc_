const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://neondb_owner:npg_R9jgB8rvZNIO@ep-muddy-king-apbwf358-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false },
});
pool.on('error', err => console.error('Pool error:', err));

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── HELPERS ──
function hashPin(pin) { return crypto.createHash('sha256').update(pin + 'salt_brinde_2025').digest('hex'); }
function genAccessId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'TM-';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
async function authMiddleware(req, res, next) {
  const token = req.headers['x-client-token'];
  if (!token) return res.status(401).json({ error: 'Token obrigatório' });
  try {
    const r = await pool.query('SELECT * FROM clients WHERE session_token=$1', [token]);
    if (!r.rows.length) return res.status(401).json({ error: 'Sessão inválida' });
    req.client = r.rows[0];
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ── INIT DB ──
async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE, pin_hash VARCHAR(64) NOT NULL,
      session_token VARCHAR(64), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS totems (
      id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, location VARCHAR(255), access_id VARCHAR(20) NOT NULL UNIQUE,
      status VARCHAR(50) DEFAULT 'ativo', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, name)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prizes (
      id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, color VARCHAR(7) DEFAULT '#0a84ff', stock INTEGER DEFAULT 0,
      description TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, description TEXT, date_start DATE NOT NULL, date_end DATE NOT NULL,
      status VARCHAR(50) DEFAULT 'ativo', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS event_totems (
      id SERIAL PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      totem_id INTEGER NOT NULL REFERENCES totems(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(event_id, totem_id)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS event_prizes (
      id SERIAL PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      prize_id INTEGER NOT NULL REFERENCES prizes(id) ON DELETE CASCADE,
      allocated INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(event_id, prize_id)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS event_schedule (
      id SERIAL PRIMARY KEY, event_prize_id INTEGER NOT NULL REFERENCES event_prizes(id) ON DELETE CASCADE,
      day DATE NOT NULL, qty INTEGER DEFAULT 0, is_exception BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(event_prize_id, day)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS distributions (
      id SERIAL PRIMARY KEY, event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
      totem_id INTEGER NOT NULL REFERENCES totems(id) ON DELETE CASCADE,
      prize_id INTEGER NOT NULL REFERENCES prizes(id) ON DELETE CASCADE,
      quantity INTEGER DEFAULT 1, distributed_at TIMESTAMP DEFAULT NOW(), user_phone VARCHAR(20)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, location VARCHAR(255),
      game_type VARCHAR(100) NOT NULL DEFAULT 'SCORE_ENDLESS',
      unity_key VARCHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS prize_tiers (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      game_type VARCHAR(100) NOT NULL,
      name VARCHAR(255) NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      outcome_type VARCHAR(50) NOT NULL DEFAULT 'PRIZE',
      band_type VARCHAR(20) NOT NULL DEFAULT 'interval',
      score_min INTEGER, score_max INTEGER, discrete_value INTEGER,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tier_gifts (
      id SERIAL PRIMARY KEY,
      tier_id INTEGER NOT NULL REFERENCES prize_tiers(id) ON DELETE CASCADE,
      event_prize_id INTEGER NOT NULL REFERENCES event_prizes(id) ON DELETE CASCADE,
      configured_weight NUMERIC(10,2) NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(tier_id, event_prize_id)
    );`);
    await pool.query(`CREATE TABLE IF NOT EXISTS play_records (
      id SERIAL PRIMARY KEY,
      activation_id INTEGER NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
      event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      tier_id INTEGER REFERENCES prize_tiers(id) ON DELETE SET NULL,
      prize_id INTEGER REFERENCES prizes(id) ON DELETE SET NULL,
      game_type VARCHAR(100) NOT NULL,
      score INTEGER,
      discrete_outcome INTEGER,
      tier_label VARCHAR(255),
      gift_name VARCHAR(255),
      had_prize BOOLEAN NOT NULL DEFAULT FALSE,
      client_round_id VARCHAR(128),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(activation_id, client_round_id)
    );`);
    console.log('✓ Database inicializado');
  } catch (err) { console.error('✗ initDB:', err.message); }
}

// ════════════════════════════════════
// AUTH
// ════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  const { name, email, pin } = req.body;
  try {
    if (!name || !email || !pin) return res.status(400).json({ error: 'Nome, email e PIN obrigatórios' });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN deve ter exatamente 4 dígitos' });
    const token = crypto.randomBytes(32).toString('hex');
    const r = await pool.query(
      `INSERT INTO clients (name,email,pin_hash,session_token) VALUES ($1,$2,$3,$4) RETURNING id,name,email`,
      [name, email.toLowerCase().trim(), hashPin(pin), token]);
    res.status(201).json({ client: r.rows[0], token });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, pin } = req.body;
  try {
    if (!email || !pin) return res.status(400).json({ error: 'Email e PIN obrigatórios' });
    const r = await pool.query('SELECT id,name,email FROM clients WHERE email=$1 AND pin_hash=$2',
      [email.toLowerCase().trim(), hashPin(pin)]);
    if (!r.rows.length) return res.status(401).json({ error: 'Email ou PIN incorretos' });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE clients SET session_token=$1, updated_at=NOW() WHERE id=$2', [token, r.rows[0].id]);
    res.json({ client: r.rows[0], token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  try { await pool.query('UPDATE clients SET session_token=NULL WHERE id=$1', [req.client.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ id: req.client.id, name: req.client.name, email: req.client.email });
});

// ════════════════════════════════════
// TOTENS
// ════════════════════════════════════
app.post('/api/totems', authMiddleware, async (req, res) => {
  const { name, location } = req.body;
  try {
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    let access_id, attempts = 0;
    while (attempts < 10) {
      access_id = genAccessId();
      if (!(await pool.query('SELECT id FROM totems WHERE access_id=$1', [access_id])).rows.length) break;
      attempts++;
    }
    const r = await pool.query(
      'INSERT INTO totems (client_id,name,location,access_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.client.id, name, location || null, access_id]);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Totem com este nome já existe' });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/totems', authMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT * FROM totems WHERE client_id=$1 ORDER BY name ASC', [req.client.id])).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/totems/:id', authMiddleware, async (req, res) => {
  const { name, location, status } = req.body;
  try {
    const r = await pool.query(
      `UPDATE totems SET name=COALESCE($1,name), location=COALESCE($2,location), status=COALESCE($3,status), updated_at=NOW()
       WHERE id=$4 AND client_id=$5 RETURNING *`,
      [name||null, location||null, status||null, req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/totems/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM totems WHERE id=$1 AND client_id=$2 RETURNING *', [req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// BRINDES
// ════════════════════════════════════
app.post('/api/prizes', authMiddleware, async (req, res) => {
  const { name, color, stock, description } = req.body;
  try {
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const r = await pool.query(
      'INSERT INTO prizes (client_id,name,color,stock,description) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.client.id, name, color||'#0a84ff', stock||0, description||null]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/prizes', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.*, COALESCE(SUM(ep.allocated),0)::int AS reserved_by_events,
        (p.stock - COALESCE(SUM(ep.allocated),0))::int AS available_stock
      FROM prizes p LEFT JOIN event_prizes ep ON ep.prize_id=p.id
      WHERE p.client_id=$1 GROUP BY p.id ORDER BY p.name ASC`, [req.client.id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/prizes/:id', authMiddleware, async (req, res) => {
  const { name, color, stock, description } = req.body;
  try {
    const r = await pool.query(
      `UPDATE prizes SET name=COALESCE($1,name), color=COALESCE($2,color), stock=COALESCE($3,stock),
       description=COALESCE($4,description), updated_at=NOW() WHERE id=$5 AND client_id=$6 RETURNING *`,
      [name||null, color||null, stock!==undefined?stock:null, description||null, req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/prizes/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM prizes WHERE id=$1 AND client_id=$2 RETURNING *', [req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// EVENTOS
// ════════════════════════════════════
app.post('/api/events', authMiddleware, async (req, res) => {
  const { name, description, date_start, date_end, totem_ids } = req.body;
  try {
    if (!name || !date_start || !date_end) return res.status(400).json({ error: 'Nome, data início e data fim obrigatórios' });
    if (date_start > date_end) return res.status(400).json({ error: 'Data início deve ser anterior à data fim' });
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      const r = await cl.query(
        'INSERT INTO events (client_id,name,description,date_start,date_end) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.client.id, name, description||null, date_start, date_end]);
      const event = r.rows[0];
      if (totem_ids?.length) {
        for (const tid of totem_ids) {
          if ((await cl.query('SELECT id FROM totems WHERE id=$1 AND client_id=$2', [tid, req.client.id])).rows.length)
            await cl.query('INSERT INTO event_totems (event_id,totem_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [event.id, tid]);
        }
      }
      await cl.query('COMMIT');
      res.status(201).json(event);
    } catch (e) { await cl.query('ROLLBACK'); throw e; }
    finally { cl.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM events WHERE client_id=$1 ORDER BY date_start DESC', [req.client.id]);
    const events = await Promise.all(r.rows.map(async (ev) => {
      const totems = await pool.query(
        `SELECT t.id,t.name,t.access_id,t.location FROM event_totems et JOIN totems t ON t.id=et.totem_id WHERE et.event_id=$1`, [ev.id]);
      const prizes = await pool.query(
        `SELECT COUNT(DISTINCT ep.prize_id)::int as prize_count, COALESCE(SUM(ep.allocated),0)::int as total_allocated FROM event_prizes ep WHERE ep.event_id=$1`, [ev.id]);
      return { ...ev, totems: totems.rows, ...prizes.rows[0] };
    }));
    res.json(events);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM events WHERE id=$1 AND client_id=$2', [req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    const ev = r.rows[0];
    ev.totems = (await pool.query(
      `SELECT t.id,t.name,t.access_id,t.location FROM event_totems et JOIN totems t ON t.id=et.totem_id WHERE et.event_id=$1`, [ev.id])).rows;
    res.json(ev);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/events/:id', authMiddleware, async (req, res) => {
  const { name, description, date_start, date_end, status } = req.body;
  try {
    const r = await pool.query(
      `UPDATE events SET name=COALESCE($1,name), description=COALESCE($2,description),
       date_start=COALESCE($3,date_start), date_end=COALESCE($4,date_end), status=COALESCE($5,status), updated_at=NOW()
       WHERE id=$6 AND client_id=$7 RETURNING *`,
      [name||null, description||null, date_start||null, date_end||null, status||null, req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM events WHERE id=$1 AND client_id=$2 RETURNING *', [req.params.id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:id/totems', authMiddleware, async (req, res) => {
  const { totem_id } = req.body;
  try {
    if (!(await pool.query('SELECT id FROM events WHERE id=$1 AND client_id=$2', [req.params.id, req.client.id])).rows.length)
      return res.status(404).json({ error: 'Evento não encontrado' });
    if (!(await pool.query('SELECT id FROM totems WHERE id=$1 AND client_id=$2', [totem_id, req.client.id])).rows.length)
      return res.status(404).json({ error: 'Totem não encontrado' });
    await pool.query('INSERT INTO event_totems (event_id,totem_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, totem_id]);
    res.status(201).json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:id/totems/:totem_id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM event_totems WHERE event_id=$1 AND totem_id=$2', [req.params.id, req.params.totem_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BRINDES DO EVENTO ──
app.get('/api/events/:event_id/prizes', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().substring(0, 10);
  try {
    const r = await pool.query(`
      SELECT ep.*, p.name as prize_name, p.color, p.stock,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS distributed_total,
        COALESCE((SELECT SUM(es.qty) FROM event_schedule es WHERE es.event_prize_id=ep.id AND es.is_exception=FALSE),0)::int AS scheduled_total,
        GREATEST(0, ep.allocated
          - COALESCE((SELECT SUM(es.qty) FROM event_schedule es WHERE es.event_prize_id=ep.id AND es.is_exception=FALSE AND es.day >= $2),0)
          - COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)
        )::int AS unscheduled_qty
      FROM event_prizes ep JOIN prizes p ON ep.prize_id=p.id
      WHERE ep.event_id=$1 ORDER BY p.name ASC`, [req.params.event_id, today]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:event_id/prizes', authMiddleware, async (req, res) => {
  const { prize_id, allocated } = req.body;
  const event_id = req.params.event_id;
  try {
    if (!prize_id || !allocated || allocated <= 0) return res.status(400).json({ error: 'prize_id e allocated obrigatórios' });
    if (!(await pool.query('SELECT id FROM events WHERE id=$1 AND client_id=$2', [event_id, req.client.id])).rows.length)
      return res.status(404).json({ error: 'Evento não encontrado' });
    const s = (await pool.query(
      `SELECT p.stock, COALESCE((SELECT SUM(ep2.allocated) FROM event_prizes ep2 WHERE ep2.prize_id=p.id AND ep2.event_id!=$2),0)::int AS reservado
       FROM prizes p WHERE p.id=$1 AND p.client_id=$3`, [prize_id, event_id, req.client.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'Brinde não encontrado' });
    if (allocated > s.stock - s.reservado) return res.status(400).json({ error: `Apenas ${s.stock - s.reservado} unidade(s) disponível(is)` });
    const r = await pool.query(
      `INSERT INTO event_prizes (event_id,prize_id,allocated) VALUES ($1,$2,$3)
       ON CONFLICT (event_id,prize_id) DO UPDATE SET allocated=$3, updated_at=NOW() RETURNING *`,
      [event_id, prize_id, allocated]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:event_id/prizes/:id', authMiddleware, async (req, res) => {
  try {
    const check = (await pool.query(
      `SELECT ep.id, ep.allocated FROM event_prizes ep JOIN events e ON e.id=ep.event_id
       WHERE ep.id=$1 AND ep.event_id=$2 AND e.client_id=$3`,
      [req.params.id, req.params.event_id, req.client.id])).rows[0];
    if (!check) return res.status(404).json({ error: 'Não encontrado' });
    await pool.query('DELETE FROM event_prizes WHERE id=$1', [req.params.id]);
    res.json({ success: true, returned: check.allocated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// SCHEDULE
// ════════════════════════════════════
app.get('/api/events/:event_id/schedule', authMiddleware, async (req, res) => {
  const { month } = req.query;
  const today = new Date().toISOString().substring(0, 10);
  try {
    const params = [req.params.event_id];
    let monthFilter = '';
    if (month) { params.push(month); monthFilter = ` AND TO_CHAR(es.day,'YYYY-MM')=$${params.length}`; }
    const schedule = (await pool.query(`
      SELECT es.event_prize_id, es.day, es.qty, es.is_exception, ep.prize_id, ep.allocated,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d
          WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id AND DATE(d.distributed_at)=es.day),0)::int AS distributed_on_day
      FROM event_schedule es JOIN event_prizes ep ON es.event_prize_id=ep.id
      WHERE ep.event_id=$1${monthFilter} ORDER BY es.day ASC`, params)).rows;
    const epRows = (await pool.query(`
      SELECT ep.id as ep_id, ep.allocated,
        COALESCE((SELECT SUM(es.qty) FROM event_schedule es WHERE es.event_prize_id=ep.id AND es.is_exception=FALSE AND es.day >= $2),0)::int AS sched_future,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS dist_total
      FROM event_prizes ep WHERE ep.event_id=$1`, [req.params.event_id, today])).rows;
    const unscheduled = {};
    for (const ep of epRows) unscheduled[ep.ep_id] = Math.max(0, ep.allocated - ep.sched_future - ep.dist_total);
    res.json({ schedule, unscheduled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:event_id/schedule/day', authMiddleware, async (req, res) => {
  const { day, is_exception, items } = req.body;
  const event_id = req.params.event_id;
  if (!day) return res.status(400).json({ error: 'day obrigatório' });
  const today = new Date().toISOString().substring(0, 10);
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const epIds = (await cl.query('SELECT id FROM event_prizes WHERE event_id=$1', [event_id])).rows.map(r => r.id);
    for (const epId of epIds) {
      await cl.query(
        `INSERT INTO event_schedule (event_prize_id,day,qty,is_exception) VALUES ($1,$2,0,$3)
         ON CONFLICT (event_prize_id,day) DO UPDATE SET qty=0, is_exception=$3, updated_at=NOW()`,
        [epId, day, !!is_exception]);
    }
    if (!is_exception) {
      for (const item of (items || [])) {
        if (!item.qty || item.qty <= 0) continue;
        const v = (await cl.query(`
          SELECT ep.allocated,
            COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS dist_total,
            COALESCE((SELECT SUM(es.qty) FROM event_schedule es WHERE es.event_prize_id=ep.id AND es.is_exception=FALSE AND es.day >= $3 AND es.day != $4),0)::int AS other_sched
          FROM event_prizes ep WHERE ep.id=$1 AND ep.event_id=$2`,
          [item.event_prize_id, event_id, today, day])).rows[0];
        if (!v) continue;
        const safeQty = Math.min(item.qty, Math.max(0, v.allocated - v.dist_total - v.other_sched));
        if (safeQty > 0) {
          await cl.query(
            `INSERT INTO event_schedule (event_prize_id,day,qty,is_exception) VALUES ($1,$2,$3,FALSE)
             ON CONFLICT (event_prize_id,day) DO UPDATE SET qty=$3, is_exception=FALSE, updated_at=NOW()`,
            [item.event_prize_id, day, safeQty]);
        }
      }
    }
    await cl.query('COMMIT');
    res.json({ success: true });
  } catch (e) { await cl.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { cl.release(); }
});

app.post('/api/events/:event_id/schedule/bulk', authMiddleware, async (req, res) => {
  const { days } = req.body;
  const event_id = req.params.event_id;
  if (!Array.isArray(days) || !days.length) return res.status(400).json({ error: 'days[] obrigatório' });
  const today = new Date().toISOString().substring(0, 10);
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const epRows = (await cl.query(`
      SELECT ep.id, ep.allocated,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS dist_total
      FROM event_prizes ep WHERE ep.event_id=$1`, [event_id])).rows;
    const epMap = {};
    for (const ep of epRows) epMap[ep.id] = { allocated: ep.allocated, dist_total: ep.dist_total };
    for (const dayObj of days) {
      const { day, is_exception, items } = dayObj;
      for (const epId of Object.keys(epMap)) {
        await cl.query(
          `INSERT INTO event_schedule (event_prize_id,day,qty,is_exception) VALUES ($1,$2,0,$3)
           ON CONFLICT (event_prize_id,day) DO UPDATE SET qty=0, is_exception=$3, updated_at=NOW()`,
          [epId, day, !!is_exception]);
      }
      if (!is_exception) {
        for (const item of (items || [])) {
          if (!item.qty || item.qty <= 0) continue;
          const ep = epMap[item.event_prize_id];
          if (!ep) continue;
          const otherSched = (await cl.query(`
            SELECT COALESCE(SUM(qty),0)::int AS s FROM event_schedule
            WHERE event_prize_id=$1 AND is_exception=FALSE AND day >= $2 AND day != $3`,
            [item.event_prize_id, today, day])).rows[0].s;
          const safeQty = Math.min(item.qty, Math.max(0, ep.allocated - ep.dist_total - otherSched));
          if (safeQty > 0) {
            await cl.query(
              `INSERT INTO event_schedule (event_prize_id,day,qty,is_exception) VALUES ($1,$2,$3,FALSE)
               ON CONFLICT (event_prize_id,day) DO UPDATE SET qty=$3, is_exception=FALSE, updated_at=NOW()`,
              [item.event_prize_id, day, safeQty]);
          }
        }
      }
    }
    await cl.query('COMMIT');
    res.json({ success: true, saved: days.length });
  } catch (e) { await cl.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { cl.release(); }
});

// ════════════════════════════════════
// ATIVAÇÕES
// ════════════════════════════════════
app.get('/api/events/:event_id/activations', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.name, a.location, a.game_type, a.created_at,
        LEFT(a.unity_key, 4) || '••••••••' || RIGHT(a.unity_key, 4) AS unity_key_masked
       FROM activations a WHERE a.event_id=$1 ORDER BY a.created_at ASC`,
      [req.params.event_id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:event_id/activations', authMiddleware, async (req, res) => {
  const { name, location, game_type } = req.body;
  try {
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const ev = (await pool.query('SELECT id FROM events WHERE id=$1 AND client_id=$2', [req.params.event_id, req.client.id])).rows[0];
    if (!ev) return res.status(404).json({ error: 'Evento não encontrado' });
    const unity_key = crypto.randomBytes(32).toString('hex');
    const r = await pool.query(
      `INSERT INTO activations (event_id,name,location,game_type,unity_key) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.event_id, name, location||null, game_type||'SCORE_ENDLESS', unity_key]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events/:event_id/activations/:id/key', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.unity_key FROM activations a JOIN events e ON e.id=a.event_id
       WHERE a.id=$1 AND a.event_id=$2 AND e.client_id=$3`,
      [req.params.id, req.params.event_id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Ativação não encontrada' });
    res.json({ unity_key: r.rows[0].unity_key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:event_id/activations/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM activations WHERE id=$1 AND event_id=$2
       AND event_id IN (SELECT id FROM events WHERE client_id=$3) RETURNING id`,
      [req.params.id, req.params.event_id, req.client.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// FAIXAS (PRIZE TIERS)
// ════════════════════════════════════
app.get('/api/events/:event_id/tiers', authMiddleware, async (req, res) => {
  const { game_type } = req.query;
  try {
    let q = `SELECT pt.*,
        json_agg(json_build_object(
          'id', tg.id, 'event_prize_id', tg.event_prize_id,
          'prize_name', p.name, 'prize_color', p.color,
          'configured_weight', tg.configured_weight, 'sort_order', tg.sort_order, 'allocated', ep.allocated
        ) ORDER BY tg.sort_order) FILTER (WHERE tg.id IS NOT NULL) AS gifts
      FROM prize_tiers pt
      LEFT JOIN tier_gifts tg ON tg.tier_id=pt.id
      LEFT JOIN event_prizes ep ON ep.id=tg.event_prize_id
      LEFT JOIN prizes p ON p.id=ep.prize_id
      WHERE pt.event_id=$1`;
    const params = [req.params.event_id];
    if (game_type) { params.push(game_type); q += ` AND pt.game_type=$${params.length}`; }
    q += ' GROUP BY pt.id ORDER BY pt.game_type, pt.sort_order';
    res.json((await pool.query(q, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:event_id/tiers', authMiddleware, async (req, res) => {
  const { game_type, name, sort_order, outcome_type, band_type, score_min, score_max, discrete_value } = req.body;
  try {
    if (!game_type || !name) return res.status(400).json({ error: 'game_type e name obrigatórios' });
    if (band_type === 'interval' && (score_min == null || score_max == null))
      return res.status(400).json({ error: 'score_min e score_max obrigatórios para intervalo' });
    if (band_type === 'discrete' && discrete_value == null)
      return res.status(400).json({ error: 'discrete_value obrigatório para modo discreto' });
    if (band_type === 'interval') {
      const overlap = (await pool.query(
        `SELECT id FROM prize_tiers WHERE event_id=$1 AND game_type=$2 AND band_type='interval'
         AND NOT (score_max < $3 OR score_min > $4)`,
        [req.params.event_id, game_type, score_min, score_max])).rows;
      if (overlap.length) return res.status(400).json({ error: 'Intervalo sobrepõe uma faixa existente' });
    }
    if (band_type === 'discrete') {
      const dup = (await pool.query(
        `SELECT id FROM prize_tiers WHERE event_id=$1 AND game_type=$2 AND band_type='discrete' AND discrete_value=$3`,
        [req.params.event_id, game_type, discrete_value])).rows;
      if (dup.length) return res.status(400).json({ error: 'Valor discreto já existe nesta configuração' });
    }
    const r = await pool.query(
      `INSERT INTO prize_tiers (event_id,game_type,name,sort_order,outcome_type,band_type,score_min,score_max,discrete_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.event_id, game_type, name, sort_order||0, outcome_type||'PRIZE',
       band_type||'interval', score_min??null, score_max??null, discrete_value??null]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:event_id/tiers/:tier_id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM prize_tiers WHERE id=$1 AND event_id=$2 RETURNING id',
      [req.params.tier_id, req.params.event_id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/events/:event_id/tiers/:tier_id/gifts', authMiddleware, async (req, res) => {
  const { event_prize_id, configured_weight, sort_order } = req.body;
  try {
    if (!event_prize_id) return res.status(400).json({ error: 'event_prize_id obrigatório' });
    const r = await pool.query(
      `INSERT INTO tier_gifts (tier_id,event_prize_id,configured_weight,sort_order) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tier_id,event_prize_id) DO UPDATE SET configured_weight=$3, sort_order=$4 RETURNING *`,
      [req.params.tier_id, event_prize_id, configured_weight??1, sort_order??0]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/events/:event_id/tiers/:tier_id/gifts/:tg_id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM tier_gifts WHERE id=$1 AND tier_id=$2', [req.params.tg_id, req.params.tier_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MÉTRICAS ──
app.get('/api/events/:event_id/metrics', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().substring(0, 10);
  try {
    const todayRow = (await pool.query(`
      SELECT p.name as prize_name, p.color, COUNT(d.id)::int as distributed_today
      FROM distributions d JOIN prizes p ON p.id=d.prize_id
      WHERE d.event_id=$1 AND DATE(d.distributed_at)=$2
      GROUP BY p.id ORDER BY p.name`, [req.params.event_id, today])).rows;
    const stockRow = (await pool.query(`
      SELECT p.name as prize_name, p.color, ep.allocated,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS distributed_total
      FROM event_prizes ep JOIN prizes p ON p.id=ep.prize_id
      WHERE ep.event_id=$1 ORDER BY p.name`, [req.params.event_id])).rows;
    const historyRow = (await pool.query(`
      SELECT DATE(d.distributed_at) as day, p.name as prize_name, p.color, COUNT(d.id)::int as qty
      FROM distributions d JOIN prizes p ON p.id=d.prize_id
      WHERE d.event_id=$1 GROUP BY DATE(d.distributed_at), p.id ORDER BY day DESC, p.name`,
      [req.params.event_id])).rows;
    res.json({ today: todayRow, stock: stockRow, history: historyRow });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// TOTEM DEVICE (sem auth de cliente)
// ════════════════════════════════════
app.get('/api/totem/:access_id/today', async (req, res) => {
  try {
    const totem = (await pool.query('SELECT * FROM totems WHERE access_id=$1', [req.params.access_id])).rows[0];
    if (!totem) return res.status(404).json({ error: 'Totem não encontrado' });
    const today = new Date().toISOString().substring(0, 10);
    const event = (await pool.query(
      `SELECT e.* FROM events e JOIN event_totems et ON et.event_id=e.id
       WHERE et.totem_id=$1 AND e.date_start<=$2 AND e.date_end>=$2 AND e.status='ativo'
       ORDER BY e.date_start DESC LIMIT 1`, [totem.id, today])).rows[0];
    if (!event) return res.json({ totem: { id: totem.id, name: totem.name }, event: null, prizes: [], message: 'Nenhum evento ativo hoje' });
    const rows = (await pool.query(`
      SELECT ep.id as event_prize_id, ep.prize_id, ep.allocated, p.name as prize_name, p.color, p.description,
        COALESCE(es.qty,0)::int as planned_today, COALESCE(es.is_exception,FALSE) as is_exception,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id AND DATE(d.distributed_at)=$2),0)::int AS distributed_today,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS distributed_total,
        COALESCE((SELECT SUM(es2.qty) FROM event_schedule es2 WHERE es2.event_prize_id=ep.id AND es2.is_exception=FALSE AND es2.day > $2),0)::int AS scheduled_future
      FROM event_prizes ep JOIN prizes p ON ep.prize_id=p.id
      LEFT JOIN event_schedule es ON es.event_prize_id=ep.id AND es.day=$2
      WHERE ep.event_id=$1 ORDER BY p.name ASC`, [event.id, today])).rows;
    const prizes = rows.map(p => {
      const remaining_total = Math.max(0, p.allocated - p.distributed_total);
      const unscheduled = Math.max(0, remaining_total - p.scheduled_future);
      let available_today;
      if (p.is_exception) available_today = 0;
      else if (p.planned_today > 0) available_today = Math.max(0, p.planned_today - p.distributed_today);
      else available_today = Math.max(0, unscheduled - p.distributed_today);
      return { ...p, remaining_total, unscheduled, available_today, remaining_today: available_today };
    });
    res.json({ totem: { id: totem.id, name: totem.name, location: totem.location }, event: { id: event.id, name: event.name, date_start: event.date_start, date_end: event.date_end }, prizes, date: today });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/totem/:access_id/distribute', async (req, res) => {
  const { prize_id, user_phone } = req.body;
  try {
    const totem = (await pool.query('SELECT * FROM totems WHERE access_id=$1', [req.params.access_id])).rows[0];
    if (!totem) return res.status(404).json({ error: 'Totem não encontrado' });
    const today = new Date().toISOString().substring(0, 10);
    const event = (await pool.query(
      `SELECT e.* FROM events e JOIN event_totems et ON et.event_id=e.id
       WHERE et.totem_id=$1 AND e.date_start<=$2 AND e.date_end>=$2 AND e.status='ativo'
       ORDER BY e.date_start DESC LIMIT 1`, [totem.id, today])).rows[0];
    if (!event) return res.status(400).json({ error: 'Nenhum evento ativo hoje' });
    const ep = (await pool.query(`
      SELECT ep.*, COALESCE(es.qty,0)::int as planned_today, COALESCE(es.is_exception,FALSE) as is_exception,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id AND DATE(d.distributed_at)=$3),0)::int AS distributed_today,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS distributed_total,
        COALESCE((SELECT SUM(es2.qty) FROM event_schedule es2 WHERE es2.event_prize_id=ep.id AND es2.is_exception=FALSE AND es2.day > $3),0)::int AS scheduled_future
      FROM event_prizes ep LEFT JOIN event_schedule es ON es.event_prize_id=ep.id AND es.day=$3
      WHERE ep.event_id=$1 AND ep.prize_id=$2`, [event.id, prize_id, today])).rows[0];
    if (!ep) return res.status(400).json({ error: 'Brinde não disponível neste evento' });
    if (ep.is_exception) return res.status(400).json({ error: 'Evento fechado hoje' });
    if (ep.distributed_total >= ep.allocated) return res.status(400).json({ error: 'Estoque total do evento esgotado' });
    if (ep.planned_today > 0) {
      if (ep.distributed_today >= ep.planned_today) return res.status(400).json({ error: `Cota diária esgotada (${ep.planned_today} para hoje)` });
    } else {
      const unscheduled = Math.max(0, (ep.allocated - ep.distributed_total) - ep.scheduled_future);
      if (unscheduled <= 0) return res.status(400).json({ error: 'Todas as unidades restantes estão reservadas para outros dias' });
    }
    const stock = (await pool.query('SELECT stock FROM prizes WHERE id=$1', [prize_id])).rows[0]?.stock;
    if (!stock || stock <= 0) return res.status(400).json({ error: 'Estoque físico esgotado' });
    await pool.query('UPDATE prizes SET stock=stock-1, updated_at=NOW() WHERE id=$1', [prize_id]);
    const r = await pool.query('INSERT INTO distributions (event_id,totem_id,prize_id,user_phone) VALUES ($1,$2,$3,$4) RETURNING *',
      [event.id, totem.id, prize_id, user_phone||null]);
    res.status(201).json({ success: true, distribution: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// DISTRIBUTIONS
// ════════════════════════════════════
app.get('/api/distributions', authMiddleware, async (req, res) => {
  const { event_id, totem_id, date } = req.query;
  try {
    let query = `SELECT d.*, t.name as totem_name, p.name as prize_name, e.name as event_name
                 FROM distributions d JOIN totems t ON d.totem_id=t.id JOIN prizes p ON d.prize_id=p.id
                 LEFT JOIN events e ON d.event_id=e.id WHERE t.client_id=$1`;
    const params = [req.client.id];
    if (event_id) { params.push(event_id); query += ` AND d.event_id=$${params.length}`; }
    if (totem_id) { params.push(totem_id); query += ` AND d.totem_id=$${params.length}`; }
    if (date) { params.push(date); query += ` AND DATE(d.distributed_at)=$${params.length}`; }
    query += ' ORDER BY d.distributed_at DESC LIMIT 200';
    res.json((await pool.query(query, params)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
// UNITY v2
// ════════════════════════════════════

// Guard: valida unity_key no header Authorization: Bearer <key>
async function unityKeyGuard(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const unity_key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!unity_key) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'Authorization header obrigatório' });
  try {
    const today = new Date().toISOString().substring(0, 10);
    const r = await pool.query(`
      SELECT a.id as activation_id, a.event_id, a.game_type, a.name as activation_name,
             e.name as event_name, e.status as event_status,
             e.date_start, e.date_end
      FROM activations a
      JOIN events e ON e.id = a.event_id
      WHERE a.unity_key = $1`, [unity_key]);
    if (!r.rows.length) return res.status(401).json({ success: false, code: 'INVALID_KEY', message: 'Unity key inválida' });
    const act = r.rows[0];
    if (act.event_status !== 'ativo') return res.status(403).json({ success: false, code: 'EVENT_INACTIVE', message: 'Evento não está ativo' });
    req.unity = act; // activation_id, event_id, game_type
    next();
  } catch (err) { res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message }); }
}

// ── Função central: resolve faixa a partir de pontuação ──
async function resolveTier(event_id, game_type, score, discrete_outcome) {
  const tiers = (await pool.query(
    `SELECT * FROM prize_tiers WHERE event_id=$1 AND game_type=$2 ORDER BY sort_order ASC`,
    [event_id, game_type])).rows;

  if (!tiers.length) return null;

  let matched = null;
  for (const tier of tiers) {
    if (tier.band_type === 'interval' && score != null) {
      if (score >= tier.score_min && score <= tier.score_max) { matched = tier; break; }
    }
    if (tier.band_type === 'discrete' && discrete_outcome != null) {
      if (tier.discrete_value === discrete_outcome) { matched = tier; break; }
    }
  }
  return matched;
}

// ── Função central: sorteio ponderado dentro da faixa ──
async function weightedDraw(tier_id, event_id) {
  // Busca brindes da faixa com estoque restante no evento
  const gifts = (await pool.query(`
    SELECT tg.id as tg_id, tg.event_prize_id, tg.configured_weight,
           p.id as prize_id, p.name as prize_name, p.color,
           ep.allocated,
           COALESCE((
             SELECT SUM(d.quantity) FROM distributions d
             WHERE d.prize_id = ep.prize_id AND d.event_id = ep.event_id
           ), 0)::int AS distributed_total
    FROM tier_gifts tg
    JOIN event_prizes ep ON ep.id = tg.event_prize_id
    JOIN prizes p ON p.id = ep.prize_id
    WHERE tg.tier_id = $1 AND ep.event_id = $2`,
    [tier_id, event_id])).rows;

  // Filtra os que ainda têm estoque no evento
  const eligible = gifts.filter(g => (g.allocated - g.distributed_total) > 0);
  if (!eligible.length) return null;

  // Calcula peso_final = peso_configurado × estoque_restante
  const weighted = eligible.map(g => ({
    ...g,
    stock_remaining: g.allocated - g.distributed_total,
    weight_final: parseFloat(g.configured_weight) * (g.allocated - g.distributed_total),
  }));

  const total_weight = weighted.reduce((s, g) => s + g.weight_final, 0);
  if (total_weight <= 0) return null;

  // Sorteio: número aleatório entre 0 e total_weight
  let rand = Math.random() * total_weight;
  for (const g of weighted) {
    rand -= g.weight_final;
    if (rand <= 0) return g;
  }
  return weighted[weighted.length - 1]; // fallback
}

// ── POST /api/v2/unity/round/complete ──
// Unity chama após o jogo terminar com a pontuação final
app.post('/api/v2/unity/round/complete', unityKeyGuard, async (req, res) => {
  const { gameType, score, discreteOutcome, clientRoundId, metadata } = req.body;
  const { activation_id, event_id } = req.unity;
  const gt = gameType || req.unity.game_type;

  // Idempotência: se já processou essa rodada, devolve o mesmo resultado
  if (clientRoundId) {
    const existing = (await pool.query(
      `SELECT * FROM play_records WHERE activation_id=$1 AND client_round_id=$2`,
      [activation_id, clientRoundId])).rows[0];
    if (existing) {
      return res.json({
        success: true,
        code: 'IDEMPOTENT_REPLAY',
        data: {
          tierId: existing.tier_id,
          tierLabel: existing.tier_label,
          gift: existing.had_prize ? { id: existing.prize_id, name: existing.gift_name } : null,
          resolvedFrom: { score: existing.score, discreteOutcome: existing.discrete_outcome },
        }
      });
    }
  }

  try {
    // 1. Resolve faixa
    const tier = await resolveTier(event_id, gt, score ?? null, discreteOutcome ?? null);

    if (!tier) {
      // Sem faixa configurada para essa pontuação
      await pool.query(
        `INSERT INTO play_records (activation_id,event_id,game_type,score,discrete_outcome,tier_label,had_prize,client_round_id)
         VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7)`,
        [activation_id, event_id, gt, score??null, discreteOutcome??null, null, clientRoundId||null]);
      return res.json({
        success: true, code: 'NO_TIER_CONFIGURED',
        data: { tierId: null, tierLabel: null, gift: null,
          resolvedFrom: { score: score??null, discreteOutcome: discreteOutcome??null } },
        message: 'Nenhuma faixa configurada para esta pontuação.'
      });
    }

    // 2. Faixa de participação (sem prêmio)
    if (tier.outcome_type === 'NO_PRIZE') {
      await pool.query(
        `INSERT INTO play_records (activation_id,event_id,tier_id,game_type,score,discrete_outcome,tier_label,had_prize,client_round_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8)`,
        [activation_id, event_id, tier.id, gt, score??null, discreteOutcome??null, tier.name, clientRoundId||null]);
      return res.json({
        success: true, code: 'NO_PRIZE_TIER',
        data: { tierId: tier.id, tierLabel: tier.name, gift: null,
          resolvedFrom: { score: score??null, band: tier.band_type==='interval'?{min:tier.score_min,max:tier.score_max}:null,
            discreteValue: tier.band_type==='discrete'?tier.discrete_value:null } },
        message: 'Faixa de participação — sem prêmio.'
      });
    }

    // 3. Sorteio ponderado dentro da faixa
    const winner = await weightedDraw(tier.id, event_id);

    if (!winner) {
      // Todos os brindes da faixa sem estoque
      await pool.query(
        `INSERT INTO play_records (activation_id,event_id,tier_id,game_type,score,discrete_outcome,tier_label,had_prize,client_round_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,FALSE,$8)`,
        [activation_id, event_id, tier.id, gt, score??null, discreteOutcome??null, tier.name, clientRoundId||null]);
      return res.json({
        success: true, code: 'NO_STOCK',
        data: { tierId: tier.id, tierLabel: tier.name, gift: null,
          resolvedFrom: { score: score??null } },
        message: 'Sem estoque disponível nesta faixa.'
      });
    }

    // 4. Decrementa estoque e registra a saída
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      // Decrementa estoque físico do brinde
      await cl.query('UPDATE prizes SET stock=stock-1, updated_at=NOW() WHERE id=$1', [winner.prize_id]);
      // Registra na tabela distributions (mesma usada pelo totem manual)
      await cl.query(
        `INSERT INTO distributions (event_id,totem_id,prize_id,quantity)
         SELECT $1, t.id, $2, 1 FROM event_totems et
         JOIN totems t ON t.id=et.totem_id
         WHERE et.event_id=$1 LIMIT 1`,
        [event_id, winner.prize_id]);
      // Registra o play_record
      await cl.query(
        `INSERT INTO play_records (activation_id,event_id,tier_id,prize_id,game_type,score,discrete_outcome,tier_label,gift_name,had_prize,client_round_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10)`,
        [activation_id, event_id, tier.id, winner.prize_id, gt,
         score??null, discreteOutcome??null, tier.name, winner.prize_name, clientRoundId||null]);
      await cl.query('COMMIT');
    } catch(e) { await cl.query('ROLLBACK'); throw e; }
    finally { cl.release(); }

    // 5. Resposta final
    res.json({
      success: true, code: 'OK',
      data: {
        tierId: tier.id,
        tierLabel: tier.name,
        gift: { id: winner.prize_id, name: winner.prize_name, color: winner.color },
        resolvedFrom: {
          score: score??null,
          discreteOutcome: discreteOutcome??null,
          band: tier.band_type==='interval' ? { min: tier.score_min, max: tier.score_max } : null,
          discreteValue: tier.band_type==='discrete' ? tier.discrete_value : null,
        },
        stockRemainingForGift: winner.stock_remaining - 1,
        drawDetails: {
          poolSize: null, // preenchido abaixo se quiser debug
          weightFinal: winner.weight_final,
        }
      }
    });
  } catch (err) { res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /api/v2/unity/round/preview ──
// Unity chama ANTES do jogo para saber qual faixa mirar (não consome estoque)
app.get('/api/v2/unity/round/preview', unityKeyGuard, async (req, res) => {
  const { event_id, game_type } = req.unity;
  try {
    const tiers = (await pool.query(
      `SELECT * FROM prize_tiers WHERE event_id=$1 AND game_type=$2 AND outcome_type='PRIZE' ORDER BY sort_order ASC`,
      [event_id, game_type])).rows;

    if (!tiers.length) {
      return res.json({ success: true, code: 'NO_TIERS', data: { targetTier: null, period: { blocked: true, reason: 'no_tiers' } } });
    }

    // Encontra a faixa com melhor estoque disponível (heurística: maior soma de pesos)
    let bestTier = null, bestWeight = -1;
    for (const tier of tiers) {
      const gifts = (await pool.query(`
        SELECT tg.configured_weight, ep.allocated,
          COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS dist
        FROM tier_gifts tg JOIN event_prizes ep ON ep.id=tg.event_prize_id
        WHERE tg.tier_id=$1`, [tier.id])).rows;
      const totalWeight = gifts.reduce((s, g) => s + parseFloat(g.configured_weight) * Math.max(0, g.allocated - g.dist), 0);
      if (totalWeight > bestWeight) { bestWeight = totalWeight; bestTier = tier; }
    }

    if (!bestTier || bestWeight <= 0) {
      return res.json({ success: true, code: 'PERIOD_CAP_REACHED', data: { targetTier: null, period: { blocked: true, reason: 'no_stock' } }, message: 'Sem estoque disponível.' });
    }

    res.json({
      success: true, code: 'OK',
      data: {
        gameType: game_type,
        targetTierId: bestTier.id,
        targetTierLabel: bestTier.name,
        scoreRange: bestTier.band_type === 'interval' ? { min: bestTier.score_min, max: bestTier.score_max } : null,
        discreteValue: bestTier.band_type === 'discrete' ? bestTier.discrete_value : null,
        period: { blocked: false, reason: null }
      }
    });
  } catch (err) { res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /api/v2/unity/health ──
app.get('/api/v2/unity/health', unityKeyGuard, async (req, res) => {
  const today = new Date().toISOString().substring(0, 10);
  try {
    const plays = (await pool.query(
      `SELECT COUNT(*)::int as total, SUM(CASE WHEN had_prize THEN 1 ELSE 0 END)::int as with_prize
       FROM play_records WHERE activation_id=$1 AND DATE(created_at)=$2`,
      [req.unity.activation_id, today])).rows[0];
    res.json({
      success: true, code: 'OK',
      data: {
        status: 'ok',
        eventId: req.unity.event_id,
        eventName: req.unity.event_name,
        activationId: req.unity.activation_id,
        activationName: req.unity.activation_name,
        gameType: req.unity.game_type,
        todayRounds: plays.total || 0,
        todayPrizes: plays.with_prize || 0,
        ts: new Date().toISOString(),
      }
    });
  } catch (err) { res.status(500).json({ success: false, code: 'SERVER_ERROR', message: err.message }); }
});

// ── GET /api/v2/unity/rounds ── histórico de rodadas (admin)
app.get('/api/events/:event_id/rounds', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT pr.*, a.name as activation_name
      FROM play_records pr
      JOIN activations a ON a.id = pr.activation_id
      WHERE pr.event_id=$1
      ORDER BY pr.created_at DESC LIMIT 200`, [req.params.event_id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: 'online', timestamp: new Date().toISOString() }));
app.use((err, req, res, next) => res.status(500).json({ error: 'Erro interno' }));

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`🎪 http://localhost:${PORT}`)));