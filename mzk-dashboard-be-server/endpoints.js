'use strict';

const url = require('url');
const crypto = require('crypto');

const sqlite = require('./sqlite');
const funcs = require('./functions');

const {
  db,
  dbState,
  DB_FILE,
  PORT,
  pruneHistory
} = sqlite;

const {
  jsonStringify,
  jsonParse,
  getLocalIPs,
  setCors,
  sendJson,
  readJsonBody,
  requiredString,
  optionalString,
  firstDefined,
  toFiniteNumber,
  normalizeStop,
  stopFromRow,
  findStopById,
  buildTripsWhere,
  weekdayNameSqlExpression,
  addDistribution,
  tripFromRow,
  reportResponse,
  analyzeVehiclePayload,
  logReceivedDataConsole
} = funcs;

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseTimeToMinutes(timeStr) {
  const parts = String(timeStr).split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parts.length > 2 ? parseInt(parts[2], 10) : 0;
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(s)) return null;
  return h * 60 + m + s / 60;
}

function validateTime(timeStr) {
  return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(String(timeStr));
}

function minutesToTimeString(totalMinutes) {
  const wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(wrapped / 60);
  const mins = Math.floor(wrapped % 60);
  const secs = Math.round((wrapped - Math.floor(wrapped)) * 60);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function firstParam(value) {
  if (Array.isArray(value)) return value.length ? value[0] : undefined;
  return value;
}

function toIntWithFallback(value, fallback) {
  const parsed = toFiniteNumber(value);
  return parsed === null ? fallback : parsed;
}

function initScheduleSchema() {
  const conn = db.connection;

  if (!conn) {
    throw new Error('Nie można zainicjalizować schematu: db.connection jest null.');
  }

  conn.exec(`
    CREATE TABLE IF NOT EXISTS lines (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL,
      type TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY,
      line_id TEXT NOT NULL,
      name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('FROM_START', 'TO_START')),
      is_extended INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (line_id) REFERENCES lines(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS route_stops (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL,
      travel_time_from_start INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
      FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS service_days (
      id TEXT PRIMARY KEY,
      day_type TEXT NOT NULL UNIQUE CHECK (day_type IN ('WEEKDAY', 'WEEKEND', 'HOLIDAY')),
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS schedule_trips (
      id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      service_day_id TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
      FOREIGN KEY (service_day_id) REFERENCES service_days(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_routes_line_id ON routes(line_id);
    CREATE INDEX IF NOT EXISTS idx_routes_line_dir ON routes(line_id, direction);
    CREATE INDEX IF NOT EXISTS idx_route_stops_route_id ON route_stops(route_id);
    CREATE INDEX IF NOT EXISTS idx_route_stops_stop_id ON route_stops(stop_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_trips_route_id ON schedule_trips(route_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_trips_service_day_id ON schedule_trips(service_day_id);
  `);

  const insertServiceDay = conn.prepare(`
    INSERT OR IGNORE INTO service_days(id, day_type, metadata)
    VALUES(?, ?, '{}')
  `);
  const dayTypes = ['WEEKDAY', 'WEEKEND', 'HOLIDAY'];
  for (const dayType of dayTypes) {
    insertServiceDay.run(dayType, dayType);
  }
}

initScheduleSchema();

function lineFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    metadata: jsonParse(row.metadata, {})
  };
}

function routeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    line_id: row.line_id,
    name: row.name,
    direction: row.direction,
    is_extended: Boolean(row.is_extended),
    metadata: jsonParse(row.metadata, {})
  };
}

function routeStopFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    route_id: row.route_id,
    stop_id: row.stop_id,
    sequence_order: row.sequence_order,
    travel_time_from_start: row.travel_time_from_start,
    metadata: jsonParse(row.metadata, {})
  };
}

function serviceDayFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    day_type: row.day_type,
    metadata: jsonParse(row.metadata, {})
  };
}

function scheduleTripFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    route_id: row.route_id,
    service_day_id: row.service_day_id,
    departure_time: row.departure_time,
    metadata: jsonParse(row.metadata, {})
  };
}

function getServiceDayIdByType(dayType) {
  const map = { weekday: 'WEEKDAY', weekend: 'WEEKEND', holiday: 'HOLIDAY' };
  return map[String(dayType || '').toLowerCase()] || null;
}

function findLineById(id) {
  return lineFromRow(db.connection.prepare('SELECT * FROM lines WHERE id = ?').get(id));
}

function findRouteById(id) {
  return routeFromRow(db.connection.prepare('SELECT * FROM routes WHERE id = ?').get(id));
}

function findServiceDayByType(dayType) {
  const id = getServiceDayIdByType(dayType);
  if (!id) return null;
  return serviceDayFromRow(db.connection.prepare('SELECT * FROM service_days WHERE id = ?').get(id));
}

function findScheduleTripById(id) {
  return scheduleTripFromRow(db.connection.prepare('SELECT * FROM schedule_trips WHERE id = ?').get(id));
}

function getRouteStopsWithDetails(routeId) {
  return db.connection.prepare(`
    SELECT rs.*, s.name AS stop_name, s.latitude, s.longitude, s.zone, s.metadata AS stop_metadata
    FROM route_stops rs
    JOIN stops s ON s.id = rs.stop_id
    WHERE rs.route_id = ?
    ORDER BY rs.sequence_order
  `).all(routeId).map(row => ({
    ...routeStopFromRow(row),
    stop_name: row.stop_name,
    latitude: row.latitude,
    longitude: row.longitude,
    zone: row.zone
  }));
}

function computeStopTimes(routeId, departureTime) {
  const conn = db.connection;
  const stops = conn.prepare(`
    SELECT rs.*, s.name AS stop_name, s.latitude, s.longitude, s.zone
    FROM route_stops rs
    JOIN stops s ON s.id = rs.stop_id
    WHERE rs.route_id = ?
    ORDER BY rs.sequence_order
  `).all(routeId);

  const baseMinutes = parseTimeToMinutes(departureTime);
  if (baseMinutes === null) return [];

  return stops.map(rs => ({
    stop_id: rs.stop_id,
    stop_name: rs.stop_name,
    latitude: rs.latitude,
    longitude: rs.longitude,
    zone: rs.zone,
    sequence_order: rs.sequence_order,
    travel_time_from_start: rs.travel_time_from_start,
    departure_time: minutesToTimeString(baseMinutes + Number(rs.travel_time_from_start || 0))
  }));
}

function buildScheduleFromRoute(routeId, serviceDayId) {
  const conn = db.connection;
  const route = findRouteById(routeId);
  if (!route) return null;

  const trips = conn.prepare(`
    SELECT * FROM schedule_trips
    WHERE route_id = ? AND service_day_id = ?
    ORDER BY departure_time
  `).all(routeId, serviceDayId);

  const stopTimes = trips.map(trip => ({
    trip_id: trip.id,
    departure_time: trip.departure_time,
    stops: computeStopTimes(routeId, trip.departure_time)
  }));

  return {
    route_id: routeId,
    route_name: route.name,
    line_id: route.line_id,
    direction: route.direction,
    is_extended: route.is_extended,
    service_day_id: serviceDayId,
    trips: stopTimes
  };
}

function buildFullSchedule(routeId) {
  const conn = db.connection;
  const route = findRouteById(routeId);
  if (!route) return null;

  const serviceDays = conn.prepare('SELECT id, day_type FROM service_days').all();
  const result = {
    route_id: routeId,
    route_name: route.name,
    line_id: route.line_id,
    direction: route.direction,
    is_extended: route.is_extended,
    services: {}
  };

  for (const sd of serviceDays) {
    result.services[sd.day_type.toLowerCase()] = buildScheduleFromRoute(routeId, sd.id);
  }

  return result;
}

function normalizeLinePayload(body) {
  const number = requiredString(body.number, 'number');
  const type = requiredString(body.type, 'type');
  if (!['bus', 'tram', 'trolley', 'train', 'metro'].includes(type)) {
    throw new Error(`Nieprawidłowy typ linii: ${type}. Dozwolone: bus, tram, trolley, train, metro`);
  }
  return {
    id: optionalString(body.id, '') || generateId(),
    number,
    type,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  };
}

function normalizeRoutePayload(body) {
  const lineId = requiredString(body.line_id, 'line_id');
  if (!findLineById(lineId)) {
    throw new Error(`Nie znaleziono linii o id: ${lineId}`);
  }
  const name = requiredString(body.name, 'name');
  const direction = requiredString(body.direction, 'direction');
  if (!['FROM_START', 'TO_START'].includes(direction)) {
    throw new Error(`Nieprawidłowy kierunek: ${direction}. Dozwolone: FROM_START, TO_START`);
  }
  const isExtended = body.is_extended === true || body.is_extended === 'true' || body.is_extended === 1;
  return {
    id: optionalString(body.id, '') || generateId(),
    line_id: lineId,
    name,
    direction,
    is_extended: isExtended,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  };
}

function normalizeRouteStopsPayload(routeId, body) {
  const stops = body.stops || body.route_stops || [];
  if (!Array.isArray(stops)) {
    throw new Error('stops musi być tablicą');
  }
  const result = [];
  for (let i = 0; i < stops.length; i++) {
    const item = stops[i] || {};
    const stopId = requiredString(firstDefined(item.stop_id, item.id), `stops[${i}].stop_id`);
    if (!findStopById(stopId)) {
      throw new Error(`Nie znaleziono przystanku o id: ${stopId}`);
    }
    const travelTime = toIntWithFallback(firstDefined(item.travel_time_from_start, item.travelTimeFromStart), 0);
    if (travelTime < 0) {
      throw new Error(`travel_time_from_start nie może być ujemne dla przystanku ${stopId}`);
    }
    result.push({
      id: optionalString(item.id, '') || generateId(),
      route_id: routeId,
      stop_id: stopId,
      sequence_order: i + 1,
      travel_time_from_start: Math.round(travelTime),
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {}
    });
  }
  return result;
}

function normalizeScheduleTripPayload(body) {
  const routeId = requiredString(body.route_id, 'route_id');
  if (!findRouteById(routeId)) {
    throw new Error(`Nie znaleziono trasy o id: ${routeId}`);
  }

  let serviceDayId = optionalString(body.service_day_id, '');
  if (!serviceDayId && body.day_type) {
    serviceDayId = getServiceDayIdByType(body.day_type) || '';
  }
  serviceDayId = requiredString(serviceDayId, 'service_day_id');

  const sd = db.connection.prepare('SELECT id FROM service_days WHERE id = ?').get(serviceDayId);
  if (!sd) {
    throw new Error(`Nie znaleziono dnia serwisowego o id: ${serviceDayId}`);
  }

  const departureTime = requiredString(body.departure_time, 'departure_time');
  if (!validateTime(departureTime)) {
    throw new Error(`Nieprawidłowy format czasu: ${departureTime}. Oczekiwano HH:MM lub HH:MM:SS`);
  }

  return {
    id: optionalString(body.id, '') || generateId(),
    route_id: routeId,
    service_day_id: serviceDayId,
    departure_time: departureTime.length === 5 ? `${departureTime}:00` : departureTime,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
  };
}

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

let latestIsarsoftData = null;

async function handleIncomingData(req, res) {
  const payload = await readJsonBody(req);
  latestIsarsoftData = payload;

  const pcId = payload.pcId;
  const pcName = payload.pcName;

  if (pcId === null || pcId === undefined || pcName === null || pcName === undefined) {
    throw new Error('Brak wymaganych pól: pcId, pcName');
  }

  const normalizedPcName = requiredString(pcName, 'pcName');
  const receivedAtDate = new Date();
  const receivedAt = receivedAtDate.toISOString();
  const minimalFrame = funcs.buildMinimalVehicleFrame(normalizedPcName, payload, receivedAtDate);

  const processIncomingTx = db.connection.transaction(() => {
    const raw = db.connection.prepare(`
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

async function handleGetIsarsoftLatest(req, res) {
  if (!latestIsarsoftData) {
    sendJson(res, 404, {
      ok: false,
      error: 'Brak danych Isarsoft – jeszcze nie odebrano żadnego pakietu.'
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    data: latestIsarsoftData
  });
}

async function handleCreateStop(req, res) {
  const body = await readJsonBody(req);
  const stop = normalizeStop(body);

  db.connection.prepare(`
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
    stop: stopFromRow(db.connection.prepare('SELECT * FROM stops WHERE id = ?').get(stop.id))
  });
}

async function handleGetStops(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(firstParam(query.id) || firstParam(query.stop_id), '');
  const zone = optionalString(firstParam(query.zone) || firstParam(query.admin_zone) || firstParam(query.adminZone), '');
  const q = optionalString(firstParam(query.q) || firstParam(query.search) || firstParam(query.name), '');

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
  const rows = db.connection.prepare(`SELECT * FROM stops ${whereSql} ORDER BY name COLLATE NOCASE, id`).all(params);
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

  db.connection.prepare(`
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
  const info = db.connection.prepare('DELETE FROM stops WHERE id = ?').run(stopId);
  if (info.changes === 0) throw new Error(`Nie znaleziono przystanku o id: ${stopId}`);
  sendJson(res, 200, { ok: true, message: 'Stop deleted', deletedCount: info.changes });
}

async function handleCreateLine(req, res) {
  const body = await readJsonBody(req);
  const line = normalizeLinePayload(body);

  db.connection.prepare(`
    INSERT INTO lines(id, number, type, metadata)
    VALUES(@id, @number, @type, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      number = excluded.number,
      type = excluded.type,
      metadata = excluded.metadata
  `).run({
    ...line,
    metadata: jsonStringify(line.metadata)
  });

  sendJson(res, 201, {
    ok: true,
    message: 'Line created',
    line: findLineById(line.id)
  });
}

async function handleGetLines(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(firstParam(query.id), '');
  const number = optionalString(firstParam(query.number), '');
  const type = optionalString(firstParam(query.type), '');

  if (id) {
    clauses.push('id = @id');
    params.id = id;
  }
  if (number) {
    clauses.push('number LIKE @number');
    params.number = `%${number}%`;
  }
  if (type) {
    clauses.push('type = @type');
    params.type = type;
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.connection.prepare(`SELECT * FROM lines ${whereSql} ORDER BY number COLLATE NOCASE, id`).all(params);
  const lines = rows.map(lineFromRow);

  sendJson(res, 200, {
    ok: true,
    count: lines.length,
    lines
  });
}

async function handleGetLineById(req, res, lineId) {
  const line = findLineById(lineId);
  if (!line) throw new Error(`Nie znaleziono linii o id: ${lineId}`);

  const routes = db.connection.prepare(`
    SELECT * FROM routes WHERE line_id = ? ORDER BY direction, is_extended DESC, name
  `).all(lineId).map(routeFromRow);

  sendJson(res, 200, { ok: true, line: { ...line, routes } });
}

async function handleUpdateLine(req, res, lineId) {
  const existing = findLineById(lineId);
  if (!existing) throw new Error(`Nie znaleziono linii o id: ${lineId}`);

  const body = await readJsonBody(req);
  const line = normalizeLinePayload({ ...body, id: lineId });
  line.metadata.updated_at = new Date().toISOString();

  db.connection.prepare(`
    UPDATE lines
    SET number = @number,
        type = @type,
        metadata = @metadata
    WHERE id = @id
  `).run({
    ...line,
    metadata: jsonStringify(line.metadata)
  });

  sendJson(res, 200, {
    ok: true,
    message: 'Line updated',
    line: findLineById(lineId)
  });
}

async function handleDeleteLine(req, res, lineId) {
  const info = db.connection.prepare('DELETE FROM lines WHERE id = ?').run(lineId);
  if (info.changes === 0) throw new Error(`Nie znaleziono linii o id: ${lineId}`);
  sendJson(res, 200, { ok: true, message: 'Line deleted (kaskadowo usunięto trasy, przystanki tras i kursy)', deletedCount: info.changes });
}

async function handleCreateRoute(req, res) {
  const body = await readJsonBody(req);
  const route = normalizeRoutePayload(body);

  const tx = db.connection.transaction(() => {
    db.connection.prepare(`
      INSERT INTO routes(id, line_id, name, direction, is_extended, metadata)
      VALUES(@id, @line_id, @name, @direction, @is_extended, @metadata)
      ON CONFLICT(id) DO UPDATE SET
        line_id = excluded.line_id,
        name = excluded.name,
        direction = excluded.direction,
        is_extended = excluded.is_extended,
        metadata = excluded.metadata
    `).run({
      ...route,
      is_extended: route.is_extended ? 1 : 0,
      metadata: jsonStringify(route.metadata)
    });

    const stops = Array.isArray(body.stops) || Array.isArray(body.route_stops)
      ? normalizeRouteStopsPayload(route.id, body)
      : null;

    if (stops) {
      db.connection.prepare('DELETE FROM route_stops WHERE route_id = ?').run(route.id);
      const insert = db.connection.prepare(`
        INSERT INTO route_stops(id, route_id, stop_id, sequence_order, travel_time_from_start, metadata)
        VALUES(@id, @route_id, @stop_id, @sequence_order, @travel_time_from_start, @metadata)
      `);
      for (const st of stops) {
        insert.run({ ...st, metadata: jsonStringify(st.metadata) });
      }
    }
  });

  tx();

  sendJson(res, 201, {
    ok: true,
    message: 'Route created',
    route: findRouteById(route.id),
    stops: getRouteStopsWithDetails(route.id)
  });
}

async function handleGetRoutes(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(firstParam(query.id), '');
  const lineId = optionalString(firstParam(query.line_id), '');
  const direction = optionalString(firstParam(query.direction), '');
  const isExtended = optionalString(firstParam(query.is_extended), '');

  if (id) {
    clauses.push('r.id = @id');
    params.id = id;
  }
  if (lineId) {
    clauses.push('r.line_id = @line_id');
    params.line_id = lineId;
  }
  if (direction) {
    clauses.push('r.direction = @direction');
    params.direction = direction;
  }
  if (isExtended === 'true' || isExtended === '1') {
    clauses.push('r.is_extended = 1');
  } else if (isExtended === 'false' || isExtended === '0') {
    clauses.push('r.is_extended = 0');
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.connection.prepare(`
    SELECT r.*, l.number AS line_number, l.type AS line_type,
           (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count
    FROM routes r
    LEFT JOIN lines l ON l.id = r.line_id
    ${whereSql}
    ORDER BY r.line_id, r.direction, r.is_extended DESC, r.name COLLATE NOCASE, r.id
  `).all(params);

  const routes = rows.map(row => ({
    ...routeFromRow(row),
    line_number: row.line_number,
    line_type: row.line_type,
    stop_count: Number(row.stop_count || 0)
  }));

  sendJson(res, 200, {
    ok: true,
    count: routes.length,
    routes
  });
}

async function handleGetRouteById(req, res, routeId) {
  const route = findRouteById(routeId);
  if (!route) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const line = findLineById(route.line_id);

  sendJson(res, 200, {
    ok: true,
    route: {
      ...route,
      line_number: line ? line.number : null,
      line_type: line ? line.type : null,
      stops: getRouteStopsWithDetails(routeId)
    }
  });
}

async function handleUpdateRoute(req, res, routeId) {
  const existing = findRouteById(routeId);
  if (!existing) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const body = await readJsonBody(req);
  const route = normalizeRoutePayload({ ...body, id: routeId });
  route.metadata.updated_at = new Date().toISOString();

  db.connection.prepare(`
    UPDATE routes
    SET line_id = @line_id,
        name = @name,
        direction = @direction,
        is_extended = @is_extended,
        metadata = @metadata
    WHERE id = @id
  `).run({
    ...route,
    is_extended: route.is_extended ? 1 : 0,
    metadata: jsonStringify(route.metadata)
  });

  sendJson(res, 200, {
    ok: true,
    message: 'Route updated',
    route: findRouteById(routeId)
  });
}

async function handleDeleteRoute(req, res, routeId) {
  const info = db.connection.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
  if (info.changes === 0) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);
  sendJson(res, 200, { ok: true, message: 'Route deleted (kaskadowo usunięto przystanki trasy i kursy)', deletedCount: info.changes });
}

async function handleSetRouteStops(req, res, routeId) {
  const route = findRouteById(routeId);
  if (!route) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const body = await readJsonBody(req);
  const stops = normalizeRouteStopsPayload(routeId, body);

  const tx = db.connection.transaction(() => {
    db.connection.prepare('DELETE FROM route_stops WHERE route_id = ?').run(routeId);
    const insert = db.connection.prepare(`
      INSERT INTO route_stops(id, route_id, stop_id, sequence_order, travel_time_from_start, metadata)
      VALUES(@id, @route_id, @stop_id, @sequence_order, @travel_time_from_start, @metadata)
    `);
    for (const st of stops) {
      insert.run({ ...st, metadata: jsonStringify(st.metadata) });
    }
  });

  tx();

  sendJson(res, 200, {
    ok: true,
    message: `Zapisano ${stops.length} przystanków dla trasy (poprzednie przypisania nadpisane)`,
    stops: getRouteStopsWithDetails(routeId)
  });
}

async function handleGetRouteStops(req, res, routeId) {
  const route = findRouteById(routeId);
  if (!route) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const stops = getRouteStopsWithDetails(routeId);

  sendJson(res, 200, {
    ok: true,
    route_id: routeId,
    count: stops.length,
    stops
  });
}

async function handleCreateScheduleTrip(req, res) {
  const body = await readJsonBody(req);

  if (Array.isArray(body.trips)) {
    const created = [];
    const tx = db.connection.transaction(() => {
      const insert = db.connection.prepare(`
        INSERT INTO schedule_trips(id, route_id, service_day_id, departure_time, metadata)
        VALUES(@id, @route_id, @service_day_id, @departure_time, @metadata)
        ON CONFLICT(id) DO UPDATE SET
          route_id = excluded.route_id,
          service_day_id = excluded.service_day_id,
          departure_time = excluded.departure_time,
          metadata = excluded.metadata
      `);
      for (const rawTrip of body.trips) {
        const trip = normalizeScheduleTripPayload({
          route_id: firstDefined(rawTrip.route_id, body.route_id),
          service_day_id: firstDefined(rawTrip.service_day_id, body.service_day_id),
          day_type: firstDefined(rawTrip.day_type, body.day_type),
          departure_time: rawTrip.departure_time,
          id: rawTrip.id,
          metadata: rawTrip.metadata
        });
        insert.run({ ...trip, metadata: jsonStringify(trip.metadata) });
        created.push(trip.id);
      }
    });
    tx();

    sendJson(res, 201, {
      ok: true,
      message: `Utworzono/zaktualizowano ${created.length} kursów`,
      trips: created.map(findScheduleTripById)
    });
    return;
  }

  const trip = normalizeScheduleTripPayload(body);

  db.connection.prepare(`
    INSERT INTO schedule_trips(id, route_id, service_day_id, departure_time, metadata)
    VALUES(@id, @route_id, @service_day_id, @departure_time, @metadata)
    ON CONFLICT(id) DO UPDATE SET
      route_id = excluded.route_id,
      service_day_id = excluded.service_day_id,
      departure_time = excluded.departure_time,
      metadata = excluded.metadata
  `).run({
    ...trip,
    metadata: jsonStringify(trip.metadata)
  });

  sendJson(res, 201, {
    ok: true,
    message: 'Trip created',
    trip: findScheduleTripById(trip.id),
    computed_stops: computeStopTimes(trip.route_id, trip.departure_time)
  });
}

async function handleGetScheduleTrips(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(firstParam(query.id), '');
  const routeId = optionalString(firstParam(query.route_id), '');
  const serviceDayId = optionalString(firstParam(query.service_day_id), '');
  const dayType = optionalString(firstParam(query.day_type), '');
  const lineId = optionalString(firstParam(query.line_id), '');

  if (id) {
    clauses.push('st.id = @id');
    params.id = id;
  }
  if (routeId) {
    clauses.push('st.route_id = @route_id');
    params.route_id = routeId;
  }
  if (serviceDayId) {
    clauses.push('st.service_day_id = @service_day_id');
    params.service_day_id = serviceDayId;
  } else if (dayType) {
    const sdId = getServiceDayIdByType(dayType);
    if (sdId) {
      clauses.push('st.service_day_id = @service_day_id');
      params.service_day_id = sdId;
    }
  }
  if (lineId) {
    clauses.push('r.line_id = @line_id');
    params.line_id = lineId;
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.connection.prepare(`
    SELECT st.*, r.name AS route_name, r.direction, r.is_extended, r.line_id AS route_line_id,
           l.number AS line_number, l.type AS line_type,
           sd.day_type AS service_day_type
    FROM schedule_trips st
    JOIN routes r ON r.id = st.route_id
    JOIN lines l ON l.id = r.line_id
    JOIN service_days sd ON sd.id = st.service_day_id
    ${whereSql}
    ORDER BY st.departure_time, st.id
  `).all(params);

  const trips = rows.map(row => ({
    ...scheduleTripFromRow(row),
    route_name: row.route_name,
    line_id: row.route_line_id,
    direction: row.direction,
    is_extended: Boolean(row.is_extended),
    line_number: row.line_number,
    line_type: row.line_type,
    service_day_type: row.service_day_type
  }));

  sendJson(res, 200, {
    ok: true,
    count: trips.length,
    trips
  });
}

async function handleGetScheduleTripById(req, res, tripId) {
  const trip = findScheduleTripById(tripId);
  if (!trip) throw new Error(`Nie znaleziono kursu o id: ${tripId}`);

  const route = findRouteById(trip.route_id);
  const sd = db.connection.prepare('SELECT day_type FROM service_days WHERE id = ?').get(trip.service_day_id);

  sendJson(res, 200, {
    ok: true,
    trip: {
      ...trip,
      route_name: route ? route.name : null,
      line_id: route ? route.line_id : null,
      direction: route ? route.direction : null,
      is_extended: route ? route.is_extended : null,
      service_day_type: sd ? sd.day_type : null,
      computed_stops: computeStopTimes(trip.route_id, trip.departure_time)
    }
  });
}

async function handleUpdateScheduleTrip(req, res, tripId) {
  const existing = findScheduleTripById(tripId);
  if (!existing) throw new Error(`Nie znaleziono kursu o id: ${tripId}`);

  const body = await readJsonBody(req);
  const trip = normalizeScheduleTripPayload({ ...body, id: tripId });
  trip.metadata.updated_at = new Date().toISOString();

  db.connection.prepare(`
    UPDATE schedule_trips
    SET route_id = @route_id,
        service_day_id = @service_day_id,
        departure_time = @departure_time,
        metadata = @metadata
    WHERE id = @id
  `).run({
    ...trip,
    metadata: jsonStringify(trip.metadata)
  });

  sendJson(res, 200, {
    ok: true,
    message: 'Trip updated',
    trip: findScheduleTripById(tripId)
  });
}

async function handleDeleteScheduleTrip(req, res, tripId) {
  const info = db.connection.prepare('DELETE FROM schedule_trips WHERE id = ?').run(tripId);
  if (info.changes === 0) throw new Error(`Nie znaleziono kursu o id: ${tripId}`);
  sendJson(res, 200, { ok: true, message: 'Trip deleted', deletedCount: info.changes });
}

async function handleGetScheduleByRoute(req, res, routeId) {
  const route = findRouteById(routeId);
  if (!route) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const schedule = buildFullSchedule(routeId);
  sendJson(res, 200, { ok: true, schedule });
}

async function handleGetScheduleByLineAndDirection(req, res, query) {
  const lineId = requiredString(firstParam(query.line_id), 'line_id');
  const direction = optionalString(firstParam(query.direction), 'FROM_START');
  if (!['FROM_START', 'TO_START'].includes(direction)) {
    throw new Error(`Nieprawidłowy kierunek: ${direction}`);
  }
  const dayType = optionalString(firstParam(query.day_type), 'weekday');
  const serviceDayId = getServiceDayIdByType(dayType);
  if (!serviceDayId) {
    throw new Error(`Nieprawidłowy typ dnia: ${dayType}`);
  }

  const route = db.connection.prepare(`
    SELECT id FROM routes
    WHERE line_id = ? AND direction = ?
    ORDER BY is_extended DESC, name
    LIMIT 1
  `).get(lineId, direction);

  if (!route) {
    throw new Error(`Nie znaleziono trasy dla linii ${lineId} w kierunku ${direction}`);
  }

  sendJson(res, 200, {
    ok: true,
    route_id: route.id,
    service_day_id: serviceDayId,
    schedule: buildScheduleFromRoute(route.id, serviceDayId)
  });
}

async function handleCopyDirection(req, res, routeId) {
  const body = await readJsonBody(req);

  let sourceRouteId = optionalString(body.source_route_id, '') || routeId;
  let targetRouteId = optionalString(body.target_route_id, '');

  if (!targetRouteId) {
    const targetLineId = optionalString(body.target_line_id, '');
    const targetDirection = optionalString(body.target_direction, '');
    if (targetLineId && targetDirection) {
      if (!['FROM_START', 'TO_START'].includes(targetDirection)) {
        throw new Error('target_direction musi być FROM_START lub TO_START');
      }
      const found = db.connection.prepare(`
        SELECT id FROM routes WHERE line_id = ? AND direction = ?
        ORDER BY is_extended DESC, name LIMIT 1
      `).get(targetLineId, targetDirection);
      if (!found) {
        throw new Error(`Nie znaleziono trasy docelowej dla linii ${targetLineId} w kierunku ${targetDirection}`);
      }
      targetRouteId = found.id;
    }
  }

  const sourceRoute = findRouteById(sourceRouteId);
  if (!sourceRoute) throw new Error(`Nie znaleziono trasy źródłowej o id: ${sourceRouteId}`);

  const targetRoute = findRouteById(targetRouteId);
  if (!targetRoute) throw new Error('Nie znaleziono trasy docelowej (podaj target_route_id lub target_line_id + target_direction)');
  if (targetRoute.id === sourceRoute.id) throw new Error('Trasa źródłowa i docelowa nie mogą być takie same');

  const reverse = body.reverse === undefined
    ? true
    : (body.reverse === true || body.reverse === 'true');

  const sourceStops = db.connection.prepare(`
    SELECT stop_id, travel_time_from_start, metadata
    FROM route_stops
    WHERE route_id = ?
    ORDER BY sequence_order
  `).all(sourceRoute.id);

  if (sourceStops.length === 0) {
    throw new Error('Źródłowa trasa nie ma zdefiniowanych przystanków');
  }

  let stopsToCopy = sourceStops.map(s => ({ ...s }));
  if (reverse) {
    stopsToCopy = stopsToCopy.slice().reverse();
    let maxTime = 0;
    for (const s of stopsToCopy) {
      const t = Number(s.travel_time_from_start || 0);
      if (t > maxTime) maxTime = t;
    }
    for (const s of stopsToCopy) {
      s.travel_time_from_start = maxTime - Number(s.travel_time_from_start || 0);
    }
  }

  const tx = db.connection.transaction(() => {
    db.connection.prepare('DELETE FROM route_stops WHERE route_id = ?').run(targetRoute.id);
    const insert = db.connection.prepare(`
      INSERT INTO route_stops(id, route_id, stop_id, sequence_order, travel_time_from_start, metadata)
      VALUES(?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < stopsToCopy.length; i++) {
      const s = stopsToCopy[i];
      insert.run(
        generateId(),
        targetRoute.id,
        s.stop_id,
        i + 1,
        Math.round(Number(s.travel_time_from_start || 0)),
        s.metadata || '{}'
      );
    }
  });

  tx();

  sendJson(res, 200, {
    ok: true,
    message: `Skopiowano przystanki z trasy ${sourceRoute.id} do ${targetRoute.id}${reverse ? ' (kolejność i czasy odwrócone)' : ''}`,
    source_route_id: sourceRoute.id,
    target_route_id: targetRoute.id,
    reversed: reverse,
    stops: getRouteStopsWithDetails(targetRoute.id)
  });
}

async function handleServiceDays(req, res) {
  const rows = db.connection.prepare('SELECT id, day_type, metadata FROM service_days ORDER BY day_type').all();
  const days = rows.map(serviceDayFromRow);

  sendJson(res, 200, {
    ok: true,
    count: days.length,
    service_days: days
  });
}

async function handleCreateHoliday(req, res) {
  const body = await readJsonBody(req);
  const date = requiredString(body.date, 'date');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Pole date musi mieć format YYYY-MM-DD');
  }

  const description = optionalString(firstDefined(body.description, body.name), 'święto');

  db.connection.prepare(`
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
  const rows = db.connection.prepare('SELECT date, description FROM holidays ORDER BY date').all();
  sendJson(res, 200, {
    ok: true,
    holidays: rows
  });
}

async function handleDeleteHoliday(req, res, date) {
  const info = db.connection.prepare('DELETE FROM holidays WHERE date = ?').run(date);
  if (info.changes === 0) throw new Error(`Nie znaleziono święta o dacie: ${date}`);
  sendJson(res, 200, { ok: true, message: 'Holiday deleted', deletedCount: info.changes });
}

async function handleUpdateVehicle(req, res, pcName) {
  const body = await readJsonBody(req);
  const routeId = optionalString(firstDefined(body.route_id, body.schedule_id), '');

  const vehicle = db.connection.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  if (!vehicle) {
    throw new Error(`Nie znaleziono pojazdu o pcName: ${pcName}`);
  }

  let route = null;
  if (routeId) {
    route = findRouteById(routeId);
    if (!route) {
      throw new Error(`Nie znaleziono trasy o id: ${routeId}`);
    }
  }

  const existingMetadata = jsonParse(vehicle.metadata, {});
  existingMetadata.route_id = routeId || null;
  existingMetadata.schedule_id = routeId || null;
  if (route) {
    existingMetadata.line_id = route.line_id;
    existingMetadata.direction = route.direction;
    existingMetadata.is_extended = route.is_extended;
  }
  existingMetadata.updated_at = new Date().toISOString();

  db.connection.prepare(`
    UPDATE vehicles
    SET metadata = @metadata
    WHERE pcName = @pcName
  `).run({
    pcName,
    metadata: jsonStringify(existingMetadata)
  });

  sendJson(res, 200, {
    ok: true,
    message: 'Vehicle route/schedule updated',
    vehicle: {
      pcName: vehicle.pcName,
      pcId: vehicle.pcId || '',
      route_id: existingMetadata.route_id,
      schedule_id: existingMetadata.schedule_id,
      metadata: existingMetadata
    }
  });
}

async function handleVehicles(req, res) {
  const rows = db.connection.prepare(`
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

  const vehicles = rows.map(row => {
    const metadata = jsonParse(row.metadata, {});
    return {
      pcName: row.pcName,
      pcId: row.pcId || '',
      first_seen_at: row.first_seen,
      last_seen_at: row.last_seen,
      last_latitude: row.last_lat,
      last_longitude: row.last_lng,
      has_schedule: Boolean(metadata.has_schedule),
      route_id: metadata.route_id || null,
      schedule_id: metadata.schedule_id || null,
      line_id: metadata.line_id || row.status_line_id || null,
      line_number: metadata.line_number || null,
      direction: metadata.direction || null,
      is_extended: metadata.is_extended === undefined ? null : Boolean(metadata.is_extended),
      brigade: metadata.brigade || '',
      status: row.status || null,
      punctuality_status: row.punctuality_status || null,
      status_updated_at: row.status_updated_at || null
    };
  });

  sendJson(res, 200, {
    ok: true,
    count: vehicles.length,
    vehicles
  });
}

async function handleGetTrips(req, res, query) {
  const page = Math.max(1, parseInt(firstParam(query.page), 10) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(firstParam(query.limit), 10) || 100));
  const offset = (page - 1) * limit;
  const { whereSql, params } = buildTripsWhere(query, 't');

  const totalRow = db.connection.prepare(`SELECT COUNT(*) AS total FROM trips t ${whereSql}`).get(params);
  const rows = db.connection.prepare(`
    SELECT *
    FROM trips t
    ${whereSql}
    ORDER BY COALESCE(t.received_at, t.timestamp) DESC, t.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  const total = Number(totalRow.total || 0);

  sendJson(res, 200, {
    ok: true,
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    rows: rows.map(tripFromRow)
  });
}

async function handleDeleteTrips(req, res, query) {
  const all = firstParam(query.all) === 'true';
  const before = firstParam(query.before);

  if (all) {
    const countRow = db.connection.prepare('SELECT COUNT(*) AS total FROM trips').get();
    db.connection.prepare('DELETE FROM trips').run();

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

    const info = db.connection.prepare(`
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
  const pcName = optionalString(firstParam(query.pcName) || firstParam(query.pc_name), '');
  const rows = pcName
    ? db.connection.prepare('SELECT * FROM current_status WHERE pcName = ?').all(pcName)
    : db.connection.prepare('SELECT * FROM current_status ORDER BY updated_at DESC').all();

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

  const totalRow = db.connection.prepare(`
    SELECT COALESCE(SUM(passenger_events), 0) AS total_passenger_events
    FROM trips t
    ${whereSql}
  `).get(params);

  const totalPassengerEvents = Number(totalRow.total_passenger_events || 0);

  const rows = db.connection.prepare(`
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

  const hourRows = db.connection.prepare(`
    SELECT
      t.stop_id,
      strftime('%H', COALESCE(t.received_at, t.timestamp)) AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
      ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
    GROUP BY t.stop_id, bucket
  `).all(params);

  const weekdayRows = db.connection.prepare(`
    SELECT
      t.stop_id,
      ${weekdayNameSqlExpression('COALESCE(t.received_at, t.timestamp)')} AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
      ${whereSql ? 'AND' : 'WHERE'} t.stop_id IS NOT NULL
    GROUP BY t.stop_id, bucket
  `).all(params);

  const dayTypeRows = db.connection.prepare(`
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
  const threshold = Number.isFinite(Number(firstParam(query.threshold_percent)))
    ? Number(firstParam(query.threshold_percent))
    : 25;
  const showAll = firstParam(query.all) === 'true';

  const havingSql = showAll ? '' : `
        HAVING ROUND((SUM(CASE WHEN cs.passenger_events > 0 THEN 1 ELSE 0 END) * 100.0) / NULLIF(COUNT(*), 0), 2) < @threshold
      `;

  const rows = db.connection.prepare(`
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

  const rows = db.connection.prepare(`
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

  const hourRows = db.connection.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.pcName, 'brak_pc') AS row_key,
      strftime('%H', COALESCE(t.received_at, t.timestamp)) AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  const weekdayRows = db.connection.prepare(`
    SELECT
      COALESCE(t.line_id, 'brak_linii') || '||' || COALESCE(t.pcName, 'brak_pc') AS row_key,
      ${weekdayNameSqlExpression('COALESCE(t.received_at, t.timestamp)')} AS bucket,
      COALESCE(SUM(t.passenger_events), 0) AS value
    FROM trips t
    ${whereSql}
    GROUP BY row_key, bucket
  `).all(params);

  const dayRows = db.connection.prepare(`
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

  const rows = db.connection.prepare(`
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
    )
    SELECT ta.* FROM trip_agg ta
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
    by_hour: {},
    by_weekday: {}
  }));

  for (const row of reportRows) {
    row.row_key = `${row.line_id || 'brak_linii'}||${row.day_type || 'unknown'}||${row.admin_zone || 'nieokreślona'}`;
  }

  const hourRows = db.connection.prepare(`
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

  const weekdayRows = db.connection.prepare(`
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

async function handleSettings(req, res) {
  const rows = db.connection.prepare('SELECT key, value FROM settings ORDER BY key').all();
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
      isarsoftLatest: 'GET /api/isarsoft/latest',
      stops: 'GET /stops, POST /stops, GET /stops/:id, PUT /stops/:id, DELETE /stops/:id',
      lines: 'GET /lines, POST /lines, GET /lines/:id, PUT /lines/:id, DELETE /lines/:id',
      routes: 'GET /routes, POST /routes, GET /routes/:id, PUT /routes/:id, DELETE /routes/:id',
      routeStops: 'GET /routes/:id/stops, PUT /routes/:id/stops',
      copyDirection: 'POST /routes/:id/copy-direction',
      scheduleTrips: 'GET /trips/schedule, POST /trips/schedule, GET /trips/schedule/:id, PUT /trips/schedule/:id, DELETE /trips/schedule/:id',
      schedule: 'GET /schedules/route?route_id=..., GET /schedules/by-line?line_id=&direction=&day_type=',
      serviceDays: 'GET /service-days',
      holidays: 'GET /holidays, POST /holidays, DELETE /holidays/:date',
      vehicles: 'GET /vehicles, PUT /vehicles/:pcName',
      trackingTrips: 'GET /trips, DELETE /trips',
      reports: 'GET /reports/trip/current, /reports/stop-usage, /reports/on-demand-stops, /reports/line-performance, /reports/admin-zone',
      settings: 'GET /settings'
    }
  });
}

async function routeRequest(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!dbState.ready || !db.connection) {
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
    if (req.method === 'GET' && pathname === '/api/isarsoft/latest') return await handleGetIsarsoftLatest(req, res);

    if (pathname === '/stops') {
      if (req.method === 'POST') return await handleCreateStop(req, res);
      if (req.method === 'GET') return await handleGetStops(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /stops');
    }

    if (pathname.startsWith('/stops/')) {
      const stopId = decodeURIComponent(pathname.substring('/stops/'.length));
      if (!stopId) throw new Error('Brak ID przystanku');
      if (req.method === 'GET') return await handleGetStopById(req, res, stopId);
      if (req.method === 'PUT') return await handleUpdateStop(req, res, stopId);
      if (req.method === 'DELETE') return await handleDeleteStop(req, res, stopId);
      throw new Error('Metoda nieobsługiwana dla /stops/:id');
    }

    if (pathname === '/lines') {
      if (req.method === 'POST') return await handleCreateLine(req, res);
      if (req.method === 'GET') return await handleGetLines(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /lines');
    }

    if (pathname.startsWith('/lines/')) {
      const lineId = decodeURIComponent(pathname.substring('/lines/'.length));
      if (!lineId) throw new Error('Brak ID linii');
      if (req.method === 'GET') return await handleGetLineById(req, res, lineId);
      if (req.method === 'PUT') return await handleUpdateLine(req, res, lineId);
      if (req.method === 'DELETE') return await handleDeleteLine(req, res, lineId);
      throw new Error('Metoda nieobsługiwana dla /lines/:id');
    }

    if (pathname === '/routes') {
      if (req.method === 'POST') return await handleCreateRoute(req, res);
      if (req.method === 'GET') return await handleGetRoutes(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /routes');
    }

    if (pathname.startsWith('/routes/') && pathname.endsWith('/copy-direction')) {
      const routeId = decodeURIComponent(pathname.substring('/routes/'.length, pathname.length - '/copy-direction'.length));
      if (!routeId) throw new Error('Brak ID trasy');
      if (req.method === 'POST') return await handleCopyDirection(req, res, routeId);
      throw new Error('Metoda nieobsługiwana dla /routes/:id/copy-direction');
    }

    if (pathname.startsWith('/routes/') && pathname.endsWith('/stops')) {
      const routeId = decodeURIComponent(pathname.substring('/routes/'.length, pathname.length - '/stops'.length));
      if (!routeId) throw new Error('Brak ID trasy');
      if (req.method === 'PUT') return await handleSetRouteStops(req, res, routeId);
      if (req.method === 'GET') return await handleGetRouteStops(req, res, routeId);
      throw new Error('Metoda nieobsługiwana dla /routes/:id/stops');
    }

    if (pathname.startsWith('/routes/')) {
      const routeId = decodeURIComponent(pathname.substring('/routes/'.length));
      if (!routeId) throw new Error('Brak ID trasy');
      if (req.method === 'GET') return await handleGetRouteById(req, res, routeId);
      if (req.method === 'PUT') return await handleUpdateRoute(req, res, routeId);
      if (req.method === 'DELETE') return await handleDeleteRoute(req, res, routeId);
      throw new Error('Metoda nieobsługiwana dla /routes/:id');
    }

    if (pathname === '/service-days') {
      if (req.method === 'GET') return await handleServiceDays(req, res);
      throw new Error('Metoda nieobsługiwana dla /service-days');
    }

    if (pathname === '/trips/schedule') {
      if (req.method === 'POST') return await handleCreateScheduleTrip(req, res);
      if (req.method === 'GET') return await handleGetScheduleTrips(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /trips/schedule');
    }

    if (pathname.startsWith('/trips/schedule/')) {
      const tripId = decodeURIComponent(pathname.substring('/trips/schedule/'.length));
      if (!tripId) throw new Error('Brak ID kursu');
      if (req.method === 'GET') return await handleGetScheduleTripById(req, res, tripId);
      if (req.method === 'PUT') return await handleUpdateScheduleTrip(req, res, tripId);
      if (req.method === 'DELETE') return await handleDeleteScheduleTrip(req, res, tripId);
      throw new Error('Metoda nieobsługiwana dla /trips/schedule/:id');
    }

    if (pathname === '/schedules/route' || pathname === '/schedules/by-route') {
      const routeId = requiredString(firstParam(query.route_id) || firstParam(query.id), 'route_id');
      if (req.method === 'GET') return await handleGetScheduleByRoute(req, res, routeId);
      throw new Error('Metoda nieobsługiwana dla /schedules/route');
    }

    if (pathname === '/schedules/by-line') {
      if (req.method === 'GET') return await handleGetScheduleByLineAndDirection(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /schedules/by-line');
    }

    if (pathname === '/holidays') {
      if (req.method === 'POST') return await handleCreateHoliday(req, res);
      if (req.method === 'GET') return await handleGetHolidays(req, res);
      throw new Error('Metoda nieobsługiwana dla /holidays');
    }

    if (pathname.startsWith('/holidays/')) {
      const date = decodeURIComponent(pathname.substring('/holidays/'.length));
      if (!date) throw new Error('Brak daty święta');
      if (req.method === 'DELETE') return await handleDeleteHoliday(req, res, date);
      throw new Error('Metoda nieobsługiwana dla /holidays/:date');
    }

    if (pathname === '/vehicles') {
      if (req.method === 'GET') return await handleVehicles(req, res);
      throw new Error('Metoda nieobsługiwana dla /vehicles');
    }

    if (pathname.startsWith('/vehicles/')) {
      const pcName = decodeURIComponent(pathname.substring('/vehicles/'.length));
      if (!pcName) throw new Error('Brak nazwy pojazdu');
      if (req.method === 'PUT') return await handleUpdateVehicle(req, res, pcName);
      throw new Error('Metoda nieobsługiwana dla /vehicles/:pcName');
    }

    if (pathname === '/trips') {
      if (req.method === 'GET') return await handleGetTrips(req, res, query);
      if (req.method === 'DELETE') return await handleDeleteTrips(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /trips');
    }

    if (pathname === '/reports/trip/current') {
      if (req.method === 'GET') return await handleReportsCurrent(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /reports/trip/current');
    }

    if (pathname === '/reports/stop-usage') {
      if (req.method === 'GET') return await handleStopUsageReport(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /reports/stop-usage');
    }

    if (pathname === '/reports/on-demand-stops') {
      if (req.method === 'GET') return await handleOnDemandStopsReport(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /reports/on-demand-stops');
    }

    if (pathname === '/reports/line-performance') {
      if (req.method === 'GET') return await handleLinePerformanceReport(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /reports/line-performance');
    }

    if (pathname === '/reports/admin-zone') {
      if (req.method === 'GET') return await handleAdminZoneReport(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /reports/admin-zone');
    }

    if (pathname === '/settings') {
      if (req.method === 'GET') return await handleSettings(req, res);
      throw new Error('Metoda nieobsługiwana dla /settings');
    }

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

module.exports = {
  routeRequest,
  initScheduleSchema,
  buildFullSchedule,
  computeStopTimes
};