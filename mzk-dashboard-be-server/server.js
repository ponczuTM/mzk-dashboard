'use strict';

const http = require('http');
const url = require('url');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// --------------------- KONFIGURACJA ---------------------
const PORT = Number(process.env.ROOM_PORT || 3001);
const DB_ROOT = path.join(__dirname, 'database');
const DB_FILE = path.join(DB_ROOT, 'database.json');
const DB_TMP_SUFFIX = '.tmp';
const SYNC_INTERVAL_MS = 5000;
const MAX_BODY_BYTES = Number(process.env.ROOM_MAX_BODY_BYTES || 100 * 1024 * 1024);
const GEOFENCE_RADIUS_METERS = Number(process.env.ROOM_GEOFENCE_RADIUS_METERS || 55);
const PUNCTUALITY_TOLERANCE_SECONDS = Number(process.env.ROOM_PUNCTUALITY_TOLERANCE_SECONDS || 60);
const FRAME_HISTORY_LIMIT_IN_DB = Number(process.env.ROOM_FRAME_HISTORY_LIMIT_IN_DB || 50000);
const DAY_TYPES = ['weekday', 'weekend', 'holiday'];

let database = createEmptyDatabase();
let databaseWriteQueue = Promise.resolve();
let databaseReady = false;

// Przechowujemy ostatnie dane dla każdego PC
const pcDataStore = new Map();

// --------------------- FUNKCJE POMOCNICZE ---------------------
function createEmptyDatabase() {
  return {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stops: [],
    schedules: [],
    trips: [],
    current_status: {},
    vehicles: {},
    holidays: [],
    settings: {
      geofence_radius_meters: GEOFENCE_RADIUS_METERS,
      punctuality_tolerance_seconds: PUNCTUALITY_TOLERANCE_SECONDS,
      sync_interval_ms: SYNC_INTERVAL_MS
    }
  };
}

function ensureDatabaseShape(input) {
  const db = input && typeof input === 'object' ? input : createEmptyDatabase();

  if (!Array.isArray(db.stops)) db.stops = [];
  if (!Array.isArray(db.schedules)) db.schedules = [];
  if (!Array.isArray(db.trips)) db.trips = [];
  if (!db.current_status || typeof db.current_status !== 'object' || Array.isArray(db.current_status)) db.current_status = {};
  if (!db.vehicles || typeof db.vehicles !== 'object' || Array.isArray(db.vehicles)) db.vehicles = {};
  if (!Array.isArray(db.holidays)) db.holidays = [];
  if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) db.settings = {};

  db.version = Number(db.version || 1);
  db.created_at = db.created_at || new Date().toISOString();
  db.updated_at = db.updated_at || new Date().toISOString();
  db.settings.geofence_radius_meters = Number(db.settings.geofence_radius_meters || GEOFENCE_RADIUS_METERS);
  db.settings.punctuality_tolerance_seconds = Number(db.settings.punctuality_tolerance_seconds || PUNCTUALITY_TOLERANCE_SECONDS);
  db.settings.sync_interval_ms = Number(db.settings.sync_interval_ms || SYNC_INTERVAL_MS);

  return db;
}

async function ensureDatabaseReady() {
  await fsp.mkdir(DB_ROOT, { recursive: true });

  try {
    const file = await atomicReadJson(DB_FILE);
    database = ensureDatabaseShape(file);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[serverRoom] Nie udało się odczytać database.json, tworzę nową bazę:', err.message);
    }

    database = createEmptyDatabase();
    await saveDatabase();
  }

  databaseReady = true;
}

async function atomicReadJson(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  const tmpFile = path.join(
    dir,
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}${DB_TMP_SUFFIX}`
  );

  const json = JSON.stringify(value, null, 2);
  await fsp.writeFile(tmpFile, json, 'utf8');
  await fsp.rename(tmpFile, filePath);
}

async function saveDatabase() {
  const snapshot = JSON.parse(JSON.stringify(database));
  snapshot.updated_at = new Date().toISOString();
  database.updated_at = snapshot.updated_at;

  databaseWriteQueue = databaseWriteQueue
    .catch(err => {
      console.error('[serverRoom] Poprzedni zapis database.json nie powiódł się:', err.message);
    })
    .then(() => atomicWriteJson(DB_FILE, snapshot));

  return databaseWriteQueue;
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, iface] of Object.entries(interfaces)) {
    if (!Array.isArray(iface)) continue;

    for (const addr of iface) {
      if (!addr.internal && addr.family === 'IPv4') {
        addresses.push({
          interface: name,
          address: addr.address,
          url: `http://${addr.address}:${PORT}/api/data`
        });
      }
    }
  }

  return addresses;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
  setCors(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let totalBytes = 0;

    req.on('data', chunk => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error(`Przekroczono maksymalny rozmiar żądania: ${MAX_BODY_BYTES} bajtów`));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};

  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`Nieprawidłowy JSON: ${err.message}`);
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toFiniteNumber(value) {
  if (isFiniteNumber(value)) return value;

  if (typeof value === 'string' && value.trim() !== '') {
    const normalized = Number(value.replace(',', '.'));
    if (Number.isFinite(normalized)) return normalized;
  }

  return null;
}

function requiredString(value, fieldName) {
  if (value === null || value === undefined) {
    throw new Error(`Brak wymaganego pola: ${fieldName}`);
  }

  const text = String(value).trim();

  if (!text) {
    throw new Error(`Pole ${fieldName} nie może być puste`);
  }

  return text;
}

function optionalString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function normalizeUuid(value) {
  if (value && typeof value === 'string' && value.trim()) return value.trim();
  return crypto.randomUUID();
}

function sanitizeFileSegment(value) {
  const raw = String(value || 'unknown_vehicle').trim();

  const safe = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return safe || 'unknown_vehicle';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function pad3(value) {
  return String(value).padStart(3, '0');
}

function formatFrameTimestamp(date) {
  return [
    pad2(date.getDate()),
    pad2(date.getMonth() + 1),
    date.getFullYear(),
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
    pad3(date.getMilliseconds())
  ].join('-');
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function secondsSinceMidnight(date) {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function normalizeTimeToHHMMSS(value) {
  const text = requiredString(value, 'planned_time');
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) {
    throw new Error(`Nieprawidłowy format planned_time: ${text}. Wymagany format HH:MM:SS albo HH:MM`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    throw new Error(`Nieprawidłowy zakres godziny planned_time: ${text}`);
  }

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function timeToSeconds(value) {
  const normalized = normalizeTimeToHHMMSS(value);
  const [h, m, s] = normalized.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function signedTimeDiffSeconds(actualSeconds, plannedSeconds) {
  let diff = actualSeconds - plannedSeconds;
  const halfDay = 12 * 3600;
  const fullDay = 24 * 3600;

  if (diff > halfDay) diff -= fullDay;
  if (diff < -halfDay) diff += fullDay;

  return diff;
}

function getPunctualityStatus(diffSeconds) {
  if (diffSeconds === null || diffSeconds === undefined || !Number.isFinite(diffSeconds)) return 'brak danych';
  if (Math.abs(diffSeconds) <= PUNCTUALITY_TOLERANCE_SECONDS) return 'o czasie';
  return diffSeconds > 0 ? 'opóźniony' : 'za szybko';
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const earthRadiusMeters = 6371000;
  const toRadians = degrees => degrees * Math.PI / 180;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
    Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMeters * c;
}

function getByPath(obj, pathSegments) {
  let current = obj;

  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[segment];
  }

  return current;
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
}

function extractCoordinates(payload) {
  const latitude = toFiniteNumber(firstDefined(
    payload.latitude,
    payload.lat,
    getByPath(payload, ['gps', 'latitude']),
    getByPath(payload, ['gps', 'lat']),
    getByPath(payload, ['position', 'latitude']),
    getByPath(payload, ['position', 'lat']),
    getByPath(payload, ['location', 'latitude']),
    getByPath(payload, ['location', 'lat']),
    getByPath(payload, ['data', 'latitude']),
    getByPath(payload, ['data', 'lat']),
    getByPath(payload, ['data', 'gps', 'latitude']),
    getByPath(payload, ['data', 'gps', 'lat'])
  ));

  const longitude = toFiniteNumber(firstDefined(
    payload.longitude,
    payload.lng,
    payload.lon,
    getByPath(payload, ['gps', 'longitude']),
    getByPath(payload, ['gps', 'lng']),
    getByPath(payload, ['gps', 'lon']),
    getByPath(payload, ['position', 'longitude']),
    getByPath(payload, ['position', 'lng']),
    getByPath(payload, ['position', 'lon']),
    getByPath(payload, ['location', 'longitude']),
    getByPath(payload, ['location', 'lng']),
    getByPath(payload, ['location', 'lon']),
    getByPath(payload, ['data', 'longitude']),
    getByPath(payload, ['data', 'lng']),
    getByPath(payload, ['data', 'lon']),
    getByPath(payload, ['data', 'gps', 'longitude']),
    getByPath(payload, ['data', 'gps', 'lng']),
    getByPath(payload, ['data', 'gps', 'lon'])
  ));

  return { latitude, longitude };
}

function getStopId(stop) {
  return String(stop.stop_id || stop.id || '').trim();
}

function findStopById(stopId) {
  const id = String(stopId || '').trim();
  if (!id) return null;
  return database.stops.find(stop => getStopId(stop) === id) || null;
}

function normalizeStop(input) {
  const latitude = toFiniteNumber(firstDefined(input.latitude, input.lat));
  const longitude = toFiniteNumber(firstDefined(input.longitude, input.lng, input.lon));

  if (!Number.isFinite(latitude)) throw new Error('Pole latitude/lat musi być poprawną liczbą');
  if (!Number.isFinite(longitude)) throw new Error('Pole longitude/lng musi być poprawną liczbą');

  const stopId = normalizeUuid(input.stop_id || input.id);

  return {
    stop_id: stopId,
    id: stopId,
    name: requiredString(input.name, 'name'),
    number: optionalString(input.number, ''),
    latitude,
    longitude,
    lat: latitude,
    lng: longitude,
    admin_zone: optionalString(input.admin_zone, optionalString(input.adminZone, 'nieokreślona')),
    zone_type: optionalString(input.zone_type, optionalString(input.zoneType, 'nieokreślony')),
    description: optionalString(input.description, optionalString(input.decription, '')),
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function normalizeScheduleSequence(sequence, dayType) {
  if (!Array.isArray(sequence)) {
    throw new Error(`Sekwencja przystanków dla ${dayType} musi być tablicą`);
  }

  return sequence.map((entry, index) => {
    const stopId = requiredString(firstDefined(entry.stop_id, entry.id), `${dayType}[${index}].stop_id`);
    const stop = findStopById(stopId);

    if (!stop) {
      throw new Error(`Nie znaleziono przystanku stop_id=${stopId} dla ${dayType}[${index}]`);
    }

    return {
      stop_id: getStopId(stop),
      planned_time: normalizeTimeToHHMMSS(entry.planned_time),
      sequence_index: index,
      stop_name: stop.name,
      stop_number: stop.number || '',
      latitude: stop.latitude,
      longitude: stop.longitude,
      admin_zone: stop.admin_zone || 'nieokreślona',
      zone_type: stop.zone_type || 'nieokreślony'
    };
  });
}

function normalizeSchedulePayload(input) {
  const pcName = requiredString(
    firstDefined(input.pcName, input.pc_name, input.vehicle_pc_name, input.vehicle_id, input.bus, input.bus_id),
    'pcName'
  );

  const lineId = requiredString(
    firstDefined(input.line_id, input.lineId, input.line, input.line_number),
    'line_id'
  );

  const dayTypeInput = input.day_types || input.dayTypes || input.schedules || {};
  const now = new Date().toISOString();

  const dayTypes = {};

  for (const dayType of DAY_TYPES) {
    const rawDay = dayTypeInput[dayType];
    let rawSequence;

    if (Array.isArray(rawDay)) {
      rawSequence = rawDay;
    } else if (rawDay && typeof rawDay === 'object') {
      rawSequence = rawDay.stops_sequence || rawDay.stopsSequence || rawDay.stops || [];
    } else {
      rawSequence = [];
    }

    dayTypes[dayType] = {
      day_type: dayType,
      stops_sequence: normalizeScheduleSequence(rawSequence, dayType)
    };
  }

  return {
    schedule_id: normalizeUuid(input.schedule_id || input.id),
    pcName,
    pcId: optionalString(firstDefined(input.pcId, input.pc_id), ''),
    vehicle_id: pcName,
    line_id: lineId,
    line_number: optionalString(firstDefined(input.line_number, input.lineNumber, input.line), lineId),
    brigade: optionalString(input.brigade, ''),
    route_name: optionalString(input.route_name, ''),
    description: optionalString(input.description, ''),
    expected_cameras: toFiniteNumber(firstDefined(input.expected_cameras, input.expectedCameras, input.camera_count, input.cameraCount)),
    day_types: dayTypes,
    active: input.active !== false,
    created_at: input.created_at || now,
    updated_at: now
  };
}

function getEasterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function getPolishPublicHolidayKeys(year) {
  const fixed = [
    `${year}-01-01`,
    `${year}-01-06`,
    `${year}-05-01`,
    `${year}-05-03`,
    `${year}-08-15`,
    `${year}-11-01`,
    `${year}-11-11`,
    `${year}-12-25`,
    `${year}-12-26`
  ];

  const easter = getEasterDate(year);
  const movable = [
    formatDateKey(easter),
    formatDateKey(addDays(easter, 1)),
    formatDateKey(addDays(easter, 60))
  ];

  return new Set([...fixed, ...movable]);
}

function determineDayType(date) {
  const dateKey = formatDateKey(date);

  const customHolidays = new Set(database.holidays.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.date;
    return '';
  }).filter(Boolean));

  if (customHolidays.has(dateKey)) return 'holiday';

  const publicHolidays = getPolishPublicHolidayKeys(date.getFullYear());
  if (publicHolidays.has(dateKey)) return 'holiday';

  const weekday = date.getDay();
  return weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
}

function findActiveScheduleForVehicle(pcName, pcId) {
  const byUpdated = [...database.schedules]
    .filter(schedule => schedule && schedule.active !== false)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  const pcNameValue = String(pcName || '').trim();
  const pcIdValue = String(pcId || '').trim();

  return byUpdated.find(schedule => {
    const schedulePcName = String(
      firstDefined(schedule.pcName, schedule.pc_name, schedule.vehicle_pc_name, schedule.vehicle_id) || ''
    ).trim();

    const schedulePcId = String(firstDefined(schedule.pcId, schedule.pc_id) || '').trim();

    return (
      (pcNameValue && schedulePcName === pcNameValue) ||
      (pcIdValue && schedulePcId && schedulePcId === pcIdValue)
    );
  }) || null;
}

function getScheduleSequence(schedule, dayType) {
  if (!schedule || !schedule.day_types || !schedule.day_types[dayType]) return [];
  const sequence = schedule.day_types[dayType].stops_sequence;
  return Array.isArray(sequence) ? sequence : [];
}

function enrichSequenceWithStops(sequence) {
  return sequence.map(entry => {
    const stop = findStopById(entry.stop_id);
    if (!stop) return null;

    return {
      ...entry,
      stop,
      planned_seconds: timeToSeconds(entry.planned_time)
    };
  }).filter(Boolean);
}

function findNearestStopByDistance(sequence, latitude, longitude) {
  let nearest = null;

  for (const entry of sequence) {
    const distanceMeters = haversineMeters(latitude, longitude, entry.stop.latitude, entry.stop.longitude);

    if (!nearest || distanceMeters < nearest.distance_meters) {
      nearest = {
        entry,
        stop: entry.stop,
        distance_meters: distanceMeters
      };
    }
  }

  return nearest;
}

function findNearestStopByPlannedTime(sequence, currentSeconds) {
  let nearest = null;

  for (const entry of sequence) {
    const diff = signedTimeDiffSeconds(currentSeconds, entry.planned_seconds);
    const absDiff = Math.abs(diff);

    if (!nearest || absDiff < nearest.abs_diff_seconds) {
      nearest = {
        entry,
        stop: entry.stop,
        diff_seconds: diff,
        abs_diff_seconds: absDiff
      };
    }
  }

  return nearest;
}

function extractPassengerStats(payload) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const totals = firstDefined(data.totals, payload.totals, {}) || {};

  const selectedIn = toFiniteNumber(firstDefined(
    totals.selected_in,
    totals.in,
    totals.entries,
    totals.boardings,
    totals.people_in,
    payload.selected_in,
    payload.passengers_in,
    payload.boardings
  )) || 0;

  const selectedOut = toFiniteNumber(firstDefined(
    totals.selected_out,
    totals.out,
    totals.exits,
    totals.alightings,
    totals.people_out,
    payload.selected_out,
    payload.passengers_out,
    payload.alightings
  )) || 0;

  const onboard = toFiniteNumber(firstDefined(
    totals.onboard,
    totals.current_passengers,
    totals.people_current,
    payload.onboard,
    payload.current_passengers
  ));

  const objectflowApps = toFiniteNumber(firstDefined(
    totals.objectflow_apps,
    data.objectflow_apps,
    payload.objectflow_apps
  ));

  const selectedAreaAvg = toFiniteNumber(firstDefined(totals.selected_area_avg, payload.selected_area_avg));
  const selectedAreaCount = toFiniteNumber(firstDefined(totals.selected_area_count, payload.selected_area_count));

  return {
    selected_in: selectedIn,
    selected_out: selectedOut,
    onboard: onboard === null ? null : onboard,
    passenger_events: selectedIn + selectedOut,
    objectflow_apps: objectflowApps === null ? null : objectflowApps,
    selected_area_avg: selectedAreaAvg === null ? null : selectedAreaAvg,
    selected_area_count: selectedAreaCount === null ? null : selectedAreaCount
  };
}

function getCameraCollections(payload) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

  const collections = [
    payload.cameras,
    payload.camera_data,
    payload.cameraData,
    payload.streams,
    payload.sources,
    data.cameras,
    data.camera_data,
    data.cameraData,
    data.streams,
    data.sources,
    data.apps,
    data.objectflow_apps
  ];

  return collections.filter(Array.isArray);
}

function isCameraOnline(camera) {
  if (!camera || typeof camera !== 'object') return true;

  const status = String(
    firstDefined(camera.status, camera.state, camera.signal_status, camera.image_status, '')
  ).toLowerCase();

  if (['offline', 'error', 'lost', 'missing', 'brak', 'inactive', 'disconnected', 'no_signal', 'no-signal'].includes(status)) {
    return false;
  }

  const explicitSignal = firstDefined(
    camera.signal,
    camera.has_signal,
    camera.hasSignal,
    camera.image,
    camera.has_image,
    camera.hasImage,
    camera.online,
    camera.active,
    camera.connected
  );

  if (explicitSignal === false) return false;

  if (
    typeof explicitSignal === 'string' &&
    ['false', '0', 'no', 'brak', 'offline'].includes(explicitSignal.toLowerCase())
  ) {
    return false;
  }

  return true;
}

function extractCameraQuality(payload, schedule) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const totals = firstDefined(data.totals, payload.totals, {}) || {};
  const collections = getCameraCollections(payload);
  const stats = extractPassengerStats(payload);

  const expectedCameras = toFiniteNumber(firstDefined(
    payload.expected_cameras,
    payload.expectedCameras,
    payload.camera_count,
    payload.cameraCount,
    data.expected_cameras,
    data.expectedCameras,
    data.camera_count,
    data.cameraCount,
    totals.expected_cameras,
    totals.camera_count,
    schedule ? schedule.expected_cameras : undefined
  ));

  let detectedCameras = stats.objectflow_apps;
  let offlineCameras = 0;

  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;

    detectedCameras = Math.max(detectedCameras || 0, collection.length);
    offlineCameras += collection.filter(camera => !isCameraOnline(camera)).length;
  }

  const explicitComplete = firstDefined(
    getByPath(payload, ['data_quality', 'complete']),
    getByPath(payload, ['dataQuality', 'complete']),
    getByPath(data, ['data_quality', 'complete']),
    getByPath(data, ['dataQuality', 'complete'])
  );

  const explicitError = firstDefined(
    getByPath(payload, ['data_quality', 'error']),
    getByPath(payload, ['dataQuality', 'error']),
    getByPath(data, ['data_quality', 'error']),
    getByPath(data, ['dataQuality', 'error'])
  );

  let complete = true;
  const errors = [];

  if (explicitComplete === false || explicitComplete === 'false') {
    complete = false;
    errors.push(String(explicitError || 'Wadliwość pomiaru: Brak obrazu ze wszystkich kamer'));
  }

  if (offlineCameras > 0) {
    complete = false;
    errors.push(`Wadliwość pomiaru: Brak obrazu ze wszystkich kamer. Kamery offline: ${offlineCameras}`);
  }

  if (expectedCameras !== null && expectedCameras > 0 && detectedCameras !== null && detectedCameras < expectedCameras) {
    complete = false;
    errors.push(`Wadliwość pomiaru: Brak obrazu ze wszystkich kamer. Wykryto ${detectedCameras}/${expectedCameras}`);
  }

  return {
    complete,
    error: complete ? null : 'Wadliwość pomiaru: Brak obrazu ze wszystkich kamer',
    details: errors,
    expected_cameras: expectedCameras === null ? null : expectedCameras,
    detected_cameras: detectedCameras === null ? null : detectedCameras,
    offline_cameras: offlineCameras
  };
}

function buildTripId(schedule, pcName, date) {
  const dateKey = formatDateKey(date);
  const line = schedule ? schedule.line_id : 'no_line';
  return `${sanitizeFileSegment(pcName)}_${sanitizeFileSegment(line)}_${dateKey}`;
}

function stopPublicView(stop, distanceMeters, plannedTime) {
  if (!stop) return null;

  return {
    stop_id: getStopId(stop),
    id: getStopId(stop),
    name: stop.name,
    number: stop.number || '',
    latitude: stop.latitude,
    longitude: stop.longitude,
    lat: stop.latitude,
    lng: stop.longitude,
    admin_zone: stop.admin_zone || 'nieokreślona',
    zone_type: stop.zone_type || 'nieokreślony',
    planned_time: plannedTime || null,
    distance_meters: Number.isFinite(distanceMeters) ? Number(distanceMeters.toFixed(2)) : null
  };
}

function analyzeVehiclePayload(payload, metadata, appendTripEvent) {
  const now = metadata.analysisDate || new Date();
  const pcName = requiredString(payload.pcName, 'pcName');
  const pcId = optionalString(payload.pcId, '');
  const timestamp = optionalString(payload.timestamp, now.toISOString());
  const coordinates = extractCoordinates(payload);
  const stats = extractPassengerStats(payload);
  const schedule = findActiveScheduleForVehicle(pcName, pcId);
  const dayType = determineDayType(now);
  const currentSeconds = secondsSinceMidnight(now);

  database.vehicles[pcName] = {
    pcName,
    pcId,
    first_seen_at: database.vehicles[pcName] ? database.vehicles[pcName].first_seen_at : now.toISOString(),
    last_seen_at: now.toISOString(),
    last_payload_timestamp: timestamp,
    last_latitude: coordinates.latitude,
    last_longitude: coordinates.longitude,
    has_schedule: Boolean(schedule)
  };

  const baseStatus = {
    pcName,
    pcId,
    timestamp,
    received_at: metadata.receivedAt || now.toISOString(),
    updated_at: now.toISOString(),
    raw_file: metadata.rawFileRelativePath || null,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    schedule_defined: Boolean(schedule),
    line_id: schedule ? schedule.line_id : null,
    line_number: schedule ? schedule.line_number : null,
    brigade: schedule ? schedule.brigade : null,
    day_type: schedule ? dayType : null,
    geofence_radius_meters: GEOFENCE_RADIUS_METERS,
    punctuality_tolerance_seconds: PUNCTUALITY_TOLERANCE_SECONDS,
    passengers: stats
  };

  if (!schedule) {
    const quality = extractCameraQuality(payload, null);

    const status = {
      ...baseStatus,
      status: 'brak rozkładu',
      punctuality_status: null,
      delay_seconds: null,
      delay_abs_seconds: null,
      current_stop: null,
      nearest_stop: null,
      data_quality: quality
    };

    database.current_status[pcName] = status;
    return status;
  }

  const quality = extractCameraQuality(payload, schedule);
  const sequence = enrichSequenceWithStops(getScheduleSequence(schedule, dayType));

  if (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) {
    const status = {
      ...baseStatus,
      schedule_id: schedule.schedule_id,
      status: 'brak pozycji GPS',
      punctuality_status: null,
      delay_seconds: null,
      delay_abs_seconds: null,
      current_stop: null,
      nearest_stop: null,
      data_quality: quality
    };

    database.current_status[pcName] = status;
    appendTripEventIfNeeded(status, schedule, now, appendTripEvent);
    return status;
  }

  if (sequence.length === 0) {
    const status = {
      ...baseStatus,
      schedule_id: schedule.schedule_id,
      status: 'brak sekwencji dla typu dnia',
      punctuality_status: null,
      delay_seconds: null,
      delay_abs_seconds: null,
      current_stop: null,
      nearest_stop: null,
      data_quality: quality
    };

    database.current_status[pcName] = status;
    appendTripEventIfNeeded(status, schedule, now, appendTripEvent);
    return status;
  }

  const nearestDistance = findNearestStopByDistance(sequence, coordinates.latitude, coordinates.longitude);
  const nearestByTime = findNearestStopByPlannedTime(sequence, currentSeconds);
  const isOnStop = Boolean(nearestDistance && nearestDistance.distance_meters <= GEOFENCE_RADIUS_METERS);
  const target = isOnStop ? nearestDistance : nearestDistance || nearestByTime;
  const plannedSeconds = target ? target.entry.planned_seconds : null;
  const diffSeconds = plannedSeconds === null ? null : signedTimeDiffSeconds(currentSeconds, plannedSeconds);
  const punctualityStatus = getPunctualityStatus(diffSeconds);
  const currentStop = isOnStop ? stopPublicView(target.stop, target.distance_meters, target.entry.planned_time) : null;
  const nearestStop = target ? stopPublicView(target.stop, target.distance_meters, target.entry.planned_time) : null;
  const timeReferenceStop = nearestByTime ? stopPublicView(nearestByTime.stop, null, nearestByTime.entry.planned_time) : null;

  const status = {
    ...baseStatus,
    schedule_id: schedule.schedule_id,
    status: punctualityStatus,
    punctuality_status: punctualityStatus,
    delay_seconds: diffSeconds,
    delay_abs_seconds: diffSeconds === null ? null : Math.abs(diffSeconds),
    current_stop: currentStop,
    nearest_stop: nearestStop,
    time_reference_stop: timeReferenceStop,
    is_on_stop: isOnStop,
    data_quality: quality
  };

  database.current_status[pcName] = status;
  appendTripEventIfNeeded(status, schedule, now, appendTripEvent);

  return status;
}

function appendTripEventIfNeeded(status, schedule, date, appendTripEvent) {
  if (!appendTripEvent) return;

  const stop = status.current_stop || status.nearest_stop || status.time_reference_stop;

  const event = {
    trip_event_id: crypto.randomUUID(),
    trip_id: buildTripId(schedule, status.pcName, date),
    pcName: status.pcName,
    pcId: status.pcId,
    line_id: schedule ? schedule.line_id : null,
    line_number: schedule ? schedule.line_number : null,
    brigade: schedule ? schedule.brigade : null,
    schedule_id: schedule ? schedule.schedule_id : null,
    day_type: status.day_type,
    timestamp: status.timestamp,
    received_at: status.received_at,
    analyzed_at: status.updated_at,
    raw_file: status.raw_file,
    latitude: status.latitude,
    longitude: status.longitude,
    stop_id: stop ? stop.stop_id : null,
    stop_name: stop ? stop.name : null,
    stop_number: stop ? stop.number : null,
    admin_zone: stop ? stop.admin_zone : null,
    zone_type: stop ? stop.zone_type : null,
    planned_time: stop ? stop.planned_time : null,
    distance_meters: stop ? stop.distance_meters : null,
    is_on_stop: Boolean(status.current_stop),
    punctuality_status: status.punctuality_status,
    delay_seconds: status.delay_seconds,
    delay_abs_seconds: status.delay_abs_seconds,
    passenger_in: status.passengers.selected_in,
    passenger_out: status.passengers.selected_out,
    passenger_events: status.passengers.passenger_events,
    onboard: status.passengers.onboard,
    camera_count: status.passengers.objectflow_apps,
    selected_area_avg: status.passengers.selected_area_avg,
    selected_area_count: status.passengers.selected_area_count,
    data_quality: status.data_quality
  };

  database.trips.push(event);

  if (database.trips.length > FRAME_HISTORY_LIMIT_IN_DB) {
    database.trips.splice(0, database.trips.length - FRAME_HISTORY_LIMIT_IN_DB);
  }
}

function buildMinimalVehicleFrame(pcName, payload, receivedAt) {
  const coordinates = extractCoordinates(payload);

  return {
    pcId: payload.pcId,
    pcName,
    timestamp: optionalString(payload.timestamp, receivedAt.toISOString()),
    latitude: Number.isFinite(coordinates.latitude) ? coordinates.latitude : null,
    longitude: Number.isFinite(coordinates.longitude) ? coordinates.longitude : null
  };
}

async function saveRawFrameForVehicle(pcName, payload, receivedAt) {
  const safePcName = sanitizeFileSegment(pcName);
  const vehicleDir = path.join(DB_ROOT, safePcName);
  await fsp.mkdir(vehicleDir, { recursive: true });

  const baseName = `${safePcName}_${formatFrameTimestamp(receivedAt)}`;
  let finalPath = path.join(vehicleDir, `${baseName}.json`);
  let counter = 1;

  while (true) {
    try {
      await fsp.access(finalPath);
      finalPath = path.join(vehicleDir, `${baseName}_${counter}.json`);
      counter += 1;
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
  }

  const minimalFrame = buildMinimalVehicleFrame(pcName, payload, receivedAt);
  await atomicWriteJson(finalPath, minimalFrame);

  return {
    absolutePath: finalPath,
    relativePath: path.relative(__dirname, finalPath).split(path.sep).join('/'),
    savedFrame: minimalFrame
  };
}

function logReceivedDataConsole(payload, status) {
  const pcId = payload.pcId;
  const pcName = payload.pcName;
  const timestamp = payload.timestamp;
  const latitude = status && status.latitude !== undefined ? status.latitude : null;
  const longitude = status && status.longitude !== undefined ? status.longitude : null;
  const data = payload.data;

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    📥 ODEBRANO DANE Z PC                    ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  PC ID:          ${String(pcId).padEnd(40)}║`);
  console.log(`║  PC Name:        ${String(pcName).padEnd(40)}║`);
  console.log(`║  Czas nadania:   ${String(timestamp).padEnd(40)}║`);
  console.log(`║  Czas odbioru:   ${new Date().toISOString().padEnd(40)}║`);

  const latStr = latitude !== null && latitude !== undefined && Number.isFinite(latitude) ? latitude.toFixed(6) : 'BRAK';
  const lonStr = longitude !== null && longitude !== undefined && Number.isFinite(longitude) ? longitude.toFixed(6) : 'BRAK';

  console.log(`║  Szerokość GPS:  ${String(latStr).padEnd(40)}║`);
  console.log(`║  Długość GPS:    ${String(lonStr).padEnd(40)}║`);
  console.log(`║  Status:         ${String(status ? status.status : 'nieustalony').padEnd(40)}║`);
  console.log('╠════════════════════════════════════════════════════════════════╣');

  if (data && data.totals) {
    const totals = data.totals;
    const apps = firstDefined(totals.objectflow_apps, 'BRAK');
    const selectedIn = firstDefined(totals.selected_in, 'BRAK');
    const selectedOut = firstDefined(totals.selected_out, 'BRAK');
    const areaAvg = toFiniteNumber(totals.selected_area_avg);
    const areaCount = firstDefined(totals.selected_area_count, 'BRAK');

    console.log(`║  Aplikacje:      ${String(apps).padEnd(40)}║`);
    console.log(`║  Suma IN:        ${String(selectedIn).padEnd(40)}║`);
    console.log(`║  Suma OUT:       ${String(selectedOut).padEnd(40)}║`);
    console.log(`║  Śr. obszarów:   ${String(areaAvg === null ? 'BRAK' : areaAvg.toFixed(2)).padEnd(40)}║`);
    console.log(`║  Licznik obsz.:  ${String(areaCount).padEnd(40)}║`);
  } else {
    console.log('║  (brak danych lub struktura niezgodna)                      ║');
  }

  console.log('╚════════════════════════════════════════════════════════════════╝\n');
}

function logStatusTick(status) {
  const lat = Number.isFinite(status.latitude) ? status.latitude.toFixed(6) : 'BRAK';
  const lng = Number.isFinite(status.longitude) ? status.longitude.toFixed(6) : 'BRAK';

  if (!status.schedule_defined) {
    console.log(`Zaktualizowano pozycję komputera pokładowego (${status.pcName}). Współrzędne: [${lat}, ${lng}]. Brak zdefiniowanego rozkładu jazdy.`);
    return;
  }

  if (!status.punctuality_status) {
    console.log(`Zaktualizowano pozycję komputera pokładowego (${status.pcName}). Współrzędne: [${lat}, ${lng}]. Status: ${status.status}.`);
    return;
  }

  const referenceStop = status.current_stop || status.nearest_stop || status.time_reference_stop || { name: 'BRAK' };
  const seconds = status.delay_abs_seconds === null || status.delay_abs_seconds === undefined ? 'BRAK' : status.delay_abs_seconds;

  console.log(`Zaktualizowano pozycję komputera pokładowego (${status.pcName}). Współrzędne: [${lat}, ${lng}]. Status: ${status.punctuality_status} o ${seconds} sek względem przystanku ${referenceStop.name} (Rozkład: ${status.day_type})`);
}

async function analyzeAllCurrentVehicles() {
  if (!databaseReady) return;
  if (pcDataStore.size === 0) return;

  let changed = false;
  const analysisDate = new Date();

  for (const [pcName, record] of pcDataStore.entries()) {
    try {
      const status = analyzeVehiclePayload(record.payload, {
        ...record.metadata,
        analysisDate
      }, false);

      logStatusTick(status);
      changed = true;
    } catch (err) {
      console.error(`[serverRoom] Błąd analizy cyklicznej dla ${pcName}:`, err.message);
    }
  }

  if (changed) {
    try {
      await saveDatabase();
    } catch (err) {
      console.error('[serverRoom] Błąd zapisu database.json po cyklicznej analizie:', err.message);
    }
  }
}

function getFilteredTripEvents(query) {
  const pcName = optionalString(query.pcName || query.pc_name, '');
  const lineId = optionalString(query.line_id || query.lineId || query.line, '');
  const dayType = optionalString(query.day_type || query.dayType, '');
  const stopId = optionalString(query.stop_id || query.stopId, '');
  const startDate = optionalString(query.start || query.from || query.date_from || query.dateFrom, '');
  const endDate = optionalString(query.end || query.to || query.date_to || query.dateTo, '');

  const startTime = startDate ? new Date(startDate).getTime() : null;
  const endTime = endDate ? new Date(endDate).getTime() : null;

  return database.trips.filter(event => {
    if (pcName && event.pcName !== pcName) return false;
    if (lineId && String(event.line_id) !== lineId) return false;
    if (dayType && event.day_type !== dayType) return false;
    if (stopId && event.stop_id !== stopId) return false;

    const eventTime = new Date(event.received_at || event.analyzed_at || event.timestamp).getTime();

    if (startTime !== null && Number.isFinite(startTime) && eventTime < startTime) return false;
    if (endTime !== null && Number.isFinite(endTime) && eventTime > endTime) return false;

    return true;
  });
}

function summarizeDataQuality(events) {
  const badEvents = events.filter(event => event.data_quality && event.data_quality.complete === false);

  if (badEvents.length === 0) {
    return {
      complete: true,
      error: null,
      bad_events_count: 0,
      total_events_count: events.length
    };
  }

  return {
    complete: false,
    error: 'Wadliwość pomiaru: Brak obrazu ze wszystkich kamer',
    bad_events_count: badEvents.length,
    total_events_count: events.length
  };
}

function getHourFromTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return pad2(date.getHours());
}

function getWeekdayFromTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';

  const names = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  return names[date.getDay()];
}

function groupKey(parts) {
  return parts.map(part => String(part === null || part === undefined ? '' : part)).join('||');
}

function buildStopUsageReport(events) {
  const totalPassengerEvents = events.reduce((sum, event) => sum + Number(event.passenger_events || 0), 0);
  const map = new Map();

  for (const event of events) {
    if (!event.stop_id) continue;

    const key = event.stop_id;

    if (!map.has(key)) {
      map.set(key, {
        stop_id: event.stop_id,
        name: event.stop_name || '',
        number: event.stop_number || '',
        admin_zone: event.admin_zone || 'nieokreślona',
        zone_type: event.zone_type || 'nieokreślony',
        total_boardings: 0,
        total_alightings: 0,
        total_passenger_events: 0,
        course_ids: new Set(),
        hours: {},
        weekdays: {},
        day_types: {}
      });
    }

    const row = map.get(key);
    const timestamp = event.received_at || event.analyzed_at || event.timestamp;
    const hour = getHourFromTimestamp(timestamp);
    const weekday = getWeekdayFromTimestamp(timestamp);
    const dayType = event.day_type || 'unknown';
    const passengerEvents = Number(event.passenger_events || 0);

    row.total_boardings += Number(event.passenger_in || 0);
    row.total_alightings += Number(event.passenger_out || 0);
    row.total_passenger_events += passengerEvents;

    if (event.trip_id) row.course_ids.add(event.trip_id);

    row.hours[hour] = (row.hours[hour] || 0) + passengerEvents;
    row.weekdays[weekday] = (row.weekdays[weekday] || 0) + passengerEvents;
    row.day_types[dayType] = (row.day_types[dayType] || 0) + passengerEvents;
  }

  return [...map.values()].map(row => ({
    stop_id: row.stop_id,
    name: row.name,
    number: row.number,
    admin_zone: row.admin_zone,
    zone_type: row.zone_type,
    total_boardings: row.total_boardings,
    total_alightings: row.total_alightings,
    total_passenger_events: row.total_passenger_events,
    share_of_all_passengers_percent: totalPassengerEvents > 0
      ? Number(((row.total_passenger_events / totalPassengerEvents) * 100).toFixed(2))
      : 0,
    course_count: row.course_ids.size,
    by_hour: row.hours,
    by_weekday: row.weekdays,
    by_day_type: row.day_types
  })).sort((a, b) => b.total_passenger_events - a.total_passenger_events);
}

function buildOnDemandStopsReport(events) {
  const map = new Map();

  for (const event of events) {
    if (!event.stop_id || !event.trip_id) continue;

    const key = event.stop_id;

    if (!map.has(key)) {
      map.set(key, {
        stop_id: event.stop_id,
        name: event.stop_name || '',
        number: event.stop_number || '',
        admin_zone: event.admin_zone || 'nieokreślona',
        courses: new Map()
      });
    }

    const row = map.get(key);

    if (!row.courses.has(event.trip_id)) {
      row.courses.set(event.trip_id, {
        passenger_events: 0,
        boardings: 0,
        alightings: 0
      });
    }

    const course = row.courses.get(event.trip_id);
    course.passenger_events += Number(event.passenger_events || 0);
    course.boardings += Number(event.passenger_in || 0);
    course.alightings += Number(event.passenger_out || 0);
  }

  return [...map.values()].map(row => {
    const courses = [...row.courses.values()];
    const coursesTotal = courses.length;
    const coursesWithPassengers = courses.filter(course => course.passenger_events > 0).length;

    return {
      stop_id: row.stop_id,
      name: row.name,
      number: row.number,
      admin_zone: row.admin_zone,
      courses_total: coursesTotal,
      courses_with_passengers: coursesWithPassengers,
      percent_courses_with_passengers: coursesTotal > 0
        ? Number(((coursesWithPassengers / coursesTotal) * 100).toFixed(2))
        : 0,
      suggested_status: coursesTotal > 0 && (coursesWithPassengers / coursesTotal) < 0.25
        ? 'kandydat na przystanek na żądanie'
        : 'regularny'
    };
  }).sort((a, b) => a.percent_courses_with_passengers - b.percent_courses_with_passengers);
}

function buildLinePerformanceReport(events) {
  const map = new Map();

  for (const event of events) {
    const key = groupKey([event.line_id || 'brak_linii', event.pcName || 'brak_pc']);

    if (!map.has(key)) {
      map.set(key, {
        line_id: event.line_id || null,
        line_number: event.line_number || null,
        pcName: event.pcName || null,
        total_boardings: 0,
        total_alightings: 0,
        total_passenger_events: 0,
        delay_sum: 0,
        delay_abs_sum: 0,
        delay_count: 0,
        on_time_count: 0,
        delayed_count: 0,
        early_count: 0,
        event_count: 0,
        course_ids: new Set(),
        by_hour: {},
        by_weekday: {},
        by_day_type: {}
      });
    }

    const row = map.get(key);
    const passengerEvents = Number(event.passenger_events || 0);
    const timestamp = event.received_at || event.analyzed_at || event.timestamp;
    const hour = getHourFromTimestamp(timestamp);
    const weekday = getWeekdayFromTimestamp(timestamp);
    const dayType = event.day_type || 'unknown';

    row.total_boardings += Number(event.passenger_in || 0);
    row.total_alightings += Number(event.passenger_out || 0);
    row.total_passenger_events += passengerEvents;
    row.event_count += 1;

    if (event.trip_id) row.course_ids.add(event.trip_id);

    if (Number.isFinite(event.delay_seconds)) {
      row.delay_sum += Number(event.delay_seconds);
      row.delay_abs_sum += Math.abs(Number(event.delay_seconds));
      row.delay_count += 1;
    }

    if (event.punctuality_status === 'o czasie') row.on_time_count += 1;
    if (event.punctuality_status === 'opóźniony') row.delayed_count += 1;
    if (event.punctuality_status === 'za szybko') row.early_count += 1;

    row.by_hour[hour] = (row.by_hour[hour] || 0) + passengerEvents;
    row.by_weekday[weekday] = (row.by_weekday[weekday] || 0) + passengerEvents;
    row.by_day_type[dayType] = (row.by_day_type[dayType] || 0) + passengerEvents;
  }

  return [...map.values()].map(row => ({
    line_id: row.line_id,
    line_number: row.line_number,
    pcName: row.pcName,
    total_boardings: row.total_boardings,
    total_alightings: row.total_alightings,
    total_passenger_events: row.total_passenger_events,
    event_count: row.event_count,
    course_count: row.course_ids.size,
    average_delay_seconds: row.delay_count > 0 ? Number((row.delay_sum / row.delay_count).toFixed(2)) : null,
    average_absolute_delay_seconds: row.delay_count > 0 ? Number((row.delay_abs_sum / row.delay_count).toFixed(2)) : null,
    on_time_percent: row.delay_count > 0 ? Number(((row.on_time_count / row.delay_count) * 100).toFixed(2)) : null,
    delayed_percent: row.delay_count > 0 ? Number(((row.delayed_count / row.delay_count) * 100).toFixed(2)) : null,
    early_percent: row.delay_count > 0 ? Number(((row.early_count / row.delay_count) * 100).toFixed(2)) : null,
    by_hour: row.by_hour,
    by_weekday: row.by_weekday,
    by_day_type: row.by_day_type
  })).sort((a, b) => b.total_passenger_events - a.total_passenger_events);
}

function computeRouteKilometersByAdminZone() {
  const result = {};

  for (const schedule of database.schedules) {
    for (const dayType of DAY_TYPES) {
      const sequence = enrichSequenceWithStops(getScheduleSequence(schedule, dayType));
      if (sequence.length < 2) continue;

      for (let i = 0; i < sequence.length - 1; i += 1) {
        const current = sequence[i].stop;
        const next = sequence[i + 1].stop;
        const zone = current.admin_zone || 'nieokreślona';
        const key = groupKey([schedule.line_id, dayType, zone]);
        const distanceKm = haversineMeters(current.latitude, current.longitude, next.latitude, next.longitude) / 1000;

        result[key] = (result[key] || 0) + distanceKm;
      }
    }
  }

  return result;
}

function buildAdminZoneReport(events) {
  const routeKm = computeRouteKilometersByAdminZone();
  const map = new Map();

  for (const event of events) {
    const zone = event.admin_zone || 'nieokreślona';
    const key = groupKey([event.line_id || 'brak_linii', event.day_type || 'unknown', zone]);

    if (!map.has(key)) {
      map.set(key, {
        line_id: event.line_id || null,
        line_number: event.line_number || null,
        day_type: event.day_type || 'unknown',
        admin_zone: zone,
        total_boardings: 0,
        total_alightings: 0,
        total_passenger_events: 0,
        event_count: 0,
        stops: new Set(),
        course_ids: new Set(),
        by_hour: {},
        by_weekday: {}
      });
    }

    const row = map.get(key);
    const passengerEvents = Number(event.passenger_events || 0);
    const timestamp = event.received_at || event.analyzed_at || event.timestamp;
    const hour = getHourFromTimestamp(timestamp);
    const weekday = getWeekdayFromTimestamp(timestamp);

    row.total_boardings += Number(event.passenger_in || 0);
    row.total_alightings += Number(event.passenger_out || 0);
    row.total_passenger_events += passengerEvents;
    row.event_count += 1;

    if (event.stop_id) row.stops.add(event.stop_id);
    if (event.trip_id) row.course_ids.add(event.trip_id);

    row.by_hour[hour] = (row.by_hour[hour] || 0) + passengerEvents;
    row.by_weekday[weekday] = (row.by_weekday[weekday] || 0) + passengerEvents;
  }

  return [...map.values()].map(row => {
    const kmKey = groupKey([row.line_id || 'brak_linii', row.day_type || 'unknown', row.admin_zone]);
    const kilometers = routeKm[kmKey] || null;

    return {
      line_id: row.line_id,
      line_number: row.line_number,
      day_type: row.day_type,
      admin_zone: row.admin_zone,
      total_boardings: row.total_boardings,
      total_alightings: row.total_alightings,
      total_passenger_events: row.total_passenger_events,
      event_count: row.event_count,
      stop_count: row.stops.size,
      course_count: row.course_ids.size,
      estimated_route_km: kilometers === null ? null : Number(kilometers.toFixed(3)),
      passengers_per_km: kilometers && kilometers > 0
        ? Number((row.total_passenger_events / kilometers).toFixed(2))
        : null,
      by_hour: row.by_hour,
      by_weekday: row.by_weekday
    };
  }).sort((a, b) => b.total_passenger_events - a.total_passenger_events);
}

function reportResponse(query, rows) {
  const events = getFilteredTripEvents(query);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    filters: query,
    data_quality: summarizeDataQuality(events),
    rows
  };
}

function listVehicles() {
  const fromCurrent = Object.values(database.vehicles || {});

  const scheduled = database.schedules.map(schedule => ({
    pcName: schedule.pcName,
    pcId: schedule.pcId || '',
    line_id: schedule.line_id,
    line_number: schedule.line_number,
    brigade: schedule.brigade || '',
    has_schedule: true,
    schedule_id: schedule.schedule_id,
    active: schedule.active !== false
  }));

  const map = new Map();

  for (const item of scheduled) map.set(item.pcName, item);

  for (const item of fromCurrent) {
    map.set(item.pcName, {
      ...(map.get(item.pcName) || {}),
      ...item
    });
  }

  return [...map.values()].sort((a, b) => String(a.pcName).localeCompare(String(b.pcName)));
}

// --------------------- HANDLERY API ---------------------
async function handleApiIp(req, res) {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ips = getLocalIPs();

  sendJson(res, 200, {
    ok: true,
    serverPort: PORT,
    serverUrls: ips.map(ip => ip.url),
    yourClientIp: clientIp,
    fullUrls: ips.map(ip => ({
      interface: ip.interface,
      url: ip.url,
      envVariable: `export ROOM_SERVER_URL="${ip.url}"`
    }))
  });
}

async function handleIncomingData(req, res) {
  const payload = await readJsonBody(req);

  const pcId = payload.pcId;
  const pcName = payload.pcName;

  if (pcId === null || pcId === undefined || pcName === null || pcName === undefined) {
    throw new Error('Brak wymaganych pól: pcId, pcName');
  }

  const normalizedPcName = requiredString(pcName, 'pcName');
  const receivedAtDate = new Date();
  const receivedAt = receivedAtDate.toISOString();

  const rawFile = await saveRawFrameForVehicle(normalizedPcName, payload, receivedAtDate);

  const metadata = {
    receivedAt,
    remoteAddress: req.socket.remoteAddress,
    rawFileAbsolutePath: rawFile.absolutePath,
    rawFileRelativePath: rawFile.relativePath,
    analysisDate: receivedAtDate
  };

  pcDataStore.set(normalizedPcName, {
    payload,
    metadata
  });

  const status = analyzeVehiclePayload(payload, metadata, true);

  logReceivedDataConsole(payload, status);

  await saveDatabase();

  sendJson(res, 200, {
    ok: true,
    message: 'Data received',
    receivedAt,
    savedRawFrame: rawFile.relativePath,
    savedFrame: rawFile.savedFrame,
    currentStatus: status
  });
}

async function handleCreateStop(req, res) {
  const body = await readJsonBody(req);
  const stop = normalizeStop(body);

  database.stops.push(stop);

  await saveDatabase();

  sendJson(res, 201, {
    ok: true,
    message: 'Stop created',
    stop
  });
}

async function handleGetStops(req, res) {
  sendJson(res, 200, {
    ok: true,
    count: database.stops.length,
    stops: database.stops
  });
}

async function handleCreateSchedule(req, res) {
  const body = await readJsonBody(req);
  const schedule = normalizeSchedulePayload(body);

  const existingIndex = database.schedules.findIndex(item => item.schedule_id === schedule.schedule_id);

  if (existingIndex >= 0) {
    schedule.created_at = database.schedules[existingIndex].created_at || schedule.created_at;
    database.schedules[existingIndex] = schedule;
  } else {
    const sameVehicleLineIndex = database.schedules.findIndex(item => (
      item.pcName === schedule.pcName && item.line_id === schedule.line_id
    ));

    if (sameVehicleLineIndex >= 0 && body.replace_existing !== false) {
      schedule.created_at = database.schedules[sameVehicleLineIndex].created_at || schedule.created_at;
      database.schedules[sameVehicleLineIndex] = schedule;
    } else {
      database.schedules.push(schedule);
    }
  }

  if (!database.vehicles[schedule.pcName]) {
    database.vehicles[schedule.pcName] = {
      pcName: schedule.pcName,
      pcId: schedule.pcId || '',
      first_seen_at: null,
      last_seen_at: null,
      has_schedule: true
    };
  } else {
    database.vehicles[schedule.pcName].has_schedule = true;
    database.vehicles[schedule.pcName].pcId = schedule.pcId || database.vehicles[schedule.pcName].pcId || '';
  }

  await saveDatabase();

  sendJson(res, 201, {
    ok: true,
    message: 'Schedule saved',
    schedule
  });
}

async function handleGetSchedules(req, res, query) {
  const pcName = optionalString(query.pcName || query.pc_name, '');
  const lineId = optionalString(query.line_id || query.lineId || query.line, '');

  const schedules = database.schedules.filter(schedule => {
    if (pcName && schedule.pcName !== pcName) return false;
    if (lineId && String(schedule.line_id) !== lineId) return false;
    return true;
  });

  sendJson(res, 200, {
    ok: true,
    count: schedules.length,
    schedules
  });
}

async function handleReportsCurrent(req, res, query) {
  const pcName = optionalString(query.pcName || query.pc_name, '');

  const statuses = pcName
    ? Object.fromEntries(Object.entries(database.current_status).filter(([key]) => key === pcName))
    : database.current_status;

  sendJson(res, 200, {
    ok: true,
    generated_at: new Date().toISOString(),
    current_status: statuses
  });
}

async function handleStopUsageReport(req, res, query) {
  const events = getFilteredTripEvents(query);
  sendJson(res, 200, reportResponse(query, buildStopUsageReport(events)));
}

async function handleOnDemandStopsReport(req, res, query) {
  const events = getFilteredTripEvents(query);
  sendJson(res, 200, reportResponse(query, buildOnDemandStopsReport(events)));
}

async function handleLinePerformanceReport(req, res, query) {
  const events = getFilteredTripEvents(query);
  sendJson(res, 200, reportResponse(query, buildLinePerformanceReport(events)));
}

async function handleAdminZoneReport(req, res, query) {
  const events = getFilteredTripEvents(query);
  sendJson(res, 200, reportResponse(query, buildAdminZoneReport(events)));
}

async function handleVehicles(req, res) {
  const vehicles = listVehicles();

  sendJson(res, 200, {
    ok: true,
    count: vehicles.length,
    vehicles
  });
}

async function handleCreateHoliday(req, res) {
  const body = await readJsonBody(req);
  const date = requiredString(body.date, 'date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Pole date musi mieć format YYYY-MM-DD');
  }

  const item = {
    date,
    name: optionalString(body.name, 'święto'),
    created_at: new Date().toISOString()
  };

  const existingIndex = database.holidays.findIndex(holiday => {
    if (typeof holiday === 'string') return holiday === date;
    return holiday && holiday.date === date;
  });

  if (existingIndex >= 0) {
    database.holidays[existingIndex] = item;
  } else {
    database.holidays.push(item);
  }

  await saveDatabase();

  sendJson(res, 201, {
    ok: true,
    holiday: item
  });
}

async function handleGetHolidays(req, res) {
  sendJson(res, 200, {
    ok: true,
    holidays: database.holidays
  });
}

// --------------------- ROUTER ---------------------
async function routeRequest(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!databaseReady) {
    sendJson(res, 503, {
      ok: false,
      error: 'Database is starting'
    });
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query || {};

  try {
    if (req.method === 'GET' && pathname === '/api/ip') return await handleApiIp(req, res);
    if (req.method === 'POST' && pathname === '/api/data') return await handleIncomingData(req, res);

    if (req.method === 'POST' && pathname === '/stops') return await handleCreateStop(req, res);
    if (req.method === 'GET' && pathname === '/stops') return await handleGetStops(req, res);

    if (req.method === 'POST' && pathname === '/schedules') return await handleCreateSchedule(req, res);
    if (req.method === 'GET' && pathname === '/schedules') return await handleGetSchedules(req, res, query);

    if (req.method === 'GET' && pathname === '/vehicles') return await handleVehicles(req, res);

    if (req.method === 'POST' && pathname === '/holidays') return await handleCreateHoliday(req, res);
    if (req.method === 'GET' && pathname === '/holidays') return await handleGetHolidays(req, res);

    if (req.method === 'GET' && pathname === '/reports/trip/current') return await handleReportsCurrent(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/stop-usage') return await handleStopUsageReport(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/on-demand-stops') return await handleOnDemandStopsReport(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/line-performance') return await handleLinePerformanceReport(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/admin-zone') return await handleAdminZoneReport(req, res, query);

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        status: 'active',
        serverTime: new Date().toISOString(),
        database: DB_FILE,
        vehiclesInMemory: pcDataStore.size,
        stops: database.stops.length,
        schedules: database.schedules.length,
        tripEvents: database.trips.length
      });
    }

    sendJson(res, 404, {
      ok: false,
      error: 'Not found'
    });
  } catch (err) {
    console.error('[serverRoom] Błąd przetwarzania żądania:', err.message);

    sendJson(res, 400, {
      ok: false,
      error: err.message
    });
  }
}

// --------------------- SERWER HTTP ---------------------
const server = http.createServer((req, res) => {
  routeRequest(req, res).catch(err => {
    console.error('[serverRoom] Krytyczny błąd obsługi HTTP:', err);

    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: 'Internal server error'
      });
    } else {
      res.end();
    }
  });
});

// --------------------- URUCHOMIENIE ---------------------
async function startServer() {
  await ensureDatabaseReady();

  server.listen(PORT, () => {
    const ips = getLocalIPs();

    console.log('\n' + '═'.repeat(70));
    console.log('║     🚀 SERWER POKOJOWY (Isarsoft Room Server) URUCHOMIONY     ║');
    console.log('═'.repeat(70));
    console.log(`║  Port: ${PORT}`);
    console.log('║  Status: Aktywny ✅');
    console.log(`║  Baza danych: ${DB_FILE}`);
    console.log(`║  Katalog ramek: ${DB_ROOT}`);
    console.log('║');
    console.log('║  📍 DOSTĘPNE ADRESY URL DO KOPIOWANIA:');
    console.log('║');

    if (ips.length === 0) {
      console.log('║  ⚠️  Nie znaleziono żadnych zewnętrznych adresów IPv4!');
      console.log('║  Sprawdź połączenie sieciowe.');
    } else {
      ips.forEach((ip, index) => {
        const prefix = index === 0 ? '▶' : ' ';
        console.log(`║  ${prefix} Interfejs: ${ip.interface.padEnd(20)}`);
        console.log(`║     URL: ${ip.url}`);
        console.log(`║     Kopiuj: ${'export ROOM_SERVER_URL="' + ip.url + '"'}`);
        console.log('║');
      });
    }

    console.log('║  💡 WSKAZÓWKI:');
    console.log('║  1. Wybierz odpowiedni adres IP z listy powyżej');
    console.log('║  2. Skopiuj komendę export i wklej w terminalu serverPc.js');
    console.log('║  3. Przykład dla Windows (PowerShell):');
    console.log('║     $env:ROOM_SERVER_URL="http://192.168.68.212:3001/api/data"');
    console.log('║  4. Przykład dla Windows (CMD):');
    console.log('║     set ROOM_SERVER_URL=http://192.168.68.212:3001/api/data');
    console.log('═'.repeat(70));
    console.log('║  📊 Serwer nasłuchuje na ścieżce: POST /api/data');
    console.log('║  📊 Endpoint pomocniczy: GET /api/ip');
    console.log('║  📊 Przystanki: POST/GET /stops');
    console.log('║  📊 Rozkłady: POST/GET /schedules');
    console.log('║  📊 Dashboard: GET /reports/trip/current');
    console.log('═'.repeat(70) + '\n');

    console.log('📋 ŁATWE KOPIOWANIE (JSON):');
    console.log(JSON.stringify({
      serverInfo: {
        port: PORT,
        time: new Date().toISOString(),
        databaseFile: DB_FILE,
        databaseRoot: DB_ROOT,
        syncIntervalMs: SYNC_INTERVAL_MS,
        geofenceRadiusMeters: GEOFENCE_RADIUS_METERS,
        punctualityToleranceSeconds: PUNCTUALITY_TOLERANCE_SECONDS,
        frameFileMode: 'minimal_vehicle_location'
      },
      availableUrls: ips.map(ip => ({
        interface: ip.interface,
        url: ip.url,
        envExport: `export ROOM_SERVER_URL="${ip.url}"`,
        windowsPowerShell: `$env:ROOM_SERVER_URL="${ip.url}"`,
        windowsCmd: `set ROOM_SERVER_URL=${ip.url}`
      })),
      endpoints: {
        receiveData: 'POST /api/data',
        serverIp: 'GET /api/ip',
        createStop: 'POST /stops',
        listStops: 'GET /stops',
        createSchedule: 'POST /schedules',
        listSchedules: 'GET /schedules',
        vehicles: 'GET /vehicles',
        currentTrip: 'GET /reports/trip/current',
        stopUsage: 'GET /reports/stop-usage',
        onDemandStops: 'GET /reports/on-demand-stops',
        linePerformance: 'GET /reports/line-performance',
        adminZone: 'GET /reports/admin-zone'
      }
    }, null, 2));

    console.log('\n');
  });

  setInterval(() => {
    analyzeAllCurrentVehicles().catch(err => {
      console.error('[serverRoom] Błąd pętli 5s:', err.message);
    });
  }, SYNC_INTERVAL_MS);
}

startServer().catch(err => {
  console.error('[serverRoom] Nie udało się uruchomić serwera:', err);
  process.exit(1);
});

// --------------------- ZAMYKANIE ---------------------
async function gracefulShutdown(signal) {
  console.log(`\n[serverRoom] Otrzymano ${signal}. Zamykam serwer...`);

  try {
    await saveDatabase();
  } catch (err) {
    console.error('[serverRoom] Błąd zapisu bazy przy zamykaniu:', err.message);
  }

  server.close(() => {
    console.log('[serverRoom] Serwer zamknięty.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[serverRoom] Wymuszone zamknięcie po przekroczeniu czasu oczekiwania.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

process.on('unhandledRejection', err => {
  console.error('[serverRoom] Nieobsłużone odrzucenie Promise:', err);
});

process.on('uncaughtException', err => {
  console.error('[serverRoom] Nieobsłużony wyjątek:', err);
  gracefulShutdown('uncaughtException');
});