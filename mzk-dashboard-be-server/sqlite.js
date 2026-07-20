'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Stałe
const PORT = Number(process.env.ROOM_PORT || 3001);
const DB_ROOT = process.env.ROOM_DB_ROOT || path.join(__dirname, 'database');
const DB_FILE = process.env.ROOM_DB_FILE || path.join(DB_ROOT, 'production.db');
const SYNC_INTERVAL_MS = Number(process.env.ROOM_SYNC_INTERVAL_MS || 5000);
const MAX_BODY_BYTES = Number(process.env.ROOM_MAX_BODY_BYTES || 100 * 1024 * 1024);
const GEOFENCE_RADIUS_METERS = Number(process.env.ROOM_GEOFENCE_RADIUS_METERS || 55);
const PUNCTUALITY_TOLERANCE_SECONDS = Number(process.env.ROOM_PUNCTUALITY_TOLERANCE_SECONDS || 60);
const FRAME_HISTORY_LIMIT_IN_DB = Number(process.env.ROOM_FRAME_HISTORY_LIMIT_IN_DB || 50000);
const DAY_TYPES = ['weekday', 'weekend', 'holiday'];
const DIRECTIONS = ['outbound', 'inbound']; // dwa kierunki

// Obiekt przechowujący połączenie – będziemy modyfikować jego właściwość
const db = { connection: null };
const dbState = { ready: false };

// --------------------- FUNKCJE POMOCNICZE BAZY ---------------------
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

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
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

// --------------------- INICJALIZACJA BAZY ---------------------
function ensureDatabaseReady() {
  fs.mkdirSync(DB_ROOT, { recursive: true });

  const conn = new Database(DB_FILE);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');

  try {
    conn.function('haversine_meters', { deterministic: true }, haversineMeters);
  } catch (err) {
    // Funkcja może być już zarejestrowana po hot-reloadzie w niektórych środowiskach.
  }

  // Przypisujemy połączenie do obiektu db
  db.connection = conn;

  initSchema(conn);
  seedDefaultSettings(conn);

  dbState.ready = true;
}

function initSchema(conn) {
  conn.exec(`
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
      name TEXT,
      line_id TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_schedules_lookup ON schedules(pcName, pcId, active, updated_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_line ON schedules(line_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_name ON schedules(name);
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

  ensureColumn(conn, 'schedules', 'pcName', 'TEXT');
  ensureColumn(conn, 'schedules', 'pcId', 'TEXT');
  ensureColumn(conn, 'schedules', 'active', 'INTEGER DEFAULT 1');
  ensureColumn(conn, 'schedules', 'updated_at', 'TEXT');

  ensureColumn(conn, 'current_status', 'status', 'TEXT');
  ensureColumn(conn, 'current_status', 'pcId', 'TEXT');
  ensureColumn(conn, 'current_status', 'day_type', 'TEXT');
  ensureColumn(conn, 'current_status', 'timestamp', 'TEXT');
  ensureColumn(conn, 'current_status', 'received_at', 'TEXT');
  ensureColumn(conn, 'current_status', 'latitude', 'REAL');
  ensureColumn(conn, 'current_status', 'longitude', 'REAL');
  ensureColumn(conn, 'current_status', 'payload_json', 'TEXT');
  ensureColumn(conn, 'current_status', 'status_json', 'TEXT');

  ensureColumn(conn, 'trips', 'pcId', 'TEXT');
  ensureColumn(conn, 'trips', 'line_number', 'TEXT');
  ensureColumn(conn, 'trips', 'brigade', 'TEXT');
  ensureColumn(conn, 'trips', 'schedule_id', 'TEXT');
  ensureColumn(conn, 'trips', 'trip_id', 'TEXT');
  ensureColumn(conn, 'trips', 'received_at', 'TEXT');
  ensureColumn(conn, 'trips', 'analyzed_at', 'TEXT');
  ensureColumn(conn, 'trips', 'latitude', 'REAL');
  ensureColumn(conn, 'trips', 'longitude', 'REAL');
  ensureColumn(conn, 'trips', 'planned_time', 'TEXT');
  ensureColumn(conn, 'trips', 'delay_abs_seconds', 'INTEGER');
  ensureColumn(conn, 'trips', 'passenger_events', 'INTEGER');
  ensureColumn(conn, 'trips', 'camera_count', 'INTEGER');
  ensureColumn(conn, 'trips', 'selected_area_avg', 'REAL');
  ensureColumn(conn, 'trips', 'selected_area_count', 'INTEGER');
  ensureColumn(conn, 'trips', 'metadata', 'TEXT');
}

function ensureColumn(conn, tableName, columnName, columnSql) {
  const columns = conn.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(column => column.name === columnName);
  if (!exists) conn.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnSql}`);
}

function seedDefaultSettings(conn) {
  const upsert = conn.prepare(`
    INSERT INTO settings(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = conn.transaction(() => {
    upsert.run('geofence_radius_meters', String(GEOFENCE_RADIUS_METERS));
    upsert.run('punctuality_tolerance_seconds', String(PUNCTUALITY_TOLERANCE_SECONDS));
    upsert.run('sync_interval_ms', String(SYNC_INTERVAL_MS));
    upsert.run('frame_history_limit_in_db', String(FRAME_HISTORY_LIMIT_IN_DB));
    upsert.run('database_file', DB_FILE);
  });

  tx();
}

function pruneHistory() {
  const conn = db.connection;
  if (!conn) return;

  const tx = conn.transaction(() => {
    conn.prepare(`
      DELETE FROM raw_frames
      WHERE id NOT IN (
        SELECT id FROM raw_frames
        ORDER BY id DESC
        LIMIT ?
      )
    `).run(FRAME_HISTORY_LIMIT_IN_DB);

    conn.prepare(`
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

module.exports = {
  db,
  dbState,
  ensureDatabaseReady,
  initSchema,
  ensureColumn,
  seedDefaultSettings,
  pruneHistory,
  getPolishPublicHolidayKeys,
  DAY_TYPES,
  DIRECTIONS,
  GEOFENCE_RADIUS_METERS,
  PUNCTUALITY_TOLERANCE_SECONDS,
  FRAME_HISTORY_LIMIT_IN_DB,
  SYNC_INTERVAL_MS,
  DB_FILE,
  DB_ROOT,
  PORT,
  haversineMeters,
  pad2,
  formatDateKey,
  getEasterDate,
  addDays,
  MAX_BODY_BYTES
};