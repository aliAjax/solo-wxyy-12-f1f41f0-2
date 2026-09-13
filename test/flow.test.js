const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

function seedDb() {
  return {
    sites: [
      {
        id: 'site-a',
        cave: '北麓三号洞',
        zone: '滴水帘区',
        pointCode: 'D-07',
        route: '西线巡测',
        sensitivity: '高',
        protectedStatus: '常规观察',
        baselineTemp: 16,
        baselineHumidity: 90,
        baselineCo2: 700,
        note: '',
        createdAt: '2026-06-14T08:00:00.000Z',
        updatedAt: '2026-06-14T08:00:00.000Z',
        history: []
      },
      {
        id: 'site-b',
        cave: '北麓三号洞',
        zone: '石笋廊道',
        pointCode: 'D-08',
        route: '西线巡测',
        sensitivity: '中',
        protectedStatus: '暂停开放',
        baselineTemp: 15,
        baselineHumidity: 88,
        baselineCo2: 650,
        note: '',
        createdAt: '2026-06-14T08:00:00.000Z',
        updatedAt: '2026-06-14T08:00:00.000Z',
        history: []
      },
      {
        id: 'site-c',
        cave: '北麓三号洞',
        zone: '地下河滩',
        pointCode: 'D-11',
        route: '东线巡测',
        sensitivity: '低',
        protectedStatus: '常规观察',
        baselineTemp: 14,
        baselineHumidity: 85,
        baselineCo2: 600,
        note: '',
        createdAt: '2026-06-14T08:00:00.000Z',
        updatedAt: '2026-06-14T08:00:00.000Z',
        history: []
      }
    ],
    surveys: [],
    batches: []
  };
}

async function startServer(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cave-test-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
  const server = createApp(file).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    readDb: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function call(base, method, pathName, body) {
  const res = await fetch(base + pathName, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function batchPayload(overrides = {}) {
  return {
    batchKey: 'bk-test-1',
    terminalId: 'term-A',
    route: '西线巡测',
    shiftDate: '2026-09-13',
    surveyor: '沈宁',
    by: '沈宁',
    readings: [
      { siteId: 'site-a', temperature: 15.5, humidity: 93, co2: 640, dripRate: 10, disturbance: '' },
      { siteId: 'site-b', temperature: 14.2, humidity: 90, co2: 600, dripRate: 8, disturbance: '' }
    ],
    ...overrides
  };
}

test('旧版单条登记、查询和状态流转保持可用', async () => {
  const ctx = await startServer(seedDb());
  try {
    // 单条登记样点
    const site = await call(ctx.base, 'POST', '/api/sites', {
      cave: '南口二号洞',
      zone: '钟乳石厅',
      pointCode: 'N-03',
      route: '南线巡测',
      sensitivity: '中',
      protectedStatus: '常规观察',
      baselineTemp: 15,
      baselineHumidity: 87,
      baselineCo2: 620,
      note: '',
      by: '管理员'
    });
    assert.equal(site.status, 201);
    assert.equal(site.body.history[0].by, '管理员');
    assert.equal(site.body.history[0].action, '创建');

    // 旧版单条巡测登记
    const survey = await call(ctx.base, 'POST', '/api/surveys', {
      siteId: 'site-a',
      surveyor: '沈宁',
      date: '2026-09-13',
      temperature: 15.8,
      humidity: 91,
      co2: 660,
      dripRate: 9,
      disturbance: '',
      photoUrl: '',
      status: '正常',
      reviewNote: '',
      by: '沈宁'
    });
    assert.equal(survey.status, 201);
    assert.equal(survey.body.status, '正常');

    // 列表与筛选数据完整返回
    const db = await call(ctx.base, 'GET', '/api/db');
    assert.equal(db.body.sites.length, 4);
    assert.equal(db.body.surveys.length, 1);
    assert.ok(Array.isArray(db.body.batches));

    // 旧版状态流转：标记异常 -> 样点联动重点保护 -> 完成复查
    const alerted = await call(ctx.base, 'POST', `/api/action/survey-alert/${survey.body.id}`, { by: '沈宁', note: 'CO2 偏高' });
    assert.equal(alerted.status, 200);
    assert.equal(alerted.body.status, '异常待复查');
    const siteAfterAlert = await call(ctx.base, 'GET', '/api/db');
    assert.equal(siteAfterAlert.body.sites.find((s) => s.id === 'site-a').protectedStatus, '重点保护');

    const reviewed = await call(ctx.base, 'POST', `/api/action/survey-review/${survey.body.id}`, { by: '复查员', note: '现场复核正常' });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.status, '已复查');
    assert.equal(reviewed.body.history[0].by, '复查员');
    assert.equal(reviewed.body.history[0].note, '现场复核正常');

    // 旧版 PATCH 与样点状态流转
    const patched = await call(ctx.base, 'PATCH', `/api/sites/${site.body.id}`, { note: '补充说明', historyAction: '备注', by: '管理员' });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.note, '补充说明');
    const focused = await call(ctx.base, 'POST', `/api/action/site-focus/${site.body.id}`, { by: '管理员' });
    assert.equal(focused.status, 200);
    assert.equal(focused.body.protectedStatus, '重点保护');
  } finally {
    await ctx.close();
  }
});

test('批次草稿暂存、恢复补交与草稿边界', async () => {
  const ctx = await startServer(seedDb());
  try {
    // 暂存草稿
    const draft = await call(ctx.base, 'PUT', '/api/batches/draft/bk-test-1', batchPayload());
    assert.equal(draft.status, 201);
    assert.equal(draft.body.status, '草稿');
    assert.equal(draft.body.history[0].action, '暂存草稿');
    assert.equal(draft.body.history[0].by, '沈宁');

    // 班次结束前反复暂存，只保留一份草稿
    const again = await call(ctx.base, 'PUT', '/api/batches/draft/bk-test-1', batchPayload({ note: '补充读数' }));
    assert.equal(again.status, 200);
    assert.equal(ctx.readDb().batches.length, 1);
    assert.equal(again.body.history[0].action, '更新草稿');

    // 恢复连接后补交：草稿转为已提交，逐样点生成巡测记录
    const submitted = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload());
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, '已提交');
    assert.ok(submitted.body.submittedAt);
    const db = ctx.readDb();
    assert.equal(db.batches.length, 1);
    assert.equal(db.surveys.length, 2);
    assert.ok(db.surveys.every((s) => s.batchId === submitted.body.id && s.status === '正常'));

    // 已提交的批次不允许被草稿覆盖
    const overwrite = await call(ctx.base, 'PUT', '/api/batches/draft/bk-test-1', batchPayload());
    assert.equal(overwrite.status, 409);
    assert.equal(overwrite.body.conflict, true);
  } finally {
    await ctx.close();
  }
});

test('同一终端重复提交不生成多条记录', async () => {
  const ctx = await startServer(seedDb());
  try {
    const first = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload());
    assert.equal(first.status, 201);

    // 网络重试 / 用户重复点击：返回已有结果
    const retry = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload());
    assert.equal(retry.status, 200);
    assert.equal(retry.body.deduplicated, true);
    assert.equal(retry.body.id, first.body.id);

    const db = ctx.readDb();
    assert.equal(db.batches.length, 1);
    assert.equal(db.surveys.length, 2);
  } finally {
    await ctx.close();
  }
});

test('两个终端同时补交同一批次只保留一份，另一份提示冲突', async () => {
  const ctx = await startServer(seedDb());
  try {
    // 终端 A 暂存草稿
    await call(ctx.base, 'PUT', '/api/batches/draft/bk-test-1', batchPayload());

    // 两个终端同时补交同一批次
    const [a, b] = await Promise.all([
      call(ctx.base, 'POST', '/api/batches/submit', batchPayload({ terminalId: 'term-A' })),
      call(ctx.base, 'POST', '/api/batches/submit', batchPayload({ terminalId: 'term-B' }))
    ]);
    const results = [a, b];
    const winner = results.find((r) => r.status === 200 || r.status === 201);
    const loser = results.find((r) => r.status === 409);
    assert.ok(winner, '应有一份提交生效');
    assert.ok(loser, '另一份应判定冲突');
    assert.equal(loser.body.conflict, true);
    assert.match(loser.body.error, /另一终端/);

    // 只保留一份有效结果：批次一条、巡测记录一组
    const db = ctx.readDb();
    assert.equal(db.batches.length, 1);
    assert.equal(db.surveys.length, 2);
    assert.equal(db.batches[0].terminalId, winner.body.terminalId);
  } finally {
    await ctx.close();
  }
});

test('越过样点基准且记录干扰痕迹时自动进入待复核', async () => {
  const ctx = await startServer(seedDb());
  try {
    // 温度越过基准 + 有干扰痕迹 -> 待复核；其余组合保持正常
    const flagged = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      batchKey: 'bk-flag',
      readings: [
        { siteId: 'site-a', temperature: 17.5, humidity: 93, co2: 640, dripRate: 10, disturbance: '栏杆旁有触碰痕迹' },
        { siteId: 'site-b', temperature: 14.2, humidity: 90, co2: 600, dripRate: 8, disturbance: '' }
      ]
    }));
    assert.equal(flagged.status, 201);
    assert.equal(flagged.body.status, '待复核');
    assert.equal(flagged.body.flaggedCount, 1);
    let db = ctx.readDb();
    const flaggedSurvey = db.surveys.find((s) => s.batchKey === 'bk-flag' && s.siteId === 'site-a');
    assert.equal(flaggedSurvey.status, '异常待复查');
    assert.match(flaggedSurvey.history[0].note, /自动进入待复核/);
    assert.equal(db.surveys.find((s) => s.batchKey === 'bk-flag' && s.siteId === 'site-b').status, '正常');

    // 越过基准但没有干扰痕迹 -> 正常
    const crossedOnly = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      batchKey: 'bk-crossed-only',
      readings: [{ siteId: 'site-a', temperature: 18, humidity: 93, co2: 640, dripRate: 10, disturbance: '' }]
    }));
    assert.equal(crossedOnly.body.status, '已提交');

    // 有干扰痕迹但未越基准 -> 正常
    const disturbanceOnly = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      batchKey: 'bk-disturbance-only',
      readings: [{ siteId: 'site-a', temperature: 15, humidity: 93, co2: 640, dripRate: 10, disturbance: '附近有游客停留' }]
    }));
    assert.equal(disturbanceOnly.body.status, '已提交');

    // 湿度低于基准同样算越过
    const dry = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      batchKey: 'bk-dry',
      readings: [{ siteId: 'site-a', temperature: 15, humidity: 80, co2: 640, dripRate: 10, disturbance: '崖壁有擦痕' }]
    }));
    assert.equal(dry.body.status, '待复核');
    db = ctx.readDb();
    assert.equal(db.surveys.filter((s) => s.status === '异常待复查').length, 2);
  } finally {
    await ctx.close();
  }
});

test('复核通过前暂停开放的样点不能降级，复核通过后放行', async () => {
  const ctx = await startServer(seedDb());
  try {
    // 暂停开放的 site-b 出现待复核读数
    const submitted = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      readings: [
        { siteId: 'site-b', temperature: 16.5, humidity: 90, co2: 600, dripRate: 8, disturbance: '洞口有踩踏痕迹' }
      ]
    }));
    assert.equal(submitted.body.status, '待复核');

    // 暂停开放 + 待复核：降级到重点保护、常规观察都被拒绝
    const toFocus = await call(ctx.base, 'POST', '/api/action/site-focus/site-b', { by: '管理员' });
    assert.equal(toFocus.status, 409);
    assert.match(toFocus.body.error, /不能降级/);
    const toNormal = await call(ctx.base, 'POST', '/api/action/site-normal/site-b', { by: '管理员' });
    assert.equal(toNormal.status, 409);

    // 升级保护（暂停开放）不受限制
    const closeA = await call(ctx.base, 'POST', '/api/action/site-close/site-a', { by: '管理员' });
    assert.equal(closeA.status, 200);

    // 复核通过后放行降级
    const db = ctx.readDb();
    const pending = db.surveys.find((s) => s.siteId === 'site-b' && s.status === '异常待复查');
    const reviewed = await call(ctx.base, 'POST', `/api/action/survey-review/${pending.id}`, { by: '复查员', note: '已现场复核' });
    assert.equal(reviewed.status, 200);
    const downgraded = await call(ctx.base, 'POST', '/api/action/site-focus/site-b', { by: '管理员', note: '复核通过，调整保护级别' });
    assert.equal(downgraded.status, 200);
    assert.equal(downgraded.body.protectedStatus, '重点保护');
    assert.equal(downgraded.body.history[0].by, '管理员');
  } finally {
    await ctx.close();
  }
});

test('复核通过前批次不能完成，复核通过后可完成', async () => {
  const ctx = await startServer(seedDb());
  try {
    const submitted = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      readings: [
        { siteId: 'site-a', temperature: 17.5, humidity: 93, co2: 640, dripRate: 10, disturbance: '有触碰痕迹' },
        { siteId: 'site-b', temperature: 14.2, humidity: 90, co2: 600, dripRate: 8, disturbance: '' }
      ]
    }));
    assert.equal(submitted.body.status, '待复核');

    // 有待复核记录：完成批次被拒绝
    const early = await call(ctx.base, 'POST', `/api/action/batch-complete/${submitted.body.id}`, { by: '班长' });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /待复核/);

    // 复核通过后完成批次
    const db = ctx.readDb();
    const pending = db.surveys.find((s) => s.batchId === submitted.body.id && s.status === '异常待复查');
    await call(ctx.base, 'POST', `/api/action/survey-review/${pending.id}`, { by: '复查员' });
    const completed = await call(ctx.base, 'POST', `/api/action/batch-complete/${submitted.body.id}`, { by: '班长', note: '复核通过，班次收尾' });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.status, '已完成');
    assert.ok(completed.body.completedAt);
    assert.equal(completed.body.history[0].by, '班长');
    assert.equal(completed.body.history[0].note, '复核通过，班次收尾');

    // 已完成的批次不能重复完成
    const again = await call(ctx.base, 'POST', `/api/action/batch-complete/${submitted.body.id}`, { by: '班长' });
    assert.equal(again.status, 409);
  } finally {
    await ctx.close();
  }
});

test('每次提交和状态变化都保留处置人、时间和原因', async () => {
  const ctx = await startServer(seedDb());
  try {
    const draft = await call(ctx.base, 'PUT', '/api/batches/draft/bk-audit', batchPayload({ batchKey: 'bk-audit', by: '沈宁' }));
    assert.equal(draft.body.history[0].by, '沈宁');
    assert.ok(draft.body.history[0].at);

    const submitted = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({ batchKey: 'bk-audit', by: '沈宁' }));
    const submitStamp = submitted.body.history[0];
    assert.equal(submitStamp.by, '沈宁');
    assert.equal(submitStamp.action, '提交批次');
    assert.ok(submitStamp.at);
    assert.ok(submitStamp.note);

    const db = ctx.readDb();
    for (const survey of db.surveys.filter((s) => s.batchKey === 'bk-audit')) {
      assert.equal(survey.history[0].by, '沈宁');
      assert.ok(survey.history[0].at);
    }

    const reviewed = await call(ctx.base, 'POST', `/api/action/survey-review/${db.surveys[0].id}`, { by: '复查员甲', note: '复核无异常' });
    assert.equal(reviewed.body.history[0].by, '复查员甲');
    assert.equal(reviewed.body.history[0].note, '复核无异常');
    assert.ok(reviewed.body.history[0].at);
  } finally {
    await ctx.close();
  }
});

test('通用接口不能直接写入批次集合', async () => {
  const ctx = await startServer(seedDb());
  try {
    const created = await call(ctx.base, 'POST', '/api/batches', batchPayload());
    assert.equal(created.status, 405);
    const patched = await call(ctx.base, 'PATCH', '/api/batches/some-id', { status: '已完成' });
    assert.equal(patched.status, 405);
    const deleted = await call(ctx.base, 'DELETE', '/api/batches/some-id');
    assert.equal(deleted.status, 405);
    assert.equal(ctx.readDb().batches.length, 0);
  } finally {
    await ctx.close();
  }
});

test('批次提交参数校验', async () => {
  const ctx = await startServer(seedDb());
  try {
    const noReadings = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({ readings: [] }));
    assert.equal(noReadings.status, 400);
    const badSite = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      readings: [{ siteId: 'site-x', temperature: 15, humidity: 90, co2: 600, dripRate: 8 }]
    }));
    assert.equal(badSite.status, 400);
    const missingValue = await call(ctx.base, 'POST', '/api/batches/submit', batchPayload({
      readings: [{ siteId: 'site-a', temperature: '', humidity: 90, co2: 600, dripRate: 8 }]
    }));
    assert.equal(missingValue.status, 400);
    assert.equal(ctx.readDb().batches.length, 0);
    assert.equal(ctx.readDb().surveys.length, 0);
  } finally {
    await ctx.close();
  }
});
