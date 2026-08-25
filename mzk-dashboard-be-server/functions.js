'use strict';

const crypto = require('crypto');
const os = require('os');

// Importujemy moduł bazy danych
const sqlite = require('./sqlite');

// Wyciągamy potrzebne stałe
const {
  db,
  dbState,
  GEOFENCE_RADIUS_METERS,
  PUNCTUALITY_TOLERANCE_SECONDS,
  VEHICLE_OFFLINE_THRESHOLD_MS,
  formatDateKey,
  getPolishPublicHolidayKeys,
  haversineMeters,
  pad2
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
          url: `http://${addr.address}:${sqlite.PORT}/api/data`
        });
      }
    }
  }

  return addresses;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET, PUT, PATCH, DELETE');
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

function toFiniteInt(value) {
  const n = toFiniteNumber(value);
  return n === null ? null : Math.trunc(n);
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

// Pojazd uznajemy za OFFLINE, jeśli od ostatniego odebranego pakietu
// telemetrii (vehicles.last_seen) minęło więcej niż VEHICLE_OFFLINE_THRESHOLD_MS.
function isVehicleOnline(lastSeenIso, referenceDate) {
  if (!lastSeenIso) return false;

  const lastSeenMs = new Date(lastSeenIso).getTime();
  if (!Number.isFinite(lastSeenMs)) return false;

  const nowMs = (referenceDate || new Date()).getTime();
  return (nowMs - lastSeenMs) <= VEHICLE_OFFLINE_THRESHOLD_MS;
}

// --------------------- CZAS ---------------------
function validateTimeHHMM(value) {
  return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(String(value));
}

function normalizeTimeHHMM(value) {
  const text = requiredString(value, 'time');
  if (!validateTimeHHMM(text)) {
    throw new Error(`Nieprawidłowy format godziny: ${text}. Oczekiwano HH:MM`);
  }
  const [h, m] = text.split(':');
  return `${pad2(Number(h))}:${m}`;
}

function normalizeTimeToHHMMSS(value) {
  const text = requiredString(value, 'planned_time');
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) {
    throw new Error(`Nieprawidłowy format czasu: ${text}. Wymagany format HH:MM:SS albo HH:MM`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    throw new Error(`Nieprawidłowy zakres czasu: ${text}`);
  }

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

function timeToSeconds(value) {
  const normalized = normalizeTimeToHHMMSS(value);
  const [h, m, s] = normalized.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// Zamienia liczbę sekund od północy z powrotem na "HH:MM" (obcina do doby).
function secondsToHHMM(totalSeconds) {
  let s = ((Math.round(totalSeconds) % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
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

const DAY_TYPE_TO_SERVICE_DAY = { weekday: 'WEEKDAY', weekend: 'WEEKEND', holiday: 'HOLIDAY' };

// --------------------- TRASY: budowanie sekwencji dnia pojazdu ---------------------

// Zwraca uporządkowaną listę przystanków trasy wraz z skumulowanym offsetem
// (w sekundach) liczonym od startu trasy. Pierwszy przystanek = offset 0.
function getRouteStopsCumulative(routeId) {
  const conn = db.connection;
  const rows = conn.prepare(`
    SELECT rs.stop_id, rs.sequence_order, rs.minutes_from_previous,
           s.name AS stop_name, s.latitude, s.longitude, s.zone, s.metadata AS stop_metadata
    FROM route_stops rs
    JOIN stops s ON s.id = rs.stop_id
    WHERE rs.route_id = ?
    ORDER BY rs.sequence_order
  `).all(routeId);

  let cumulativeSeconds = 0;
  return rows.map((row, index) => {
    const minutes = index === 0 ? 0 : Number(row.minutes_from_previous || 0);
    cumulativeSeconds += minutes * 60;
    return {
      stop_id: row.stop_id,
      sequence_order: row.sequence_order,
      minutes_from_previous: index === 0 ? 0 : Number(row.minutes_from_previous || 0),
      offset_seconds: cumulativeSeconds,
      stop_name: row.stop_name,
      latitude: row.latitude,
      longitude: row.longitude,
      zone: row.zone,
      stop_metadata: row.stop_metadata
    };
  });
}

// Buduje spłaszczoną, chronologicznie posortowaną sekwencję przystanków ze
// WSZYSTKICH kursów (trip_assignments) przypisanych pojazdowi na dany dzień.
// Dla każdego kursu: planowany czas przystanku = start_time + skumulowany offset.
// Przypisania stałe (date=NULL) oraz jednorazowe (date=YYYY-MM-DD) łączą się;
// jeśli istnieje przypisanie na konkretną datę, ma pierwszeństwo dla tego
// samego kursu (ta sama trasa + start + typ dnia).
function buildVehicleDaySequence(pcName, dayType, dateKey) {
  const pcNameValue = String(pcName || '').trim();
  const serviceDayType = DAY_TYPE_TO_SERVICE_DAY[String(dayType || '').toLowerCase()];
  if (!pcNameValue || !serviceDayType) return [];

  const conn = db.connection;

  const assignmentRows = conn.prepare(`
    SELECT ta.id, ta.route_id, ta.start_time, ta.date, ta.block_id,
           r.name AS line_name, r.code AS line_code
    FROM trip_assignments ta
    JOIN routes r ON r.id = ta.route_id
    WHERE ta.pcName = ?
      AND ta.day_type = ?
      AND (ta.date IS NULL OR ta.date = ?)
      AND r.isActive = 1
  `).all(pcNameValue, serviceDayType, dateKey);

  if (assignmentRows.length === 0) return [];

  // Deduplikacja: klucz = trasa + start_time. Przypisanie na konkretną datę
  // wygrywa z przypisaniem stałym (date=NULL).
  const byKey = new Map();
  for (const row of assignmentRows) {
    const key = `${row.route_id}||${row.start_time}`;
    const existing = byKey.get(key);
    if (!existing || (row.date && !existing.date)) byKey.set(key, row);
  }

  const assignments = [...byKey.values()];

  // Cache: sekwencja przystanków per trasa (jedno zapytanie na unikalną trasę).
  const routeCache = new Map();
  const getRoute = routeId => {
    if (!routeCache.has(routeId)) routeCache.set(routeId, getRouteStopsCumulative(routeId));
    return routeCache.get(routeId);
  };

  const sequence = [];

  for (const assignment of assignments) {
    const startSeconds = timeToSeconds(assignment.start_time);
    const routeStops = getRoute(assignment.route_id);

    for (const rs of routeStops) {
      const plannedSeconds = startSeconds + rs.offset_seconds;
      const stopMetadata = jsonParse(rs.stop_metadata, {});
      sequence.push({
        stop_id: rs.stop_id,
        planned_time: secondsToHHMM(plannedSeconds),
        planned_seconds: plannedSeconds,
        sequence_index: rs.sequence_order,
        minutes_from_previous: rs.minutes_from_previous,
        stop_name: rs.stop_name,
        stop_number: stopMetadata.number || '',
        latitude: rs.latitude,
        longitude: rs.longitude,
        admin_zone: rs.zone || stopMetadata.admin_zone || 'nieokreślona',
        zone: rs.zone || 'nieokreślona',
        zone_type: stopMetadata.zone_type || 'nieokreślony',
        trip_id: assignment.id,
        route_id: assignment.route_id,
        start_time: assignment.start_time,
        block_id: assignment.block_id || '',
        line_id: assignment.route_id,
        line_number: assignment.line_code || assignment.line_name
      });
    }
  }

  // Sortujemy chronologicznie po planowanym czasie (sekundach od północy).
  sequence.sort((a, b) => a.planned_seconds - b.planned_seconds);

  return sequence;
}

// Zastępuje dawne przypisanie jednego rozkładu — pojazd może dziś wykonywać
// wiele kursów (różnych tras) o różnych godzinach startu.
function findVehicleAssignmentForDay(pcName, dayType, dateKey) {
  const sequence = buildVehicleDaySequence(pcName, dayType, dateKey);
  if (sequence.length === 0) return null;

  return {
    pcName: String(pcName || '').trim(),
    day_type: dayType,
    sequence
  };
}

function getScheduleSequence(assignment) {
  if (!assignment || !Array.isArray(assignment.sequence)) return [];
  return assignment.sequence;
}

function enrichSequenceWithStops(sequence) {
  const result = [];

  for (const entry of sequence) {
    const stop = findStopById(entry.stop_id);
    if (!stop) continue;

    result.push({
      ...entry,
      stop,
      planned_seconds: Number.isFinite(entry.planned_seconds)
        ? entry.planned_seconds
        : timeToSeconds(entry.planned_time)
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
    payload.boardings,
    payload.in
  )) || 0;

  const selectedOut = toFiniteNumber(firstDefined(
    totals.selected_out,
    totals.out,
    totals.exits,
    totals.alightings,
    totals.people_out,
    payload.selected_out,
    payload.passengers_out,
    payload.alightings,
    payload.out
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

// --------------------- LICZNIK OSÓB: STAN URZĄDZENIA I DELTY ---------------------
// Kamera Isarsoft wysyła CAŁKOWITE, narastające liczniki (in/out) co 5 sekund,
// wielokrotnie powtarzając ten sam pakiet lub przesyłając wyższe wartości.
// Zamiast sumować surowe paczki (co prowadzi do absurdalnych wyników po
// kilku godzinach), wyliczamy przyrost (deltę) względem OSTATNIEGO znanego
// stanu zapisanego w device_state.

function toNonNegativeInt(value, fieldName) {
  const n = toFiniteInt(value);
  if (n === null) throw new Error(`Pole ${fieldName} musi być liczbą całkowitą`);
  if (n < 0) throw new Error(`Pole ${fieldName} nie może być ujemne`);
  return n;
}

function getDeviceState(deviceId) {
  const row = db.connection.prepare('SELECT * FROM device_state WHERE device_id = ?').get(deviceId);
  return row || {
    device_id: deviceId,
    last_in: 0,
    last_out: 0,
    current_occupancy: 0,
    total_in: 0,
    total_out: 0,
    updated_at: null
  };
}

// Zwraca stan bez modyfikowania bazy — używane przy cyklicznym odświeżaniu
// statusu pojazdu (ten sam pakiet analizowany ponownie co SYNC_INTERVAL_MS
// bez nowych danych z kamery), żeby nie logować sztucznych zdarzeń "zerowych".
function peekPassengerState(deviceId) {
  const state = getDeviceState(deviceId);
  return {
    device_id: deviceId,
    raw_in: state.last_in,
    raw_out: state.last_out,
    delta_in: 0,
    delta_out: 0,
    current_occupancy: state.current_occupancy,
    total_in: state.total_in,
    total_out: state.total_out,
    reset_detected: false,
    updated_at: state.updated_at
  };
}

// Czysta funkcja: wylicza przyrost (in/out) na podstawie ostatniego i
// bieżącego stanu licznika kamery. Ujemna delta oznacza reset licznika
// (np. restart urządzenia) — w takim wypadku bieżące wartości traktujemy
// jako przyrost od zera, a nie jako ubytek.
function computePassengerDelta(lastIn, lastOut, currentIn, currentOut) {
  let deltaIn = currentIn - lastIn;
  let deltaOut = currentOut - lastOut;
  let resetDetected = false;

  if (deltaIn < 0 || deltaOut < 0) {
    resetDetected = true;
    deltaIn = currentIn;
    deltaOut = currentOut;
  }

  return { deltaIn, deltaOut, resetDetected };
}

// Waliduje pakiet z kamery, wylicza deltę względem ostatniego znanego stanu
// i atomowo (transakcja) zapisuje: nowy stan urządzenia (device_state) oraz
// wpis w historii zdarzeń (passenger_count_events). Zwraca ujednolicony
// widok stanu, gotowy do dalszego wykorzystania (current_status / trips).
function processPassengerCounts(deviceId, rawIn, rawOut, receivedAtIso) {
  const deviceIdValue = requiredString(deviceId, 'device_id');
  const currentIn = toNonNegativeInt(rawIn, 'in');
  const currentOut = toNonNegativeInt(rawOut, 'out');
  const receivedAt = receivedAtIso || new Date().toISOString();

  const conn = db.connection;

  const tx = conn.transaction(() => {
    const previous = getDeviceState(deviceIdValue);
    const { deltaIn, deltaOut, resetDetected } = computePassengerDelta(
      previous.last_in, previous.last_out, currentIn, currentOut
    );

    // Aktualna liczba osób na pokładzie = Suma IN - Suma OUT z NAJNOWSZEGO
    // pakietu (nie skumulowana delta z poprzednich pakietów). Ujemne wartości
    // są dopuszczalne (np. gdy część pasażerów wsiadła przed startem systemu).
    // Dzięki temu reset licznika kamery (patrz computePassengerDelta) nie
    // zniekształca bieżącego obłożenia — ono zawsze odpowiada literalnie
    // ostatniemu odebranemu pakietowi telemetrii.
    const nextOccupancy = currentIn - currentOut;
    const nextTotalIn = previous.total_in + deltaIn;
    const nextTotalOut = previous.total_out + deltaOut;

    conn.prepare(`
      INSERT INTO device_state(device_id, last_in, last_out, current_occupancy, total_in, total_out, updated_at)
      VALUES(@device_id, @last_in, @last_out, @current_occupancy, @total_in, @total_out, @updated_at)
      ON CONFLICT(device_id) DO UPDATE SET
        last_in = excluded.last_in,
        last_out = excluded.last_out,
        current_occupancy = excluded.current_occupancy,
        total_in = excluded.total_in,
        total_out = excluded.total_out,
        updated_at = excluded.updated_at
    `).run({
      device_id: deviceIdValue,
      last_in: currentIn,
      last_out: currentOut,
      current_occupancy: nextOccupancy,
      total_in: nextTotalIn,
      total_out: nextTotalOut,
      updated_at: receivedAt
    });

    conn.prepare(`
      INSERT INTO passenger_count_events(
        device_id, raw_in, raw_out, delta_in, delta_out, occupancy_after, reset_detected, received_at
      )
      VALUES(@device_id, @raw_in, @raw_out, @delta_in, @delta_out, @occupancy_after, @reset_detected, @received_at)
    `).run({
      device_id: deviceIdValue,
      raw_in: currentIn,
      raw_out: currentOut,
      delta_in: deltaIn,
      delta_out: deltaOut,
      occupancy_after: nextOccupancy,
      reset_detected: resetDetected ? 1 : 0,
      received_at: receivedAt
    });

    return {
      device_id: deviceIdValue,
      raw_in: currentIn,
      raw_out: currentOut,
      delta_in: deltaIn,
      delta_out: deltaOut,
      current_occupancy: nextOccupancy,
      total_in: nextTotalIn,
      total_out: nextTotalOut,
      reset_detected: resetDetected,
      updated_at: receivedAt
    };
  });

  return tx();
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

function buildTripId(routeId, pcName, date) {
  const dateKey = formatDateKey(date);
  const line = routeId || 'no_route';
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
      current_occupancy, camera_quality_json, updated_at, status, pcId, day_type, timestamp, received_at,
      latitude, longitude, payload_json, status_json
    )
    VALUES(
      @pcName, @line_id, @current_stop_id, @nearest_stop_id, @punctuality_status,
      @delay_seconds, @geo_distance, @passengers_in, @passengers_out, @passengers_onboard,
      @current_occupancy, @camera_quality_json, @updated_at, @status, @pcId, @day_type, @timestamp, @received_at,
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
      current_occupancy = excluded.current_occupancy,
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
    // passengers_in/out = przyrost (delta) z OSTATNIEGO odebranego pakietu,
    // NIE surowy narastający licznik kamery — patrz processPassengerCounts.
    passengers_in: Number(passengers.delta_in || 0),
    passengers_out: Number(passengers.delta_out || 0),
    passengers_onboard: passengers.onboard === null || passengers.onboard === undefined ? null : Number(passengers.onboard),
    current_occupancy: Number(passengers.current_occupancy || 0),
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

function appendTripEventIfNeeded(status, date, appendTripEvent) {
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
      distance_to_stop, is_at_stop, pcId, line_number, brigade, route_id, trip_id,
      received_at, analyzed_at, latitude, longitude, planned_time, delay_abs_seconds,
      passenger_events, camera_count, selected_area_avg, selected_area_count, metadata
    )
    VALUES(
      @pcName, @line_id, @stop_id, @timestamp, @day_type, @passengers_in, @passengers_out,
      @passengers_onboard, @delay_seconds, @punctuality_status, @camera_error_detected,
      @distance_to_stop, @is_at_stop, @pcId, @line_number, @brigade, @route_id, @trip_id,
      @received_at, @analyzed_at, @latitude, @longitude, @planned_time, @delay_abs_seconds,
      @passenger_events, @camera_count, @selected_area_avg, @selected_area_count, @metadata
    )
  `).run({
    pcName: status.pcName,
    line_id: status.line_id || null,
    stop_id: stop ? stop.stop_id : null,
    timestamp: status.timestamp,
    day_type: status.day_type,
    // Zapisujemy przyrost (delta) wyliczony względem ostatniego znanego
    // stanu licznika kamery — sumowanie tych wartości w raportach daje
    // realną liczbę wsiadających/wysiadających, a nie wielokrotność
    // narastającego licznika z kamery.
    passengers_in: Number(passengers.delta_in || 0),
    passengers_out: Number(passengers.delta_out || 0),
    passengers_onboard: passengers.onboard === null || passengers.onboard === undefined ? null : Number(passengers.onboard),
    delay_seconds: Number.isFinite(status.delay_seconds) ? status.delay_seconds : null,
    punctuality_status: status.punctuality_status || null,
    camera_error_detected: quality.complete === false ? 1 : 0,
    distance_to_stop: stop && Number.isFinite(stop.distance_meters) ? stop.distance_meters : null,
    is_at_stop: status.current_stop ? 1 : 0,
    pcId: status.pcId || '',
    line_number: status.line_number || null,
    brigade: status.brigade || null,
    route_id: status.route_id || null,
    trip_id: status.current_trip_id || buildTripId(status.route_id, status.pcName, date),
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

  // Delta narastających liczników kamery liczymy TYLKO gdy przetwarzamy
  // świeżo odebrany pakiet (appendTripEvent=true). Cykliczne odświeżanie
  // statusu (co SYNC_INTERVAL_MS) reanalizuje ten sam zapisany payload bez
  // nowych danych z kamery — tam jedynie podglądamy stan, bez zapisu, aby
  // nie tworzyć sztucznych zdarzeń o zerowym przyroście w historii.
  const passengerState = appendTripEvent
    ? processPassengerCounts(pcName, stats.selected_in, stats.selected_out, metadata.receivedAt || nowIso)
    : peekPassengerState(pcName);

  stats.raw_in = passengerState.raw_in;
  stats.raw_out = passengerState.raw_out;
  stats.delta_in = passengerState.delta_in;
  stats.delta_out = passengerState.delta_out;
  stats.current_occupancy = passengerState.current_occupancy;
  stats.reset_detected = passengerState.reset_detected;
  stats.passenger_events = passengerState.delta_in + passengerState.delta_out;

  const dayType = determineDayType(now);
  const dateKey = formatDateKey(now);
  const assignment = findVehicleAssignmentForDay(pcName, dayType, dateKey);
  const currentSeconds = secondsSinceMidnight(now);
  const quality = extractCameraQuality(payload, null);

  // upsertVehicle aktualizuje vehicles.last_seen — musi się wykonać TYLKO dla
  // świeżo odebranego pakietu (appendTripEvent=true). Cykliczna reanaliza co
  // SYNC_INTERVAL_MS (appendTripEvent=false) odtwarza ten sam zapisany payload
  // bez żadnych nowych danych z pojazdu — jeśli wołałaby upsertVehicle, co
  // 5 sekund odświeżałaby last_seen "z powietrza" i pojazd NIGDY nie
  // przechodziłby w status OFFLINE, nawet gdy realnie przestał wysyłać dane.
  if (appendTripEvent) {
    upsertVehicle(pcName, pcId, coordinates, timestamp, nowIso, payload, metadata, Boolean(assignment));
  }

  const baseStatus = {
    pcName,
    pcId,
    timestamp,
    received_at: metadata.receivedAt || nowIso,
    updated_at: nowIso,
    raw_frame_id: metadata.rawFrameId || null,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    schedule_defined: Boolean(assignment),
    line_id: null,
    line_number: null,
    brigade: null,
    route_id: null,
    current_trip_id: null,
    day_type: assignment ? dayType : null,
    geofence_radius_meters: GEOFENCE_RADIUS_METERS,
    punctuality_tolerance_seconds: PUNCTUALITY_TOLERANCE_SECONDS,
    passengers: stats
  };

  if (!assignment) {
    const status = {
      ...baseStatus,
      status: 'brak przypisanych kursów',
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
    appendTripEventIfNeeded(status, now, appendTripEvent);
    return status;
  }

  const sequence = enrichSequenceWithStops(getScheduleSequence(assignment));

  if (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude)) {
    const status = {
      ...baseStatus,
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
    appendTripEventIfNeeded(status, now, appendTripEvent);
    return status;
  }

  if (sequence.length === 0) {
    const status = {
      ...baseStatus,
      status: 'brak kursów dla typu dnia',
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
    appendTripEventIfNeeded(status, now, appendTripEvent);
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
    line_id: target ? target.entry.line_id : null,
    line_number: target ? target.entry.line_number : null,
    brigade: target ? target.entry.block_id : null,
    route_id: target ? target.entry.route_id : null,
    current_trip_id: target ? target.entry.trip_id : null,
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
  appendTripEventIfNeeded(status, now, appendTripEvent);

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
    console.log(`Zaktualizowano pozycję komputera pokładowego (${status.pcName}). Współrzędne: [${lat}, ${lng}]. Brak przypisanych kursów.`);
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
  const lineId = optionalString(query.line_id || query.lineId || query.line || query.route_id || query.routeId, '');
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
    route_id: row.route_id,
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
  toFiniteInt,
  requiredString,
  optionalString,
  normalizeUuid,
  sanitizeFileSegment,
  secondsSinceMidnight,
  isVehicleOnline,
  validateTimeHHMM,
  normalizeTimeHHMM,
  normalizeTimeToHHMMSS,
  timeToSeconds,
  secondsToHHMM,
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
  getRouteStopsCumulative,
  buildVehicleDaySequence,
  findVehicleAssignmentForDay,
  getScheduleSequence,
  enrichSequenceWithStops,
  findNearestStopByDistance,
  findNearestStopByPlannedTime,
  determineDayType,
  extractPassengerStats,
  getDeviceState,
  peekPassengerState,
  computePassengerDelta,
  processPassengerCounts,
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