const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_R9jgB8rvZNIO@ep-muddy-king-apbwf358-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

function genAccessId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = 'TM-';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
function hashPin(pin) {
  return crypto.createHash('sha256').update(pin + 'salt_brinde_2025').digest('hex');
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
    console.log('✓ Database inicializado');
  } catch (err) { console.error('✗ initDB:', err.message); }
}

// ══ AUTH ══
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

// ══ TOTENS ══
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
    const r = await pool.query('INSERT INTO totems (client_id,name,location,access_id) VALUES ($1,$2,$3,$4) RETURNING *',
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
      `UPDATE totems SET name=COALESCE($1,name), location=COALESCE($2,location), status=COALESCE($3,status), updated_at=NOW() WHERE id=$4 AND client_id=$5 RETURNING *`,
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

// ══ BRINDES ══
app.post('/api/prizes', authMiddleware, async (req, res) => {
  const { name, color, stock, description } = req.body;
  try {
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const r = await pool.query('INSERT INTO prizes (client_id,name,color,stock,description) VALUES ($1,$2,$3,$4,$5) RETURNING *',
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
      `UPDATE prizes SET name=COALESCE($1,name), color=COALESCE($2,color), stock=COALESCE($3,stock), description=COALESCE($4,description), updated_at=NOW() WHERE id=$5 AND client_id=$6 RETURNING *`,
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

// ══ EVENTOS ══
app.post('/api/events', authMiddleware, async (req, res) => {
  const { name, description, date_start, date_end, totem_ids } = req.body;
  try {
    if (!name || !date_start || !date_end) return res.status(400).json({ error: 'Nome, data início e data fim obrigatórios' });
    if (date_start > date_end) return res.status(400).json({ error: 'Data início deve ser anterior à data fim' });
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      const r = await cl.query('INSERT INTO events (client_id,name,description,date_start,date_end) VALUES ($1,$2,$3,$4,$5) RETURNING *',
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
      const totems = await pool.query(`SELECT t.id,t.name,t.access_id,t.location FROM event_totems et JOIN totems t ON t.id=et.totem_id WHERE et.event_id=$1`, [ev.id]);
      const prizes = await pool.query(`SELECT COUNT(DISTINCT ep.prize_id)::int as prize_count, COALESCE(SUM(ep.allocated),0)::int as total_allocated FROM event_prizes ep WHERE ep.event_id=$1`, [ev.id]);
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
    ev.totems = (await pool.query(`SELECT t.id,t.name,t.access_id,t.location FROM event_totems et JOIN totems t ON t.id=et.totem_id WHERE et.event_id=$1`, [ev.id])).rows;
    res.json(ev);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/api/events/:id', authMiddleware, async (req, res) => {
  const { name, description, date_start, date_end, status } = req.body;
  try {
    const r = await pool.query(
      `UPDATE events SET name=COALESCE($1,name), description=COALESCE($2,description), date_start=COALESCE($3,date_start), date_end=COALESCE($4,date_end), status=COALESCE($5,status), updated_at=NOW() WHERE id=$6 AND client_id=$7 RETURNING *`,
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
  try { await pool.query('DELETE FROM event_totems WHERE event_id=$1 AND totem_id=$2', [req.params.id, req.params.totem_id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ EVENT PRIZES ══
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
    const s = (await pool.query(`SELECT p.stock, COALESCE((SELECT SUM(ep2.allocated) FROM event_prizes ep2 WHERE ep2.prize_id=p.id AND ep2.event_id!=$2),0)::int AS reservado FROM prizes p WHERE p.id=$1 AND p.client_id=$3`, [prize_id, event_id, req.client.id])).rows[0];
    if (!s) return res.status(404).json({ error: 'Brinde não encontrado' });
    const disponivel = s.stock - s.reservado;
    if (allocated > disponivel) return res.status(400).json({ error: `Apenas ${disponivel} unidade(s) disponível(is)` });
    const r = await pool.query(
      `INSERT INTO event_prizes (event_id,prize_id,allocated) VALUES ($1,$2,$3) ON CONFLICT (event_id,prize_id) DO UPDATE SET allocated=$3, updated_at=NOW() RETURNING *`,
      [event_id, prize_id, allocated]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/events/:event_id/prizes/:id', authMiddleware, async (req, res) => {
  try {
    const check = (await pool.query(
      `SELECT ep.id, ep.allocated FROM event_prizes ep JOIN events e ON e.id=ep.event_id WHERE ep.id=$1 AND ep.event_id=$2 AND e.client_id=$3`,
      [req.params.id, req.params.event_id, req.client.id])).rows[0];
    if (!check) return res.status(404).json({ error: 'Não encontrado' });
    await pool.query('DELETE FROM event_prizes WHERE id=$1', [req.params.id]);
    res.json({ success: true, returned: check.allocated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══ SCHEDULE ══

// GET — retorna schedule do mês + unscheduled map por event_prize_id
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
      FROM event_schedule es
      JOIN event_prizes ep ON es.event_prize_id=ep.id
      WHERE ep.event_id=$1${monthFilter}
      ORDER BY es.day ASC`, params)).rows;

    // unscheduled = allocated - scheduled_from_today - distributed_total (global, todos os meses)
    const epRows = (await pool.query(`
      SELECT ep.id as ep_id, ep.allocated,
        COALESCE((SELECT SUM(es.qty) FROM event_schedule es WHERE es.event_prize_id=ep.id AND es.is_exception=FALSE AND es.day >= $2),0)::int AS sched_future,
        COALESCE((SELECT SUM(d.quantity) FROM distributions d WHERE d.prize_id=ep.prize_id AND d.event_id=ep.event_id),0)::int AS dist_total
      FROM event_prizes ep WHERE ep.event_id=$1`, [req.params.event_id, today])).rows;

    const unscheduled = {};
    for (const ep of epRows) {
      unscheduled[ep.ep_id] = Math.max(0, ep.allocated - ep.sched_future - ep.dist_total);
    }

    res.json({ schedule, unscheduled });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /schedule/day — salva 1 dia (modal individual)
app.post('/api/events/:event_id/schedule/day', authMiddleware, async (req, res) => {
  const { day, is_exception, items } = req.body;
  const event_id = req.params.event_id;
  if (!day) return res.status(400).json({ error: 'day obrigatório' });
  const today = new Date().toISOString().substring(0, 10);
  const cl = await pool.connect();
  try {
    await cl.query('BEGIN');
    const epIds = (await cl.query('SELECT id FROM event_prizes WHERE event_id=$1', [event_id])).rows.map(r => r.id);

    // Zera o dia para todos os brindes do evento
    for (const epId of epIds) {
      await cl.query(
        `INSERT INTO event_schedule (event_prize_id,day,qty,is_exception) VALUES ($1,$2,0,$3)
         ON CONFLICT (event_prize_id,day) DO UPDATE SET qty=0, is_exception=$3, updated_at=NOW()`,
        [epId, day, !!is_exception]);
    }

    if (!is_exception) {
      for (const item of (items || [])) {
        if (!item.qty || item.qty <= 0) continue;
        // Máximo = allocated - distributed_total - scheduled em outros dias futuros (exceto este dia)
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

// POST /schedule/bulk — salva múltiplos dias em 1 transação
// Body: { days: [ { day, is_exception, items: [{event_prize_id, qty}] } ] }
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

    const epMap = {}; // ep_id -> { allocated, dist_total }
    for (const ep of epRows) epMap[ep.id] = { allocated: ep.allocated, dist_total: ep.dist_total };

    for (const dayObj of days) {
      const { day, is_exception, items } = dayObj;

      // Zera o dia para todos
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
          // Scheduled em outros dias futuros exceto este dia
          // (lê do banco pois outros itens do batch já podem ter sido inseridos)
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

// ══ TOTEM DEVICE ══
app.get('/api/totem/:access_id/today', async (req, res) => {
  try {
    const totem = (await pool.query('SELECT * FROM totems WHERE access_id=$1', [req.params.access_id])).rows[0];
    if (!totem) return res.status(404).json({ error: 'Totem não encontrado' });
    const today = new Date().toISOString().substring(0, 10);
    const event = (await pool.query(
      `SELECT e.* FROM events e JOIN event_totems et ON et.event_id=e.id WHERE et.totem_id=$1 AND e.date_start<=$2 AND e.date_end>=$2 AND e.status='ativo' ORDER BY e.date_start DESC LIMIT 1`,
      [totem.id, today])).rows[0];
    if (!event) return res.json({ totem: { id: totem.id, name: totem.name }, event: null, prizes: [], message: 'Nenhum evento ativo hoje' });
    const rows = (await pool.query(`
      SELECT ep.id as event_prize_id, ep.prize_id, ep.allocated, p.name as prize_name, p.color, p.description,
        COALESCE(es.qty,0)::int as planned_today,
        COALESCE(es.is_exception,FALSE) as is_exception,
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
      `SELECT e.* FROM events e JOIN event_totems et ON et.event_id=e.id WHERE et.totem_id=$1 AND e.date_start<=$2 AND e.date_end>=$2 AND e.status='ativo' ORDER BY e.date_start DESC LIMIT 1`,
      [totem.id, today])).rows[0];
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

// ══ DISTRIBUTIONS ══
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

// ══ MIGRATION ══
app.post('/api/migrate', async (req, res) => {
  try {
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      await cl.query(`CREATE TABLE IF NOT EXISTS clients (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE, pin_hash VARCHAR(64) NOT NULL, session_token VARCHAR(64), created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
      const existing = await cl.query('SELECT id FROM clients LIMIT 1');
      let clientId;
      if (!existing.rows.length) {
        clientId = (await cl.query(`INSERT INTO clients (name,email,pin_hash) VALUES ('Admin','admin@admin.com',$1) RETURNING id`, [hashPin('1234')])).rows[0].id;
      } else { clientId = existing.rows[0].id; }
      await cl.query(`ALTER TABLE totems ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE;`);
      await cl.query(`ALTER TABLE totems ADD COLUMN IF NOT EXISTS access_id VARCHAR(20);`);
      await cl.query(`UPDATE totems SET client_id=$1 WHERE client_id IS NULL`, [clientId]);
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (const t of (await cl.query(`SELECT id FROM totems WHERE access_id IS NULL`)).rows) {
        let aid = 'TM-'; for (let i=0;i<6;i++) aid+=chars[Math.floor(Math.random()*chars.length)];
        await cl.query(`UPDATE totems SET access_id=$1 WHERE id=$2`, [aid, t.id]);
      }
      await cl.query(`DO $$ BEGIN BEGIN ALTER TABLE totems ALTER COLUMN client_id SET NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END; END $$;`);
      await cl.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='totems_access_id_key') THEN ALTER TABLE totems ADD CONSTRAINT totems_access_id_key UNIQUE (access_id); END IF; END $$;`);
      await cl.query(`ALTER TABLE prizes ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE;`);
      await cl.query(`UPDATE prizes SET client_id=$1 WHERE client_id IS NULL`, [clientId]);
      await cl.query(`DO $$ BEGIN BEGIN ALTER TABLE prizes ALTER COLUMN client_id SET NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END; END $$;`);
      await cl.query(`CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, name VARCHAR(255) NOT NULL, description TEXT, date_start DATE NOT NULL, date_end DATE NOT NULL, status VARCHAR(50) DEFAULT 'ativo', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
      await cl.query(`CREATE TABLE IF NOT EXISTS event_totems (id SERIAL PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, totem_id INTEGER NOT NULL REFERENCES totems(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(event_id,totem_id));`);
      await cl.query(`CREATE TABLE IF NOT EXISTS event_prizes (id SERIAL PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, prize_id INTEGER NOT NULL REFERENCES prizes(id) ON DELETE CASCADE, allocated INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(event_id,prize_id));`);
      await cl.query(`CREATE TABLE IF NOT EXISTS event_schedule (id SERIAL PRIMARY KEY, event_prize_id INTEGER NOT NULL REFERENCES event_prizes(id) ON DELETE CASCADE, day DATE NOT NULL, qty INTEGER DEFAULT 0, is_exception BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(event_prize_id,day));`);
      await cl.query(`ALTER TABLE distributions ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE SET NULL;`);
      await cl.query('COMMIT');
      res.json({ success: true, client_id: clientId, message: 'Migration concluída! Login: admin@admin.com / PIN: 1234' });
    } catch (e) { await cl.query('ROLLBACK'); throw e; }
    finally { cl.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ status: 'online', timestamp: new Date().toISOString() }));
app.use((err, req, res, next) => res.status(500).json({ error: 'Erro interno' }));

const PORT = process.env.PORT || 3000;
pool.on('error', err => console.error('Pool error:', err));
initDB().then(() => app.listen(PORT, () => console.log(`🎪 http://localhost:${PORT}`)));