'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

// ============================================================
// KONFIGURACJA
// ============================================================
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
  // Zmieniamy domyślny preset na LAST_1_DAY, aby mieć pewność, że dane istnieją
  defaultPreset: process.env.ISARSOFT_PRESET || 'LAST_1_DAY',
  defaultClasses: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000),
};

// ============================================================
// AGENT HTTPS
// ============================================================
const httpsAgent = new https.Agent({
  rejectUnauthorized: CONFIG.verifyTls,
});

// ============================================================
// POMOCNICY
// ============================================================
function nowIso() {
  return new Date().toISOString();
}

function toArray(v) {
  return Array.isArray(v) ? v : [];
}

function lower(v) {
  return String(v || '').toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sumBy(arr, fn) {
  return toArray(arr).reduce((acc, item) => acc + num(fn(item)), 0);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ============================================================
// NISKOPOZIOMOWE ŻĄDANIA HTTP
// ============================================================
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
        res.on('data', (chunk) => {
          raw += chunk;
        });
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

// ============================================================
// TOKEN OAuth2
// ============================================================
let tokenCache = { token: null, expiresAt: 0 };

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

  return tokenCache.token;
}

// ============================================================
// WYKONYWANIE ZAPYTAŃ GRAPHQL
// ============================================================
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
    await getToken(true);
    return graphql(query, variables, false);
  }

  if (!res.ok) {
    throw new Error(`GraphQL HTTP error: ${res.status} ${res.statusText} ${res.text}`);
  }

  if (!json) {
    throw new Error(`GraphQL returned invalid JSON: ${res.text}`);
  }

  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data || null;
}

// ============================================================
// ZAPYTANIA GRAPHQL (poprawione)
// ============================================================

// 1. Introspekcja – pobranie enumów
const QUERY_SCHEMA = `
query {
  __schema {
    types {
      name
      kind
      enumValues { name }
    }
  }
}
`;

// 2. Lista aplikacji ObjectFlow (metadane + linie i obszary bez liczników)
const QUERY_OBJECTFLOW_APPS = `
query {
  allApplications {
    __typename
    ... on ObjectFlow {
      uuid
      name
      tags
      created_at
      updated_at
      status
      last_online
      camera { uuid name }
      model { uuid name }
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

// 3. Szczegóły aplikacji ObjectFlow z danymi licznikowymi
//    UWAGA: użyto poprawnego argumentu `application: { uuid: $app }`
const QUERY_ONE_APP_COUNTS = `
query($app: String!, $range: TimeRangeInput!, $classes: [ObjectClassInput!]!) {
  getApplication(application: { uuid: $app }) {
    __typename
    ... on ObjectFlow {
      uuid
      name
      camera { uuid name }
      lines {
        uuid
        name
        tags
        coordinates
        count_data(time_range: $range, object_classes: $classes) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }
        count_live(object_classes: $classes) {
          count_in
          count_out
        }
      }
      areas {
        uuid
        name
        tags
        coordinates
        count_data(time_range: $range, object_classes: $classes) {
          time_bucket
          number_of_samples
          count_min
          count_avg
          count_max
        }
        count_live(object_classes: $classes) {
          count
        }
      }
    }
  }
}
`;

// 4. Lista wszystkich kamer
const QUERY_ALL_CAMERAS = `
query {
  allCameras {
    uuid
    name
  }
}
`;

// 5. Licencja (uproszczona)
const QUERY_LICENSE = `
query {
  getLicenseStatus {
    valid
  }
}
`;

// ============================================================
// FUNKCJE POMOCNICZE DO PRZETWARZANIA DANYCH
// ============================================================

function getEnumValues(schema, typeName) {
  const type = toArray(schema?.types).find((x) => x.name === typeName);
  return toArray(type?.enumValues).map((x) => x.name).filter(Boolean);
}

function normalizePreset(input, allowed) {
  const fallback = CONFIG.defaultPreset;
  if (!input) return allowed.includes(fallback) ? fallback : allowed[0] || 'LAST_1_DAY';

  const raw = String(input).trim().toUpperCase();
  if (allowed.includes(raw)) return raw;

  const collapsed = raw.replace(/[_\s-]/g, '');
  const found = allowed.find((x) => x.replace(/[_\s-]/g, '') === collapsed);
  return found || (allowed.includes(fallback) ? fallback : allowed[0]) || 'LAST_1_DAY';
}

function parseClasses(input) {
  const raw = (input || CONFIG.defaultClasses.join(','))
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  return raw.length ? raw : CONFIG.defaultClasses;
}

function classInputs(classes) {
  return classes.map((name) => ({ name }));
}

// ============================================================
// UWAGA: Funkcje agregujące obsługują teraz tablicę tablic
//         (gdy count_data zwraca dane dla wielu klas oddzielnie)
// ============================================================

function flattenRows(rows) {
  // Jeśli rows jest tablicą, a pierwszy element też jest tablicą, to spłaszczamy
  if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
    return rows.flat();
  }
  return toArray(rows);
}

function summarizeBuckets(rows) {
  const flat = flattenRows(rows);
  const raw = flat;
  return {
    buckets: raw.length,
    first_bucket: raw[0]?.time_bucket || null,
    last_bucket: raw[raw.length - 1]?.time_bucket || null,
    total_in: sumBy(raw, (x) => x?.count_in),
    total_out: sumBy(raw, (x) => x?.count_out),
    raw,
  };
}

function summarizeAreaBuckets(rows) {
  const flat = flattenRows(rows);
  const raw = flat;
  return {
    buckets: raw.length,
    first_bucket: raw[0]?.time_bucket || null,
    last_bucket: raw[raw.length - 1]?.time_bucket || null,
    avg_min: raw.length ? sumBy(raw, (x) => x?.count_min) / raw.length : 0,
    avg_avg: raw.length ? sumBy(raw, (x) => x?.count_avg) / raw.length : 0,
    avg_max: raw.length ? sumBy(raw, (x) => x?.count_max) / raw.length : 0,
    total_samples: sumBy(raw, (x) => x?.number_of_samples),
    raw,
  };
}

function summarizeLive(rows) {
  const flat = flattenRows(rows);
  const raw = flat;
  return {
    total_in: sumBy(raw, (x) => x?.count_in),
    total_out: sumBy(raw, (x) => x?.count_out),
    raw,
  };
}

function summarizeAreaLive(rows) {
  const flat = flattenRows(rows);
  const raw = flat;
  return {
    total_count: sumBy(raw, (x) => x?.count),
    raw,
  };
}

// ============================================================
// GŁÓWNA FUNKCJA ZBIERAJĄCA DANE
// ============================================================

async function collectAllData(filters = {}) {
  // --- 1. Pobierz schemę dla enumów ---
  let allowedPresets = ['LAST_1_DAY', 'LAST_1_HOUR', 'LAST_12_HOUR', 'THIS_YEAR', 'THIS_WEEK', 'THIS_MONTH'];
  try {
    const schemaData = await graphql(QUERY_SCHEMA);
    const schema = schemaData?.__schema || null;
    const enumVals = getEnumValues(schema, 'TimeRangePreset');
    if (enumVals.length) allowedPresets = enumVals;
  } catch (err) {
    console.warn('[collectAllData] Nie udało się pobrać enumów, używam domyślnych:', err.message);
  }

  const preset = normalizePreset(filters.preset, allowedPresets);
  const classes = parseClasses(filters.class);
  const range = { time_range_preset: preset };
  const classesVar = classInputs(classes);

  // --- 2. Pobierz listę aplikacji ObjectFlow ---
  let apps = [];
  try {
    const appsData = await graphql(QUERY_OBJECTFLOW_APPS);
    apps = toArray(appsData?.allApplications).filter((x) => x.__typename === 'ObjectFlow');
  } catch (err) {
    console.error('[collectAllData] Błąd pobierania aplikacji:', err.message);
    throw err;
  }

  // Filtrowanie po nazwie / kamerze
  if (filters.app) {
    apps = apps.filter((x) => lower(x.name).includes(lower(filters.app)));
  }
  if (filters.camera) {
    apps = apps.filter((x) => lower(x.camera?.name).includes(lower(filters.camera)));
  }

  // --- 3. Dla każdej aplikacji pobierz szczegółowe dane licznikowe ---
  const detailedApps = [];
  for (const app of apps) {
    try {
      const one = await graphql(QUERY_ONE_APP_COUNTS, {
        app: app.uuid,
        range,
        classes: classesVar,
      });

      const objectFlow = one?.getApplication;
      if (!objectFlow || objectFlow.__typename !== 'ObjectFlow') {
        detailedApps.push({
          uuid: app.uuid,
          name: app.name,
          status: app.status || null,
          last_online: app.last_online || null,
          camera: app.camera || null,
          model: app.model || null,
          lines: [],
          areas: [],
          totals: { in: 0, out: 0 },
          area_totals: { min: 0, avg: 0, max: 0, count: 0 },
        });
        continue;
      }

      // --- 3a. Linie ---
      let lines = toArray(objectFlow.lines);
      if (filters.line) {
        lines = lines.filter((l) => lower(l.name).includes(lower(filters.line)));
      }

      const mappedLines = lines.map((line) => {
        const data = summarizeBuckets(line.count_data);
        const live = summarizeLive(line.count_live);
        return {
          uuid: line.uuid,
          name: line.name,
          tags: toArray(line.tags),
          coordinates: toArray(line.coordinates),
          totals: { in: data.total_in, out: data.total_out },
          live,
          data,
        };
      });

      // --- 3b. Obszary ---
      let areas = toArray(objectFlow.areas);
      if (filters.area) {
        areas = areas.filter((a) => lower(a.name).includes(lower(filters.area)));
      }

      const mappedAreas = areas.map((area) => {
        const data = summarizeAreaBuckets(area.count_data);
        const live = summarizeAreaLive(area.count_live);
        return {
          uuid: area.uuid,
          name: area.name,
          tags: toArray(area.tags),
          coordinates: toArray(area.coordinates),
          totals: {
            min: data.avg_min,
            avg: data.avg_avg,
            max: data.avg_max,
            samples: data.total_samples,
          },
          live,
          data,
        };
      });

      // --- 3c. Agregacja ---
      const totalIn = sumBy(mappedLines, (x) => x.totals.in);
      const totalOut = sumBy(mappedLines, (x) => x.totals.out);

      const areaMin = mappedAreas.length ? sumBy(mappedAreas, (x) => x.totals.min) / mappedAreas.length : 0;
      const areaAvg = mappedAreas.length ? sumBy(mappedAreas, (x) => x.totals.avg) / mappedAreas.length : 0;
      const areaMax = mappedAreas.length ? sumBy(mappedAreas, (x) => x.totals.max) / mappedAreas.length : 0;
      const areaCount = sumBy(mappedAreas, (x) => x.live.total_count);

      detailedApps.push({
        uuid: app.uuid,
        name: app.name,
        tags: toArray(app.tags),
        status: app.status || null,
        last_online: app.last_online || null,
        camera: app.camera || null,
        model: app.model || null,
        created_at: app.created_at || null,
        updated_at: app.updated_at || null,
        lines: mappedLines,
        areas: mappedAreas,
        totals: { in: totalIn, out: totalOut },
        area_totals: { min: areaMin, avg: areaAvg, max: areaMax, count: areaCount },
      });
    } catch (err) {
      console.error(`[collectAllData] Błąd dla aplikacji ${app.uuid} (${app.name}):`, err.message);
      detailedApps.push({
        uuid: app.uuid,
        name: app.name,
        status: app.status || null,
        last_online: app.last_online || null,
        camera: app.camera || null,
        model: app.model || null,
        lines: [],
        areas: [],
        totals: { in: 0, out: 0 },
        area_totals: { min: 0, avg: 0, max: 0, count: 0 },
        _error: err.message,
      });
    }
  }

  // --- 4. Kamery ---
  let allCameras = [];
  try {
    const camerasData = await graphql(QUERY_ALL_CAMERAS);
    allCameras = toArray(camerasData?.allCameras);
  } catch (err) {
    console.error('[collectAllData] Błąd pobierania kamer:', err.message);
  }

  // --- 5. Licencja ---
  let licenseStatus = null;
  try {
    const licenseData = await graphql(QUERY_LICENSE);
    licenseStatus = licenseData?.getLicenseStatus || null;
  } catch (err) {
    console.error('[collectAllData] Błąd pobierania licencji:', err.message);
  }

  // --- 6. Integracje (MQTT, Kafka) ---
  let mqttSettings = null;
  try {
    const mqttData = await graphql(`
      query {
        getMQTTSettings {
          enabled
          host
          port
          username
          topic_prefix
        }
      }
    `);
    mqttSettings = mqttData?.getMQTTSettings || null;
  } catch (err) {
    // ignorujemy
  }

  let kafkaSettings = null;
  try {
    const kafkaData = await graphql(`
      query {
        getKafkaSettings {
          enabled
          bootstrap_servers
          topic
          security_protocol
        }
      }
    `);
    kafkaSettings = kafkaData?.getKafkaSettings || null;
  } catch (err) {
    // ignorujemy
  }

  // --- 7. Wynik ---
  const lineRows = detailedApps.flatMap((app) =>
    app.lines.map((line) => ({
      application_uuid: app.uuid,
      application_name: app.name,
      camera_name: app.camera?.name || null,
      line_uuid: line.uuid,
      line_name: line.name,
      total_in: line.totals.in,
      total_out: line.totals.out,
      live_in: line.live.total_in,
      live_out: line.live.total_out,
      buckets: line.data.buckets,
      first_bucket: line.data.first_bucket,
      last_bucket: line.data.last_bucket,
    }))
  );

  lineRows.sort((a, b) => b.total_out - a.total_out || b.total_in - a.total_in);

  const areaRows = detailedApps.flatMap((app) =>
    app.areas.map((area) => ({
      application_uuid: app.uuid,
      application_name: app.name,
      camera_name: app.camera?.name || null,
      area_uuid: area.uuid,
      area_name: area.name,
      avg_min: area.totals.min,
      avg_avg: area.totals.avg,
      avg_max: area.totals.max,
      live_count: area.live.total_count,
      buckets: area.data.buckets,
    }))
  );

  areaRows.sort((a, b) => b.avg_avg - a.avg_avg);

  return {
    ok: true,
    generated_at: nowIso(),
    filters: {
      preset,
      class: classes.join(','),
      app: filters.app || '',
      camera: filters.camera || '',
      line: filters.line || '',
      area: filters.area || '',
    },
    available_presets: allowedPresets,
    totals: {
      objectflow_apps: detailedApps.length,
      selected_in: sumBy(detailedApps, (x) => x.totals.in),
      selected_out: sumBy(detailedApps, (x) => x.totals.out),
      selected_area_avg: detailedApps.length ? sumBy(detailedApps, (x) => x.area_totals.avg) / detailedApps.length : 0,
      selected_area_count: sumBy(detailedApps, (x) => x.area_totals.count),
    },
    applications: detailedApps,
    lines: lineRows,
    areas: areaRows,
    cameras: allCameras,
    license: licenseStatus,
    integrations: {
      mqtt: mqttSettings,
      kafka: kafkaSettings,
    },
  };
}

// ============================================================
// BUFOR PAMIĘCIOWY (cache)
// ============================================================
let cachedData = null;
let lastSuccess = null;
let isPolling = false;
let pollError = null;

async function refreshCache(filters = {}) {
  if (isPolling) return;
  isPolling = true;
  try {
    console.log('[refreshCache] Rozpoczynam odświeżanie danych...');
    const data = await collectAllData(filters);
    cachedData = data;
    lastSuccess = nowIso();
    pollError = null;
    console.log(`[refreshCache] Odświeżono dane. Aplikacji: ${data.totals.objectflow_apps}, IN: ${data.totals.selected_in}, OUT: ${data.totals.selected_out}`);
  } catch (err) {
    pollError = err.message;
    console.error('[refreshCache] Błąd odświeżania:', err.message);
  } finally {
    isPolling = false;
  }
}

function getCachedData() {
  if (!cachedData) {
    return {
      ok: false,
      error: 'Brak danych w pamięci podręcznej – pierwsze odświeżenie w toku...',
      generated_at: nowIso(),
      last_success: lastSuccess,
      poll_error: pollError,
    };
  }
  return {
    ...cachedData,
    cached_at: nowIso(),
    last_success: lastSuccess,
    poll_error: pollError,
    is_polling: isPolling,
  };
}

// ============================================================
// SERWER HTTP
// ============================================================

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function parseFilters(url) {
  return {
    preset: url.searchParams.get('preset') || '',
    class: url.searchParams.get('class') || '',
    app: url.searchParams.get('app') || '',
    camera: url.searchParams.get('camera') || '',
    line: url.searchParams.get('line') || '',
    area: url.searchParams.get('area') || '',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    return sendOptions(res);
  }

  // GET /
  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'Isarsoft Dashboard Cache',
      version: '2.2.0',
      endpoints: [
        { path: '/', description: 'Informacje' },
        { path: '/health', description: 'Status serwera' },
        { path: '/data', description: 'Dane z cache (domyślnie LAST_1_DAY)' },
        { path: '/data?preset=LAST_1_HOUR', description: 'Dane z cache z wybranym presetem' },
        { path: '/refresh', description: 'Wymusza odświeżenie cache' },
        { path: '/debug/lines', description: 'Podgląd linii' },
        { path: '/debug/areas', description: 'Podgląd obszarów' },
        { path: '/debug/apps', description: 'Podgląd aplikacji' },
        { path: '/raw', description: 'Pobiera dane bezpośrednio z API (pomija cache)' },
      ],
      filters: {
        preset: 'np. LAST_1_HOUR, LAST_1_DAY, THIS_YEAR, ...',
        class: 'PERSON, HEAD, ...',
        app: 'filtruje po nazwie aplikacji',
        camera: 'filtruje po nazwie kamery',
        line: 'filtruje po nazwie linii',
        area: 'filtruje po nazwie obszaru',
      },
      cached: {
        available: !!cachedData,
        last_success: lastSuccess,
        is_polling: isPolling,
        poll_error: pollError,
      },
      time: nowIso(),
    });
  }

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'Isarsoft Dashboard Cache',
      version: '2.2.0',
      cached: {
        available: !!cachedData,
        last_success: lastSuccess,
        is_polling: isPolling,
        poll_error: pollError,
      },
      token: {
        valid: !!tokenCache.token,
        expires_at: tokenCache.expiresAt ? new Date(tokenCache.expiresAt).toISOString() : null,
      },
      time: nowIso(),
    });
  }

  // GET /refresh
  if (req.method === 'GET' && url.pathname === '/refresh') {
    const filters = parseFilters(url);
    await refreshCache(filters);
    return sendJson(res, 200, {
      ok: true,
      message: 'Cache odświeżony',
      filters,
      cached: {
        available: !!cachedData,
        last_success: lastSuccess,
        is_polling: isPolling,
        poll_error: pollError,
      },
      time: nowIso(),
    });
  }

  // GET /data
  if (req.method === 'GET' && url.pathname === '/data') {
    // Jeśli podano preset, możemy odświeżyć cache z tym presetem (ale to kosztowne)
    // Dla uproszczenia zwracamy dane z cache, ale z informacją o aktualnym presetcie.
    const data = getCachedData();
    if (!data.ok) {
      return sendJson(res, 503, data);
    }
    // Można dodać możliwość filtrowania po stronie serwera, ale to już zrobione w collectAllData
    // – tutaj zwracamy to, co jest w cache.
    return sendJson(res, 200, data);
  }

  // GET /raw – pobiera dane na żywo z API (pomija cache)
  if (req.method === 'GET' && url.pathname === '/raw') {
    try {
      const filters = parseFilters(url);
      const rawData = await collectAllData(filters);
      return sendJson(res, 200, {
        ok: true,
        source: 'direct_api',
        ...rawData,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // GET /debug/lines
  if (req.method === 'GET' && url.pathname === '/debug/lines') {
    const data = getCachedData();
    if (!data.ok) {
      return sendJson(res, 503, data);
    }
    return sendJson(res, 200, {
      ok: true,
      generated_at: data.generated_at,
      filters: data.filters,
      totals: data.totals,
      lines: data.lines || [],
      line_count: (data.lines || []).length,
    });
  }

  // GET /debug/areas
  if (req.method === 'GET' && url.pathname === '/debug/areas') {
    const data = getCachedData();
    if (!data.ok) {
      return sendJson(res, 503, data);
    }
    return sendJson(res, 200, {
      ok: true,
      generated_at: data.generated_at,
      filters: data.filters,
      totals: data.totals,
      areas: data.areas || [],
      area_count: (data.areas || []).length,
    });
  }

  // GET /debug/apps
  if (req.method === 'GET' && url.pathname === '/debug/apps') {
    const data = getCachedData();
    if (!data.ok) {
      return sendJson(res, 503, data);
    }
    return sendJson(res, 200, {
      ok: true,
      generated_at: data.generated_at,
      filters: data.filters,
      totals: data.totals,
      applications: data.applications?.map((app) => ({
        uuid: app.uuid,
        name: app.name,
        status: app.status,
        camera: app.camera?.name || null,
        lines_count: app.lines.length,
        areas_count: app.areas.length,
        total_in: app.totals.in,
        total_out: app.totals.out,
      })) || [],
    });
  }

  // 404
  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

// ============================================================
// URUCHOMIENIE
// ============================================================

server.listen(CONFIG.port, async () => {
  console.log(JSON.stringify({
    ok: true,
    message: 'Isarsoft Dashboard Cache Server started',
    version: '2.2.0',
    port: CONFIG.port,
    baseUrl: CONFIG.baseUrl,
    defaultPreset: CONFIG.defaultPreset,
    defaultClasses: CONFIG.defaultClasses,
    pollIntervalMs: CONFIG.pollIntervalMs,
    time: nowIso(),
  }, null, 2));

  try {
    console.log('[startup] Pierwsze odświeżenie cache...');
    await refreshCache();
    console.log('[startup] Cache zainicjalizowany.');
  } catch (err) {
    console.error('[startup] Błąd inicjalizacji cache:', err.message);
  }

  setInterval(async () => {
    try {
      await refreshCache();
    } catch (err) {
      console.error('[interval] Błąd odświeżania:', err.message);
    }
  }, CONFIG.pollIntervalMs);

  console.log(`[startup] Serwer nasłuchuje na porcie ${CONFIG.port}, odświeżanie co ${CONFIG.pollIntervalMs / 1000}s`);
});

// ============================================================
// ZAMKNIĘCIE
// ============================================================
process.on('SIGINT', () => {
  console.log('[shutdown] Otrzymano SIGINT, zamykam serwer...');
  server.close(() => {
    console.log('[shutdown] Serwer zamknięty.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Otrzymano SIGTERM, zamykam serwer...');
  server.close(() => {
    console.log('[shutdown] Serwer zamknięty.');
    process.exit(0);
  });
});