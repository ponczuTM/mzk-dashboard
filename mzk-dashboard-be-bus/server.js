'use strict';

const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');
const { SerialPort } = require('serialport');
const { GPS } = require('gps');

const PC_ID = Number(process.env.PC_ID || 1);
const PC_NAME = process.env.PC_NAME || 'linia_nr_1';

const ROOM_SERVER_URL =
  process.env.ROOM_SERVER_URL || 'http://192.168.77.54:3001/api/data';

const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 30 * 1000);
const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS || 5 * 1000);

const GPS_PORT_PATH = process.env.GPS_PORT_PATH || '/dev/ttyUSB0';
const GPS_BAUD_RATE = Number(process.env.GPS_BAUD_RATE || 9600);

const GPS_FIX_MAX_AGE_MS = Number(process.env.GPS_FIX_MAX_AGE_MS || 30 * 1000);
const GPS_REOPEN_DELAY_MS = Number(process.env.GPS_REOPEN_DELAY_MS || 10 * 1000);

const GEO_FALLBACK_URL = process.env.GEO_FALLBACK_URL || 'http://ip-api.com/json/';
const ENABLE_IP_GEO_FALLBACK = process.env.ENABLE_IP_GEO_FALLBACK !== 'false';

/*
  Wysyłane są wyłącznie aplikacje o statusie Online.

  API zwraca "Online", ale kod normalizuje go do "ONLINE".
  Każdy inny status, np. Paused / Offline / Error, jest ignorowany.
*/
const ONLINE_STATUS = 'ONLINE';

/*
  Dodatkowe zabezpieczenie:
  aplikacja Online musi posiadać świeże last_online.

  Jeśli Isarsoft aktualizuje last_online rzadziej niż co 2 minuty,
  możesz uruchomić:
  ISARSOFT_APP_ONLINE_MAX_AGE_MS=300000 node server.js

  Aby całkowicie wyłączyć tę kontrolę:
  ISARSOFT_REQUIRE_RECENT_ONLINE=false node server.js
*/
const REQUIRE_RECENT_ONLINE = process.env.ISARSOFT_REQUIRE_RECENT_ONLINE !== 'false';
const APP_ONLINE_MAX_AGE_MS = Number(
  process.env.ISARSOFT_APP_ONLINE_MAX_AGE_MS || 2 * 60 * 1000
);

const CONFIG = {
  baseUrl: process.env.ISARSOFT_BASE_URL || 'https://localhost:8443',

  graphqlPath:
    process.env.ISARSOFT_GRAPHQL_PATH || '/isarsoft/api/graphql',

  tokenPath:
    process.env.ISARSOFT_TOKEN_PATH ||
    '/isarsoft/auth/realms/perception/protocol/openid-connect/token',

  clientId: process.env.ISARSOFT_CLIENT_ID || 'perception',
  username: process.env.ISARSOFT_USERNAME || 'perception',
  password: process.env.ISARSOFT_PASSWORD || 'perception',

  verifyTls: process.env.ISARSOFT_VERIFY_TLS === 'true',

  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 30000),

  /*
    Liczymy wyłącznie osoby.

    Nie używamy jednocześnie PERSON i HEAD, aby nie liczyć jednej
    osoby jako człowieka oraz jako głowy.
  */
  objectClasses: (process.env.ISARSOFT_CLASSES || 'PERSON')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean),
};

let currentLatitude = null;
let currentLongitude = null;
let currentAltitude = null;

let gpsFix = false;
let gpsEnabled = false;
let gpsSource = 'none';

let lastValidGpsAt = 0;
let lastNmeaAt = 0;
let lastGpsLogTime = 0;

let serialPortRef = null;
let reopenTimer = null;

let refreshInProgress = false;
let sendInProgress = false;

let cachedData = null;
let lastRefreshSuccess = null;

let ipGeoCache = {
  latitude: null,
  longitude: null,
  fetchedAt: 0,
  source: 'none',
};

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumBy(array, mapper) {
  return toArray(array).reduce((total, item) => total + num(mapper(item)), 0);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

function parseDateMs(value) {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function isValidCoordinate(latitude, longitude) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function hasFreshGpsFix() {
  return (
    gpsFix &&
    isValidCoordinate(currentLatitude, currentLongitude) &&
    Date.now() - lastValidGpsAt <= GPS_FIX_MAX_AGE_MS
  );
}

/*
  Filtruje aplikacje wyłącznie po statusie Online oraz świeżości last_online.
  Nie ma allowlisty, UUID ani zewnętrznych plików konfiguracyjnych.
*/
function isApplicationOnline(app) {
  if (normalizeStatus(app?.status) !== ONLINE_STATUS) {
    return false;
  }

  if (!REQUIRE_RECENT_ONLINE) {
    return true;
  }

  const lastOnlineMs = parseDateMs(app?.last_online);

  if (!lastOnlineMs) {
    return false;
  }

  const ageMs = Date.now() - lastOnlineMs;

  /*
    Margines -60 sekund uwzględnia minimalną różnicę między zegarem
    urządzenia a zegarem serwera Isarsoft.
  */
  return ageMs >= -60 * 1000 && ageMs <= APP_ONLINE_MAX_AGE_MS;
}

function getExcludedReason(app) {
  const status = normalizeStatus(app?.status);

  if (status !== ONLINE_STATUS) {
    return `status=${status || 'BRAK'} (wymagany ONLINE)`;
  }

  if (!REQUIRE_RECENT_ONLINE) {
    return null;
  }

  const lastOnlineMs = parseDateMs(app?.last_online);

  if (!lastOnlineMs) {
    return 'brak poprawnego last_online';
  }

  const ageMs = Date.now() - lastOnlineMs;

  if (ageMs < -60 * 1000) {
    return `last_online jest w przyszłości: ${app.last_online}`;
  }

  if (ageMs > APP_ONLINE_MAX_AGE_MS) {
    return `last_online jest zbyt stare: ${app.last_online}`;
  }

  return null;
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: CONFIG.verifyTls,
});

function requestRaw(urlString, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;

    const request = lib.request(
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
      (response) => {
        let raw = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          raw += chunk;
        });

        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage,
            text: raw,
            json: () => safeJson(raw),
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(
        new Error(`Timeout po ${CONFIG.requestTimeoutMs} ms`)
      );
    });

    request.on('error', reject);

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

let tokenCache = {
  token: null,
  expiresAt: 0,
};

async function getToken(force = false) {
  if (
    !force &&
    tokenCache.token &&
    Date.now() < tokenCache.expiresAt - 15000
  ) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: CONFIG.clientId,
    username: CONFIG.username,
    password: CONFIG.password,
  }).toString();

  const response = await requestRaw(
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

  const json = response.json();

  if (!response.ok || !json?.access_token) {
    throw new Error(
      `Token request failed: ${response.status} ${response.statusText} ${response.text}`
    );
  }

  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 300) * 1000,
  };

  return tokenCache.token;
}

async function graphql(query, variables = null, retry = true) {
  const token = await getToken(false);

  const body = JSON.stringify({
    query,
    variables,
  });

  const response = await requestRaw(
    `${CONFIG.baseUrl}${CONFIG.graphqlPath}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    body
  );

  const json = response.json();

  if (response.status === 401 && retry) {
    await getToken(true);
    return graphql(query, variables, false);
  }

  if (!response.ok) {
    throw new Error(
      `GraphQL HTTP error: ${response.status} ${response.statusText} ${response.text}`
    );
  }

  if (!json) {
    throw new Error(`GraphQL zwrócił niepoprawny JSON: ${response.text}`);
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data || null;
}

/*
  Pierwsze zapytanie pobiera tylko listę aplikacji i ich statusy.

  Jest ono potrzebne tylko po to, aby wybrać aplikacje o statusie ONLINE.
*/
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
      camera {
        uuid
        name
      }
      model {
        uuid
        name
      }
    }
  }
}
`;

/*
  Najważniejsze zapytanie.

  Celowo NIE ma count_data i NIE ma TimeRangeInput.

  count_live:
  - zwraca aktualny stan liczników przekazany przez aktywną aplikację,
  - nie sumuje bucketów z LAST_1_DAY / LAST_1_HOUR,
  - zwraca bieżące IN oraz OUT dla każdej linii.
*/
const QUERY_ONE_APP_LIVE = `
query($app: String!, $classes: [ObjectClassInput!]!) {
  getApplication(application: { uuid: $app }) {
    __typename
    ... on ObjectFlow {
      uuid
      name
      status
      last_online
      camera {
        uuid
        name
      }
      lines {
        uuid
        name
        tags
        coordinates
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

function flattenRows(rows) {
  if (Array.isArray(rows) && rows.length && Array.isArray(rows[0])) {
    return rows.flat();
  }

  return toArray(rows);
}

function summarizeLiveLine(rows) {
  const raw = flattenRows(rows);

  return {
    total_in: sumBy(raw, (row) => row?.count_in),
    total_out: sumBy(raw, (row) => row?.count_out),
    raw,
  };
}

function summarizeLiveArea(rows) {
  const raw = flattenRows(rows);

  return {
    total_count: sumBy(raw, (row) => row?.count),
    raw,
  };
}

function classInputs(classes) {
  return classes.map((name) => ({ name }));
}

async function collectAllData() {
  const classes = CONFIG.objectClasses;
  const classesVar = classInputs(classes);

  let allObjectFlowApps = [];

  try {
    const appsData = await graphql(QUERY_OBJECTFLOW_APPS);

    allObjectFlowApps = toArray(appsData?.allApplications).filter(
      (app) => app.__typename === 'ObjectFlow'
    );
  } catch (error) {
    console.error(
      '[collectAllData] Błąd pobierania listy aplikacji:',
      error.message
    );

    throw error;
  }

  console.log(
    `[collectAllData] Wszystkie aplikacje ObjectFlow: ${allObjectFlowApps.length}`
  );

  for (const app of allObjectFlowApps) {
    console.log(
      `[Isarsoft] uuid=${app.uuid} | name="${app.name}" | status="${app.status}" | last_online="${app.last_online}" | camera="${app.camera?.name || '-'}"`
    );
  }

  const onlineApps = [];
  const excludedApps = [];

  for (const app of allObjectFlowApps) {
    const reason = getExcludedReason(app);

    if (reason) {
      excludedApps.push({
        app,
        reason,
      });
    } else {
      onlineApps.push(app);
    }
  }

  console.log(
    `[collectAllData] ONLINE: ${onlineApps.length}; pominięte: ${excludedApps.length}; wymagany status: ${ONLINE_STATUS}; requireRecentOnline=${REQUIRE_RECENT_ONLINE}`
  );

  for (const item of excludedApps) {
    console.log(
      `[collectAllData] Pominięto "${item.app.name}" (${item.app.uuid}): ${item.reason}`
    );
  }

  const detailedApps = [];

  for (const app of onlineApps) {
    try {
      const appData = await graphql(QUERY_ONE_APP_LIVE, {
        app: app.uuid,
        classes: classesVar,
      });

      const objectFlow = appData?.getApplication;

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
          totals: null,
          area_totals: null,
          _error: 'Aplikacja nie została zwrócona jako ObjectFlow',
        });

        continue;
      }

      /*
        Druga kontrola po pobraniu szczegółów.

        Chroni przed przypadkiem, gdy aplikacja została zatrzymana
        dokładnie pomiędzy pierwszym a drugim zapytaniem GraphQL.
      */
      const currentApp = {
        ...app,
        status: objectFlow.status ?? app.status,
        last_online: objectFlow.last_online ?? app.last_online,
      };

      const exclusionReason = getExcludedReason(currentApp);

      if (exclusionReason) {
        console.warn(
          `[collectAllData] "${app.name}" nie jest już ONLINE po pobraniu szczegółów: ${exclusionReason}`
        );

        excludedApps.push({
          app: currentApp,
          reason: `zmiana statusu po odczycie: ${exclusionReason}`,
        });

        continue;
      }

      const mappedLines = toArray(objectFlow.lines).map((line) => {
        const live = summarizeLiveLine(line.count_live);

        return {
          uuid: line.uuid,
          name: line.name,
          tags: toArray(line.tags),
          coordinates: toArray(line.coordinates),

          /*
            To są aktualne wartości z count_live.
            Nie są sumą danych historycznych.
          */
          totals: {
            in: live.total_in,
            out: live.total_out,
          },

          live,
        };
      });

      const mappedAreas = toArray(objectFlow.areas).map((area) => {
        const live = summarizeLiveArea(area.count_live);

        return {
          uuid: area.uuid,
          name: area.name,
          tags: toArray(area.tags),
          coordinates: toArray(area.coordinates),

          /*
            Aktualna liczba osób / obiektów w danym obszarze.
          */
          live,
        };
      });

      /*
        Suma aktualnych count_live ze wszystkich linii aplikacji.

        W Twoim przypadku Office ma jedną linię "New Line",
        więc wartości będą dokładnie takie jak zwraca Isarsoft:
        np. IN=1, OUT=4.
      */
      const currentIn = sumBy(mappedLines, (line) => line.live.total_in);
      const currentOut = sumBy(mappedLines, (line) => line.live.total_out);

      const currentAreaCount = sumBy(
        mappedAreas,
        (area) => area.live.total_count
      );

      console.log(
        `[collectAllData] ONLINE "${app.name}" (${app.uuid}): AKTUALNE IN=${currentIn}, AKTUALNE OUT=${currentOut}, osoby w obszarach=${currentAreaCount}, lines=${mappedLines.length}, areas=${mappedAreas.length}`
      );

      for (const line of mappedLines) {
        console.log(
          `[collectAllData]   Linia "${line.name}": aktualne IN=${line.live.total_in}, aktualne OUT=${line.live.total_out}`
        );
      }

      detailedApps.push({
        uuid: app.uuid,
        name: app.name,
        tags: toArray(app.tags),

        status: currentApp.status || null,
        last_online: currentApp.last_online || null,

        camera: objectFlow.camera || app.camera || null,
        model: app.model || null,

        created_at: app.created_at || null,
        updated_at: app.updated_at || null,

        lines: mappedLines,
        areas: mappedAreas,

        /*
          Zachowujemy kompatybilność z Twoim serwerem pokojowym:
          data.totals.selected_in i data.totals.selected_out.

          Tu są aktualne count_live, a nie count_data z LAST_1_DAY.
        */
        totals: {
          in: currentIn,
          out: currentOut,
        },

        area_totals: {
          count: currentAreaCount,
        },
      });
    } catch (error) {
      console.error(
        `[collectAllData] Błąd dla aplikacji ${app.uuid} (${app.name}):`,
        error.message
      );

      detailedApps.push({
        uuid: app.uuid,
        name: app.name,
        status: app.status || null,
        last_online: app.last_online || null,
        camera: app.camera || null,
        model: app.model || null,
        lines: [],
        areas: [],
        totals: null,
        area_totals: null,
        _error: error.message,
      });
    }
  }

  let cameras = [];

  try {
    const camerasData = await graphql(QUERY_ALL_CAMERAS);
    cameras = toArray(camerasData?.allCameras);
  } catch (error) {
    console.error('[collectAllData] Błąd pobierania kamer:', error.message);
  }

  let license = null;

  try {
    const licenseData = await graphql(QUERY_LICENSE);
    license = licenseData?.getLicenseStatus || null;
  } catch (error) {
    console.error('[collectAllData] Błąd pobierania licencji:', error.message);
  }

  const successfulApps = detailedApps.filter(
    (app) => !app._error && app.totals
  );

  const lineRows = successfulApps.flatMap((app) =>
    app.lines.map((line) => ({
      application_uuid: app.uuid,
      application_name: app.name,
      application_status: app.status,
      application_last_online: app.last_online,
      camera_name: app.camera?.name || null,

      line_uuid: line.uuid,
      line_name: line.name,

      /*
        Nazwy zachowane dla kompatybilności z odbiorcą danych.
        Wartości są jednak pobrane z count_live.
      */
      total_in: line.live.total_in,
      total_out: line.live.total_out,

      live_in: line.live.total_in,
      live_out: line.live.total_out,
    }))
  );

  lineRows.sort(
    (a, b) => b.total_out - a.total_out || b.total_in - a.total_in
  );

  const areaRows = successfulApps.flatMap((app) =>
    app.areas.map((area) => ({
      application_uuid: app.uuid,
      application_name: app.name,
      application_status: app.status,
      application_last_online: app.last_online,
      camera_name: app.camera?.name || null,

      area_uuid: area.uuid,
      area_name: area.name,

      live_count: area.live.total_count,
    }))
  );

  areaRows.sort((a, b) => b.live_count - a.live_count);

  return {
    ok: true,
    generated_at: nowIso(),

    /*
      Informacja diagnostyczna dla systemu odbierającego:
      wartości główne pochodzą z count_live.
    */
    mode: 'LIVE_CURRENT_VALUES',

    filters: {
      object_classes: classes.join(','),
      accepted_status: ONLINE_STATUS,
      require_recent_online: REQUIRE_RECENT_ONLINE,
      online_max_age_ms: APP_ONLINE_MAX_AGE_MS,
      count_source: 'count_live',
    },

    applications_summary: {
      all_objectflow_apps: allObjectFlowApps.length,
      online_apps: successfulApps.length,

      excluded_apps: excludedApps.map(({ app, reason }) => ({
        uuid: app.uuid,
        name: app.name,
        status: app.status || null,
        last_online: app.last_online || null,
        camera_name: app.camera?.name || null,
        reason,
      })),

      read_errors: detailedApps
        .filter((app) => app._error)
        .map((app) => ({
          uuid: app.uuid,
          name: app.name,
          error: app._error,
        })),
    },

    totals: {
      objectflow_apps: successfulApps.length,

      /*
        Te pola czyta najpewniej Twój dashboard:
        Suma IN / Suma OUT.

        Są to aktualne wartości count_live.
      */
      selected_in: sumBy(successfulApps, (app) => app.totals.in),
      selected_out: sumBy(successfulApps, (app) => app.totals.out),

      selected_area_avg: 0,

      /*
        Aktualna liczba wykrytych obiektów we wszystkich obszarach.
      */
      selected_area_count: sumBy(
        successfulApps,
        (app) => app.area_totals.count
      ),
    },

    applications: successfulApps,
    lines: lineRows,
    areas: areaRows,

    cameras,
    license,
  };
}

async function refreshCache() {
  if (refreshInProgress) {
    console.warn(
      '[refreshCache] Poprzednie odświeżanie nadal trwa, pomijam kolejne.'
    );

    return;
  }

  refreshInProgress = true;

  try {
    console.log('[refreshCache] Odświeżanie aktualnych danych z Isarsoft...');

    const data = await collectAllData();

    cachedData = data;
    lastRefreshSuccess = nowIso();

    console.log(
      `[refreshCache] Dane odświeżone. Aplikacje ONLINE: ${data.totals.objectflow_apps}, AKTUALNE IN: ${data.totals.selected_in}, AKTUALNE OUT: ${data.totals.selected_out}, obszary live: ${data.totals.selected_area_count}`
    );
  } catch (error) {
    console.error('[refreshCache] Błąd odświeżania:', error.message);
  } finally {
    refreshInProgress = false;
  }
}

function scheduleSerialReopen() {
  if (reopenTimer) {
    return;
  }

  reopenTimer = setTimeout(() => {
    reopenTimer = null;

    if (serialPortRef && !serialPortRef.isOpen) {
      console.log('[GPS] Próba ponownego otwarcia portu...');

      serialPortRef.open((error) => {
        if (error) {
          console.error(
            `[GPS] Ponowne otwarcie nieudane: ${error.message}`
          );

          scheduleSerialReopen();
        }
      });
    }
  }, GPS_REOPEN_DELAY_MS);
}

function updateGpsFromState(gps, reason) {
  const latitude = Number(gps?.state?.lat);
  const longitude = Number(gps?.state?.lon);
  const altitude = Number(gps?.state?.alt);

  if (isValidCoordinate(latitude, longitude)) {
    currentLatitude = latitude;
    currentLongitude = longitude;
    currentAltitude = Number.isFinite(altitude) ? altitude : null;

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

        console.log(
          `[GPS] Fix RMC: lat=${currentLatitude}, lon=${currentLongitude}`
        );
      }

      return;
    }

    if (data.type === 'GLL') {
      if (data.status === 'active' || data.status === 'A') {
        updateGpsFromState(gps, 'gps-gll');

        console.log(
          `[GPS] Fix GLL: lat=${currentLatitude}, lon=${currentLongitude}`
        );
      }

      return;
    }

    updateGpsFromState(gps, 'gps-state');
  });

  gps.on('error', (error) => {
    console.error('[GPS] Błąd parsera NMEA:', error.message);
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
    console.log(
      `[GPS] Port ${GPS_PORT_PATH} otwarty, prędkość ${GPS_BAUD_RATE} bps`
    );

    gpsEnabled = true;
  });

  let rawDataBuffer = '';

  serialPort.on('data', (chunk) => {
    try {
      const text = chunk.toString('utf8');

      rawDataBuffer += text;

      if (rawDataBuffer.length > 1024) {
        const sample = rawDataBuffer
          .slice(0, 200)
          .replace(/\r?\n/g, '\\n');

        console.log(`[GPS] Próbka surowych danych: ${sample}...`);

        rawDataBuffer = '';
      }

      gps.updatePartial(text);
    } catch (error) {
      console.error(
        '[GPS] Błąd przetwarzania danych z portu:',
        error.message
      );
    }
  });

  serialPort.on('error', (error) => {
    console.error(`[GPS] Błąd portu ${GPS_PORT_PATH}: ${error.message}`);

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

  serialPort.open((error) => {
    if (error) {
      console.error(
        `[GPS] Nie udało się otworzyć portu ${GPS_PORT_PATH}: ${error.message}`
      );

      gpsEnabled = false;

      scheduleSerialReopen();
    }
  });
}

async function getIpFallbackLocation() {
  if (!ENABLE_IP_GEO_FALLBACK) {
    return null;
  }

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
    const response = await requestRaw(GEO_FALLBACK_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'isarsoft-pc-client/1.0',
      },
    });

    const json = response.json();

    if (!response.ok || !json) {
      throw new Error(`HTTP ${response.status}`);
    }

    const latitude = Number(json.lat ?? json.latitude);
    const longitude = Number(json.lon ?? json.longitude);

    if (!isValidCoordinate(latitude, longitude)) {
      throw new Error('Brak poprawnych współrzędnych w odpowiedzi fallback');
    }

    ipGeoCache = {
      latitude,
      longitude,
      fetchedAt: Date.now(),
      source: 'ip-geolocation',
    };

    console.warn(
      `[GPS] Używam fallback IP geolocation: lat=${latitude}, lon=${longitude}`
    );

    return {
      latitude,
      longitude,
      source: 'ip-geolocation',
    };
  } catch (error) {
    console.error(
      '[GPS] Fallback IP geolocation nieudany:',
      error.message
    );

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
  if (sendInProgress) {
    console.warn(
      '[sendDataToRoom] Poprzednia wysyłka nadal trwa, pomijam kolejną.'
    );

    return;
  }

  if (!cachedData) {
    console.warn('[sendDataToRoom] Brak danych w cache, pomijam wysyłkę.');

    return;
  }

  sendInProgress = true;

  try {
    const location = await resolveLocationForPayload();

    const payload = {
      pcId: PC_ID,
      pcName: PC_NAME,
      timestamp: nowIso(),

      latitude: location.latitude,
      longitude: location.longitude,
      locationSource: location.source,
      gpsFix: location.gpsFix,

      lastValidGpsAt: lastValidGpsAt
        ? new Date(lastValidGpsAt).toISOString()
        : null,

      lastRefreshSuccess,

      /*
        data.totals.selected_in oraz data.totals.selected_out
        zawierają aktualne wartości count_live.
      */
      data: cachedData,
    };

    console.log(
      `[sendDataToRoom] source=${location.source}, gpsFix=${location.gpsFix ? 'TAK' : 'NIE'}, lat=${location.latitude}, lon=${location.longitude}`
    );

    const postData = JSON.stringify(payload);
    const url = new URL(ROOM_SERVER_URL);
    const lib = url.protocol === 'https:' ? https : http;

    const response = await new Promise((resolve, reject) => {
      const request = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
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
              status: res.statusCode,
              body: raw,
            });
          });
        }
      );

      request.on('error', reject);

      request.on('timeout', () => {
        request.destroy(
          new Error('Timeout wysyłania do serwera pokojowego')
        );
      });

      request.write(postData);
      request.end();
    });

    if (response.status >= 200 && response.status < 300) {
      console.log(
        `[sendDataToRoom] Dane wysłane do ${ROOM_SERVER_URL}, status: ${response.status}`
      );
    } else {
      console.warn(
        `[sendDataToRoom] Serwer odpowiedział statusem ${response.status}, treść: ${response.body}`
      );
    }
  } catch (error) {
    console.error('[sendDataToRoom] Błąd wysyłania:', error.message);
  } finally {
    sendInProgress = false;
  }
}

function logGpsStatus() {
  const now = Date.now();

  if (now - lastGpsLogTime <= 10000) {
    return;
  }

  lastGpsLogTime = now;

  console.log(
    `[GPS] Status: enabled=${gpsEnabled}, fix=${hasFreshGpsFix()}, source=${gpsSource}, lat=${currentLatitude}, lon=${currentLongitude}, lastNmeaAt=${lastNmeaAt ? new Date(lastNmeaAt).toISOString() : 'BRAK'}`
  );
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

        isarsoftClasses: CONFIG.objectClasses,
        isarsoftCounterMode: 'count_live',

        acceptedApplicationStatus: ONLINE_STATUS,
        requireRecentOnline: REQUIRE_RECENT_ONLINE,
        appOnlineMaxAgeMs: APP_ONLINE_MAX_AGE_MS,

        time: nowIso(),
      },
      null,
      2
    )
  );

  initGps();

  setInterval(logGpsStatus, 5000);

  await refreshCache();

  setInterval(() => {
    refreshCache().catch((error) => {
      console.error('[refreshCache] Błąd cykliczny:', error.message);
    });
  }, REFRESH_INTERVAL_MS);

  setInterval(() => {
    sendDataToRoom().catch((error) => {
      console.error('[sendDataToRoom] Błąd cykliczny:', error.message);
    });
  }, SEND_INTERVAL_MS);

  await sendDataToRoom();
}

start().catch((error) => {
  console.error('[start] Błąd krytyczny:', error);
});