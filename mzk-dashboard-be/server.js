'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.ISARSOFT_BASE_URL || 'https://localhost:8443',
  graphqlPath: process.env.ISARSOFT_GRAPHQL_PATH || '/isarsoft/api/graphql',
  tokenPath:
    process.env.ISARSOFT_TOKEN_PATH ||
    '/isarsoft/auth/realms/perception/protocol/openid-connect/token',
  clientId: process.env.ISARSOFT_CLIENT_ID || 'perception',
  username: process.env.ISARSOFT_USERNAME || 'perception',
  password: process.env.ISARSOFT_PASSWORD || 'perception',
  verifyTls: process.env.ISARSOFT_VERIFY_TLS === 'true',
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000),
  defaultPreset: process.env.ISARSOFT_PRESET || 'THIS_YEAR',
  defaultClasses: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),
  debugMode: process.env.DEBUG_MODE === 'true',
};

const httpsAgent = new https.Agent({ rejectUnauthorized: CONFIG.verifyTls });
let tokenCache = { token: null, expiresAt: 0 };

function nowIso() { return new Date().toISOString(); }
function toArray(v) { return Array.isArray(v) ? v : []; }
function lower(v) { return String(v || '').toLowerCase(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function sumBy(arr, fn) { return toArray(arr).reduce((acc, item) => acc + num(fn(item)), 0); }
function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

function log(level, msg, data) {
  const entry = { time: nowIso(), level, msg };
  if (data !== undefined) entry.data = data;
  console.log(JSON.stringify(entry));
}
function debug(msg, data) { if (CONFIG.debugMode) log('DEBUG', msg, data); }

// ─── HTTP ────────────────────────────────────────────────────────────────────

function requestRaw(urlString, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: url.protocol === 'https:' ? httpsAgent : undefined,
        timeout: CONFIG.requestTimeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          statusText: res.statusMessage,
          text: raw,
          json: () => safeJson(raw),
        }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

async function getToken(force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - 15000) {
    return tokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: CONFIG.clientId,
    username: CONFIG.username,
    password: CONFIG.password,
  }).toString();
  const res = await requestRaw(
    `${CONFIG.baseUrl}${CONFIG.tokenPath}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
    body
  );
  const json = res.json();
  if (!res.ok || !json?.access_token) {
    throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
  }
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 300) * 1000 };
  log('INFO', 'Token refreshed');
  return tokenCache.token;
}

async function graphql(query, retry = true) {
  const token = await getToken(false);
  const payload = JSON.stringify({ query });
  const res = await requestRaw(
    `${CONFIG.baseUrl}${CONFIG.graphqlPath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    payload
  );
  const json = res.json();
  if (res.status === 401 && retry) {
    log('WARN', 'Got 401, refreshing token');
    await getToken(true);
    return graphql(query, false);
  }
  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${res.text.slice(0, 800)}`);
  }
  if (!json) throw new Error(`GraphQL returned invalid JSON`);
  if (json.errors && !json.data) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
  }
  if (json.errors) {
    log('WARN', 'GraphQL partial errors', json.errors.map(e => e.message));
  }
  return json.data || null;
}

// ─── QUERIES ────────────────────────────────────────────────────────────────
//
// Key facts learned from the logs:
//   1. ObjectFlowAreaLiveData has field "count" (not count_min/avg/max)
//   2. getApplication requires argument form: application: {uuid: "..."}
//   3. The big allApplications-with-inline-count_data query is the cleanest
//      approach — it avoids getApplication entirely.

const QUERY_PRESETS = `query { __schema { types { name enumValues { name } } } }`;

function buildAllAppsQuery(preset, classNames) {
  const classesArg = classNames.map((n) => `{name:"${n}"}`).join(', ');
  const rangeArg   = `{time_range_preset: ${preset}}`;

  // NOTE: ObjectFlowAreaLiveData.count_live returns { count } not { count_min, count_avg, count_max }
  // ObjectFlowArea.count_data      returns { time_bucket, number_of_samples, count_min, count_avg, count_max }
  // ObjectFlowLine.count_data      returns { time_bucket, number_of_samples, count_in, count_out }
  // ObjectFlowLine.count_live      returns { count_in, count_out }
  return `
query {
  allApplications {
    __typename
    ... on ObjectFlow {
      uuid
      name
      tags
      status
      last_online
      created_at
      updated_at
      camera { uuid name }
      model  { uuid name }
      lines {
        uuid
        name
        tags
        coordinates
        count_data(
          time_range: ${rangeArg},
          object_classes: [${classesArg}]
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }
        count_live(object_classes: [${classesArg}]) {
          count_in
          count_out
        }
      }
      areas {
        uuid
        name
        tags
        coordinates
        count_data(
          time_range: ${rangeArg},
          object_classes: [${classesArg}]
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }
        count_live(object_classes: [${classesArg}]) {
          count
        }
      }
    }
  }
}`;
}

// Per-app fallback using the confirmed working argument form: application: {uuid: "..."}
function buildPerAppQuery(appUuid, preset, classNames) {
  const classesArg = classNames.map((n) => `{name:"${n}"}`).join(', ');
  const rangeArg   = `{time_range_preset: ${preset}}`;
  return `
query {
  getApplication(application: {uuid: "${appUuid}"}) {
    __typename
    ... on ObjectFlow {
      uuid
      name
      lines {
        uuid
        name
        count_data(
          time_range: ${rangeArg},
          object_classes: [${classesArg}]
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }
        count_live(object_classes: [${classesArg}]) {
          count_in
          count_out
        }
      }
      areas {
        uuid
        name
        count_data(
          time_range: ${rangeArg},
          object_classes: [${classesArg}]
        ) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }
        count_live(object_classes: [${classesArg}]) {
          count
        }
      }
    }
  }
}`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getEnumValues(schemaTypes, typeName) {
  const t = toArray(schemaTypes).find((x) => x.name === typeName);
  return toArray(t?.enumValues).map((x) => x.name).filter(Boolean);
}

function normalizePreset(input, allowed) {
  const fallback = CONFIG.defaultPreset;
  if (!input) return allowed.includes(fallback) ? fallback : (allowed[0] || 'LAST_1_DAY');
  const upper = String(input).trim().toUpperCase();
  if (allowed.includes(upper)) return upper;
  const collapsed = upper.replace(/_/g, '');
  const found = allowed.find((x) => x.replace(/_/g, '') === collapsed);
  if (found) return found;
  return allowed.includes(fallback) ? fallback : (allowed[0] || 'LAST_1_DAY');
}

function parseClasses(input) {
  if (!input) return CONFIG.defaultClasses;
  const raw = String(input).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  return raw.length ? raw : CONFIG.defaultClasses;
}

function summarizeLine(line) {
  const buckets = toArray(line.count_data);
  // count_live: array or single object, fields: count_in / count_out
  let liveIn = 0, liveOut = 0;
  if (Array.isArray(line.count_live)) {
    liveIn  = sumBy(line.count_live, (x) => x?.count_in);
    liveOut = sumBy(line.count_live, (x) => x?.count_out);
  } else if (line.count_live && typeof line.count_live === 'object') {
    liveIn  = num(line.count_live.count_in);
    liveOut = num(line.count_live.count_out);
  }
  return {
    uuid:        line.uuid,
    name:        line.name,
    tags:        toArray(line.tags),
    coordinates: toArray(line.coordinates),
    totals: {
      in:  sumBy(buckets, (x) => x?.count_in),
      out: sumBy(buckets, (x) => x?.count_out),
    },
    live: { in: liveIn, out: liveOut },
    history: {
      buckets:      buckets.length,
      first_bucket: buckets[0]?.time_bucket || null,
      last_bucket:  buckets[buckets.length - 1]?.time_bucket || null,
      raw:          buckets,
    },
  };
}

function summarizeArea(area) {
  const buckets = toArray(area.count_data);
  // count_live for ObjectFlowArea: { count } (single scalar field)
  let liveCount = null;
  if (Array.isArray(area.count_live) && area.count_live.length > 0) {
    liveCount = num(area.count_live[0]?.count);
  } else if (area.count_live && typeof area.count_live === 'object') {
    liveCount = num(area.count_live.count);
  }
  return {
    uuid:        area.uuid,
    name:        area.name,
    tags:        toArray(area.tags),
    coordinates: toArray(area.coordinates),
    live: { count: liveCount },
    history: {
      buckets:      buckets.length,
      first_bucket: buckets[0]?.time_bucket || null,
      last_bucket:  buckets[buckets.length - 1]?.time_bucket || null,
      raw:          buckets,
    },
  };
}

function pickFilters(url) {
  return {
    preset: url.searchParams.get('preset') || '',
    class:  url.searchParams.get('class')  || '',
    app:    url.searchParams.get('app')    || '',
    camera: url.searchParams.get('camera') || '',
    line:   url.searchParams.get('line')   || '',
  };
}

// ─── DATA COLLECTION ─────────────────────────────────────────────────────────

async function collectData(filters = {}) {
  // 1. Schema — get allowed preset values
  const schemaData   = await graphql(QUERY_PRESETS);
  const schemaTypes  = schemaData?.__schema?.types || [];
  const allowedPresets = getEnumValues(schemaTypes, 'TimeRangePreset');
  debug('Available presets', allowedPresets);

  const preset  = normalizePreset(filters.preset, allowedPresets);
  const classes = parseClasses(filters.class);
  log('INFO', `Collecting data: preset=${preset} classes=${classes.join(',')}`);

  // 2. Try single big query (allApplications with count_data inline — no getApplication needed)
  let appsRaw = [];
  let strategy = 'unknown';

  const bigQ = buildAllAppsQuery(preset, classes);
  debug('Big query', bigQ);

  try {
    const bigData = await graphql(bigQ);
    appsRaw = toArray(bigData?.allApplications).filter((x) => x.__typename === 'ObjectFlow');

    const totalBuckets = appsRaw.reduce(
      (acc, app) => acc + toArray(app.lines).reduce((a, l) => a + toArray(l.count_data).length, 0), 0
    );
    log('INFO', `Single query OK: ${appsRaw.length} apps, ${totalBuckets} line-buckets total`);
    strategy = 'single';

    // If we got apps but zero buckets across all of them, something is still off —
    // fall through to per-app queries.
    if (appsRaw.length > 0 && totalBuckets === 0) {
      log('WARN', 'Single query returned 0 buckets across all apps — trying per-app fallback');
      strategy = 'fallback';
    }
  } catch (err) {
    log('WARN', 'Single query failed', { error: err.message });
    strategy = 'fallback';
  }

  // 3. Per-app fallback
  if (strategy === 'fallback') {
    // Re-fetch app list without count_data to get clean metadata
    const listQ = `
query {
  allApplications {
    __typename
    ... on ObjectFlow {
      uuid name tags status last_online created_at updated_at
      camera { uuid name }
      model  { uuid name }
      lines { uuid name tags coordinates }
      areas { uuid name tags coordinates }
    }
  }
}`;
    const listData = await graphql(listQ);
    const appList  = toArray(listData?.allApplications).filter((x) => x.__typename === 'ObjectFlow');
    log('INFO', `Fallback: found ${appList.length} apps, fetching per-app counts`);

    appsRaw = [];
    for (const meta of appList) {
      log('INFO', `Per-app query: ${meta.name} (${meta.uuid})`);
      try {
        const q   = buildPerAppQuery(meta.uuid, preset, classes);
        const d   = await graphql(q);
        const app = d?.getApplication;
        if (app && app.__typename === 'ObjectFlow') {
          // Merge coordinates/tags from meta into count response
          const mergedLines = toArray(app.lines).map((l) => {
            const m = toArray(meta.lines).find((ml) => ml.uuid === l.uuid) || {};
            return { ...m, ...l };
          });
          const mergedAreas = toArray(app.areas).map((a) => {
            const m = toArray(meta.areas).find((ma) => ma.uuid === a.uuid) || {};
            return { ...m, ...a };
          });
          appsRaw.push({ ...meta, lines: mergedLines, areas: mergedAreas });
          const b = mergedLines.reduce((acc, l) => acc + toArray(l.count_data).length, 0);
          log('INFO', `  -> ${mergedLines.length} lines, ${b} buckets`);
        } else {
          log('WARN', `  -> getApplication returned unexpected type for ${meta.name}`);
          appsRaw.push(meta);
        }
      } catch (err) {
        log('WARN', `  -> Per-app query failed for ${meta.name}: ${err.message}`);
        appsRaw.push(meta); // include with no counts rather than skip
      }
    }
  }

  // 4. Apply filters
  let apps = appsRaw;
  if (filters.app)    apps = apps.filter((x) => lower(x.name).includes(lower(filters.app)));
  if (filters.camera) apps = apps.filter((x) => lower(x.camera?.name).includes(lower(filters.camera)));

  // 5. Structure output
  const detailedApps = apps.map((app) => {
    let lines = toArray(app.lines).map(summarizeLine);
    let areas = toArray(app.areas).map(summarizeArea);

    if (filters.line) lines = lines.filter((l) => lower(l.name).includes(lower(filters.line)));

    const totalIn  = sumBy(lines, (l) => l.totals.in);
    const totalOut = sumBy(lines, (l) => l.totals.out);

    return {
      uuid:        app.uuid,
      name:        app.name,
      tags:        toArray(app.tags),
      status:      app.status      || null,
      last_online: app.last_online || null,
      created_at:  app.created_at  || null,
      updated_at:  app.updated_at  || null,
      camera:      app.camera || null,
      model:       app.model  || null,
      totals:      { in: totalIn, out: totalOut },
      lines,
      areas,
    };
  });

  const lineRows = detailedApps.flatMap((app) =>
    app.lines.map((line) => ({
      application_uuid: app.uuid,
      application_name: app.name,
      camera_name:      app.camera?.name || null,
      line_uuid:        line.uuid,
      line_name:        line.name,
      total_in:         line.totals.in,
      total_out:        line.totals.out,
      live_in:          line.live.in,
      live_out:         line.live.out,
      buckets:          line.history.buckets,
      first_bucket:     line.history.first_bucket,
      last_bucket:      line.history.last_bucket,
    }))
  );
  lineRows.sort((a, b) => b.total_out - a.total_out || b.total_in - a.total_in);

  return {
    ok:           true,
    generated_at: nowIso(),
    strategy,
    filters: {
      preset,
      class:  classes.join(','),
      app:    filters.app    || '',
      camera: filters.camera || '',
      line:   filters.line   || '',
    },
    available_presets: allowedPresets,
    totals: {
      objectflow_apps: detailedApps.length,
      total_in:        sumBy(detailedApps, (x) => x.totals.in),
      total_out:       sumBy(detailedApps, (x) => x.totals.out),
    },
    applications: detailedApps,
    lines:        lineRows,
  };
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, payload) {
  cors(res);
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type':   'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  log('INFO', `${req.method} ${url.pathname}`);

  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });

  if (url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      endpoints: [
        'GET /health',
        'GET /debug/presets              — list preset values from live schema',
        'GET /summary?preset=THIS_YEAR&class=PERSON,HEAD',
        'GET /data?preset=THIS_YEAR&class=PERSON,HEAD',
        'GET /debug/lines?preset=THIS_YEAR&class=PERSON,HEAD',
      ],
      time: nowIso(),
    });
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, time: nowIso() });
  }

  if (url.pathname === '/debug/presets') {
    try {
      const d = await graphql(QUERY_PRESETS);
      const presets = getEnumValues(d?.__schema?.types || [], 'TimeRangePreset');
      return sendJson(res, 200, { ok: true, presets });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  const handler = async () => {
    const data = await collectData(pickFilters(url));

    if (url.pathname === '/summary') {
      return sendJson(res, 200, {
        ok:                true,
        generated_at:      data.generated_at,
        strategy:          data.strategy,
        filters:           data.filters,
        available_presets: data.available_presets,
        totals:            data.totals,
        applications: data.applications.map((a) => ({
          uuid:        a.uuid,
          name:        a.name,
          status:      a.status,
          last_online: a.last_online,
          camera:      a.camera,
          totals:      a.totals,
          lines: a.lines.map((l) => ({
            uuid:    l.uuid,
            name:    l.name,
            totals:  l.totals,
            live:    l.live,
            buckets: l.history.buckets,
          })),
        })),
      });
    }

    if (url.pathname === '/data') {
      return sendJson(res, 200, data);
    }

    if (url.pathname === '/debug/lines') {
      return sendJson(res, 200, {
        ok:           true,
        generated_at: data.generated_at,
        strategy:     data.strategy,
        filters:      data.filters,
        totals:       data.totals,
        lines:        data.lines,
      });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  };

  if (['/summary', '/data', '/debug/lines'].includes(url.pathname)) {
    try {
      await handler();
    } catch (err) {
      log('ERROR', `${url.pathname} failed`, { error: err.message });
      return sendJson(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(CONFIG.port, () => {
  log('INFO', 'Server started', {
    port:           CONFIG.port,
    baseUrl:        CONFIG.baseUrl,
    defaultPreset:  CONFIG.defaultPreset,
    defaultClasses: CONFIG.defaultClasses,
    tip:            'Set DEBUG_MODE=true for verbose query logging',
  });
});