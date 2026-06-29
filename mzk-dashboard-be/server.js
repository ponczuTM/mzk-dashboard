'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const fs = require('fs').promises;
const path = require('path');

// ============================
// KONFIGURACJA I STAŁE
// ============================

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
  defaultPreset: process.env.ISARSOFT_PRESET || 'LAST_1_DAY',
  defaultClasses: (process.env.ISARSOFT_CLASSES || 'PERSON,HEAD')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5 * 60 * 1000),
  // Nowe stałe dla symulacji
  simulationIntervalMs: 5000, // co 5 sekund
  delayThresholdSeconds: 10,   // próg punktualności
  maxHistoryEntries: 1000,     // ograniczenie historii
};

const VEHICLE_ID = 'first_bus_line_113';
const DB_PATH = path.join(__dirname, 'database.json');

// ============================
// POMOCNICY OGÓLNI (istniejący)
// ============================

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

// ============================
// OBSŁUGA BAZY DANYCH (database.json)
// ============================

/**
 * Zwraca domyślną strukturę bazy z przykładowymi danymi dla linii 113 w Toruniu.
 */
function getDefaultDatabase() {
  return {
    stops: [
      {
        stop_id: 'stop_1',
        name: 'Plac Rapackiego',
        number: '01',
        latitude: 53.0138,
        longitude: 18.5982,
        admin_zone: 'Toruń',
        zone_type: 'stały',
      },
      {
        stop_id: 'stop_2',
        name: 'Dworzec Główny',
        number: '02',
        latitude: 53.0146,
        longitude: 18.5998,
        admin_zone: 'Toruń',
        zone_type: 'stały',
      },
      {
        stop_id: 'stop_3',
        name: 'Bydgoska',
        number: '03',
        latitude: 53.0133,
        longitude: 18.6022,
        admin_zone: 'Toruń',
        zone_type: 'stały',
      },
      {
        stop_id: 'stop_4',
        name: 'Szosa Chełmińska',
        number: '04',
        latitude: 53.0106,
        longitude: 18.6015,
        admin_zone: 'Toruń',
        zone_type: 'stały',
      },
      {
        stop_id: 'stop_5',
        name: 'Włocławska',
        number: '05',
        latitude: 53.0088,
        longitude: 18.5983,
        admin_zone: 'Toruń',
        zone_type: 'na żądanie',
      },
    ],
    schedules: [
      {
        line: '113',
        direction: 'Dworzec Główny → Włocławska',
        day_type: 'weekday',
        stops_sequence: [
          { stop_id: 'stop_1', planned_time: '06:00:00' },
          { stop_id: 'stop_2', planned_time: '06:05:00' },
          { stop_id: 'stop_3', planned_time: '06:10:00' },
          { stop_id: 'stop_4', planned_time: '06:15:00' },
          { stop_id: 'stop_5', planned_time: '06:20:00' },
        ],
      },
      {
        line: '113',
        direction: 'Dworzec Główny → Włocławska',
        day_type: 'weekend',
        stops_sequence: [
          { stop_id: 'stop_1', planned_time: '07:00:00' },
          { stop_id: 'stop_2', planned_time: '07:06:00' },
          { stop_id: 'stop_3', planned_time: '07:12:00' },
          { stop_id: 'stop_4', planned_time: '07:18:00' },
          { stop_id: 'stop_5', planned_time: '07:24:00' },
        ],
      },
    ],
    trips: {
      vehicle_id: VEHICLE_ID,
      current_stop_index: 0,
      current_position: { lat: 53.0138, lng: 18.5982 },
      next_stop: null,
      planned_time: null,
      actual_time: null,
      status: 'o czasie',
      delay_seconds: 0,
      last_update: null,
      data_quality: { complete: true, errors: [] },
    },
    history: [],
  };
}

/**
 * Atomowy odczyt bazy danych.
 */
async function readDatabase() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Baza nie istnieje – tworzymy domyślną i zapisujemy
      const defaultData = getDefaultDatabase();
      await writeDatabase(defaultData);
      return defaultData;
    }
    throw err;
  }
}

/**
 * Atomowy zapis bazy danych (przez plik tymczasowy + rename).
 */
async function writeDatabase(data) {
  const tempPath = DB_PATH + '.tmp';
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fs.rename(tempPath, DB_PATH);
}

// ============================
// FUNKCJE POMOCNICZE DLA SYMULACJI
// ============================

/**
 * Określa typ dnia na podstawie aktualnej daty.
 * Pomija święta – uproszczenie.
 */
function getCurrentDayType() {
  const now = new Date();
  const day = now.getDay(); // 0 = niedziela, 6 = sobota
  if (day === 0 || day === 6) return 'weekend';
  return 'weekday';
}

/**
 * Konwertuje czas HH:MM:SS na liczbę sekund od północy.
 */
function timeToSeconds(timeStr) {
  const parts = timeStr.split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/**
 * Formatuje różnicę w sekundach na czytelny napis HH:MM:SS.
 * Dla wartości ujemnej zwraca z minusem.
 */
function formatDelay(seconds) {
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  const sign = seconds < 0 ? '-' : '';
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Interpoluje współrzędne między dwoma przystankami na podstawie frakcji (0..1).
 */
function interpolatePosition(stopA, stopB, fraction) {
  const lat = stopA.latitude + fraction * (stopB.latitude - stopA.latitude);
  const lng = stopA.longitude + fraction * (stopB.longitude - stopA.longitude);
  return { lat, lng };
}

/**
 * Sprawdza jakość danych z kamer na podstawie globalnego cache.
 */
function checkCameraQuality() {
  const result = { complete: true, errors: [] };

  // Jeśli cache jest pusty lub wystąpił błąd pobierania
  if (!cachedData || pollError) {
    result.complete = false;
    result.errors.push('Brak danych z Isarsoft – pomiar wadliwy');
    return result;
  }

  // Sprawdzamy, czy mamy jakiekolwiek kamery
  const cameras = cachedData.cameras || [];
  if (cameras.length === 0) {
    result.complete = false;
    result.errors.push('Brak zarejestrowanych kamer – pomiar wadliwy');
    return result;
  }

  // Opcjonalnie: sprawdź, czy wszystkie aplikacje ObjectFlow są online
  const apps = cachedData.applications || [];
  const offlineApps = apps.filter(app => app.status !== 'online' && app.status !== 'OK');
  if (offlineApps.length > 0) {
    result.complete = false;
    result.errors.push(`Następujące aplikacje są offline: ${offlineApps.map(a => a.name).join(', ')}`);
  }

  return result;
}

// ============================
// GŁÓWNA LOGIKA SYMULACJI (wywoływana co 5 sekund)
// ============================

async function simulatePosition() {
  try {
    // 1. Odczyt bazy
    const db = await readDatabase();

    // 2. Pobranie aktualnego dnia i znalezienie odpowiedniego rozkładu
    const dayType = getCurrentDayType();
    const schedule = db.schedules.find(
      (s) => s.line === '113' && s.day_type === dayType
    );

    if (!schedule) {
      // Brak rozkładu – nie aktualizujemy pozycji
      console.log(`[simulate] Brak rozkładu dla dnia ${dayType}, pomijam aktualizację.`);
      return;
    }

    const stopsSeq = schedule.stops_sequence;
    if (!stopsSeq || stopsSeq.length < 2) {
      console.log('[simulate] Rozkład ma mniej niż 2 przystanki – pomijam.');
      return;
    }

    // 3. Pobranie pełnych danych przystanków (z kolekcji stops)
    const stopsMap = {};
    db.stops.forEach((stop) => {
      stopsMap[stop.stop_id] = stop;
    });

    // Sprawdzenie, czy wszystkie stop_id z rozkładu istnieją
    const missingStops = stopsSeq
      .map((item) => item.stop_id)
      .filter((id) => !stopsMap[id]);
    if (missingStops.length > 0) {
      console.log(`[simulate] Brak danych dla przystanków: ${missingStops.join(', ')}`);
      return;
    }

    // 4. Obliczenie planowanych czasów w sekundach od północy
    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentSeconds = Math.floor((now.getTime() - todayMidnight.getTime()) / 1000);

    const plannedTimes = stopsSeq.map((item) => timeToSeconds(item.planned_time));

    // 5. Znalezienie przedziału, w którym znajduje się aktualny czas
    let index = 0;
    while (index < plannedTimes.length - 1 && currentSeconds > plannedTimes[index + 1]) {
      index++;
    }

    // Jeśli czas jest przed pierwszym przystankiem
    if (currentSeconds < plannedTimes[0]) {
      // Autobus jeszcze nie ruszył – stoi na pierwszym przystanku
      const firstStop = stopsMap[stopsSeq[0].stop_id];
      const nextStop = stopsMap[stopsSeq[1].stop_id];
      const delay = currentSeconds - plannedTimes[0]; // ujemne (za wcześnie)
      const status = delay < -CONFIG.delayThresholdSeconds ? 'za szybko' : 'o czasie';

      // Aktualizacja trips
      db.trips.current_stop_index = 0;
      db.trips.current_position = { lat: firstStop.latitude, lng: firstStop.longitude };
      db.trips.next_stop = {
        stop_id: firstStop.stop_id,
        name: firstStop.name,
        planned_time: stopsSeq[0].planned_time,
      };
      db.trips.planned_time = stopsSeq[0].planned_time;
      db.trips.actual_time = nowIso();
      db.trips.status = status;
      db.trips.delay_seconds = delay;
      db.trips.last_update = nowIso();

      // Jakość kamer
      const quality = checkCameraQuality();
      db.trips.data_quality = quality;

      // Dodanie do historii
      db.history.push({
        timestamp: nowIso(),
        lat: firstStop.latitude,
        lng: firstStop.longitude,
        stop_id: firstStop.stop_id,
        status: status,
        delay_seconds: delay,
      });
      // Ograniczenie historii
      if (db.history.length > CONFIG.maxHistoryEntries) {
        db.history = db.history.slice(-CONFIG.maxHistoryEntries);
      }

      await writeDatabase(db);

      // Log
      const statusText = status === 'o czasie' ? 'O CZASIE' : status.toUpperCase();
      console.log(
        `Zaktualizowano pozycję komputera pokładowego (${VEHICLE_ID}). Współrzędne: [${firstStop.latitude.toFixed(4)}, ${firstStop.longitude.toFixed(4)}]. Status: ${statusText} (odchylenie ${formatDelay(delay)}) względem przystanku ${firstStop.name} (Rozkład: ${dayType})`
      );
      return;
    }

    // Jeśli czas jest po ostatnim przystanku
    if (currentSeconds >= plannedTimes[plannedTimes.length - 1]) {
      const lastStop = stopsMap[stopsSeq[stopsSeq.length - 1].stop_id];
      const delay = currentSeconds - plannedTimes[plannedTimes.length - 1];
      const status = delay > CONFIG.delayThresholdSeconds ? 'opóźniony' : 'o czasie';

      db.trips.current_stop_index = stopsSeq.length - 1;
      db.trips.current_position = { lat: lastStop.latitude, lng: lastStop.longitude };
      db.trips.next_stop = {
        stop_id: lastStop.stop_id,
        name: lastStop.name,
        planned_time: stopsSeq[stopsSeq.length - 1].planned_time,
      };
      db.trips.planned_time = stopsSeq[stopsSeq.length - 1].planned_time;
      db.trips.actual_time = nowIso();
      db.trips.status = status;
      db.trips.delay_seconds = delay;
      db.trips.last_update = nowIso();

      const quality = checkCameraQuality();
      db.trips.data_quality = quality;

      db.history.push({
        timestamp: nowIso(),
        lat: lastStop.latitude,
        lng: lastStop.longitude,
        stop_id: lastStop.stop_id,
        status: status,
        delay_seconds: delay,
      });
      if (db.history.length > CONFIG.maxHistoryEntries) {
        db.history = db.history.slice(-CONFIG.maxHistoryEntries);
      }

      await writeDatabase(db);

      const statusText = status === 'o czasie' ? 'O CZASIE' : status.toUpperCase();
      console.log(
        `Zaktualizowano pozycję komputera pokładowego (${VEHICLE_ID}). Współrzędne: [${lastStop.latitude.toFixed(4)}, ${lastStop.longitude.toFixed(4)}]. Status: ${statusText} (odchylenie ${formatDelay(delay)}) względem przystanku ${lastStop.name} (Rozkład: ${dayType})`
      );
      return;
    }

    // 6. Interpolacja między przystankiem 'index' a 'index+1'
    const stopA = stopsMap[stopsSeq[index].stop_id];
    const stopB = stopsMap[stopsSeq[index + 1].stop_id];
    const tA = plannedTimes[index];
    const tB = plannedTimes[index + 1];
    const fraction = (currentSeconds - tA) / (tB - tA); // 0..1

    const pos = interpolatePosition(stopA, stopB, fraction);

    // 7. Określenie statusu na podstawie najbliższego przystanku docelowego (index+1)
    const delay = currentSeconds - plannedTimes[index + 1];
    let status = 'o czasie';
    if (delay > CONFIG.delayThresholdSeconds) status = 'opóźniony';
    else if (delay < -CONFIG.delayThresholdSeconds) status = 'za szybko';

    // 8. Aktualizacja trips
    db.trips.current_stop_index = index;
    db.trips.current_position = { lat: pos.lat, lng: pos.lng };
    db.trips.next_stop = {
      stop_id: stopB.stop_id,
      name: stopB.name,
      planned_time: stopsSeq[index + 1].planned_time,
    };
    db.trips.planned_time = stopsSeq[index + 1].planned_time;
    db.trips.actual_time = nowIso();
    db.trips.status = status;
    db.trips.delay_seconds = delay;
    db.trips.last_update = nowIso();

    const quality = checkCameraQuality();
    db.trips.data_quality = quality;

    // 9. Zapis do historii
    db.history.push({
      timestamp: nowIso(),
      lat: pos.lat,
      lng: pos.lng,
      stop_id: stopB.stop_id, // zapisujemy docelowy przystanek
      status: status,
      delay_seconds: delay,
    });
    if (db.history.length > CONFIG.maxHistoryEntries) {
      db.history = db.history.slice(-CONFIG.maxHistoryEntries);
    }

    await writeDatabase(db);

    // 10. Log
    const statusText = status === 'o czasie' ? 'O CZASIE' : status.toUpperCase();
    console.log(
      `Zaktualizowano pozycję komputera pokładowego (${VEHICLE_ID}). Współrzędne: [${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}]. Status: ${statusText} (odchylenie ${formatDelay(delay)}) względem przystanku ${stopB.name} (Rozkład: ${dayType})`
    );
  } catch (err) {
    console.error('[simulatePosition] Błąd:', err.message);
  }
}

// ============================
// ISTNIEJĄCY KOD OBSŁUGI ISARSOFT (bez zmian)
// ============================

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

    req.on('timeout', () => req.destroy(new Error(`Timeout after ${CONFIG.requestTimeoutMs}ms`)));
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

// Zapytania GraphQL
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

async function collectAllData(filters = {}) {
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

// ============================
// CACHE DANYCH ISARSOFT
// ============================

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

// ============================
// SERWER HTTP
// ============================

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/**
 * Pomocnicza funkcja do odczytu body żądania (dla POST).
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    return sendOptions(res);
  }

  // ------------------------------------------------------------
  // 1. GŁÓWNY ENDPOINT INFORMACYJNY
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/') {
    return sendJson(res, 200, {
      ok: true,
      service: 'Isarsoft Dashboard Cache + Symulacja GPS',
      version: '3.0.0',
      endpoints: [
        { path: '/', description: 'Informacje' },
        { path: '/health', description: 'Status serwera' },
        { path: '/data', description: 'Dane z cache Isarsoft' },
        { path: '/raw', description: 'Dane na żywo z Isarsoft' },
        { path: '/refresh', description: 'Wymusza odświeżenie cache' },
        { path: '/debug/lines', description: 'Podgląd linii' },
        { path: '/debug/areas', description: 'Podgląd obszarów' },
        { path: '/debug/apps', description: 'Podgląd aplikacji' },
        // Nowe endpointy
        { path: '/reports/trip/current', description: 'Aktualna pozycja i status pojazdu' },
        { path: '/reports/stop-usage', description: 'Statystyki wykorzystania przystanków' },
        { path: '/reports/on-demand-stops', description: 'Statystyki przystanków na żądanie' },
        { path: '/stops', method: 'POST', description: 'Dodaje nowy przystanek' },
        { path: '/schedules', method: 'POST', description: 'Dodaje/aktualizuje rozkład jazdy' },
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

  // ------------------------------------------------------------
  // 2. HEALTH
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'Isarsoft Dashboard Cache + Symulacja GPS',
      version: '3.0.0',
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

  // ------------------------------------------------------------
  // 3. REFRESH CACHE
  // ------------------------------------------------------------
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

  // ------------------------------------------------------------
  // 4. DANE Z CACHE
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/data') {
    const data = getCachedData();
    if (!data.ok) {
      return sendJson(res, 503, data);
    }
    return sendJson(res, 200, data);
  }

  // ------------------------------------------------------------
  // 5. RAW – BEZPOŚREDNIO Z API
  // ------------------------------------------------------------
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

  // ------------------------------------------------------------
  // 6. DEBUG /lines, /areas, /apps
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/debug/lines') {
    const data = getCachedData();
    if (!data.ok) return sendJson(res, 503, data);
    return sendJson(res, 200, {
      ok: true,
      generated_at: data.generated_at,
      filters: data.filters,
      totals: data.totals,
      lines: data.lines || [],
      line_count: (data.lines || []).length,
    });
  }

  if (req.method === 'GET' && url.pathname === '/debug/areas') {
    const data = getCachedData();
    if (!data.ok) return sendJson(res, 503, data);
    return sendJson(res, 200, {
      ok: true,
      generated_at: data.generated_at,
      filters: data.filters,
      totals: data.totals,
      areas: data.areas || [],
      area_count: (data.areas || []).length,
    });
  }

  if (req.method === 'GET' && url.pathname === '/debug/apps') {
    const data = getCachedData();
    if (!data.ok) return sendJson(res, 503, data);
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

  // ------------------------------------------------------------
  // 7. NOWE ENDPOINTY: /reports/trip/current
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/reports/trip/current') {
    try {
      const db = await readDatabase();
      const trip = db.trips || null;
      if (!trip) {
        return sendJson(res, 404, { ok: false, error: 'Brak danych o kursie' });
      }
      return sendJson(res, 200, {
        ok: true,
        vehicle_id: trip.vehicle_id,
        current_position: trip.current_position,
        next_stop: trip.next_stop,
        planned_time: trip.planned_time,
        actual_time: trip.actual_time,
        status: trip.status,
        delay_seconds: trip.delay_seconds,
        last_update: trip.last_update,
        data_quality: trip.data_quality,
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ------------------------------------------------------------
  // 8. ENDPOINT: /reports/stop-usage
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/reports/stop-usage') {
    try {
      const db = await readDatabase();
      const history = db.history || [];
      const usageMap = {};
      history.forEach((entry) => {
        if (entry.stop_id) {
          usageMap[entry.stop_id] = (usageMap[entry.stop_id] || 0) + 1;
        }
      });
      // Dołącz nazwy przystanków
      const stopsMap = {};
      db.stops.forEach((s) => (stopsMap[s.stop_id] = s));
      const result = Object.keys(usageMap).map((stopId) => ({
        stop_id: stopId,
        name: stopsMap[stopId]?.name || stopId,
        count: usageMap[stopId],
      }));
      result.sort((a, b) => b.count - a.count);
      return sendJson(res, 200, { ok: true, usage: result });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ------------------------------------------------------------
  // 9. ENDPOINT: /reports/on-demand-stops
  // ------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/reports/on-demand-stops') {
    try {
      const db = await readDatabase();
      const onDemandIds = db.stops
        .filter((s) => s.zone_type === 'na żądanie')
        .map((s) => s.stop_id);
      const history = db.history || [];
      const usageMap = {};
      history.forEach((entry) => {
        if (entry.stop_id && onDemandIds.includes(entry.stop_id)) {
          usageMap[entry.stop_id] = (usageMap[entry.stop_id] || 0) + 1;
        }
      });
      const stopsMap = {};
      db.stops.forEach((s) => (stopsMap[s.stop_id] = s));
      const result = onDemandIds.map((stopId) => ({
        stop_id: stopId,
        name: stopsMap[stopId]?.name || stopId,
        count: usageMap[stopId] || 0,
      }));
      result.sort((a, b) => b.count - a.count);
      return sendJson(res, 200, { ok: true, on_demand_usage: result });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ------------------------------------------------------------
  // 10. POST /stops – dodawanie przystanku
  // ------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/stops') {
    try {
      const body = await readRequestBody(req);
      // Walidacja wymaganych pól
      const required = ['stop_id', 'name', 'number', 'latitude', 'longitude', 'admin_zone', 'zone_type'];
      for (const field of required) {
        if (!(field in body)) {
          return sendJson(res, 400, { ok: false, error: `Brak wymaganego pola: ${field}` });
        }
      }
      const db = await readDatabase();
      // Sprawdzenie, czy stop_id już istnieje
      if (db.stops.some((s) => s.stop_id === body.stop_id)) {
        return sendJson(res, 400, { ok: false, error: `Przystanek o ID ${body.stop_id} już istnieje` });
      }
      db.stops.push({
        stop_id: body.stop_id,
        name: body.name,
        number: body.number,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
        admin_zone: body.admin_zone,
        zone_type: body.zone_type,
      });
      await writeDatabase(db);
      return sendJson(res, 201, { ok: true, message: 'Przystanek dodany', stop: body });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ------------------------------------------------------------
  // 11. POST /schedules – dodawanie/aktualizacja rozkładu
  // ------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/schedules') {
    try {
      const body = await readRequestBody(req);
      const required = ['line', 'direction', 'day_type', 'stops_sequence'];
      for (const field of required) {
        if (!(field in body)) {
          return sendJson(res, 400, { ok: false, error: `Brak wymaganego pola: ${field}` });
        }
      }
      // Walidacja stops_sequence
      if (!Array.isArray(body.stops_sequence) || body.stops_sequence.length < 2) {
        return sendJson(res, 400, { ok: false, error: 'stops_sequence musi być tablicą z co najmniej 2 elementami' });
      }
      for (const item of body.stops_sequence) {
        if (!item.stop_id || !item.planned_time) {
          return sendJson(res, 400, { ok: false, error: 'Każdy element stops_sequence wymaga stop_id i planned_time' });
        }
        // Sprawdzenie poprawności czasu HH:MM:SS
        if (!/^\d{2}:\d{2}:\d{2}$/.test(item.planned_time)) {
          return sendJson(res, 400, { ok: false, error: `Nieprawidłowy format czasu: ${item.planned_time}` });
        }
      }

      const db = await readDatabase();
      // Sprawdzenie, czy wszystkie stop_id istnieją
      const existingIds = new Set(db.stops.map((s) => s.stop_id));
      const missing = body.stops_sequence.filter((item) => !existingIds.has(item.stop_id));
      if (missing.length > 0) {
        return sendJson(res, 400, {
          ok: false,
          error: `Następujące stop_id nie istnieją: ${missing.map((m) => m.stop_id).join(', ')}`,
        });
      }

      // Usuń istniejący rozkład dla tej samej linii, kierunku i dnia (aktualizacja)
      const index = db.schedules.findIndex(
        (s) => s.line === body.line && s.direction === body.direction && s.day_type === body.day_type
      );
      const newSchedule = {
        line: body.line,
        direction: body.direction,
        day_type: body.day_type,
        stops_sequence: body.stops_sequence,
      };
      if (index !== -1) {
        db.schedules[index] = newSchedule;
      } else {
        db.schedules.push(newSchedule);
      }
      await writeDatabase(db);
      return sendJson(res, 201, { ok: true, message: 'Rozkład zapisany', schedule: newSchedule });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ------------------------------------------------------------
  // 12. 404
  // ------------------------------------------------------------
  return sendJson(res, 404, { ok: false, error: 'Not found' });
});

// ============================
// URUCHOMIENIE SERWERA
// ============================

server.listen(CONFIG.port, async () => {
  console.log(JSON.stringify({
    ok: true,
    message: 'Isarsoft Dashboard Cache + Symulacja GPS Server started',
    version: '3.0.0',
    port: CONFIG.port,
    baseUrl: CONFIG.baseUrl,
    defaultPreset: CONFIG.defaultPreset,
    defaultClasses: CONFIG.defaultClasses,
    pollIntervalMs: CONFIG.pollIntervalMs,
    simulationIntervalMs: CONFIG.simulationIntervalMs,
    time: nowIso(),
  }, null, 2));

  // Inicjalizacja bazy danych (jeśli nie istnieje)
  try {
    await readDatabase(); // tworzy domyślną jeśli brak
    console.log('[startup] Baza danych zainicjalizowana.');
  } catch (err) {
    console.error('[startup] Błąd inicjalizacji bazy:', err.message);
  }

  // Pierwsze odświeżenie cache Isarsoft
  try {
    console.log('[startup] Pierwsze odświeżenie cache Isarsoft...');
    await refreshCache();
    console.log('[startup] Cache Isarsoft zainicjalizowany.');
  } catch (err) {
    console.error('[startup] Błąd inicjalizacji cache:', err.message);
  }

  // Cykliczne odświeżanie cache Isarsoft
  setInterval(async () => {
    try {
      await refreshCache();
    } catch (err) {
      console.error('[interval] Błąd odświeżania cache:', err.message);
    }
  }, CONFIG.pollIntervalMs);

  // Cykliczna symulacja pozycji GPS (co 5 sekund)
  setInterval(async () => {
    try {
      await simulatePosition();
    } catch (err) {
      console.error('[simulation] Błąd symulacji:', err.message);
    }
  }, CONFIG.simulationIntervalMs);

  console.log(`[startup] Serwer nasłuchuje na porcie ${CONFIG.port}, odświeżanie cache co ${CONFIG.pollIntervalMs / 1000}s, symulacja co ${CONFIG.simulationIntervalMs / 1000}s`);
});

// ============================
// ZAMKNIĘCIE SERWERA
// ============================

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