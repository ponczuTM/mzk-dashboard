'use strict';

const crypto = require('crypto');
const os = require('os');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Importujemy moduł bazy danych
const sqlite = require('./sqlite');

// Wyciągamy potrzebne stałe
const {
  db,
  dbState,
  DAY_TYPES,
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
  getPolishPublicHolidayKeys,
  pruneHistory
} = sqlite;

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

      if (totalBytes > sqlite.MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error(`Przekroczono maksymalny rozmiar żądania: ${sqlite.MAX_BODY_BYTES} bajtów`));
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
  const row = db.connection.prepare('SELECT * FROM stops WHERE id = ?').get(id);
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

function findScheduleRowsByBaseId(scheduleId) {
  return db.connection.prepare(`
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

function findActiveScheduleForVehicle(pcName, pcId, dayType) {
  const pcNameValue = String(pcName || '').trim();
  const pcIdValue = String(pcId || '').trim();

  const row = db.connection.prepare(`
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

function determineDayType(date) {
  const dateKey = formatDateKey(date);
  const customHoliday = db.connection.prepare('SELECT date FROM holidays WHERE date = ?').get(dateKey);

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
  const conn = db.connection;
  const existing = conn.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  const existingMetadata = existing ? jsonParse(existing.metadata, {}) : {};

  const nextMetadata = {
    ...existingMetadata,
    last_payload_timestamp: timestamp,
    has_schedule: Boolean(hasSchedule),
    last_payload: payload,
    last_payload_metadata: metadata,
    updated_at: nowIso
  };

  conn.prepare(`
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
  const conn = db.connection;
  const passengers = status.passengers || {};
  const currentStopId = status.current_stop ? status.current_stop.stop_id : null;
  const nearestStopId = status.nearest_stop ? status.nearest_stop.stop_id : null;
  const distance = status.nearest_stop && Number.isFinite(status.nearest_stop.distance_meters)
    ? status.nearest_stop.distance_meters
    : null;

  conn.prepare(`
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

  const conn = db.connection;
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

  conn.prepare(`
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
    appendTripEventIfNeeded(status, schedule, now, appendTripEvent);
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
  if (!dbState.ready) return;

  const conn = db.connection;
  const rows = conn.prepare(`
    SELECT pcName, pcId, metadata
    FROM vehicles
    WHERE metadata IS NOT NULL
      AND last_seen IS NOT NULL
    ORDER BY last_seen DESC
  `).all();

  if (rows.length === 0) return;

  const analysisDate = new Date();

  const tx = conn.transaction(() => {
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
  const row = db.connection.prepare(`
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

// Eksport
module.exports = {
  jsonStringify,
  jsonParse,
  getLocalIPs,
  setCors,
  sendJson,
  readRequestBody,
  readJsonBody,
  isFiniteNumber,
  toFiniteNumber,
  requiredString,
  optionalString,
  normalizeUuid,
  sanitizeFileSegment,
  secondsSinceMidnight,
  normalizeTimeToHHMMSS,
  timeToSeconds,
  signedTimeDiffSeconds,
  getPunctualityStatus,
  getByPath,
  firstDefined,
  extractCoordinates,
  getStopId,
  stopFromRow,
  findStopById,
  normalizeStop,
  stopPublicView,
  normalizeScheduleSequence,
  normalizeSchedulePayload,
  findScheduleRowsByBaseId,
  scheduleFromRows,
  findActiveScheduleForVehicle,
  getScheduleSequence,
  enrichSequenceWithStops,
  findNearestStopByDistance,
  findNearestStopByPlannedTime,
  determineDayType,
  extractPassengerStats,
  getCameraCollections,
  isCameraOnline,
  extractCameraQuality,
  buildTripId,
  buildMinimalVehicleFrame,
  upsertVehicle,
  upsertCurrentStatus,
  appendTripEventIfNeeded,
  analyzeVehiclePayload,
  analyzeAllCurrentVehicles,
  buildTripsWhere,
  summarizeDataQualitySql,
  weekdayNameSqlExpression,
  addDistribution,
  tripFromRow,
  reportResponse,
  logReceivedDataConsole,
  logStatusTick
};