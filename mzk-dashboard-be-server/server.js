'use strict';

const http = require('http');
const url = require('url');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// --------------------- KONFIGURACJA ---------------------
const PORT = Number(process.env.ROOM_PORT || 3001);
const DB_ROOT = process.env.ROOM_DB_ROOT || path.join(__dirname, 'database');
const DB_FILE = process.env.ROOM_DB_FILE || path.join(DB_ROOT, 'production.db');
const SYNC_INTERVAL_MS = Number(process.env.ROOM_SYNC_INTERVAL_MS || 5000);
const MAX_BODY_BYTES = Number(process.env.ROOM_MAX_BODY_BYTES || 100 * 1024 * 1024);
const GEOFENCE_RADIUS_METERS = Number(process.env.ROOM_GEOFENCE_RADIUS_METERS || 55);
const PUNCTUALITY_TOLERANCE_SECONDS = Number(process.env.ROOM_PUNCTUALITY_TOLERANCE_SECONDS || 60);
const FRAME_HISTORY_LIMIT_IN_DB = Number(process.env.ROOM_FRAME_HISTORY_LIMIT_IN_DB || 50000);
const DAY_TYPES = ['weekday', 'weekend', 'holiday'];

let db = null;
let databaseReady = false;
let server = null;

// --------------------- BAZA SQLITE ---------------------
function ensureDatabaseReady() {
  fs.mkdirSync(DB_ROOT, { recursive: true });

  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    db.function('haversine_meters', { deterministic: true }, haversineMeters);
  } catch (err) {
    // Funkcja może być już zarejestrowana po hot-reloadzie w niektórych środowiskach.
  }

  initSchema();
  seedDefaultSettings();

  databaseReady = true;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stops (
      id TEXT PRIMARY KEY,
      name TEXT,
      latitude REAL,
      longitude REAL,
      zone TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      line_id TEXT,
      route_name TEXT,
      day_type TEXT,
      sequence_json TEXT,
      metadata TEXT,
      pcName TEXT,
      pcId TEXT,
      active INTEGER DEFAULT 1,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      pcName TEXT PRIMARY KEY,
      pcId TEXT,
      last_lat REAL,
      last_lng REAL,
      first_seen TEXT,
      last_seen TEXT,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS current_status (
      pcName TEXT PRIMARY KEY,
      line_id TEXT,
      current_stop_id TEXT,
      nearest_stop_id TEXT,
      punctuality_status TEXT,
      delay_seconds INTEGER,
      geo_distance REAL,
      passengers_in INTEGER,
      passengers_out INTEGER,
      passengers_onboard INTEGER,
      camera_quality_json TEXT,
      updated_at TEXT,
      status TEXT,
      pcId TEXT,
      day_type TEXT,
      timestamp TEXT,
      received_at TEXT,
      latitude REAL,
      longitude REAL,
      payload_json TEXT,
      status_json TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pcName TEXT,
      pcId TEXT,
      timestamp TEXT,
      latitude REAL,
      longitude REAL,
      received_at TEXT
    );

    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pcName TEXT,
      line_id TEXT,
      stop_id TEXT,
      timestamp TEXT,
      day_type TEXT,
      passengers_in INTEGER,
      passengers_out INTEGER,
      passengers_onboard INTEGER,
      delay_seconds INTEGER,
      punctuality_status TEXT,
      camera_error_detected INTEGER,
      distance_to_stop REAL,
      is_at_stop INTEGER,
      pcId TEXT,
      line_number TEXT,
      brigade TEXT,
      schedule_id TEXT,
      trip_id TEXT,
      received_at TEXT,
      analyzed_at TEXT,
      latitude REAL,
      longitude REAL,
      planned_time TEXT,
      delay_abs_seconds INTEGER,
      passenger_events INTEGER,
      camera_count INTEGER,
      selected_area_avg REAL,
      selected_area_count INTEGER,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS holidays (
      date TEXT PRIMARY KEY,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_stops_zone ON stops(zone);
    CREATE INDEX IF NOT EXISTS idx_schedules_lookup ON schedules(pcName, pcId, day_type, active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_line ON schedules(line_id, day_type);
    CREATE INDEX IF NOT EXISTS idx_vehicles_last_seen ON vehicles(last_seen);
    CREATE INDEX IF NOT EXISTS idx_current_status_updated ON current_status(updated_at);
    CREATE INDEX IF NOT EXISTS idx_raw_frames_pc_time ON raw_frames(pcName, received_at);
    CREATE INDEX IF NOT EXISTS idx_raw_frames_id ON raw_frames(id);
    CREATE INDEX IF NOT EXISTS idx_trips_filters ON trips(pcName, line_id, stop_id, day_type, received_at);
    CREATE INDEX IF NOT EXISTS idx_trips_line_vehicle ON trips(line_id, pcName, received_at);
    CREATE INDEX IF NOT EXISTS idx_trips_stop ON trips(stop_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_trips_id ON trips(id);
    CREATE INDEX IF NOT EXISTS idx_trips_quality ON trips(camera_error_detected);
  `);

  ensureColumn('schedules', 'pcName', 'TEXT');
  ensureColumn('schedules', 'pcId', 'TEXT');
  ensureColumn('schedules', 'active', 'INTEGER DEFAULT 1');
  ensureColumn('schedules', 'updated_at', 'TEXT');

  ensureColumn('current_status', 'status', 'TEXT');
  ensureColumn('current_status', 'pcId', 'TEXT');
  ensureColumn('current_status', 'day_type', 'TEXT');
  ensureColumn('current_status', 'timestamp', 'TEXT');
  ensureColumn('current_status', 'received_at', 'TEXT');
  ensureColumn('current_status', 'latitude', 'REAL');
  ensureColumn('current_status', 'longitude', 'REAL');
  ensureColumn('current_status', 'payload_json', 'TEXT');
  ensureColumn('current_status', 'status_json', 'TEXT');

  ensureColumn('trips', 'pcId', 'TEXT');
  ensureColumn('trips', 'line_number', 'TEXT');
  ensureColumn('trips', 'brigade', 'TEXT');
  ensureColumn('trips', 'schedule_id', 'TEXT');
  ensureColumn('trips', 'trip_id', 'TEXT');
  ensureColumn('trips', 'received_at', 'TEXT');
  ensureColumn('trips', 'analyzed_at', 'TEXT');
  ensureColumn('trips', 'latitude', 'REAL');
  ensureColumn('trips', 'longitude', 'REAL');
  ensureColumn('trips', 'planned_time', 'TEXT');
  ensureColumn('trips', 'delay_abs_seconds', 'INTEGER');
  ensureColumn('trips', 'passenger_events', 'INTEGER');
  ensureColumn('trips', 'camera_count', 'INTEGER');
  ensureColumn('trips', 'selected_area_avg', 'REAL');
  ensureColumn('trips', 'selected_area_count', 'INTEGER');
  ensureColumn('trips', 'metadata', 'TEXT');
}

function ensureColumn(tableName, columnName, columnSql) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(column => column.name === columnName);
  if (!exists) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
}

function seedDefaultSettings() {
  const upsert = db.prepare(`
    INSERT INTO settings(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = db.transaction(() => {
    upsert.run('geofence_radius_meters', String(GEOFENCE_RADIUS_METERS));
    upsert.run('punctuality_tolerance_seconds', String(PUNCTUALITY_TOLERANCE_SECONDS));
    upsert.run('sync_interval_ms', String(SYNC_INTERVAL_MS));
    upsert.run('frame_history_limit_in_db', String(FRAME_HISTORY_LIMIT_IN_DB));
    upsert.run('database_file', DB_FILE);
  });

  tx();
}

function pruneHistory() {
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM raw_frames
      WHERE id NOT IN (
        SELECT id FROM raw_frames
        ORDER BY id DESC
        LIMIT ?
      )
    `).run(FRAME_HISTORY_LIMIT_IN_DB);

    db.prepare(`
      DELETE FROM trips
      WHERE id NOT IN (
        SELECT id FROM trips
        ORDER BY id DESC
        LIMIT ?
      )
    `).run(FRAME_HISTORY_LIMIT_IN_DB);
  });

  tx();
}

// --------------------- FUNKCJE POMOCNICZE ---------------------
function jsonStringify(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function jsonParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
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
    let rejected = false;

    req.on('data', chunk => {
      totalBytes += chunk.length;

      if (totalBytes > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error(`Przekroczono maksymalny rozmiar żądania: ${MAX_BODY_BYTES} bajtów`));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on('end', () => {
      if (!rejected) resolve(body);
    });
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
  if (value === null || value === undefined) throw new Error(`Brak wymaganego pola: ${fieldName}`);

  const text = String(value).trim();
  if (!text) throw new Error(`Pole ${fieldName} nie może być puste`);

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
  const aLat1 = Number(lat1);
  const aLon1 = Number(lon1);
  const aLat2 = Number(lat2);
  const aLon2 = Number(lon2);

  if (![aLat1, aLon1, aLat2, aLon2].every(Number.isFinite)) return null;

  const earthRadiusMeters = 6371000;
  const toRadians = degrees => degrees * Math.PI / 180;

  const dLat = toRadians(aLat2 - aLat1);
  const dLon = toRadians(aLon2 - aLon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(aLat1)) *
    Math.cos(toRadians(aLat2)) *
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

function stopFromRow(row) {
  if (!row) return null;
  const metadata = jsonParse(row.metadata, {});

  return {
    stop_id: row.id,
    id: row.id,
    name: row.name || '',
    number: metadata.number || '',
    latitude: row.latitude,
    longitude: row.longitude,
    lat: row.latitude,
    lng: row.longitude,
    admin_zone: metadata.admin_zone || metadata.adminZone || row.zone || 'nieokreślona',
    zone: row.zone || metadata.admin_zone || 'nieokreślona',
    zone_type: metadata.zone_type || metadata.zoneType || 'nieokreślony',
    description: metadata.description || '',
    created_at: metadata.created_at || null,
    updated_at: metadata.updated_at || null,
    metadata
  };
}

function findStopById(stopId) {
  const id = String(stopId || '').trim();
  if (!id) return null;
  const row = db.prepare('SELECT * FROM stops WHERE id = ?').get(id);
  return stopFromRow(row);
}

function normalizeStop(input) {
  const latitude = toFiniteNumber(firstDefined(input.latitude, input.lat));
  const longitude = toFiniteNumber(firstDefined(input.longitude, input.lng, input.lon));

  if (!Number.isFinite(latitude)) throw new Error('Pole latitude/lat musi być poprawną liczbą');
  if (!Number.isFinite(longitude)) throw new Error('Pole longitude/lng musi być poprawną liczbą');

  const stopId = normalizeUuid(input.stop_id || input.id);
  const now = new Date().toISOString();
  const zone = optionalString(
    firstDefined(input.zone, input.admin_zone, input.adminZone),
    'nieokreślona'
  );

  const metadata = {
    number: optionalString(input.number, ''),
    admin_zone: zone,
    zone_type: optionalString(input.zone_type, optionalString(input.zoneType, 'nieokreślony')),
    description: optionalString(input.description, optionalString(input.decription, '')),
    created_at: input.created_at || now,
    updated_at: now,
    original: input.metadata && typeof input.metadata === 'object' ? input.metadata : undefined
  };

  return {
    id: stopId,
    name: requiredString(input.name, 'name'),
    latitude,
    longitude,
    zone,
    metadata
  };
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
    admin_zone: stop.admin_zone || stop.zone || 'nieokreślona',
    zone: stop.zone || stop.admin_zone || 'nieokreślona',
    zone_type: stop.zone_type || 'nieokreślony',
    planned_time: plannedTime || null,
    distance_meters: Number.isFinite(distanceMeters) ? Number(distanceMeters.toFixed(2)) : null
  };
}

function normalizeScheduleSequence(sequence, dayType) {
  if (!Array.isArray(sequence)) {
    throw new Error(`Sekwencja przystanków dla ${dayType} musi być tablicą`);
  }

  const result = [];

  for (let index = 0; index < sequence.length; index += 1) {
    const entry = sequence[index];
    const stopId = requiredString(firstDefined(entry.stop_id, entry.id), `${dayType}[${index}].stop_id`);
    const stop = findStopById(stopId);

    if (!stop) {
      throw new Error(`Nie znaleziono przystanku stop_id=${stopId} dla ${dayType}[${index}]`);
    }

    result.push({
      stop_id: getStopId(stop),
      planned_time: normalizeTimeToHHMMSS(entry.planned_time),
      sequence_index: index,
      stop_name: stop.name,
      stop_number: stop.number || '',
      latitude: stop.latitude,
      longitude: stop.longitude,
      admin_zone: stop.admin_zone || stop.zone || 'nieokreślona',
      zone: stop.zone || stop.admin_zone || 'nieokreślona',
      zone_type: stop.zone_type || 'nieokreślony'
    });
  }

  return result;
}

function normalizeSchedulePayload(input, forcedScheduleId) {
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
    } else if (Array.isArray(input.stops_sequence) && DAY_TYPES.length === 3) {
      rawSequence = input.stops_sequence;
    } else {
      rawSequence = [];
    }

    dayTypes[dayType] = {
      day_type: dayType,
      stops_sequence: normalizeScheduleSequence(rawSequence, dayType)
    };
  }

  const scheduleId = forcedScheduleId || normalizeUuid(input.schedule_id || input.id);
  const metadata = {
    schedule_id: scheduleId,
    pcName,
    pcId: optionalString(firstDefined(input.pcId, input.pc_id), ''),
    vehicle_id: pcName,
    line_number: optionalString(firstDefined(input.line_number, input.lineNumber, input.line), lineId),
    brigade: optionalString(input.brigade, ''),
    description: optionalString(input.description, ''),
    expected_cameras: toFiniteNumber(firstDefined(input.expected_cameras, input.expectedCameras, input.camera_count, input.cameraCount)),
    active: input.active !== false,
    created_at: input.created_at || now,
    updated_at: now
  };

  return {
    schedule_id: scheduleId,
    pcName,
    pcId: metadata.pcId,
    line_id: lineId,
    route_name: optionalString(input.route_name, ''),
    day_types: dayTypes,
    metadata
  };
}

function scheduleFromRows(rows) {
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  const meta = jsonParse(first.metadata, {});
  const result = {
    schedule_id: meta.schedule_id || String(first.id).split(':')[0],
    id: meta.schedule_id || String(first.id).split(':')[0],
    pcName: meta.pcName || first.pcName || '',
    pcId: meta.pcId || first.pcId || '',
    vehicle_id: meta.vehicle_id || meta.pcName || first.pcName || '',
    line_id: first.line_id,
    line_number: meta.line_number || first.line_id,
    brigade: meta.brigade || '',
    route_name: first.route_name || '',
    description: meta.description || '',
    expected_cameras: meta.expected_cameras === undefined ? null : meta.expected_cameras,
    active: first.active !== 0,
    created_at: meta.created_at || null,
    updated_at: meta.updated_at || first.updated_at || null,
    day_types: {}
  };

  for (const dayType of DAY_TYPES) {
    result.day_types[dayType] = {
      day_type: dayType,
      stops_sequence: []
    };
  }

  for (const row of rows) {
    const dayType = row.day_type || 'weekday';
    result.day_types[dayType] = {
      day_type: dayType,
      stops_sequence: jsonParse(row.sequence_json, [])
    };
  }

  return result;
}

function findScheduleRowsByBaseId(scheduleId) {
  return db.prepare(`
    SELECT *
    FROM schedules
    WHERE id = ? OR id LIKE ?
    ORDER BY CASE day_type
      WHEN 'weekday' THEN 1
      WHEN 'weekend' THEN 2
      WHEN 'holiday' THEN 3
      ELSE 4
    END
  `).all(scheduleId, `${scheduleId}:%`);
}

function findActiveScheduleForVehicle(pcName, pcId, dayType) {
  const pcNameValue = String(pcName || '').trim();
  const pcIdValue = String(pcId || '').trim();

  const row = db.prepare(`
    SELECT *
    FROM schedules
    WHERE day_type = ?
      AND active = 1
      AND (
        (? <> '' AND pcName = ?)
        OR (? <> '' AND pcId = ?)
      )
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get(dayType, pcNameValue, pcNameValue, pcIdValue, pcIdValue);

  if (!row) return null;

  const baseId = jsonParse(row.metadata, {}).schedule_id || String(row.id).split(':')[0];
  return scheduleFromRows(findScheduleRowsByBaseId(baseId));
}

function getScheduleSequence(schedule, dayType) {
  if (!schedule || !schedule.day_types || !schedule.day_types[dayType]) return [];
  const sequence = schedule.day_types[dayType].stops_sequence;
  return Array.isArray(sequence) ? sequence : [];
}

function enrichSequenceWithStops(sequence) {
  const result = [];

  for (const entry of sequence) {
    const stop = findStopById(entry.stop_id);
    if (!stop) continue;

    result.push({
      ...entry,
      stop,
      planned_seconds: timeToSeconds(entry.planned_time)
    });
  }

  return result;
}

function findNearestStopByDistance(sequence, latitude, longitude) {
  let nearest = null;

  for (const entry of sequence) {
    const distanceMeters = haversineMeters(latitude, longitude, entry.stop.latitude, entry.stop.longitude);

    if (!Number.isFinite(distanceMeters)) continue;

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
  const customHoliday = db.prepare('SELECT date FROM holidays WHERE date = ?').get(dateKey);

  if (customHoliday) return 'holiday';

  const publicHolidays = getPolishPublicHolidayKeys(date.getFullYear());
  if (publicHolidays.has(dateKey)) return 'holiday';

  const weekday = date.getDay();
  return weekday === 0 || weekday === 6 ? 'weekend' : 'weekday';
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

  const result = [];

  for (const collection of collections) {
    if (Array.isArray(collection)) result.push(collection);
  }

  return result;
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
    detectedCameras = Math.max(detectedCameras || 0, collection.length);

    for (const camera of collection) {
      if (!isCameraOnline(camera)) offlineCameras += 1;
    }
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

// --------------------- WARSTWA ZAPISU ANALIZY ---------------------
function upsertVehicle(pcName, pcId, coordinates, timestamp, nowIso, payload, metadata, hasSchedule) {
  const existing = db.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  const existingMetadata = existing ? jsonParse(existing.metadata, {}) : {};

  const nextMetadata = {
    ...existingMetadata,
    last_payload_timestamp: timestamp,
    has_schedule: Boolean(hasSchedule),
    last_payload: payload,
    last_payload_metadata: metadata,
    updated_at: nowIso
  };

  db.prepare(`
    INSERT INTO vehicles(pcName, pcId, last_lat, last_lng, first_seen, last_seen, metadata)
    VALUES(@pcName, @pcId, @last_lat, @last_lng, @first_seen, @last_seen, @metadata)
    ON CONFLICT(pcName) DO UPDATE SET
      pcId = excluded.pcId,
      last_lat = excluded.last_lat,
      last_lng = excluded.last_lng,
      last_seen = excluded.last_seen,
      metadata = excluded.metadata
  `).run({
    pcName,
    pcId: pcId || (existing ? existing.pcId : ''),
    last_lat: Number.isFinite(coordinates.latitude) ? coordinates.latitude : null,
    last_lng: Number.isFinite(coordinates.longitude) ? coordinates.longitude : null,
    first_seen: existing && existing.first_seen ? existing.first_seen : nowIso,
    last_seen: nowIso,
    metadata: jsonStringify(nextMetadata)
  });
}

function upsertCurrentStatus(status, payload) {
  const passengers = status.passengers || {};
  const currentStopId = status.current_stop ? status.current_stop.stop_id : null;
  const nearestStopId = status.nearest_stop ? status.nearest_stop.stop_id : null;
  const distance = status.nearest_stop && Number.isFinite(status.nearest_stop.distance_meters)
    ? status.nearest_stop.distance_meters
    : null;

  db.prepare(`
    INSERT INTO current_status(
      pcName, line_id, current_stop_id, nearest_stop_id, punctuality_status,
      delay_seconds, geo_distance, passengers_in, passengers_out, passengers_onboard,
      camera_quality_json, updated_at, status, pcId, day_type, timestamp, received_at,
      latitude, longitude, payload_json, status_json
    )
    VALUES(
      @pcName, @line_id, @current_stop_id, @nearest_stop_id, @punctuality_status,
      @delay_seconds, @geo_distance, @passengers_in, @passengers_out, @passengers_onboard,
      @camera_quality_json, @updated_at, @status, @pcId, @day_type, @timestamp, @received_at,
      @latitude, @longitude, @payload_json, @status_json
    )
    ON CONFLICT(pcName) DO UPDATE SET
      line_id = excluded.line_id,
      current_stop_id = excluded.current_stop_id,
      nearest_stop_id = excluded.nearest_stop_id,
      punctuality_status = excluded.punctuality_status,
      delay_seconds = excluded.delay_seconds,
      geo_distance = excluded.geo_distance,
      passengers_in = excluded.passengers_in,
      passengers_out = excluded.passengers_out,
      passengers_onboard = excluded.passengers_onboard,
      camera_quality_json = excluded.camera_quality_json,
      updated_at = excluded.updated_at,
      status = excluded.status,
      pcId = excluded.pcId,
      day_type = excluded.day_type,
      timestamp = excluded.timestamp,
      received_at = excluded.received_at,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      payload_json = excluded.payload_json,
      status_json = excluded.status_json
  `).run({
    pcName: status.pcName,
    line_id: status.line_id || null,
    current_stop_id: currentStopId,
    nearest_stop_id: nearestStopId,
    punctuality_status: status.punctuality_status || null,
    delay_seconds: Number.isFinite(status.delay_seconds) ? status.delay_seconds : null,
    geo_distance: distance,
    passengers_in: Number(passengers.selected_in || 0),
    passengers_out: Number(passengers.selected_out || 0),
    passengers_onboard: passengers.onboard === null || passengers.onboard === undefined ? null : Number(passengers.onboard),
    camera_quality_json: jsonStringify(status.data_quality || null),
    updated_at: status.updated_at,
    status: status.status || null,
    pcId: status.pcId || '',
    day_type: status.day_type || null,
    timestamp: status.timestamp || null,
    received_at: status.received_at || null,
    latitude: Number.isFinite(status.latitude) ? status.latitude : null,
    longitude: Number.isFinite(status.longitude) ? status.longitude : null,
    payload_json: jsonStringify(payload),
    status_json: jsonStringify(status)
  });
}

function appendTripEventIfNeeded(status, schedule, date, appendTripEvent) {
  if (!appendTripEvent) return;

  const stop = status.current_stop || status.nearest_stop || status.time_reference_stop;
  const passengers = status.passengers || {};
  const quality = status.data_quality || {};
  const passengerEvents = Number(passengers.passenger_events || 0);

  const metadata = {
    trip_event_id: crypto.randomUUID(),
    stop_name: stop ? stop.name : null,
    stop_number: stop ? stop.number : null,
    admin_zone: stop ? (stop.admin_zone || stop.zone || null) : null,
    zone_type: stop ? stop.zone_type : null,
    data_quality: quality,
    passengers,
    raw_frame_id: status.raw_frame_id || null
  };

  db.prepare(`
    INSERT INTO trips(
      pcName, line_id, stop_id, timestamp, day_type, passengers_in, passengers_out,
      passengers_onboard, delay_seconds, punctuality_status, camera_error_detected,
      distance_to_stop, is_at_stop, pcId, line_number, brigade, schedule_id, trip_id,
      received_at, analyzed_at, latitude, longitude, planned_time, delay_abs_seconds,
      passenger_events, camera_count, selected_area_avg, selected_area_count, metadata
    )
    VALUES(
      @pcName, @line_id, @stop_id, @timestamp, @day_type, @passengers_in, @passengers_out,
      @passengers_onboard, @delay_seconds, @punctuality_status, @camera_error_detected,
      @distance_to_stop, @is_at_stop, @pcId, @line_number, @brigade, @schedule_id, @trip_id,
      @received_at, @analyzed_at, @latitude, @longitude, @planned_time, @delay_abs_seconds,
      @passenger_events, @camera_count, @selected_area_avg, @selected_area_count, @metadata
    )
  `).run({
    pcName: status.pcName,
    line_id: schedule ? schedule.line_id : null,
    stop_id: stop ? stop.stop_id : null,
    timestamp: status.timestamp,
    day_type: status.day_type,
    passengers_in: Number(passengers.selected_in || 0),
    passengers_out: Number(passengers.selected_out || 0),
    passengers_onboard: passengers.onboard === null || passengers.onboard === undefined ? null : Number(passengers.onboard),
    delay_seconds: Number.isFinite(status.delay_seconds) ? status.delay_seconds : null,
    punctuality_status: status.punctuality_status || null,
    camera_error_detected: quality.complete === false ? 1 : 0,
    distance_to_stop: stop && Number.isFinite(stop.distance_meters) ? stop.distance_meters : null,
    is_at_stop: status.current_stop ? 1 : 0,
    pcId: status.pcId || '',
    line_number: schedule ? schedule.line_number : null,
    brigade: schedule ? schedule.brigade : null,
    schedule_id: schedule ? schedule.schedule_id : null,
    trip_id: buildTripId(schedule, status.pcName, date),
    received_at: status.received_at,
    analyzed_at: status.updated_at,
    latitude: Number.isFinite(status.latitude) ? status.latitude : null,
    longitude: Number.isFinite(status.longitude) ? status.longitude : null,
    planned_time: stop ? stop.planned_time : null,
    delay_abs_seconds: Number.isFinite(status.delay_abs_seconds) ? status.delay_abs_seconds : null,
    passenger_events: passengerEvents,
    camera_count: passengers.objectflow_apps === null || passengers.objectflow_apps === undefined ? null : Number(passengers.objectflow_apps),
    selected_area_avg: passengers.selected_area_avg,
    selected_area_count: passengers.selected_area_count,
    metadata: jsonStringify(metadata)
  });
}

function analyzeVehiclePayload(payload, metadata, appendTripEvent) {
  const now = metadata.analysisDate || new Date();
  const nowIso = now.toISOString();
  const pcName = requiredString(payload.pcName, 'pcName');
  const pcId = optionalString(payload.pcId, '');
  const timestamp = optionalString(payload.timestamp, nowIso);
  const coordinates = extractCoordinates(payload);
  const stats = extractPassengerStats(payload);
  const dayType = determineDayType(now);
  const schedule = findActiveScheduleForVehicle(pcName, pcId, dayType);
  const currentSeconds = secondsSinceMidnight(now);

  upsertVehicle(pcName, pcId, coordinates, timestamp, nowIso, payload, metadata, Boolean(schedule));

  const baseStatus = {
    pcName,
    pcId,
    timestamp,
    received_at: metadata.receivedAt || nowIso,
    updated_at: nowIso,
    raw_frame_id: metadata.rawFrameId || null,
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
      time_reference_stop: null,
      is_on_stop: false,
      data_quality: quality
    };

    upsertCurrentStatus(status, payload);
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
      time_reference_stop: null,
      is_on_stop: false,
      data_quality: quality
    };

    upsertCurrentStatus(status, payload);
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
      time_reference_stop: null,
      is_on_stop: false,
      data_quality: quality
    };

    upsertCurrentStatus(status, payload);
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

  upsertCurrentStatus(status, payload);
  appendTripEventIfNeeded(status, schedule, now, appendTripEvent);

  return status;
}

// --------------------- LOGOWANIE ---------------------
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
  console.log(`║  Czas nadania:   ${String(timestamp || 'BRAK').padEnd(40)}║`);
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

function analyzeAllCurrentVehicles() {
  if (!databaseReady) return;

  const rows = db.prepare(`
    SELECT pcName, pcId, metadata
    FROM vehicles
    WHERE metadata IS NOT NULL
      AND last_seen IS NOT NULL
    ORDER BY last_seen DESC
  `).all();

  if (rows.length === 0) return;

  const analysisDate = new Date();

  const tx = db.transaction(() => {
    for (const row of rows) {
      try {
        const metadataJson = jsonParse(row.metadata, {});
        const payload = metadataJson.last_payload;

        if (!payload || typeof payload !== 'object') continue;

        const status = analyzeVehiclePayload(payload, {
          ...(metadataJson.last_payload_metadata || {}),
          analysisDate,
          receivedAt: metadataJson.last_payload_metadata
            ? metadataJson.last_payload_metadata.receivedAt
            : analysisDate.toISOString()
        }, false);

        logStatusTick(status);
      } catch (err) {
        console.error(`[serverRoom] Błąd analizy cyklicznej dla ${row.pcName}:`, err.message);
      }
    }
  });

  tx();
}

// --------------------- SQL FILTER BUILDER ---------------------
function buildTripsWhere(query, alias = 't') {
  const prefix = alias ? `${alias}.` : '';
  const clauses = [];
  const params = {};

  const pcName = optionalString(query.pcName || query.pc_name, '');
  const lineId = optionalString(query.line_id || query.lineId || query.line, '');
  const dayType = optionalString(query.day_type || query.dayType, '');
  const stopId = optionalString(query.stop_id || query.stopId, '');
  const startDate = optionalString(query.start || query.from || query.date_from || query.dateFrom, '');
  const endDate = optionalString(query.end || query.to || query.date_to || query.dateTo, '');

  if (pcName) {
    clauses.push(`${prefix}pcName = @pcName`);
    params.pcName = pcName;
  }

  if (lineId) {
    clauses.push(`${prefix}line_id = @lineId`);
    params.lineId = lineId;
  }

  if (dayType) {
    clauses.push(`${prefix}day_type = @dayType`);
    params.dayType = dayType;
  }

  if (stopId) {
    clauses.push(`${prefix}stop_id = @stopId`);
    params.stopId = stopId;
  }

  if (startDate) {
    clauses.push(`datetime(COALESCE(${prefix}received_at, ${prefix}timestamp)) >= datetime(@startDate)`);
    params.startDate = startDate;
  }

  if (endDate) {
    clauses.push(`datetime(COALESCE(${prefix}received_at, ${prefix}timestamp)) <= datetime(@endDate)`);
    params.endDate = endDate;
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    andSql: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    params
  };
}

function summarizeDataQualitySql(query) {
  const { whereSql, params } = buildTripsWhere(query, 't');
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_events_count,
      COALESCE(SUM(CASE WHEN camera_error_detected = 1 THEN 1 ELSE 0 END), 0) AS bad_events_count
    FROM trips t
    ${whereSql}
  `).get(params);

  const total = Number(row.total_events_count || 0);
  const bad = Number(row.bad_events_count || 0);

  return {
    complete: bad === 0,
    error: bad === 0 ? null : 'Wadliwość pomiaru: Brak obrazu ze wszystkich kamer',
    bad_events_count: bad,
    total_events_count: total
  };
}

function reportResponse(query, rows) {
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    filters: query,
    data_quality: summarizeDataQualitySql(query),
    rows
  };
}

function weekdayNameSqlExpression(timestampExpression) {
  return `CASE strftime('%w', ${timestampExpression})
    WHEN '0' THEN 'niedziela'
    WHEN '1' THEN 'poniedziałek'
    WHEN '2' THEN 'wtorek'
    WHEN '3' THEN 'środa'
    WHEN '4' THEN 'czwartek'
    WHEN '5' THEN 'piątek'
    WHEN '6' THEN 'sobota'
    ELSE 'unknown'
  END`;
}

function addDistribution(targetRows, keyField, outputField, distributionRows, valueField) {
  const byKey = new Map();

  for (const row of distributionRows) {
    const key = String(row[keyField] || '');
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[String(row.bucket || 'unknown')] = Number(row[valueField] || 0);
  }

  for (const row of targetRows) {
    row[outputField] = byKey.get(String(row[keyField] || '')) || {};
  }
}

// --------------------- KONWERSJA WIERSZY ---------------------
function tripFromRow(row) {
  const metadata = jsonParse(row.metadata, {});

  return {
    id: row.id,
    trip_event_id: metadata.trip_event_id || String(row.id),
    trip_id: row.trip_id,
    pcName: row.pcName,
    pcId: row.pcId || '',
    line_id: row.line_id,
    line_number: row.line_number || row.line_id,
    brigade: row.brigade || '',
    schedule_id: row.schedule_id,
    day_type: row.day_type,
    timestamp: row.timestamp,
    received_at: row.received_at,
    analyzed_at: row.analyzed_at,
    latitude: row.latitude,
    longitude: row.longitude,
    stop_id: row.stop_id,
    stop_name: metadata.stop_name || '',
    stop_number: metadata.stop_number || '',
    admin_zone: metadata.admin_zone || 'nieokreślona',
    zone_type: metadata.zone_type || 'nieokreślony',
    planned_time: row.planned_time,
    distance_meters: row.distance_to_stop,
    is_on_stop: Boolean(row.is_at_stop),
    punctuality_status: row.punctuality_status,
    delay_seconds: row.delay_seconds,
    delay_abs_seconds: row.delay_abs_seconds,
    passenger_in: row.passengers_in,
    passenger_out: row.passengers_out,
    passenger_events: row.passenger_events,
    onboard: row.passengers_onboard,
    camera_count: row.camera_count,
    selected_area_avg: row.selected_area_avg,
    selected_area_count: row.selected_area_count,
    data_quality: metadata.data_quality || {
      complete: row.camera_error_detected !== 1,
      error: row.camera_error_detected === 1 ? 'Wadliwość pomiaru: Brak obrazu ze wszystkich kamer' : null
    }
  };
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
  const minimalFrame = buildMinimalVehicleFrame(normalizedPcName, payload, receivedAtDate);

  const processIncomingTx = db.transaction(() => {
    const raw = db.prepare(`
      INSERT INTO raw_frames(pcName, pcId, timestamp, latitude, longitude, received_at)
      VALUES(@pcName, @pcId, @timestamp, @latitude, @longitude, @received_at)
    `).run({
      pcName: normalizedPcName,
      pcId: optionalString(pcId, ''),
      timestamp: minimalFrame.timestamp,
      latitude: minimalFrame.latitude,
      longitude: minimalFrame.longitude,
      received_at: receivedAt
    });

    const metadata = {
      receivedAt,
      remoteAddress: req.socket.remoteAddress,
      rawFrameId: raw.lastInsertRowid,
      analysisDate: receivedAtDate
    };

    const status = analyzeVehiclePayload(payload, metadata, true);
    pruneHistory();

    return {
      rawFrameId: raw.lastInsertRowid,
      status
    };
  });

  const result = processIncomingTx();

  logReceivedDataConsole(payload, result.status);

  sendJson(res, 200, {
    ok: true,
    message: 'Data received',
    receivedAt,
    savedRawFrame: `sqlite:raw_frames:${result.rawFrameId}`,
    savedFrame: minimalFrame,
    currentStatus: result.status
  });
}

async function handleCreateStop(req, res) {
  const body = await readJsonBody(req);
  const stop = normalizeStop(body);

  db.prepare(`
    INSERT INTO stops(id, name, latitude, longitude, zone, metadata)
    VALUES(@id, @name, @latitude, @longitude, @zone, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      zone = excluded.zone,
      metadata = excluded.metadata
  `).run({
    ...stop,
    metadata: jsonStringify(stop.metadata)
  });

  sendJson(res, 201, {
    ok: true,
    message: 'Stop created',
    stop: stopFromRow(db.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id))
  });
}

async function handleGetStops(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(query.id || query.stop_id, '');
  const zone = optionalString(query.zone || query.admin_zone || query.adminZone, '');
  const q = optionalString(query.q || query.search || query.name, '');

  if (id) {
    clauses.push('id = @id');
    params.id = id;
  }

  if (zone) {
    clauses.push('(zone = @zone OR metadata LIKE @zoneLike)');
    params.zone = zone;
    params.zoneLike = `%"admin_zone":"${zone.replace(/"/g, '\\"')}"%`;
  }

  if (q) {
    clauses.push('(name LIKE @q OR id LIKE @q)');
    params.q = `%${q}%`;
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM stops ${whereSql} ORDER BY name COLLATE NOCASE, id`).all(params);
  const stops = rows.map(stopFromRow);

  sendJson(res, 200, {
    ok: true,
    count: stops.length,
    stops
  });
}

async function handleGetStopById(req, res, stopId) {
  const stop = findStopById(stopId);
  if (!stop) throw new Error(`Nie znaleziono przystanku o id: ${stopId}`);

  sendJson(res, 200, { ok: true, stop });
}

async function handleUpdateStop(req, res, stopId) {
  const existing = findStopById(stopId);
  if (!existing) throw new Error(`Nie znaleziono przystanku o id: ${stopId}`);

  const body = await readJsonBody(req);
  const updatedStop = normalizeStop({ ...body, id: stopId, stop_id: stopId });
  updatedStop.metadata.created_at = existing.created_at || updatedStop.metadata.created_at;
  updatedStop.metadata.updated_at = new Date().toISOString();

  db.prepare(`
    UPDATE stops
    SET name = @name,
        latitude = @latitude,
        longitude = @longitude,
        zone = @zone,
        metadata = @metadata
    WHERE id = @id
  `).run({
    ...updatedStop,
    metadata: jsonStringify(updatedStop.metadata)
  });

  sendJson(res, 200, {
    ok: true,
    message: 'Stop updated',
    stop: findStopById(stopId)
  });
}

async function handleDeleteStop(req, res, stopId) {
  const info = db.prepare('DELETE FROM stops WHERE id = ?').run(stopId);
  if (info.changes === 0) throw new Error(`Nie znaleziono przystanku o id: ${stopId}`);

  sendJson(res, 200, { ok: true, message: 'Stop deleted', deletedCount: info.changes });
}

function saveSchedule(schedule) {
  const insert = db.prepare(`
    INSERT INTO schedules(id, line_id, route_name, day_type, sequence_json, metadata, pcName, pcId, active, updated_at)
    VALUES(@id, @line_id, @route_name, @day_type, @sequence_json, @metadata, @pcName, @pcId, @active, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      line_id = excluded.line_id,
      route_name = excluded.route_name,
      day_type = excluded.day_type,
      sequence_json = excluded.sequence_json,
      metadata = excluded.metadata,
      pcName = excluded.pcName,
      pcId = excluded.pcId,
      active = excluded.active,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM schedules WHERE id = ? OR id LIKE ?').run(schedule.schedule_id, `${schedule.schedule_id}:%`);

    for (const dayType of DAY_TYPES) {
      const meta = {
        ...schedule.metadata,
        day_type: dayType
      };

      insert.run({
        id: `${schedule.schedule_id}:${dayType}`,
        line_id: schedule.line_id,
        route_name: schedule.route_name,
        day_type: dayType,
        sequence_json: jsonStringify(schedule.day_types[dayType].stops_sequence),
        metadata: jsonStringify(meta),
        pcName: schedule.pcName,
        pcId: schedule.pcId,
        active: schedule.metadata.active ? 1 : 0,
        updated_at: schedule.metadata.updated_at
      });
    }

    const existingVehicle = db.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(schedule.pcName);
    const existingMetadata = existingVehicle ? jsonParse(existingVehicle.metadata, {}) : {};

    db.prepare(`
      INSERT INTO vehicles(pcName, pcId, last_lat, last_lng, first_seen, last_seen, metadata)
      VALUES(@pcName, @pcId, @last_lat, @last_lng, @first_seen, @last_seen, @metadata)
      ON CONFLICT(pcName) DO UPDATE SET
        pcId = CASE WHEN excluded.pcId <> '' THEN excluded.pcId ELSE vehicles.pcId END,
        metadata = excluded.metadata
    `).run({
      pcName: schedule.pcName,
      pcId: schedule.pcId || '',
      last_lat: existingVehicle ? existingVehicle.last_lat : null,
      last_lng: existingVehicle ? existingVehicle.last_lng : null,
      first_seen: existingVehicle ? existingVehicle.first_seen : null,
      last_seen: existingVehicle ? existingVehicle.last_seen : null,
      metadata: jsonStringify({
        ...existingMetadata,
        has_schedule: true,
        schedule_id: schedule.schedule_id,
        line_id: schedule.line_id,
        line_number: schedule.metadata.line_number,
        brigade: schedule.metadata.brigade,
        updated_at: schedule.metadata.updated_at
      })
    });
  });

  tx();
}

async function handleCreateSchedule(req, res) {
  const body = await readJsonBody(req);
  const normalized = normalizeSchedulePayload(body);

  if (body.replace_existing !== false) {
    const existingRows = db.prepare(`
      SELECT id
      FROM schedules
      WHERE line_id = @lineId
        AND pcName = @pcName
    `).all({ lineId: normalized.line_id, pcName: normalized.pcName });

    for (const row of existingRows) {
      const baseId = String(row.id).split(':')[0];
      if (baseId !== normalized.schedule_id) {
        db.prepare('DELETE FROM schedules WHERE id = ? OR id LIKE ?').run(baseId, `${baseId}:%`);
      }
    }
  }

  saveSchedule(normalized);

  sendJson(res, 201, {
    ok: true,
    message: 'Schedule saved',
    schedule: scheduleFromRows(findScheduleRowsByBaseId(normalized.schedule_id))
  });
}

async function handleGetSchedules(req, res, query) {
  const clauses = [];
  const params = {};

  const pcName = optionalString(query.pcName || query.pc_name, '');
  const lineId = optionalString(query.line_id || query.lineId || query.line, '');
  const dayType = optionalString(query.day_type || query.dayType, '');
  const active = optionalString(query.active, '');

  if (pcName) {
    clauses.push('pcName = @pcName');
    params.pcName = pcName;
  }

  if (lineId) {
    clauses.push('line_id = @lineId');
    params.lineId = lineId;
  }

  if (dayType) {
    clauses.push('day_type = @dayType');
    params.dayType = dayType;
  }

  if (active === 'true' || active === '1') {
    clauses.push('active = 1');
  } else if (active === 'false' || active === '0') {
    clauses.push('active = 0');
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT *
    FROM schedules
    ${whereSql}
    ORDER BY updated_at DESC, id
  `).all(params);

  const grouped = new Map();
  for (const row of rows) {
    const baseId = jsonParse(row.metadata, {}).schedule_id || String(row.id).split(':')[0];
    if (!grouped.has(baseId)) grouped.set(baseId, []);
    grouped.get(baseId).push(row);
  }

  const schedules = [];
  for (const groupRows of grouped.values()) {
    schedules.push(scheduleFromRows(groupRows));
  }

  sendJson(res, 200, {
    ok: true,
    count: schedules.length,
    schedules
  });
}

async function handleGetScheduleById(req, res, scheduleId) {
  const schedule = scheduleFromRows(findScheduleRowsByBaseId(scheduleId));
  if (!schedule) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);

  sendJson(res, 200, { ok: true, schedule });
}

async function handleUpdateSchedule(req, res, scheduleId) {
  const existing = scheduleFromRows(findScheduleRowsByBaseId(scheduleId));
  if (!existing) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);

  const body = await readJsonBody(req);
  const updatedSchedule = normalizeSchedulePayload({
    ...body,
    schedule_id: scheduleId,
    id: scheduleId,
    created_at: existing.created_at || body.created_at
  }, scheduleId);

  saveSchedule(updatedSchedule);

  sendJson(res, 200, {
    ok: true,
    message: 'Schedule updated',
    schedule: scheduleFromRows(findScheduleRowsByBaseId(scheduleId))
  });
}

async function handleDeleteSchedule(req, res, scheduleId) {
  const info = db.prepare('DELETE FROM schedules WHERE id = ? OR id LIKE ?').run(scheduleId, `${scheduleId}:%`);
  if (info.changes === 0) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);

  sendJson(res, 200, { ok: true, message: 'Schedule deleted', deletedCount: info.changes });
}

async function handleCreateHoliday(req, res) {
  const body = await readJsonBody(req);
  const date = requiredString(body.date, 'date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Pole date musi mieć format YYYY-MM-DD');
  }

  const description = optionalString(firstDefined(body.description, body.name), 'święto');

  db.prepare(`
    INSERT INTO holidays(date, description)
    VALUES(?, ?)
    ON CONFLICT(date) DO UPDATE SET description = excluded.description
  `).run(date, description);

  sendJson(res, 201, {
    ok: true,
    holiday: { date, description }
  });
}

async function handleGetHolidays(req, res) {
  const rows = db.prepare('SELECT date, description FROM holidays ORDER BY date').all();

  sendJson(res, 200, {
    ok: true,
    holidays: rows
  });
}

async function handleDeleteHoliday(req, res, date) {
  const info = db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
  if (info.changes === 0) throw new Error(`Nie znaleziono święta o dacie: ${date}`);

  sendJson(res, 200, { ok: true, message: 'Holiday deleted', deletedCount: info.changes });
}

async function handleGetTrips(req, res, query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(query.limit, 10) || 100));
  const offset = (page - 1) * limit;
  const { whereSql, params } = buildTripsWhere(query, 't');

  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM trips t ${whereSql}`).get(params);
  const rows = db.prepare(`
    SELECT *
    FROM trips t
    ${whereSql}
    ORDER BY COALESCE(t.received_at, t.timestamp) DESC, t.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const resultRows = rows.map(tripFromRow);
  const total = Number(totalRow.total || 0);

  sendJson(res, 200, {
    ok: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    rows: resultRows
  });
}

async function handleDeleteTrips(req, res, query) {
  const all = query.all === 'true';
  const before = query.before;

  if (all) {
    const countRow = db.prepare('SELECT COUNT(*) AS total FROM trips').get();
    db.prepare('DELETE FROM trips').run();

    sendJson(res, 200, {
      ok: true,
      message: `Usunięto wszystkie ${countRow.total} zdarzeń`,
      deletedCount: Number(countRow.total || 0)
    });
    return;
  }

  if (before) {
    const beforeDate = new Date(before);
    if (Number.isNaN(beforeDate.getTime())) {
      throw new Error('Nieprawidłowy format before, oczekiwano YYYY-MM-DD');
    }

    const info = db.prepare(`
      DELETE FROM trips
      WHERE datetime(COALESCE(received_at, timestamp)) < datetime(?)
    `).run(before);

    sendJson(res, 200, {
      ok: true,
      message: `Usunięto ${info.changes} zdarzeń starszych niż ${before}`,
      deletedCount: info.changes
    });
    return;
  }

  throw new Error('Aby usunąć, podaj ?all=true lub ?before=YYYY-MM-DD');
}

async function handleReportsCurrent(req, res, query) {
  const pcName = optionalString(query.pcName || query.pc_name, '');
  const rows = pcName
    ? db.prepare('SELECT * FROM current_status WHERE pcName = ?').all(pcName)
    : db.prepare('SELECT * FROM current_status ORDER BY updated_at DESC').all();

  const statuses = {};

  for (const row of rows) {
    statuses[row.pcName] = jsonParse(row.status_json, {
      pcName: row.pcName,
      pcId: row.pcId,
      status: row.status,
      line_id: row.line_id,
      current_stop_id: row.current_stop_id,
      nearest_stop_id: row.nearest_stop_id,
      punctuality_status: row.punctuality_status,
      delay_seconds: row.delay_seconds,
      latitude: row.latitude,
      longitude: row.longitude,
      passengers: {
        selected_in: row.passengers_in,
        selected_out: row.passengers_out,
        onboard: row.passengers_onboard
      },
      data_quality: jsonParse(row.camera_quality_json, null),
      updated_at: row.updated_at
    });
  }

  sendJson(res, 200, {
    ok: true,
    generated_at: new Date().toISOString(),
    current_status: statuses
  });
}

async function handleStopUsageReport(req, res, query) {
  const { whereSql, params } = buildTripsWhere(query, 't');

  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(passenger_events), 0) AS total_passenger_events
    FROM trips t
    ${whereSql}
  `).get(params);

  const totalPassengerEvents = Number(totalRow.total_passenger_events || 0);

  const rows = db.prepare(`
    SELECT
      t.stop_id,
      COALESCE(s.name, json_extract(t.metadata, '$.stop_name'), '') AS name,
      COALESCE(json_extract(s.metadata, '$.number'), json_extract(t.metadata, '$.stop_number'), '') AS number,
      COALESCE(s.zone, json_extract(s.metadata, '$.admin_zone'), json_extract(t.metadata, '$.admin_zone'), 'nieokreślona') AS admin_zone,
      COALESCE(json_extract(s.metadata, '$.zone_type'), json_extract(t.metadata, '$.zone_type'), 'nieokreślony') AS zone_type,
      COALESCE(SUM(t.passengers_in), 0) AS total_boardings,
      COALESCE(SUM(t.passengers_out), 0) AS total_alightings,
      COALESCE(SUM(t.passenger_events), 0) AS total_passenger_events,
      COUNT(*) AS event_count,
      COUNT(DISTINCT t.trip_id) AS course_count
    FROM trips t
    LEFT JOIN stops s ON s.id = t.stop_id
    ${whereSql}
      ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
    GROUP BY t.stop_id
    ORDER BY total_passenger_events DESC
  `).all(params);

  const reportRows = rows.map(row => ({
    stop_id: row.stop_id,
    name: row.name,
    number: row.number,
    admin_zone: row.admin_zone,
    zone_type: row.zone_type,
    total_boardings: Number(row.total_boardings || 0),
    total_alightings: Number(row.total_alightings || 0),
    total_passenger_events: Number(row.total_passenger_events || 0),
    share_of_all_passengers_percent: totalPassengerEvents > 0
      ? Number(((Number(row.total_passenger_events || 0) / totalPassengerEvents) * 100).toFixed(2))
      : 0,
    event_count: Number(row.event_count || 0),
    course_count: Number(row.course_count || 0),
    by_hour: {},
    by_weekday: {},
    by_day_type: {}
  }));

  const hourRows = db.prepare(`
    SELECT
      t.stop_id,
      strftime('%H', COALESCE(t.received_at, t.timestamp)) AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
      ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
    GROUP BY t.stop_id, bucket
  `).all(params);

  const weekdayRows = db.prepare(`
    SELECT
      t.stop_id,
      ${weekdayNameSqlExpression('COALESCE(t.received_at, t.timestamp)')} AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
      ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
    GROUP BY t.stop_id, bucket
  `).all(params);

  const dayTypeRows = db.prepare(`
    SELECT
      t.stop_id,
      COALESCE(t.day_type, 'unknown') AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
      ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
    GROUP BY t.stop_id, bucket
  `).all(params);

  addDistribution(reportRows, 'stop_id', 'by_hour', hourRows, 'value');
  addDistribution(reportRows, 'stop_id', 'by_weekday', weekdayRows, 'value');
  addDistribution(reportRows, 'stop_id', 'by_day_type', dayTypeRows, 'value');

  sendJson(res, 200, reportResponse(query, reportRows));
}

async function handleOnDemandStopsReport(req, res, query) {
  const { whereSql, params } = buildTripsWhere(query, 't');
  const threshold = Number.isFinite(Number(query.threshold_percent))
    ? Number(query.threshold_percent)
    : 25;
  const showAll = query.all === 'true';

  const havingSql = showAll ? '' : `
        HAVING ROUND((SUM(CASE WHEN cs.passenger_events > 0 THEN 1 ELSE 0 END) * 100.0) / NULLIF(COUNT(*), 0), 2) < @threshold
      `;

  const rows = db.prepare(`
    WITH course_stop AS (
      SELECT
        t.stop_id,
        COALESCE(t.trip_id, CAST(t.id AS TEXT)) AS course_id,
        COALESCE(SUM(t.passenger_events), 0) AS passenger_events
      FROM trips t
      ${whereSql}
        ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
      GROUP BY t.stop_id, course_id
    ),
    stop_stats AS (
      SELECT
        cs.stop_id,
        COUNT(*) AS courses_total,
        SUM(CASE WHEN cs.passenger_events > 0 THEN 1 ELSE 0 END) AS courses_with_passengers,
        ROUND((SUM(CASE WHEN cs.passenger_events > 0 THEN 1 ELSE 0 END) * 100.0) / NULLIF(COUNT(*), 0), 2) AS percent_courses_with_passengers
      FROM course_stop cs
      GROUP BY cs.stop_id
      ${havingSql}
    )
    SELECT
      ss.stop_id,
      COALESCE(s.name, '') AS name,
      COALESCE(json_extract(s.metadata, '$.number'), '') AS number,
      COALESCE(s.zone, json_extract(s.metadata, '$.admin_zone'), 'nieokreślona') AS admin_zone,
      ss.courses_total,
      ss.courses_with_passengers,
      COALESCE(ss.percent_courses_with_passengers, 0) AS percent_courses_with_passengers
    FROM stop_stats ss
    LEFT JOIN stops s ON s.id = ss.stop_id
    ORDER BY percent_courses_with_passengers ASC, courses_total DESC
  `).all({ ...params, threshold });

  const reportRows = rows.map(row => ({
    stop_id: row.stop_id,
    name: row.name,
    number: row.number,
    admin_zone: row.admin_zone,
    courses_total: Number(row.courses_total || 0),
    courses_with_passengers: Number(row.courses_with_passengers || 0),
    percent_courses_with_passengers: Number(row.percent_courses_with_passengers || 0),
    threshold_percent: threshold,
    suggested_status: Number(row.percent_courses_with_passengers || 0) < threshold
      ? 'kandydat na przystanek na żądanie'
      : 'regularny'
  }));

  sendJson(res, 200, reportResponse(query, reportRows));
}

async function handleLinePerformanceReport(req, res, query) {
  const { whereSql, params } = buildTripsWhere(query, 't');

  const rows = db.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') AS group_line_id,
      t.line_id,
      t.line_number,
      COALESCE(t.pcName, 'brak_pc') AS pcName,
      COALESCE(SUM(t.passengers_in), 0) AS total_boardings,
      COALESCE(SUM(t.passengers_out), 0) AS total_alightings,
      COALESCE(SUM(t.passenger_events), 0) AS total_passenger_events,
      COUNT(*) AS event_count,
      COUNT(DISTINCT t.trip_id) AS course_count,
      ROUND(AVG(t.delay_seconds), 2) AS average_delay_seconds,
      ROUND(AVG(ABS(t.delay_seconds)), 2) AS average_absolute_delay_seconds,
      ROUND(SUM(CASE WHEN t.punctuality_status = 'o czasie' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN t.delay_seconds IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS on_time_percent,
      ROUND(SUM(CASE WHEN t.punctuality_status = 'opóźniony' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN t.delay_seconds IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS delayed_percent,
      ROUND(SUM(CASE WHEN t.punctuality_status = 'za szybko' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN t.delay_seconds IS NOT NULL THEN 1 ELSE 0 END), 0), 2) AS early_percent
    FROM trips t
    ${whereSql}
    GROUP BY group_line_id, t.pcName
    ORDER BY total_passenger_events DESC
  `).all(params);

  const reportRows = rows.map(row => ({
    line_id: row.line_id,
    line_number: row.line_number || row.line_id,
    pcName: row.pcName === 'brak_pc' ? null : row.pcName,
    total_boardings: Number(row.total_boardings || 0),
    total_alightings: Number(row.total_alightings || 0),
    total_passenger_events: Number(row.total_passenger_events || 0),
    event_count: Number(row.event_count || 0),
    course_count: Number(row.course_count || 0),
    average_delay_seconds: row.average_delay_seconds === null ? null : Number(row.average_delay_seconds),
    average_absolute_delay_seconds: row.average_absolute_delay_seconds === null ? null : Number(row.average_absolute_delay_seconds),
    on_time_percent: row.on_time_percent === null ? null : Number(row.on_time_percent),
    delayed_percent: row.delayed_percent === null ? null : Number(row.delayed_percent),
    early_percent: row.early_percent === null ? null : Number(row.early_percent),
    by_hour: {},
    by_weekday: {},
    by_day_type: {}
  }));

  const hourRows = db.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.pcName, 'brak_pc') AS row_key,
      strftime('%H', COALESCE(t.received_at, t.timestamp)) AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  const weekdayRows = db.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.pcName, 'brak_pc') AS row_key,
      ${weekdayNameSqlExpression('COALESCE(t.received_at, t.timestamp)')} AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  const dayRows = db.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.pcName, 'brak_pc') AS row_key,
      COALESCE(t.day_type, 'unknown') AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  for (const row of reportRows) {
    row.row_key = `${row.line_id || 'brak_linii'}||${row.pcName || 'brak_pc'}`;
  }

  addDistribution(reportRows, 'row_key', 'by_hour', hourRows, 'value');
  addDistribution(reportRows, 'row_key', 'by_weekday', weekdayRows, 'value');
  addDistribution(reportRows, 'row_key', 'by_day_type', dayRows, 'value');

  for (const row of reportRows) delete row.row_key;

  sendJson(res, 200, reportResponse(query, reportRows));
}

async function handleAdminZoneReport(req, res, query) {
  const { whereSql, params } = buildTripsWhere(query, 't');

  const rows = db.prepare(`
    WITH trip_agg AS (
      SELECT
        t.line_id,
        t.line_number,
        t.day_type,
        COALESCE(s.zone, json_extract(s.metadata, '$.admin_zone'), json_extract(t.metadata, '$.admin_zone'), 'nieokreślona') AS admin_zone,
        COALESCE(SUM(t.passengers_in), 0) AS total_boardings,
        COALESCE(SUM(t.passengers_out), 0) AS total_alightings,
        COALESCE(SUM(t.passenger_events), 0) AS total_passenger_events,
        COUNT(*) AS event_count,
        COUNT(DISTINCT t.stop_id) AS stop_count,
        COUNT(DISTINCT t.trip_id) AS course_count
      FROM trips t
      LEFT JOIN stops s ON s.id = t.stop_id
      ${whereSql}
      GROUP BY t.line_id, t.day_type, admin_zone
    ),
    route_km AS (
      SELECT
        s.line_id,
        s.day_type,
        COALESCE(json_extract(a.value, '$.admin_zone'), json_extract(a.value, '$.zone'), 'nieokreślona') AS admin_zone,
        SUM(haversine_meters(
          json_extract(a.value, '$.latitude'),
          json_extract(a.value, '$.longitude'),
          json_extract(b.value, '$.latitude'),
          json_extract(b.value, '$.longitude')
        )) / 1000.0 AS estimated_route_km
      FROM schedules s
      JOIN json_each(s.sequence_json) a
      JOIN json_each(s.sequence_json) b ON CAST(b.key AS INTEGER) = CAST(a.key AS INTEGER) + 1
      WHERE s.active = 1
      GROUP BY s.line_id, s.day_type, admin_zone
    )
    SELECT
      ta.*,
      ROUND(rk.estimated_route_km, 3) AS estimated_route_km,
      CASE
        WHEN rk.estimated_route_km IS NOT NULL AND rk.estimated_route_km > 0
        THEN ROUND(ta.total_passenger_events / rk.estimated_route_km, 2)
        ELSE NULL
      END AS passengers_per_km
    FROM trip_agg ta
    LEFT JOIN route_km rk
      ON rk.line_id = ta.line_id
      AND rk.day_type = ta.day_type
      AND rk.admin_zone = ta.admin_zone
    ORDER BY ta.total_passenger_events DESC
  `).all(params);

  const reportRows = rows.map(row => ({
    line_id: row.line_id,
    line_number: row.line_number || row.line_id,
    day_type: row.day_type || 'unknown',
    admin_zone: row.admin_zone,
    total_boardings: Number(row.total_boardings || 0),
    total_alightings: Number(row.total_alightings || 0),
    total_passenger_events: Number(row.total_passenger_events || 0),
    event_count: Number(row.event_count || 0),
    stop_count: Number(row.stop_count || 0),
    course_count: Number(row.course_count || 0),
    estimated_route_km: row.estimated_route_km === null ? null : Number(row.estimated_route_km),
    passengers_per_km: row.passengers_per_km === null ? null : Number(row.passengers_per_km),
    by_hour: {},
    by_weekday: {}
  }));

  for (const row of reportRows) {
    row.row_key = `${row.line_id || 'brak_linii'}||${row.day_type || 'unknown'}||${row.admin_zone || 'nieokreślona'}`;
  }

  const hourRows = db.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.day_type, 'unknown') || '||' ||
        COALESCE(s.zone, json_extract(s.metadata, '$.admin_zone'), json_extract(t.metadata, '$.admin_zone'), 'nieokreślona') AS row_key,
      strftime('%H', COALESCE(t.received_at, t.timestamp)) AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    LEFT JOIN stops s ON s.id = t.stop_id
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  const weekdayRows = db.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.day_type, 'unknown') || '||' ||
        COALESCE(s.zone, json_extract(s.metadata, '$.admin_zone'), json_extract(t.metadata, '$.admin_zone'), 'nieokreślona') AS row_key,
      ${weekdayNameSqlExpression('COALESCE(t.received_at, t.timestamp)')} AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    LEFT JOIN stops s ON s.id = t.stop_id
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  addDistribution(reportRows, 'row_key', 'by_hour', hourRows, 'value');
  addDistribution(reportRows, 'row_key', 'by_weekday', weekdayRows, 'value');

  for (const row of reportRows) delete row.row_key;

  sendJson(res, 200, reportResponse(query, reportRows));
}

async function handleVehicles(req, res) {
  const rows = db.prepare(`
    SELECT
      v.*,
      cs.line_id AS status_line_id,
      cs.status AS status,
      cs.punctuality_status AS punctuality_status,
      cs.updated_at AS status_updated_at
    FROM vehicles v
    LEFT JOIN current_status cs ON cs.pcName = v.pcName
    ORDER BY v.pcName COLLATE NOCASE
  `).all();

  const vehicles = [];

  for (const row of rows) {
    const metadata = jsonParse(row.metadata, {});

    vehicles.push({
      pcName: row.pcName,
      pcId: row.pcId || '',
      first_seen_at: row.first_seen,
      last_seen_at: row.last_seen,
      last_latitude: row.last_lat,
      last_longitude: row.last_lng,
      has_schedule: Boolean(metadata.has_schedule),
      schedule_id: metadata.schedule_id || null,
      line_id: metadata.line_id || row.status_line_id || null,
      line_number: metadata.line_number || null,
      brigade: metadata.brigade || '',
      status: row.status || null,
      punctuality_status: row.punctuality_status || null,
      status_updated_at: row.status_updated_at || null
    });
  }

  sendJson(res, 200, {
    ok: true,
    count: vehicles.length,
    vehicles
  });
}

async function handleSettings(req, res) {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  const settings = {};

  for (const row of rows) {
    settings[row.key] = row.value;
  }

  sendJson(res, 200, { ok: true, settings });
}

async function handleRoot(req, res) {
  sendJson(res, 200, {
    ok: true,
    name: 'Isarsoft Room Server SQLite',
    database: {
      file: DB_FILE,
      engine: 'SQLite',
      driver: 'better-sqlite3'
    },
    endpoints: {
      apiIp: 'GET /api/ip',
      dataSink: 'POST /api/data',
      createStop: 'POST /stops',
      listStops: 'GET /stops',
      getStop: 'GET /stops/:id',
      updateStop: 'PUT /stops/:id',
      deleteStop: 'DELETE /stops/:id',
      createSchedule: 'POST /schedules',
      listSchedules: 'GET /schedules',
      getSchedule: 'GET /schedules/:id',
      updateSchedule: 'PUT /schedules/:id',
      deleteSchedule: 'DELETE /schedules/:id',
      createHoliday: 'POST /holidays',
      listHolidays: 'GET /holidays',
      deleteHoliday: 'DELETE /holidays/:date',
      getTrips: 'GET /trips?page=1&limit=100&pcName=...&line_id=...&stop_id=...&start=...&end=...',
      deleteTrips: 'DELETE /trips?all=true lub ?before=YYYY-MM-DD',
      vehicles: 'GET /vehicles',
      settings: 'GET /settings',
      currentTrip: 'GET /reports/trip/current',
      stopUsage: 'GET /reports/stop-usage',
      onDemandStops: 'GET /reports/on-demand-stops',
      linePerformance: 'GET /reports/line-performance',
      adminZone: 'GET /reports/admin-zone'
    }
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
    if (req.method === 'GET' && pathname === '/') return await handleRoot(req, res);
    if (req.method === 'GET' && pathname === '/api/ip') return await handleApiIp(req, res);
    if (req.method === 'POST' && pathname === '/api/data') return await handleIncomingData(req, res);

    if (pathname.startsWith('/stops/') && pathname !== '/stops') {
      const stopId = decodeURIComponent(pathname.substring('/stops/'.length));
      if (!stopId) throw new Error('Brak ID przystanku');
      if (req.method === 'GET') return await handleGetStopById(req, res, stopId);
      if (req.method === 'PUT') return await handleUpdateStop(req, res, stopId);
      if (req.method === 'DELETE') return await handleDeleteStop(req, res, stopId);
      throw new Error('Metoda nieobsługiwana dla /stops/:id');
    }

    if (pathname.startsWith('/schedules/') && pathname !== '/schedules') {
      const scheduleId = decodeURIComponent(pathname.substring('/schedules/'.length));
      if (!scheduleId) throw new Error('Brak ID rozkładu');
      if (req.method === 'GET') return await handleGetScheduleById(req, res, scheduleId);
      if (req.method === 'PUT') return await handleUpdateSchedule(req, res, scheduleId);
      if (req.method === 'DELETE') return await handleDeleteSchedule(req, res, scheduleId);
      throw new Error('Metoda nieobsługiwana dla /schedules/:id');
    }

    if (pathname.startsWith('/holidays/') && pathname !== '/holidays') {
      const date = decodeURIComponent(pathname.substring('/holidays/'.length));
      if (!date) throw new Error('Brak daty święta');
      if (req.method === 'DELETE') return await handleDeleteHoliday(req, res, date);
      throw new Error('Metoda nieobsługiwana dla /holidays/:date');
    }

    if (pathname === '/trips') {
      if (req.method === 'GET') return await handleGetTrips(req, res, query);
      if (req.method === 'DELETE') return await handleDeleteTrips(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /trips');
    }

    if (req.method === 'POST' && pathname === '/stops') return await handleCreateStop(req, res);
    if (req.method === 'GET' && pathname === '/stops') return await handleGetStops(req, res, query);

    if (req.method === 'POST' && pathname === '/schedules') return await handleCreateSchedule(req, res);
    if (req.method === 'GET' && pathname === '/schedules') return await handleGetSchedules(req, res, query);

    if (req.method === 'POST' && pathname === '/holidays') return await handleCreateHoliday(req, res);
    if (req.method === 'GET' && pathname === '/holidays') return await handleGetHolidays(req, res);

    if (req.method === 'GET' && pathname === '/vehicles') return await handleVehicles(req, res);
    if (req.method === 'GET' && pathname === '/settings') return await handleSettings(req, res);

    if (req.method === 'GET' && pathname === '/reports/trip/current') return await handleReportsCurrent(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/stop-usage') return await handleStopUsageReport(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/on-demand-stops') return await handleOnDemandStopsReport(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/line-performance') return await handleLinePerformanceReport(req, res, query);
    if (req.method === 'GET' && pathname === '/reports/admin-zone') return await handleAdminZoneReport(req, res, query);

    sendJson(res, 404, {
      ok: false,
      error: 'Not found',
      path: pathname
    });
  } catch (err) {
    console.error('[serverRoom] Błąd obsługi żądania:', err.message);

    sendJson(res, 400, {
      ok: false,
      error: err.message
    });
  }
}

// --------------------- URUCHOMIENIE ---------------------
async function startServer() {
  ensureDatabaseReady();

  server = http.createServer((req, res) => {
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

  server.listen(PORT, () => {
    const ips = getLocalIPs();

    console.log('\n' + '═'.repeat(70));
    console.log('║     🚀 SERWER POKOJOWY (Isarsoft Room Server) URUCHOMIONY     ║');
    console.log('═'.repeat(70));
    console.log(`║  Port: ${PORT}`);
    console.log('║  Status: Aktywny ✅');
    console.log(`║  Baza danych SQLite: ${DB_FILE}`);
    console.log(`║  Tryb ramek: SQLite raw_frames, bez plików JSON`);
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
    console.log('║  3. Windows PowerShell:');
    console.log('║     $env:ROOM_SERVER_URL="http://192.168.68.212:3001/api/data"');
    console.log('║  4. Windows CMD:');
    console.log('║     set ROOM_SERVER_URL=http://192.168.68.212:3001/api/data');
    console.log('═'.repeat(70));
    console.log('║  📊 Sink: POST /api/data');
    console.log('║  📊 IP: GET /api/ip');
    console.log('║  📊 Przystanki: POST/GET /stops, GET/PUT/DELETE /stops/:id');
    console.log('║  📊 Rozkłady: POST/GET /schedules, GET/PUT/DELETE /schedules/:id');
    console.log('║  📊 Święta: POST/GET /holidays, DELETE /holidays/:date');
    console.log('║  📊 Zdarzenia: GET /trips, DELETE /trips');
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
        frameStorageMode: 'sqlite_raw_frames'
      },
      availableUrls: ips.map(ip => ({
        interface: ip.interface,
        url: ip.url,
        envVariable: `export ROOM_SERVER_URL="${ip.url}"`
      })),
      endpoints: {
        dataSink: 'POST /api/data',
        apiIp: 'GET /api/ip',
        createStop: 'POST /stops',
        listStops: 'GET /stops',
        createSchedule: 'POST /schedules',
        listSchedules: 'GET /schedules',
        createHoliday: 'POST /holidays',
        listHolidays: 'GET /holidays',
        getTrips: 'GET /trips?page=1&limit=100',
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
    try {
      analyzeAllCurrentVehicles();
    } catch (err) {
      console.error('[serverRoom] Błąd pętli 5s:', err.message);
    }
  }, SYNC_INTERVAL_MS);
}

startServer().catch(err => {
  console.error('[serverRoom] Nie udało się uruchomić serwera:', err);
  process.exit(1);
});

// --------------------- ZAMYKANIE ---------------------
function gracefulShutdown(signal) {
  console.log(`\n[serverRoom] Otrzymano ${signal}. Zamykam serwer...`);

  try {
    if (db) {
      db.close();
      console.log('[serverRoom] Połączenie SQLite zamknięte.');
    }
  } catch (err) {
    console.error('[serverRoom] Błąd zamykania SQLite:', err.message);
  }

  if (!server) {
    process.exit(0);
    return;
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