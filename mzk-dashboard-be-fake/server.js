'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PC_ID = process.env.PC_ID || 'mock-pc-1';
const PC_NAME = process.env.PC_NAME || 'mock_linia_nr_2';
const ROOM_SERVER_URL = process.env.ROOM_SERVER_URL || 'http://192.168.68.155:3001/api/data';

const SEND_INTERVAL_MS = Number(process.env.SEND_INTERVAL_MS || 5000);
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 30000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);

const MOCK_APP_COUNT = Number(process.env.MOCK_APP_COUNT || 2);
const MOCK_LINE_COUNT = Number(process.env.MOCK_LINE_COUNT || 2);
const MOCK_AREA_COUNT = Number(process.env.MOCK_AREA_COUNT || 1);

const MOCK_PRESET = process.env.MOCK_PRESET || 'LAST_1_DAY';
const MOCK_CLASSES = process.env.MOCK_CLASSES || 'PERSON,HEAD';

/*
 * Godzina startu trasy w lokalnym czasie komputera.
 *
 * Przykłady:
 * ROUTE_START_HOUR=13:40
 * ROUTE_START_HOUR=13:50
 */
const ROUTE_START_HOUR = process.env.ROUTE_START_HOUR || '13:40';

/*
 * Poza trasą przesyłana jest ta pozycja.
 */
const DEFAULT_LATITUDE = 53.0000;
const DEFAULT_LONGITUDE = 18.0000;

/*
 * Punkty trasy:
 *
 * start + 0 min  -> 53.024180481478716; 18.66653585181815
 * start + 3 min  -> 53.0231855133872;   18.659680759545367
 * start + 6 min  -> 53.02155567943058;  18.6491505561822
 */
const ROUTE_POINTS = [
  {
    offsetMinutes: 0,
    latitude: 53.024180481478716,
    longitude: 18.66653585181815,
  },
  {
    offsetMinutes: 3,
    latitude: 53.0231855133872,
    longitude: 18.659680759545367,
  },
  {
    offsetMinutes: 6,
    latitude: 53.02155567943058,
    longitude: 18.6491505561822,
  },
];

let cachedData = null;
let sequence = 0;

function nowIso() {
  return new Date().toISOString();
}

function parseRouteStartHour(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);

  if (!match) {
    throw new Error(
      `Nieprawidłowy ROUTE_START_HOUR="${value}". Użyj formatu HH:MM, np. 13:40`
    );
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      `Nieprawidłowy ROUTE_START_HOUR="${value}". Godzina musi być w zakresie 00:00-23:59`
    );
  }

  return { hour, minute };
}

const routeStartTime = parseRouteStartHour(ROUTE_START_HOUR);

/*
 * Tworzy obiekt Date odpowiadający dzisiejszej godzinie startu
 * w lokalnej strefie czasowej komputera.
 */
function getTodayRouteStartDate(now = new Date()) {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    routeStartTime.hour,
    routeStartTime.minute,
    0,
    0
  );
}

function interpolate(startValue, endValue, progress) {
  return startValue + (endValue - startValue) * progress;
}

/*
 * Zwraca aktualną lokalizację na podstawie lokalnego czasu systemowego.
 *
 * Przed startem trasy i po jej zakończeniu:
 * 53.0000;18.0000
 *
 * Pomiędzy punktami trasy współrzędne są interpolowane liniowo.
 */
function getCurrentLocation(now = new Date()) {
  const routeStartDate = getTodayRouteStartDate(now);
  const elapsedMs = now.getTime() - routeStartDate.getTime();
  const firstPoint = ROUTE_POINTS[0];
  const lastPoint = ROUTE_POINTS[ROUTE_POINTS.length - 1];
  const routeDurationMs = lastPoint.offsetMinutes * 60 * 1000;

  if (elapsedMs < 0 || elapsedMs > routeDurationMs) {
    return {
      latitude: DEFAULT_LATITUDE,
      longitude: DEFAULT_LONGITUDE,
      locationSource: 'default-outside-route',
      routeActive: false,
    };
  }

  for (let index = 0; index < ROUTE_POINTS.length - 1; index += 1) {
    const currentPoint = ROUTE_POINTS[index];
    const nextPoint = ROUTE_POINTS[index + 1];

    const segmentStartMs = currentPoint.offsetMinutes * 60 * 1000;
    const segmentEndMs = nextPoint.offsetMinutes * 60 * 1000;

    if (elapsedMs >= segmentStartMs && elapsedMs <= segmentEndMs) {
      const progress = (elapsedMs - segmentStartMs) / (segmentEndMs - segmentStartMs);

      return {
        latitude: interpolate(
          currentPoint.latitude,
          nextPoint.latitude,
          progress
        ),
        longitude: interpolate(
          currentPoint.longitude,
          nextPoint.longitude,
          progress
        ),
        locationSource: 'simulated-route',
        routeActive: true,
      };
    }
  }

  return {
    latitude: lastPoint.latitude,
    longitude: lastPoint.longitude,
    locationSource: 'simulated-route',
    routeActive: true,
  };
}

function httpPost(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';

        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          responseBody += chunk;
        });

        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: responseBody,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function makeBuckets(baseIn, baseOut) {
  const now = Date.now();

  return Array.from({ length: 6 }, (_, index) => ({
    time_bucket: new Date(
      now - (5 - index) * 10 * 60 * 1000
    ).toISOString(),
    number_of_samples: 10,
    count_in: baseIn + index * 2,
    count_out: baseOut + index,
  }));
}

function makeAreaBuckets(baseCount) {
  const now = Date.now();

  return Array.from({ length: 6 }, (_, index) => ({
    time_bucket: new Date(
      now - (5 - index) * 10 * 60 * 1000
    ).toISOString(),
    number_of_samples: 10,
    count_min: Math.max(0, baseCount - 4 + index),
    count_avg: baseCount + index,
    count_max: baseCount + 8 + index,
  }));
}

function createMockData() {
  sequence += 1;

  const applications = [];
  const lines = [];
  const areas = [];

  for (let appIndex = 1; appIndex <= MOCK_APP_COUNT; appIndex += 1) {
    const applicationUuid = `mock-app-${appIndex}`;
    const appLines = [];
    const appAreas = [];

    for (let lineIndex = 1; lineIndex <= MOCK_LINE_COUNT; lineIndex += 1) {
      const lineUuid = `${applicationUuid}-line-${lineIndex}`;
      const baseIn = 20 + appIndex * 10 + lineIndex * 4 + sequence;
      const baseOut =
        15 + appIndex * 8 + lineIndex * 3 + Math.floor(sequence / 2);

      const countData = makeBuckets(baseIn, baseOut);

      const line = {
        uuid: lineUuid,
        name: `Linia ${lineIndex}`,
        tags: ['mock', 'test'],
        coordinates: [
          { x: 0.25, y: 0.45 },
          { x: 0.75, y: 0.55 },
        ],
        totals: {
          in: countData.reduce((sum, item) => sum + item.count_in, 0),
          out: countData.reduce((sum, item) => sum + item.count_out, 0),
        },
        live: {
          total_in: baseIn,
          total_out: baseOut,
          raw: [{ count_in: baseIn, count_out: baseOut }],
        },
        data: {
          buckets: countData.length,
          first_bucket: countData[0].time_bucket,
          last_bucket: countData[countData.length - 1].time_bucket,
          total_in: countData.reduce((sum, item) => sum + item.count_in, 0),
          total_out: countData.reduce((sum, item) => sum + item.count_out, 0),
          raw: countData,
        },
      };

      appLines.push(line);

      lines.push({
        application_uuid: applicationUuid,
        application_name: `Mock ObjectFlow ${appIndex}`,
        camera_name: `Mock Camera ${appIndex}`,
        line_uuid: lineUuid,
        line_name: line.name,
        total_in: line.totals.in,
        total_out: line.totals.out,
        live_in: line.live.total_in,
        live_out: line.live.total_out,
        buckets: line.data.buckets,
        first_bucket: line.data.first_bucket,
        last_bucket: line.data.last_bucket,
      });
    }

    for (let areaIndex = 1; areaIndex <= MOCK_AREA_COUNT; areaIndex += 1) {
      const areaUuid = `${applicationUuid}-area-${areaIndex}`;
      const baseCount =
        8 + appIndex * 5 + areaIndex * 2 + (sequence % 5);

      const countData = makeAreaBuckets(baseCount);

      const area = {
        uuid: areaUuid,
        name: `Strefa ${areaIndex}`,
        tags: ['mock', 'test'],
        coordinates: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.9, y: 0.9 },
          { x: 0.1, y: 0.9 },
        ],
        totals: {
          min:
            countData.reduce((sum, item) => sum + item.count_min, 0) /
            countData.length,
          avg:
            countData.reduce((sum, item) => sum + item.count_avg, 0) /
            countData.length,
          max:
            countData.reduce((sum, item) => sum + item.count_max, 0) /
            countData.length,
          samples: countData.reduce(
            (sum, item) => sum + item.number_of_samples,
            0
          ),
        },
        live: {
          total_count: baseCount,
          raw: [{ count: baseCount }],
        },
        data: {
          buckets: countData.length,
          first_bucket: countData[0].time_bucket,
          last_bucket: countData[countData.length - 1].time_bucket,
          avg_min:
            countData.reduce((sum, item) => sum + item.count_min, 0) /
            countData.length,
          avg_avg:
            countData.reduce((sum, item) => sum + item.count_avg, 0) /
            countData.length,
          avg_max:
            countData.reduce((sum, item) => sum + item.count_max, 0) /
            countData.length,
          total_samples: countData.reduce(
            (sum, item) => sum + item.number_of_samples,
            0
          ),
          raw: countData,
        },
      };

      appAreas.push(area);

      areas.push({
        application_uuid: applicationUuid,
        application_name: `Mock ObjectFlow ${appIndex}`,
        camera_name: `Mock Camera ${appIndex}`,
        area_uuid: areaUuid,
        area_name: area.name,
        avg_min: area.totals.min,
        avg_avg: area.totals.avg,
        avg_max: area.totals.max,
        live_count: area.live.total_count,
        buckets: area.data.buckets,
      });
    }

    applications.push({
      uuid: applicationUuid,
      name: `Mock ObjectFlow ${appIndex}`,
      tags: ['mock', 'simulation'],
      status: 'ONLINE',
      last_online: nowIso(),
      camera: {
        uuid: `mock-camera-${appIndex}`,
        name: `Mock Camera ${appIndex}`,
      },
      model: {
        uuid: `mock-model-${appIndex}`,
        name: 'Mock Detection Model',
      },
      created_at: nowIso(),
      updated_at: nowIso(),
      lines: appLines,
      areas: appAreas,
      totals: {
        in: appLines.reduce((sum, line) => sum + line.totals.in, 0),
        out: appLines.reduce((sum, line) => sum + line.totals.out, 0),
      },
      area_totals: {
        min: appAreas.length
          ? appAreas.reduce((sum, area) => sum + area.totals.min, 0) /
            appAreas.length
          : 0,
        avg: appAreas.length
          ? appAreas.reduce((sum, area) => sum + area.totals.avg, 0) /
            appAreas.length
          : 0,
        max: appAreas.length
          ? appAreas.reduce((sum, area) => sum + area.totals.max, 0) /
            appAreas.length
          : 0,
        count: appAreas.reduce(
          (sum, area) => sum + area.live.total_count,
          0
        ),
      },
    });
  }

  lines.sort((a, b) => b.total_out - a.total_out || b.total_in - a.total_in);
  areas.sort((a, b) => b.avg_avg - a.avg_avg);

  return {
    ok: true,
    generated_at: nowIso(),
    filters: {
      preset: MOCK_PRESET,
      class: MOCK_CLASSES,
      app: '',
      camera: '',
      line: '',
      area: '',
    },
    available_presets: [
      'LAST_1_DAY',
      'LAST_1_HOUR',
      'LAST_12_HOUR',
      'THIS_YEAR',
      'THIS_WEEK',
      'THIS_MONTH',
    ],
    totals: {
      objectflow_apps: applications.length,
      selected_in: applications.reduce(
        (sum, app) => sum + app.totals.in,
        0
      ),
      selected_out: applications.reduce(
        (sum, app) => sum + app.totals.out,
        0
      ),
      selected_area_avg: applications.length
        ? applications.reduce(
            (sum, app) => sum + app.area_totals.avg,
            0
          ) / applications.length
        : 0,
      selected_area_count: applications.reduce(
        (sum, app) => sum + app.area_totals.count,
        0
      ),
    },
    applications,
    lines,
    areas,
    cameras: applications.map((app) => app.camera),
    license: { valid: true },
    integrations: {
      mqtt: {
        enabled: false,
        host: 'mock-mqtt.local',
        port: 1883,
        username: 'mock',
        topic_prefix: 'mock/isarsoft',
      },
      kafka: {
        enabled: false,
        bootstrap_servers: 'mock-kafka.local:9092',
        topic: 'mock-traffic',
        security_protocol: 'PLAINTEXT',
      },
    },
  };
}

async function sendDataToRoom() {
  if (!cachedData) {
    return;
  }

  const currentLocation = getCurrentLocation();

  const payload = {
    pcId: PC_ID,
    pcName: PC_NAME,
    timestamp: nowIso(),
    latitude: currentLocation.latitude,
    longitude: currentLocation.longitude,
    locationSource: currentLocation.locationSource,
    gpsFix: false,
    lastValidGpsAt: null,
    data: cachedData,
  };

  try {
    const response = await httpPost(ROOM_SERVER_URL, payload);

    if (response.status >= 200 && response.status < 300) {
      console.log(
        `[mock] Wysłano ramkę do ${ROOM_SERVER_URL}, ` +
        `status=${response.status}, seq=${sequence}, ` +
        `lat=${currentLocation.latitude}, ` +
        `lng=${currentLocation.longitude}, ` +
        `routeActive=${currentLocation.routeActive}`
      );
    } else {
      console.warn(
        `[mock] Serwer odpowiedział ${response.status}: ${response.body}`
      );
    }
  } catch (error) {
    console.error(`[mock] Błąd wysyłania: ${error.message}`);
  }
}

async function refreshCache() {
  cachedData = createMockData();

  console.log(
    `[mock] Cache odświeżony: apps=${cachedData.totals.objectflow_apps}, ` +
    `IN=${cachedData.totals.selected_in}, ` +
    `OUT=${cachedData.totals.selected_out}`
  );
}

async function start() {
  console.log(
    JSON.stringify(
      {
        ok: true,
        message: 'Mock Isarsoft PC Client started',
        pcId: PC_ID,
        pcName: PC_NAME,
        roomServerUrl: ROOM_SERVER_URL,
        refreshIntervalMs: REFRESH_INTERVAL_MS,
        sendIntervalMs: SEND_INTERVAL_MS,
        routeStartHour: ROUTE_START_HOUR,
        defaultLocation: {
          latitude: DEFAULT_LATITUDE,
          longitude: DEFAULT_LONGITUDE,
        },
        routePoints: ROUTE_POINTS,
      },
      null,
      2
    )
  );

  await refreshCache();
  await sendDataToRoom();

  setInterval(refreshCache, REFRESH_INTERVAL_MS);

  setInterval(() => {
    sendDataToRoom().catch((error) => {
      console.error('[mock] Błąd cykliczny:', error.message);
    });
  }, SEND_INTERVAL_MS);
}

start().catch((error) => {
  console.error('[mock] Błąd krytyczny:', error);
  process.exitCode = 1;
});