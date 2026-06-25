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
function toArray(v) { return Array.isArray(v) ? v : (v != null ? [] : []); }
function lower(v) { return String(v || '').toLowerCase(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function sumBy(arr, fn) { return toArray(arr).reduce((acc, item) => acc + num(fn(item)), 0); }
function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

function log(level, msg, data) {
  const entry = { time: nowIso(), level, msg };
  if (data !== undefined) entry.data = data;
  console.log(JSON.stringify(entry));
}

function debug(msg, data) {
  if (CONFIG.debugMode) log('DEBUG', msg, data);
}

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
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage,
            text: raw,
            json: () => safeJson(raw),
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error(`Timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  const json = res.json();
  if (!res.ok || !json?.access_token) {
    throw new Error(`Token request failed: ${res.status} ${res.statusText} ${res.text}`);
  }

  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 300) * 1000,
  };

  log('INFO', 'Token refreshed', { expires_in: json.expires_in });
  return tokenCache.token;
}

async function graphql(query, variables = null, retry = true) {
  const token = await getToken(false);
  const payload = JSON.stringify({ query, variables });

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
    log('WARN', 'Got 401, refreshing token and retrying');
    await getToken(true);
    return graphql(query, variables, false);
  }

  if (!res.ok) {
    throw new Error(`GraphQL HTTP error: ${res.status} ${res.statusText} ${res.text.slice(0, 500)}`);
  }

  if (!json) {
    throw new Error(`GraphQL returned invalid JSON: ${res.text.slice(0, 500)}`);
  }

  if (json.errors && json.errors.length > 0) {
    // Log errors but don't throw — partial data may still be present
    log('WARN', 'GraphQL errors', json.errors);
    if (!json.data) {
      throw new Error(`GraphQL errors (no data): ${JSON.stringify(json.errors)}`);
    }
  }

  return json.data || null;
}

// ─── QUERIES ────────────────────────────────────────────────────────────────

const QUERY_TIME_RANGE_PRESETS = `
query {
  __schema {
    types {
      name
      enumValues { name }
    }
  }
}
`;

// Step 1: list all apps with basic metadata, line/area UUIDs and coordinates
// We do NOT ask for count_data here — that requires time_range argument on each line,
// which we'll supply in Step 2.
const QUERY_ALL_OBJECTFLOW_APPS = `
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
      }
      areas {
        uuid
        name
        tags
        coordinates
      }
    }
  }
}
`;

// Step 2: for a single ObjectFlow app, fetch count_data and count_live on all lines.
// Uses inline arguments (no variables) to avoid schema mismatches with input types.
// We build this string dynamically so we can inject the exact preset and class names.
function buildAppCountQuery(appUuid, preset, classNames) {
  const classesArg = classNames.map((n) => `{name:"${n}"}`).join(', ');
  const rangeArg = `{time_range_preset: ${preset}}`;

  // Try both known argument forms for getApplication.
  // The API might accept uuid directly or wrapped in an ApplicationInput object.
  // We'll try direct uuid first (most common pattern).
  return `
query {
  getApplication(uuid: "${appUuid}") {
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
          count_min
          count_avg
          count_max
        }
      }
    }
  }
}
`;
}

// Fallback form if getApplication doesn't accept bare uuid
function buildAppCountQueryAlt(appUuid, preset, classNames) {
  const classesArg = classNames.map((n) => `{name:"${n}"}`).join(', ');
  const rangeArg = `{time_range_preset: ${preset}}`;

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
          count_min
          count_avg
          count_max
        }
      }
    }
  }
}
`;
}

// Alternative: fetch all apps with count_data inline (one big query, no per-app roundtrips)
// This works when the API allows count_data args directly on allApplications results.
function buildAllAppsCountQuery(preset, classNames) {
  const classesArg = classNames.map((n) => `{name:"${n}"}`).join(', ');
  const rangeArg = `{time_range_preset: ${preset}}`;

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
          count_min
          count_avg
          count_max
        }
      }
    }
  }
}
`;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getEnumValues(schemaTypes, typeName) {
  const type = toArray(schemaTypes).find((x) => x.name === typeName);
  return toArray(type?.enumValues).map((x) => x.name).filter(Boolean);
}

function normalizePreset(input, allowed) {
  const fallback = CONFIG.defaultPreset;
  if (!input) return allowed.includes(fallback) ? fallback : (allowed[0] || 'LAST_1_DAY');

  // Try exact match (case-insensitive)
  const upper = String(input).trim().toUpperCase();
  if (allowed.includes(upper)) return upper;

  // Try collapsed match (ignore underscores)
  const collapsed = upper.replace(/_/g, '');
  const found = allowed.find((x) => x.replace(/_/g, '') === collapsed);
  if (found) return found;

  // Try common aliases
  const ALIASES = {
    THISYEAR: 'THIS_YEAR',
    THISMONTH: 'THIS_MONTH',
    THISWEEK: 'THIS_WEEK',
    TODAY: 'THIS_DAY',
    YESTERDAY: 'PREVIOUS_DAY',
    LAST1HOUR: 'LAST_1_HOUR',
    LAST1DAY: 'LAST_1_DAY',
  };
  const aliased = ALIASES[collapsed];
  if (aliased && allowed.includes(aliased)) return aliased;

  return allowed.includes(fallback) ? fallback : (allowed[0] || 'LAST_1_DAY');
}

function parseClasses(input) {
  if (!input) return CONFIG.defaultClasses;
  const raw = String(input).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  return raw.length ? raw : CONFIG.defaultClasses;
}

function summarizeLine(line) {
  const buckets = toArray(line.count_data);

  // count_live can be an array OR a single object — handle both
  let liveIn = 0, liveOut = 0;
  if (Array.isArray(line.count_live)) {
    liveIn  = sumBy(line.count_live, (x) => x?.count_in);
    liveOut = sumBy(line.count_live, (x) => x?.count_out);
  } else if (line.count_live && typeof line.count_live === 'object') {
    liveIn  = num(line.count_live.count_in);
    liveOut = num(line.count_live.count_out);
  }

  const totalIn  = sumBy(buckets, (x) => x?.count_in);
  const totalOut = sumBy(buckets, (x) => x?.count_out);

  return {
    uuid:        line.uuid,
    name:        line.name,
    tags:        toArray(line.tags),
    coordinates: toArray(line.coordinates),
    totals: { in: totalIn, out: totalOut },
    live:   { in: liveIn, out: liveOut },
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

  let liveMin = null, liveAvg = null, liveMax = null;
  if (Array.isArray(area.count_live) && area.count_live.length > 0) {
    liveAvg = area.count_live[0]?.count_avg ?? null;
    liveMin = area.count_live[0]?.count_min ?? null;
    liveMax = area.count_live[0]?.count_max ?? null;
  } else if (area.count_live && typeof area.count_live === 'object') {
    liveAvg = num(area.count_live.count_avg);
    liveMin = num(area.count_live.count_min);
    liveMax = num(area.count_live.count_max);
  }

  return {
    uuid:        area.uuid,
    name:        area.name,
    tags:        toArray(area.tags),
    coordinates: toArray(area.coordinates),
    live: { min: liveMin, avg: liveAvg, max: liveMax },
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

// ─── MAIN DATA COLLECTION ────────────────────────────────────────────────────

async function collectData(filters = {}) {
  // 1. Fetch allowed preset values from schema
  log('INFO', 'Fetching schema enums...');
  const schemaData = await graphql(QUERY_TIME_RANGE_PRESETS);
  const schemaTypes = schemaData?.__schema?.types || [];
  const allowedPresets = getEnumValues(schemaTypes, 'TimeRangePreset');
  debug('Available TimeRangePreset values', allowedPresets);

  const preset  = normalizePreset(filters.preset, allowedPresets);
  const classes = parseClasses(filters.class);
  log('INFO', `Using preset=${preset}, classes=${classes.join(',')}`);

  // 2. Try to fetch everything in ONE query (allApplications with count_data inline).
  //    This is the most efficient and avoids getApplication argument guessing.
  log('INFO', 'Fetching all ObjectFlow apps with count_data (single query)...');
  const bigQuery = buildAllAppsCountQuery(preset, classes);
  debug('Big query', bigQuery);

  let appsRaw = [];
  let usedSingleQuery = false;

  try {
    const bigData = await graphql(bigQuery);
    const candidates = toArray(bigData?.allApplications).filter(
      (x) => x.__typename === 'ObjectFlow'
    );

    // Check if we actually got count data or if everything is empty/null
    const totalBuckets = candidates.reduce(
      (acc, app) => acc + toArray(app.lines).reduce(
        (a2, l) => a2 + toArray(l.count_data).length, 0
      ), 0
    );

    debug('Single-query results', {
      apps: candidates.length,
      total_count_data_buckets: totalBuckets,
    });

    appsRaw = candidates;
    usedSingleQuery = true;
    log('INFO', `Single-query succeeded: ${candidates.length} apps, ${totalBuckets} total buckets`);
  } catch (err) {
    log('WARN', 'Single-query failed, will fall back to per-app queries', { error: err.message });
  }

  // 3. If single query gave us nothing (count_data all empty), try per-app approach
  //    with both argument forms for getApplication.
  if (!usedSingleQuery || appsRaw.every(
    (app) => toArray(app.lines).every((l) => toArray(l.count_data).length === 0)
  )) {
    log('INFO', 'Falling back to per-app queries (count_data was empty in single query)...');

    // First get the app list without counts
    const listData = await graphql(QUERY_ALL_OBJECTFLOW_APPS);
    const appList  = toArray(listData?.allApplications).filter(
      (x) => x.__typename === 'ObjectFlow'
    );
    log('INFO', `Found ${appList.length} ObjectFlow apps`);

    appsRaw = [];

    for (const appMeta of appList) {
      log('INFO', `Fetching counts for app: ${appMeta.name} (${appMeta.uuid})`);

      let appWithCounts = null;

      // Try primary form first
      try {
        const q = buildAppCountQuery(appMeta.uuid, preset, classes);
        debug(`Query for ${appMeta.name}`, q);
        const d = await graphql(q);
        const candidate = d?.getApplication;
        if (candidate && candidate.__typename === 'ObjectFlow') {
          appWithCounts = candidate;
          debug(`Primary form worked for ${appMeta.name}`, {
            lines: toArray(candidate.lines).length,
            buckets: toArray(candidate.lines).reduce(
              (a, l) => a + toArray(l.count_data).length, 0
            ),
          });
        }
      } catch (err) {
        log('WARN', `Primary getApplication form failed for ${appMeta.name}`, { error: err.message });
      }

      // Try alt form
      if (!appWithCounts) {
        try {
          const q2 = buildAppCountQueryAlt(appMeta.uuid, preset, classes);
          debug(`Alt query for ${appMeta.name}`, q2);
          const d2 = await graphql(q2);
          const candidate2 = d2?.getApplication;
          if (candidate2 && candidate2.__typename === 'ObjectFlow') {
            appWithCounts = candidate2;
            debug(`Alt form worked for ${appMeta.name}`);
          }
        } catch (err2) {
          log('WARN', `Alt getApplication form also failed for ${appMeta.name}`, { error: err2.message });
        }
      }

      // Merge metadata from appList with count data from getApplication
      if (appWithCounts) {
        appsRaw.push({
          ...appMeta,
          lines: toArray(appWithCounts.lines).map((countLine) => {
            const metaLine = toArray(appMeta.lines).find((ml) => ml.uuid === countLine.uuid) || {};
            return { ...metaLine, ...countLine };
          }),
          areas: toArray(appWithCounts.areas).map((countArea) => {
            const metaArea = toArray(appMeta.areas).find((ma) => ma.uuid === countArea.uuid) || {};
            return { ...metaArea, ...countArea };
          }),
        });
      } else {
        // Still include the app but with no count data so it shows up in listings
        log('WARN', `Could not fetch counts for ${appMeta.name}, including with empty counts`);
        appsRaw.push(appMeta);
      }
    }
  }

  // 4. Apply filters
  let apps = appsRaw;

  if (filters.app) {
    apps = apps.filter((x) => lower(x.name).includes(lower(filters.app)));
  }
  if (filters.camera) {
    apps = apps.filter((x) => lower(x.camera?.name).includes(lower(filters.camera)));
  }

  // 5. Summarize and structure
  const detailedApps = apps.map((app) => {
    let lines = toArray(app.lines).map(summarizeLine);
    let areas = toArray(app.areas).map(summarizeArea);

    if (filters.line) {
      lines = lines.filter((l) => lower(l.name).includes(lower(filters.line)));
    }

    const appTotalIn  = sumBy(lines, (l) => l.totals.in);
    const appTotalOut = sumBy(lines, (l) => l.totals.out);

    debug(`App summary: ${app.name}`, {
      lines: lines.length,
      totalIn: appTotalIn,
      totalOut: appTotalOut,
    });

    return {
      uuid:        app.uuid,
      name:        app.name,
      tags:        toArray(app.tags),
      status:      app.status || null,
      last_online: app.last_online || null,
      created_at:  app.created_at || null,
      updated_at:  app.updated_at || null,
      camera:      app.camera || null,
      model:       app.model  || null,
      totals:      { in: appTotalIn, out: appTotalOut },
      lines,
      areas,
    };
  });

  // 6. Flat line rows for the /debug/lines endpoint
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
    ok:               true,
    generated_at:     nowIso(),
    used_single_query: usedSingleQuery,
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
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  log('INFO', `${req.method} ${url.pathname}`);

  if (req.method !== 'GET') {
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  // Root
  if (url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      endpoints: [
        'GET /health',
        'GET /summary?preset=THIS_YEAR&class=PERSON,HEAD',
        'GET /data?preset=THIS_YEAR&class=PERSON,HEAD',
        'GET /debug/lines?preset=THIS_YEAR&class=PERSON,HEAD',
        'GET /debug/raw?preset=THIS_YEAR&class=PERSON,HEAD&app=Real+Cam+2',
      ],
      presets_hint: 'Use /debug/presets to see available preset values from the live schema',
      time: nowIso(),
    });
  }

  // Health
  if (url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, time: nowIso() });
  }

  // Show available presets (useful for debugging what values the API accepts)
  if (url.pathname === '/debug/presets') {
    try {
      const schemaData = await graphql(QUERY_TIME_RANGE_PRESETS);
      const types = schemaData?.__schema?.types || [];
      const presets = getEnumValues(types, 'TimeRangePreset');
      return sendJson(res, 200, { ok: true, presets });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Summary (no raw data)
  if (url.pathname === '/summary') {
    try {
      const data = await collectData(pickFilters(url));
      return sendJson(res, 200, {
        ok:                true,
        generated_at:      data.generated_at,
        used_single_query: data.used_single_query,
        filters:           data.filters,
        available_presets: data.available_presets,
        totals:            data.totals,
        applications:      data.applications.map((a) => ({
          uuid:        a.uuid,
          name:        a.name,
          status:      a.status,
          last_online: a.last_online,
          camera:      a.camera,
          totals:      a.totals,
          lines:       a.lines.map((l) => ({
            uuid:    l.uuid,
            name:    l.name,
            totals:  l.totals,
            live:    l.live,
            buckets: l.history.buckets,
          })),
        })),
      });
    } catch (err) {
      log('ERROR', 'Error in /summary', { error: err.message, stack: err.stack });
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Full data with raw buckets
  if (url.pathname === '/data') {
    try {
      const data = await collectData(pickFilters(url));
      return sendJson(res, 200, data);
    } catch (err) {
      log('ERROR', 'Error in /data', { error: err.message, stack: err.stack });
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Flat line rows
  if (url.pathname === '/debug/lines') {
    try {
      const data = await collectData(pickFilters(url));
      return sendJson(res, 200, {
        ok:          true,
        generated_at: data.generated_at,
        filters:     data.filters,
        totals:      data.totals,
        lines:       data.lines,
      });
    } catch (err) {
      log('ERROR', 'Error in /debug/lines', { error: err.message, stack: err.stack });
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Raw app dump for one app — useful to see exactly what the API returns
  if (url.pathname === '/debug/raw') {
    const appFilter = url.searchParams.get('app') || '';
    const preset    = url.searchParams.get('preset') || CONFIG.defaultPreset;
    const classStr  = url.searchParams.get('class') || CONFIG.defaultClasses.join(',');

    try {
      const schemaData   = await graphql(QUERY_TIME_RANGE_PRESETS);
      const schemaTypes  = schemaData?.__schema?.types || [];
      const allowed      = getEnumValues(schemaTypes, 'TimeRangePreset');
      const finalPreset  = normalizePreset(preset, allowed);
      const classes      = parseClasses(classStr);

      // First get app list to find the UUID
      const listData = await graphql(QUERY_ALL_OBJECTFLOW_APPS);
      let candidates = toArray(listData?.allApplications).filter(
        (x) => x.__typename === 'ObjectFlow'
      );
      if (appFilter) {
        candidates = candidates.filter((x) => lower(x.name).includes(lower(appFilter)));
      }

      if (candidates.length === 0) {
        return sendJson(res, 200, { ok: true, message: 'No matching apps', available: toArray(listData?.allApplications).map((x) => x.name) });
      }

      const app = candidates[0];

      // Try primary form
      let rawResult = null;
      let formUsed  = null;
      let rawError1 = null;

      try {
        const q1 = buildAppCountQuery(app.uuid, finalPreset, classes);
        const d1 = await graphql(q1);
        rawResult = d1;
        formUsed  = 'primary (uuid: "...")';
      } catch (e) {
        rawError1 = e.message;
      }

      if (!rawResult?.getApplication) {
        try {
          const q2 = buildAppCountQueryAlt(app.uuid, finalPreset, classes);
          const d2 = await graphql(q2);
          rawResult = d2;
          formUsed  = 'alt (application: {uuid: "..."})';
        } catch (e) {
          // both failed
        }
      }

      return sendJson(res, 200, {
        ok:           true,
        app_meta:     app,
        preset_used:  finalPreset,
        classes_used: classes,
        form_used:    formUsed,
        raw_primary_error: rawError1,
        raw_result:   rawResult,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(CONFIG.port, () => {
  log('INFO', 'Server started', {
    port:           CONFIG.port,
    baseUrl:        CONFIG.baseUrl,
    graphqlPath:    CONFIG.graphqlPath,
    defaultPreset:  CONFIG.defaultPreset,
    defaultClasses: CONFIG.defaultClasses,
    debugMode:      CONFIG.debugMode,
    tip: 'Set DEBUG_MODE=true env var to see verbose query/response logging',
  });
});