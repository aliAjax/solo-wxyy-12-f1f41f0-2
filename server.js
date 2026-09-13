const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// 批次只能走专用的草稿/提交/完成接口，通用增改删接口对其关闭
const RESERVED_COLLECTIONS = new Set(['batches']);

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

// 每次提交和状态变化都留下处置人、时间和原因
function stamp(action, note, by) {
  return {
    at: new Date().toISOString(),
    by: by || '系统',
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

const levelRank = { '低': 1, '中': 2, '高': 3 };

function runAction(db, action, item, extras = {}) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const by = extras.by || '系统';
  for (const guard of action.guards || []) {
    const left = guard.left ? getValue(context, guard.left) : undefined;
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
    if (guard.op === 'noOpenReview') {
      // 关联集合中存在「异常待复查」记录时拒绝；selfField/selfValue 可限定仅在自身处于某状态时生效
      const applies = !guard.selfField || getValue(context, `item.${guard.selfField}`) === guard.selfValue;
      if (applies) {
        const pending = (db[guard.collection] || []).some(
          (entry) => entry[guard.foreignKey] === item.id && entry.status === '异常待复查'
        );
        if (pending) return { error: guard.message };
      }
    }
  }
  const stamped = new Set();
  const touch = (target, note) => {
    target.updatedAt = new Date().toISOString();
    if (stamped.has(target)) return;
    stamped.add(target);
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, note, by));
  };
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath
      ? getValue(context, patch.valuePath)
      : patch.value === '$now'
        ? new Date().toISOString()
        : patch.value;
    setValue(target, patch.field, next);
    touch(target, extras.note || action.note || '状态流转');
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    touch(target, extras.note || action.note || '数量调整');
  }
  return { item };
}

// ---- 巡测批次规则 ----

function num(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 温度或 CO2 高于基准、湿度低于基准，视为读数越过样点基准
function crossesBaseline(site, reading) {
  const temp = num(reading.temperature);
  const humidity = num(reading.humidity);
  const co2 = num(reading.co2);
  if (temp !== null && num(site.baselineTemp) !== null && temp > num(site.baselineTemp)) return true;
  if (humidity !== null && num(site.baselineHumidity) !== null && humidity < num(site.baselineHumidity)) return true;
  if (co2 !== null && num(site.baselineCo2) !== null && co2 > num(site.baselineCo2)) return true;
  return false;
}

function hasDisturbance(reading) {
  return String(reading.disturbance || '').trim().length > 0;
}

const READING_FIELDS = [
  ['temperature', '温度'],
  ['humidity', '湿度'],
  ['co2', 'CO2'],
  ['dripRate', '滴水频率']
];

function validateBatch(db, body) {
  const errors = [];
  if (!body.batchKey) errors.push('缺少批次标识');
  if (!body.route) errors.push('请选择巡测路线');
  if (!body.surveyor || !String(body.surveyor).trim()) errors.push('请填写巡测人员');
  if (!body.shiftDate) errors.push('请填写班次日期');
  const readings = Array.isArray(body.readings) ? body.readings : [];
  if (!readings.length) errors.push('批次至少包含一个样点读数');
  readings.forEach((reading, index) => {
    const label = `第 ${index + 1} 条读数`;
    const site = db.sites.find((entry) => entry.id === reading.siteId);
    if (!site) {
      errors.push(`${label}的样点不存在`);
      return;
    }
    for (const [field, name] of READING_FIELDS) {
      if (num(reading[field]) === null) errors.push(`${label}（${site.pointCode}）缺少有效${name}`);
    }
  });
  return errors;
}

function createApp(dbFile) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // 串行化全部写操作，避免两个终端并发补交时出现读-改-写竞争
  let queue = Promise.resolve();
  function mutate(fn) {
    const run = queue.then(fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readDb() {
    const raw = await fs.readFile(dbFile, 'utf8');
    return JSON.parse(raw);
  }

  async function writeDb(db) {
    await fs.writeFile(dbFile, JSON.stringify(db, null, 2) + '\n');
  }

  function respond(res, result) {
    res.status(result.status).json(result.body);
  }

  app.get('/api/config', (req, res) => {
    res.json(config);
  });

  app.get('/api/db', async (req, res) => {
    const db = await readDb();
    for (const key of Object.keys(db)) {
      if (Array.isArray(db[key])) db[key].sort(sortNewest);
    }
    res.json(db);
  });

  // 暂存草稿：按 batchKey 幂等 upsert，已提交的批次不允许被草稿覆盖
  app.put('/api/batches/draft/:batchKey', async (req, res) => {
    try {
      const result = await mutate(async () => {
        const db = await readDb();
        const { batchKey } = req.params;
        const existing = db.batches.find((entry) => entry.batchKey === batchKey);
        if (existing && existing.status !== '草稿') {
          return { status: 409, body: { error: '批次已提交，草稿不能覆盖已生效的结果', conflict: true } };
        }
        const now = new Date().toISOString();
        const by = req.body.by || req.body.surveyor || '系统';
        const draft = existing || { id: newId('batch'), batchKey, createdAt: now, history: [] };
        Object.assign(draft, {
          terminalId: req.body.terminalId || draft.terminalId || '',
          route: req.body.route || '',
          shiftDate: req.body.shiftDate || '',
          surveyor: req.body.surveyor || '',
          readings: Array.isArray(req.body.readings) ? req.body.readings : [],
          status: '草稿',
          updatedAt: now
        });
        draft.history.unshift(stamp(existing ? '更新草稿' : '暂存草稿', req.body.note || '班次结束前暂存，恢复连接后可补交', by));
        if (!existing) db.batches.push(draft);
        await writeDb(db);
        return { status: existing ? 200 : 201, body: draft };
      });
      respond(res, result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 提交批次：同一终端重复提交返回已有结果；不同终端提交同一批次判定冲突
  app.post('/api/batches/submit', async (req, res) => {
    try {
      const result = await mutate(async () => {
        const db = await readDb();
        const body = req.body || {};
        const existing = db.batches.find((entry) => entry.batchKey === body.batchKey);
        if (existing && existing.status !== '草稿') {
          if ((existing.terminalId || '') === (body.terminalId || '')) {
            return { status: 200, body: { ...existing, deduplicated: true } };
          }
          return {
            status: 409,
            body: { error: '该批次已由另一终端提交，仅保留一份有效结果', conflict: true, batchId: existing.id }
          };
        }
        const errors = validateBatch(db, body);
        if (errors.length) return { status: 400, body: { error: errors.join('；') } };
        const now = new Date().toISOString();
        const by = body.by || body.surveyor || '系统';
        let flaggedCount = 0;
        const readings = body.readings.map((reading) => {
          const site = db.sites.find((entry) => entry.id === reading.siteId);
          const crossed = crossesBaseline(site, reading);
          const flagged = crossed && hasDisturbance(reading);
          if (flagged) flaggedCount += 1;
          return {
            siteId: reading.siteId,
            temperature: num(reading.temperature),
            humidity: num(reading.humidity),
            co2: num(reading.co2),
            dripRate: num(reading.dripRate),
            disturbance: String(reading.disturbance || '').trim(),
            photoUrl: String(reading.photoUrl || ''),
            crossedBaseline: crossed,
            flagged
          };
        });
        const batch = existing || { id: newId('batch'), batchKey: body.batchKey, createdAt: now, history: [] };
        Object.assign(batch, {
          terminalId: body.terminalId || '',
          route: body.route,
          shiftDate: body.shiftDate,
          surveyor: String(body.surveyor).trim(),
          readings,
          flaggedCount,
          status: flaggedCount > 0 ? '待复核' : '已提交',
          submittedAt: now,
          updatedAt: now
        });
        batch.history.unshift(
          stamp('提交批次', body.note || (flaggedCount > 0 ? `提交完成，${flaggedCount} 条读数自动进入待复核` : '提交完成，读数全部正常'), by)
        );
        if (!existing) db.batches.push(batch);
        for (const reading of readings) {
          db.surveys.push({
            id: newId('survey'),
            batchId: batch.id,
            batchKey: batch.batchKey,
            siteId: reading.siteId,
            surveyor: batch.surveyor,
            date: batch.shiftDate,
            temperature: reading.temperature,
            humidity: reading.humidity,
            co2: reading.co2,
            dripRate: reading.dripRate,
            disturbance: reading.disturbance,
            photoUrl: reading.photoUrl,
            status: reading.flagged ? '异常待复查' : '正常',
            reviewNote: '',
            createdAt: now,
            updatedAt: now,
            history: [
              stamp('创建', reading.flagged ? '批次提交：读数越过样点基准且记录干扰痕迹，自动进入待复核' : '批次提交登记', by)
            ]
          });
        }
        await writeDb(db);
        return { status: existing ? 200 : 201, body: batch };
      });
      respond(res, result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/:collection', async (req, res) => {
    try {
      const result = await mutate(async () => {
        const db = await readDb();
        const { collection } = req.params;
        if (!Array.isArray(db[collection])) return { status: 404, body: { error: 'unknown collection' } };
        if (RESERVED_COLLECTIONS.has(collection)) {
          return { status: 405, body: { error: '巡测批次请使用草稿/提交专用接口' } };
        }
        const by = req.body.by;
        delete req.body.by;
        const now = new Date().toISOString();
        const item = {
          id: newId(collection),
          ...req.body,
          createdAt: now,
          updatedAt: now,
          history: [stamp('创建', req.body.note || req.body.memo || '', by)]
        };
        db[collection].push(item);
        await writeDb(db);
        return { status: 201, body: item };
      });
      respond(res, result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/:collection/:id', async (req, res) => {
    try {
      const result = await mutate(async () => {
        const db = await readDb();
        const { collection, id } = req.params;
        if (!Array.isArray(db[collection])) return { status: 404, body: { error: 'unknown collection' } };
        if (RESERVED_COLLECTIONS.has(collection)) {
          return { status: 405, body: { error: '巡测批次请使用草稿/提交专用接口' } };
        }
        const item = db[collection].find((entry) => entry.id === id);
        if (!item) return { status: 404, body: { error: 'not found' } };
        const by = req.body.by;
        delete req.body.by;
        const historyAction = req.body.historyAction;
        delete req.body.historyAction;
        Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
        item.history = item.history || [];
        if (historyAction || req.body.note || req.body.memo || req.body.status) {
          item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || '', by));
        }
        await writeDb(db);
        return { status: 200, body: item };
      });
      respond(res, result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/:collection/:id', async (req, res) => {
    try {
      const result = await mutate(async () => {
        const db = await readDb();
        const { collection, id } = req.params;
        if (!Array.isArray(db[collection])) return { status: 404, body: { error: 'unknown collection' } };
        if (RESERVED_COLLECTIONS.has(collection)) {
          return { status: 405, body: { error: '巡测批次请使用草稿/提交专用接口' } };
        }
        const before = db[collection].length;
        db[collection] = db[collection].filter((entry) => entry.id !== id);
        if (db[collection].length === before) return { status: 404, body: { error: 'not found' } };
        await writeDb(db);
        return { status: 204, body: null };
      });
      if (result.status === 204) return res.status(204).end();
      respond(res, result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/action/:actionId/:id', async (req, res) => {
    try {
      const result = await mutate(async () => {
        const db = await readDb();
        const action = config.actions.find((entry) => entry.id === req.params.actionId);
        if (!action) return { status: 404, body: { error: 'unknown action' } };
        const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
        if (!item) return { status: 404, body: { error: 'not found' } };
        const out = runAction(db, action, item, { by: req.body?.by, note: req.body?.note });
        if (out.error) return { status: 409, body: { error: out.error } };
        await writeDb(db);
        return { status: 200, body: out.item };
      });
      respond(res, result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return app;
}

if (require.main === module) {
  createApp(DB_FILE).listen(PORT, () => {
    console.log(`${config.title} running at http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
