'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const { SerialPort } = require('serialport');
const { GPS } = require('gps');

const PC_ID = process.env.PC_ID || 1;
const PC_NAME = process.env.PC_NAME || 'pc_number_113';

const ROOM_SERVER_URL =
  process.env.ROOM_SERVER_URL || 'http://192.168.77.152:3001/api/data';

const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 30 * 1000);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS || 5 * 1000);

const GPS_PORT_PATH = process.env.GPS_PORT_PATH || '/dev/ttyUSB0';
const GPS_BAUD_RATE = Number(process.env.GPS_BAUD_RATE || 9600);

const GPS_FIX_MAX_AGE_MS = Number(process.env.GPS_FIX_MAX_AGE_MS || 30 * 1000);
const GPS_REOPEN_DELAY_MS = Number(process.env.GPS_REOPEN_DELAY_MS || 10 * 1000);
const GEO_FALLBACK_URL = process.env.GEO_FALLBACK_URL || 'http://ip-api.com/json/';
const ENABLE_IP_GEO_FALLBACK = process.env.ENABLE_IP_GEO_FALLBACK !== 'false';

const CONFIG = {
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
  defaultPreset: process.env.ISARSOFT_PRESET || 'LAST_1_DAY',
  defaultClasses: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),
};

let currentLatitude = null;
let currentLongitude = null;
let currentAltitude = null;
let gpsFix = false;
let gpsEnabled = false;
let lastGpsLogTime = 0;
let lastValidGpsAt = 0;
let lastNmeaAt = 0;
let gpsSource = 'none';
let serialPortRef = null;
let reopenTimer = null;
let ipGeoCache = {
  latitude: null,
  longitude: null,
  fetchedAt: 0,
  source: 'none',
};

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

function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180;
}

function hasFreshGpsFix() {
  return (
    gpsFix &&
    isValidCoordinate(currentLatitude, currentLongitude) &&
    Date.now() - lastValidGpsAt <= GPS_FIX_MAX_AGE_MS
  );
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: CONFIG.verifyTls,
});

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

    req.on('timeout', () =>
      req.destroy(new Error(`Timeout after ${CONFIG.requestTimeoutMs}ms`))
    );
    req.on('error', reject);

    if (body) req.write(body);
    req.end();
  });
}

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

const QUERY_ALL_CAMERAS = `
query {
  allCameras {
    uuid
    name
  }
}
`;

const QUERY_LICENSE = `
query {
  getLicenseStatus {
    valid
  }
}
`;

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

function flattenRows(rows) {
  if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
    return rows.flat();
  }
  return toArray(rows);
}

function summarizeBuckets(rows) {
  const raw = flattenRows(rows);
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
  const raw = flattenRows(rows);
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
  const raw = flattenRows(rows);
  return {
    total_in: sumBy(raw, (x) => x?.count_in),
    total_out: sumBy(raw, (x) => x?.count_out),
    raw,
  };
}

function summarizeAreaLive(rows) {
  const raw = flattenRows(rows);
  return {
    total_count: sumBy(raw, (x) => x?.count),
    raw,
  };
}

async function collectAllData(filters = {}) {
  let allowedPresets = [
    'LAST_1_DAY',
    'LAST_1_HOUR',
    'LAST_12_HOUR',
    'THIS_YEAR',
    'THIS_WEEK',
    'THIS_MONTH',
  ];

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

  let apps = [];
  try {
    const appsData = await graphql(QUERY_OBJECTFLOW_APPS);
    apps = toArray(appsData?.allApplications).filter((x) => x.__typename === 'ObjectFlow');
  } catch (err) {
    console.error('[collectAllData] Błąd pobierania aplikacji:', err.message);
    throw err;
  }

  if (filters.app) {
    apps = apps.filter((x) => lower(x.name).includes(lower(filters.app)));
  }
  if (filters.camera) {
    apps = apps.filter((x) => lower(x.camera?.name).includes(lower(filters.camera)));
  }

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

  let allCameras = [];
  try {
    const camerasData = await graphql(QUERY_ALL_CAMERAS);
    allCameras = toArray(camerasData?.allCameras);
  } catch (err) {
    console.error('[collectAllData] Błąd pobierania kamer:', err.message);
  }

  let licenseStatus = null;
  try {
    const licenseData = await graphql(QUERY_LICENSE);
    licenseStatus = licenseData?.getLicenseStatus || null;
  } catch (err) {
    console.error('[collectAllData] Błąd pobierania licencji:', err.message);
  }

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
  } catch {}

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
  } catch {}

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
      selected_area_avg: detailedApps.length
        ? sumBy(detailedApps, (x) => x.area_totals.avg) / detailedApps.length
        : 0,
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

let cachedData = null;
let lastRefreshSuccess = null;

async function refreshCache() {
  try {
    console.log('[refreshCache] Odświeżanie danych z Isarsoft...');
    const data = await collectAllData();
    cachedData = data;
    lastRefreshSuccess = nowIso();
    console.log(
      `[refreshCache] Dane odświeżone. Aplikacji: ${data.totals.objectflow_apps}, IN: ${data.totals.selected_in}, OUT: ${data.totals.selected_out}`
    );
  } catch (err) {
    console.error('[refreshCache] Błąd odświeżania:', err.message);
  }
}

function scheduleSerialReopen() {
  if (reopenTimer) return;
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    if (serialPortRef && !serialPortRef.isOpen) {
      console.log('[GPS] Próba ponownego otwarcia portu...');
      serialPortRef.open((err) => {
        if (err) {
          console.error(`[GPS] Ponowne otwarcie nieudane: ${err.message}`);
          scheduleSerialReopen();
        }
      });
    }
  }, GPS_REOPEN_DELAY_MS);
}

function updateGpsFromState(gps, reason) {
  const lat = Number(gps?.state?.lat);
  const lon = Number(gps?.state?.lon);
  const alt = Number(gps?.state?.alt);

  if (isValidCoordinate(lat, lon)) {
    currentLatitude = lat;
    currentLongitude = lon;
    currentAltitude = Number.isFinite(alt) ? alt : null;
    gpsFix = true;
    lastValidGpsAt = Date.now();
    gpsSource = reason || 'gps';
  }
}

function initGps() {
  const gps = new GPS();

  gps.on('data', (data) => {
    lastNmeaAt = Date.now();

    if (data?.valid === false) {
      return;
    }

    if (data.type === 'GGA') {
      if (data.quality !== undefined && data.quality > 0) {
        updateGpsFromState(gps, 'gps-gga');
        console.log(
          `[GPS] Fix GGA: lat=${currentLatitude}, lon=${currentLongitude}, alt=${currentAltitude}`
        );
      }
      return;
    }

    if (data.type === 'RMC') {
      if (data.status === 'active' || data.status === 'A') {
        updateGpsFromState(gps, 'gps-rmc');
        console.log(`[GPS] Fix RMC: lat=${currentLatitude}, lon=${currentLongitude}`);
      }
      return;
    }

    if (data.type === 'GLL') {
      if (data.status === 'active' || data.status === 'A') {
        updateGpsFromState(gps, 'gps-gll');
        console.log(`[GPS] Fix GLL: lat=${currentLatitude}, lon=${currentLongitude}`);
      }
      return;
    }

    updateGpsFromState(gps, 'gps-state');
  });

  gps.on('error', (err) => {
    console.error('[GPS] Błąd parsera NMEA:', err.message);
  });

  const serialPort = new SerialPort({
    path: GPS_PORT_PATH,
    baudRate: GPS_BAUD_RATE,
    autoOpen: false,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    rtscts: false,
  });

  serialPortRef = serialPort;

  serialPort.on('open', () => {
    console.log(`[GPS] Port ${GPS_PORT_PATH} otwarty, prędkość ${GPS_BAUD_RATE} bps`);
    gpsEnabled = true;
  });

  let rawDataBuffer = '';
  serialPort.on('data', (chunk) => {
    try {
      const str = chunk.toString('utf8');
      rawDataBuffer += str;

      if (rawDataBuffer.length > 1024) {
        const sample = rawDataBuffer.slice(0, 200).replace(/\r?\n/g, '\\n');
        console.log(`[GPS] Próbka surowych danych: ${sample}...`);
        rawDataBuffer = '';
      }

      gps.updatePartial(str);
    } catch (err) {
      console.error('[GPS] Błąd przetwarzania danych z portu:', err.message);
    }
  });

  serialPort.on('error', (err) => {
    console.error(`[GPS] Błąd portu ${GPS_PORT_PATH}: ${err.message}`);
    gpsEnabled = false;
    gpsFix = false;
    scheduleSerialReopen();
  });

  serialPort.on('close', () => {
    console.warn(`[GPS] Port ${GPS_PORT_PATH} zamknięty`);
    gpsEnabled = false;
    gpsFix = false;
    scheduleSerialReopen();
  });

  serialPort.open((err) => {
    if (err) {
      console.error(`[GPS] Nie udało się otworzyć portu ${GPS_PORT_PATH}: ${err.message}`);
      gpsEnabled = false;
      scheduleSerialReopen();
    }
  });
}

async function getIpFallbackLocation() {
  if (!ENABLE_IP_GEO_FALLBACK) return null;

  const cacheFresh = Date.now() - ipGeoCache.fetchedAt < 10 * 60 * 1000;
  if (
    cacheFresh &&
    isValidCoordinate(ipGeoCache.latitude, ipGeoCache.longitude)
  ) {
    return {
      latitude: ipGeoCache.latitude,
      longitude: ipGeoCache.longitude,
      source: ipGeoCache.source,
    };
  }

  try {
    const res = await requestRaw(GEO_FALLBACK_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'isarsoft-pc-client/1.0',
      },
    });

    const json = res.json();
    if (!res.ok || !json) {
      throw new Error(`HTTP ${res.status}`);
    }

    const lat = Number(json.lat ?? json.latitude);
    const lon = Number(json.lon ?? json.longitude);

    if (!isValidCoordinate(lat, lon)) {
      throw new Error('Brak poprawnych współrzędnych w odpowiedzi fallback');
    }

    ipGeoCache = {
      latitude: lat,
      longitude: lon,
      fetchedAt: Date.now(),
      source: 'ip-geolocation',
    };

    console.warn(`[GPS] Używam fallback IP geolocation: lat=${lat}, lon=${lon}`);
    return {
      latitude: lat,
      longitude: lon,
      source: 'ip-geolocation',
    };
  } catch (err) {
    console.error('[GPS] Fallback IP geolocation nieudany:', err.message);
    return null;
  }
}

async function resolveLocationForPayload() {
  if (hasFreshGpsFix()) {
    return {
      latitude: currentLatitude,
      longitude: currentLongitude,
      source: gpsSource || 'gps',
      gpsFix: true,
    };
  }

  const fallback = await getIpFallbackLocation();
  if (fallback) {
    return {
      latitude: fallback.latitude,
      longitude: fallback.longitude,
      source: fallback.source,
      gpsFix: false,
    };
  }

  if (isValidCoordinate(currentLatitude, currentLongitude)) {
    return {
      latitude: currentLatitude,
      longitude: currentLongitude,
      source: gpsSource || 'stale-gps',
      gpsFix: false,
    };
  }

  return {
    latitude: 0,
    longitude: 0,
    source: 'none',
    gpsFix: false,
  };
}

async function sendDataToRoom() {
  if (!cachedData) {
    console.warn('[sendDataToRoom] Brak danych w cache, pomijam wysyłkę.');
    return;
  }

  const location = await resolveLocationForPayload();

  const payload = {
    pcId: PC_ID,
    pcName: PC_NAME,
    timestamp: nowIso(),
    latitude: location.latitude,
    longitude: location.longitude,
    locationSource: location.source,
    gpsFix: location.gpsFix,
    lastValidGpsAt: lastValidGpsAt ? new Date(lastValidGpsAt).toISOString() : null,
    data: cachedData,
  };

  console.log(
    `[sendDataToRoom] source=${location.source}, gpsFix=${location.gpsFix ? 'TAK' : 'NIE'}, lat=${location.latitude}, lon=${location.longitude}`
  );

  try {
    const postData = JSON.stringify(payload);
    const url = new URL(ROOM_SERVER_URL);
    const lib = url.protocol === 'https:' ? https : http;

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: CONFIG.requestTimeoutMs,
    };

    const res = await new Promise((resolve, reject) => {
      const req = lib.request(url, options, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      });
      req.on('error', reject);
      req.on('timeout', () =>
        req.destroy(new Error('Timeout wysyłania do serwera pokojowego'))
      );
      req.write(postData);
      req.end();
    });

    if (res.status >= 200 && res.status < 300) {
      console.log(`[sendDataToRoom] Dane wysłane do ${ROOM_SERVER_URL}, status: ${res.status}`);
    } else {
      console.warn(`[sendDataToRoom] Serwer odpowiedział statusem ${res.status}, treść: ${res.body}`);
    }
  } catch (err) {
    console.error('[sendDataToRoom] Błąd wysyłania:', err.message);
  }
}

function logGpsStatus() {
  const now = Date.now();
  if (now - lastGpsLogTime > 10000) {
    lastGpsLogTime = now;
    console.log(
      `[GPS] Status: enabled=${gpsEnabled}, fix=${hasFreshGpsFix()}, source=${gpsSource}, lat=${currentLatitude}, lon=${currentLongitude}, lastNmeaAt=${lastNmeaAt ? new Date(lastNmeaAt).toISOString() : 'BRAK'}`
    );
  }
}

async function start() {
  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'Isarsoft PC Client started',
        pcId: PC_ID,
        pcName: PC_NAME,
        roomServerUrl: ROOM_SERVER_URL,
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        sendIntervalMs: SEND_INTERVAL_MS,
        gpsPort: GPS_PORT_PATH,
        gpsBaudRate: GPS_BAUD_RATE,
        gpsFixMaxAgeMs: GPS_FIX_MAX_AGE_MS,
        ipGeoFallback: ENABLE_IP_GEO_FALLBACK,
        time: nowIso(),
      },
      null,
      2
    )
  );

  initGps();
  setInterval(logGpsStatus, 5000);

  await refreshCache();
  setInterval(refreshCache, REFRESH_INTERVAL_MS);

  setInterval(() => {
    sendDataToRoom().catch((err) => {
      console.error('[sendDataToRoom] Błąd cykliczny:', err.message);
    });
  }, SEND_INTERVAL_MS);

  await sendDataToRoom();
}

start().catch((err) => console.error('[start] Błąd krytyczny:', err));