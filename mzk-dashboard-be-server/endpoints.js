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

function validateTimeHHMM(value) {
  return /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(String(value));
}

function normalizeTimeHHMM(value) {
  const text = requiredString(value, 'time');
  if (!validateTimeHHMM(text)) {
    throw new Error(`Nieprawidłowy format godziny: ${text}. Oczekiwano HH:MM`);
  }
  const [h, m] = text.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

function firstParam(value) {
  if (Array.isArray(value)) return value.length ? value[0] : undefined;
  return value;
}

const DAY_TYPES_UPPER = ['WEEKDAY', 'WEEKEND', 'HOLIDAY'];
const SCHEDULE_DIRECTIONS = ['FROM_START', 'TO_START'];

function initScheduleSchema() {
  const conn = db.connection;

  if (!conn) {
    throw new Error('Nie można zainicjalizować schematu: db.connection jest null.');
  }

  // Sprzątamy tabele z poprzedniego modelu (linia -> trasa -> przystanki z minutami dojazdu),
  // zastąpionego przez schedules -> schedule_sides -> schedule_stops (godziny bezwzględne HH:MM).
  conn.exec(`
    DROP TABLE IF EXISTS schedule_trips;
    DROP TABLE IF EXISTS route_stops;
    DROP TABLE IF EXISTS routes;
    DROP TABLE IF EXISTS service_days;
    DROP TABLE IF EXISTS lines;
  `);

  conn.exec(`
    CREATE TABLE IF NOT EXISTS schedule_sides (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('FROM_START', 'TO_START')),
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
      UNIQUE (schedule_id, direction)
    );

    CREATE TABLE IF NOT EXISTS schedule_stops (
      id TEXT PRIMARY KEY,
      side_id TEXT NOT NULL,
      day_type TEXT NOT NULL CHECK (day_type IN ('WEEKDAY', 'WEEKEND', 'HOLIDAY')),
      stop_id TEXT NOT NULL,
      sequence_order INTEGER NOT NULL,
      time TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (side_id) REFERENCES schedule_sides(id) ON DELETE CASCADE,
      FOREIGN KEY (stop_id) REFERENCES stops(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_sides_schedule_id ON schedule_sides(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_stops_side_day ON schedule_stops(side_id, day_type);
    CREATE INDEX IF NOT EXISTS idx_schedule_stops_stop_id ON schedule_stops(stop_id);
  `);
}

initScheduleSchema();

function scheduleFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    line_id: row.line_id || null,
    metadata: jsonParse(row.metadata, {}),
    pcName: row.pcName || null,
    pcId: row.pcId || null,
    active: row.active !== 0,
    updated_at: row.updated_at
  };
}

function scheduleSideFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    schedule_id: row.schedule_id,
    direction: row.direction,
    metadata: jsonParse(row.metadata, {})
  };
}

function scheduleStopFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    side_id: row.side_id,
    day_type: row.day_type,
    stop_id: row.stop_id,
    sequence_order: row.sequence_order,
    time: row.time,
    metadata: jsonParse(row.metadata, {})
  };
}

function findScheduleById(id) {
  return scheduleFromRow(db.connection.prepare('SELECT * FROM schedules WHERE id = ?').get(id));
}

function findScheduleSideById(id) {
  return scheduleSideFromRow(db.connection.prepare('SELECT * FROM schedule_sides WHERE id = ?').get(id));
}

function getScheduleSides(scheduleId) {
  return db.connection.prepare('SELECT * FROM schedule_sides WHERE schedule_id = ? ORDER BY direction').all(scheduleId).map(scheduleSideFromRow);
}

function getScheduleSideStopCounts(sideId) {
  const rows = db.connection.prepare('SELECT day_type, COUNT(*) AS count FROM schedule_stops WHERE side_id = ? GROUP BY day_type').all(sideId);
  const result = { WEEKDAY: 0, WEEKEND: 0, HOLIDAY: 0 };
  for (const row of rows) result[row.day_type] = Number(row.count || 0);
  return result;
}

function getScheduleStopsWithDetails(sideId, dayType) {
  return db.connection.prepare(`
    SELECT ss.*, s.name AS stop_name, s.latitude, s.longitude, s.zone
    FROM schedule_stops ss
    JOIN stops s ON s.id = ss.stop_id
    WHERE ss.side_id = ? AND ss.day_type = ?
    ORDER BY ss.sequence_order
  `).all(sideId, dayType).map(row => ({
    ...scheduleStopFromRow(row),
    stop_name: row.stop_name,
    latitude: row.latitude,
    longitude: row.longitude,
    zone: row.zone
  }));
}

function buildScheduleWithSides(scheduleId) {
  const schedule = findScheduleById(scheduleId);
  if (!schedule) return null;
  const sides = getScheduleSides(scheduleId).map(side => ({
    ...side,
    stop_counts: getScheduleSideStopCounts(side.id)
  }));
  return { ...schedule, sides };
}

function normalizeSchedulePayload(body, existing) {
  const name = requiredString(body.name, 'name');
  return {
    name,
    line_id: optionalString(firstDefined(body.line_id, body.lineId), existing ? existing.line_id || '' : ''),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : (existing ? existing.metadata : {})
  };
}

function normalizeScheduleStopsPayload(sideId, dayType, body) {
  const stops = body.stops;
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
    const time = normalizeTimeHHMM(firstDefined(item.time, item.departure_time, item.arrival_time));
    result.push({
      id: optionalString(item.id, '') || generateId(),
      side_id: sideId,
      day_type: dayType,
      stop_id: stopId,
      sequence_order: i + 1,
      time,
      metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {}
    });
  }
  return result;
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

async function handleCreateSchedule(req, res) {
  const body = await readJsonBody(req);
  const data = normalizeSchedulePayload(body);
  const id = optionalString(body.id, '') || generateId();
  const now = new Date().toISOString();

  const tx = db.connection.transaction(() => {
    db.connection.prepare(`
      INSERT INTO schedules(id, name, line_id, metadata, active, updated_at)
      VALUES(@id, @name, @line_id, @metadata, 1, @updated_at)
    `).run({
      id,
      name: data.name,
      line_id: data.line_id || null,
      metadata: jsonStringify(data.metadata),
      updated_at: now
    });

    const insertSide = db.connection.prepare(`
      INSERT INTO schedule_sides(id, schedule_id, direction, metadata)
      VALUES(?, ?, ?, '{}')
    `);
    for (const direction of SCHEDULE_DIRECTIONS) {
      insertSide.run(generateId(), id, direction);
    }
  });

  tx();

  sendJson(res, 201, {
    ok: true,
    message: 'Rozkład utworzony (z dwoma stronami: tam i powrót)',
    schedule: buildScheduleWithSides(id)
  });
}

async function handleGetSchedules(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(firstParam(query.id), '');
  const lineId = optionalString(firstParam(query.line_id), '');
  const q = optionalString(firstParam(query.q) || firstParam(query.search), '');

  if (id) {
    clauses.push('id = @id');
    params.id = id;
  }
  if (lineId) {
    clauses.push('line_id = @line_id');
    params.line_id = lineId;
  }
  if (q) {
    clauses.push('name LIKE @q');
    params.q = `%${q}%`;
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.connection.prepare(`SELECT * FROM schedules ${whereSql} ORDER BY name COLLATE NOCASE, id`).all(params);
  const schedules = rows.map(row => buildScheduleWithSides(row.id));

  sendJson(res, 200, {
    ok: true,
    count: schedules.length,
    schedules
  });
}

async function handleGetScheduleById(req, res, scheduleId) {
  const schedule = buildScheduleWithSides(scheduleId);
  if (!schedule) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);
  sendJson(res, 200, { ok: true, schedule });
}

async function handleUpdateSchedule(req, res, scheduleId) {
  const existing = findScheduleById(scheduleId);
  if (!existing) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);

  const body = await readJsonBody(req);
  const data = normalizeSchedulePayload(body, existing);

  db.connection.prepare(`
    UPDATE schedules
    SET name = @name, line_id = @line_id, metadata = @metadata, updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: scheduleId,
    name: data.name,
    line_id: data.line_id || null,
    metadata: jsonStringify(data.metadata),
    updated_at: new Date().toISOString()
  });

  sendJson(res, 200, {
    ok: true,
    message: 'Rozkład zaktualizowany',
    schedule: buildScheduleWithSides(scheduleId)
  });
}

async function handleDeleteSchedule(req, res, scheduleId) {
  const info = db.connection.prepare('DELETE FROM schedules WHERE id = ?').run(scheduleId);
  if (info.changes === 0) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);
  sendJson(res, 200, { ok: true, message: 'Rozkład usunięty (kaskadowo usunięto strony i godziny przystanków)', deletedCount: info.changes });
}

async function handleGetScheduleSideStops(req, res, scheduleId, sideId, query) {
  const side = findScheduleSideById(sideId);
  if (!side || side.schedule_id !== scheduleId) throw new Error(`Nie znaleziono strony rozkładu o id: ${sideId}`);

  const dayType = optionalString(firstParam(query.day_type), 'WEEKDAY').toUpperCase();
  if (!DAY_TYPES_UPPER.includes(dayType)) throw new Error(`Nieprawidłowy typ dnia: ${dayType}. Dozwolone: ${DAY_TYPES_UPPER.join(', ')}`);

  const stops = getScheduleStopsWithDetails(sideId, dayType);

  sendJson(res, 200, {
    ok: true,
    side_id: sideId,
    day_type: dayType,
    count: stops.length,
    stops
  });
}

async function handleSetScheduleSideStops(req, res, scheduleId, sideId, query) {
  const side = findScheduleSideById(sideId);
  if (!side || side.schedule_id !== scheduleId) throw new Error(`Nie znaleziono strony rozkładu o id: ${sideId}`);

  const body = await readJsonBody(req);
  const dayType = optionalString(firstDefined(firstParam(query.day_type), body.day_type), 'WEEKDAY').toUpperCase();
  if (!DAY_TYPES_UPPER.includes(dayType)) throw new Error(`Nieprawidłowy typ dnia: ${dayType}. Dozwolone: ${DAY_TYPES_UPPER.join(', ')}`);

  const stops = normalizeScheduleStopsPayload(sideId, dayType, body);

  const tx = db.connection.transaction(() => {
    db.connection.prepare('DELETE FROM schedule_stops WHERE side_id = ? AND day_type = ?').run(sideId, dayType);
    const insert = db.connection.prepare(`
      INSERT INTO schedule_stops(id, side_id, day_type, stop_id, sequence_order, time, metadata)
      VALUES(@id, @side_id, @day_type, @stop_id, @sequence_order, @time, @metadata)
    `);
    for (const st of stops) {
      insert.run({ ...st, metadata: jsonStringify(st.metadata) });
    }
  });

  tx();

  sendJson(res, 200, {
    ok: true,
    message: `Zapisano ${stops.length} przystanków (${dayType})`,
    side_id: sideId,
    day_type: dayType,
    stops: getScheduleStopsWithDetails(sideId, dayType)
  });
}

async function handleCopyScheduleSideStops(req, res, scheduleId, sideId) {
  const targetSide = findScheduleSideById(sideId);
  if (!targetSide || targetSide.schedule_id !== scheduleId) throw new Error(`Nie znaleziono strony rozkładu o id: ${sideId}`);

  const body = await readJsonBody(req);
  const targetDayType = optionalString(body.day_type, 'WEEKDAY').toUpperCase();
  if (!DAY_TYPES_UPPER.includes(targetDayType)) throw new Error(`Nieprawidłowy typ dnia docelowego: ${targetDayType}`);

  const sourceSideId = optionalString(body.source_side_id, '') || sideId;
  const sourceSide = findScheduleSideById(sourceSideId);
  if (!sourceSide || sourceSide.schedule_id !== scheduleId) throw new Error(`Nie znaleziono źródłowej strony rozkładu o id: ${sourceSideId}`);

  const sourceDayType = optionalString(body.source_day_type, targetDayType).toUpperCase();
  if (!DAY_TYPES_UPPER.includes(sourceDayType)) throw new Error(`Nieprawidłowy typ dnia źródłowego: ${sourceDayType}`);

  if (sourceSideId === sideId && sourceDayType === targetDayType) {
    throw new Error('Źródło i cel kopiowania nie mogą być takie same');
  }

  const reverse = body.reverse === true || body.reverse === 'true';

  let sourceStops = db.connection.prepare(`
    SELECT stop_id, time, metadata
    FROM schedule_stops
    WHERE side_id = ? AND day_type = ?
    ORDER BY sequence_order
  `).all(sourceSideId, sourceDayType);

  if (sourceStops.length === 0) {
    throw new Error('Strona źródłowa nie ma zdefiniowanych przystanków dla wskazanego typu dnia');
  }

  if (reverse) sourceStops = sourceStops.slice().reverse();

  const tx = db.connection.transaction(() => {
    db.connection.prepare('DELETE FROM schedule_stops WHERE side_id = ? AND day_type = ?').run(sideId, targetDayType);
    const insert = db.connection.prepare(`
      INSERT INTO schedule_stops(id, side_id, day_type, stop_id, sequence_order, time, metadata)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
    sourceStops.forEach((s, i) => {
      insert.run(generateId(), sideId, targetDayType, s.stop_id, i + 1, s.time, s.metadata || '{}');
    });
  });

  tx();

  sendJson(res, 200, {
    ok: true,
    message: `Skopiowano ${sourceStops.length} przystanków${reverse ? ' (kolejność odwrócona)' : ''}. Zweryfikuj godziny przed zapisaniem.`,
    stops: getScheduleStopsWithDetails(sideId, targetDayType)
  });
}

async function handleServiceDays(req, res) {
  const days = DAY_TYPES_UPPER.map(dt => ({ id: dt, day_type: dt }));

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
  const scheduleId = optionalString(firstDefined(body.schedule_id, body.route_id), '');

  const vehicle = db.connection.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  if (!vehicle) {
    throw new Error(`Nie znaleziono pojazdu o pcName: ${pcName}`);
  }

  let schedule = null;
  if (scheduleId) {
    schedule = findScheduleById(scheduleId);
    if (!schedule) {
      throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);
    }
  }

  const tx = db.connection.transaction(() => {
    // Odepnij pojazd od jakiegokolwiek innego rozkładu, do którego był wcześniej przypisany
    // (silnik śledzenia na żywo szuka rozkładu właśnie po pcName/pcId w tabeli schedules).
    db.connection.prepare(`
      UPDATE schedules SET pcName = NULL, pcId = NULL WHERE pcName = ? AND id != ?
    `).run(pcName, scheduleId || '');

    if (schedule) {
      db.connection.prepare(`
        UPDATE schedules SET pcName = ?, pcId = ?, updated_at = ? WHERE id = ?
      `).run(pcName, vehicle.pcId || '', new Date().toISOString(), scheduleId);
    }

    const existingMetadata = jsonParse(vehicle.metadata, {});
    existingMetadata.schedule_id = scheduleId || null;
    if (schedule) {
      existingMetadata.line_id = schedule.line_id;
      existingMetadata.schedule_name = schedule.name;
    } else {
      delete existingMetadata.line_id;
      delete existingMetadata.schedule_name;
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
  });

  tx();

  const updatedVehicle = db.connection.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  const updatedMetadata = jsonParse(updatedVehicle.metadata, {});

  sendJson(res, 200, {
    ok: true,
    message: 'Przypisanie rozkładu do pojazdu zaktualizowane',
    vehicle: {
      pcName: updatedVehicle.pcName,
      pcId: updatedVehicle.pcId || '',
      schedule_id: updatedMetadata.schedule_id,
      metadata: updatedMetadata
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
      schedule_id: metadata.schedule_id || null,
      schedule_name: metadata.schedule_name || null,
      line_id: metadata.line_id || row.status_line_id || null,
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
      schedules: 'GET /schedules, POST /schedules, GET /schedules/:id, PUT /schedules/:id, DELETE /schedules/:id (każdy rozkład ma 2 strony: FROM_START i TO_START)',
      scheduleSideStops: 'GET /schedules/:id/sides/:sideId/stops?day_type=WEEKDAY|WEEKEND|HOLIDAY, PUT /schedules/:id/sides/:sideId/stops?day_type=... (body: {stops:[{stop_id, time:"HH:MM"}]})',
      copyScheduleSideStops: 'POST /schedules/:id/sides/:sideId/copy (body: {source_side_id?, source_day_type?, day_type, reverse?})',
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

    if (pathname === '/schedules') {
      if (req.method === 'POST') return await handleCreateSchedule(req, res);
      if (req.method === 'GET') return await handleGetSchedules(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /schedules');
    }

    if (pathname.startsWith('/schedules/') && pathname.includes('/sides/') && pathname.endsWith('/copy')) {
      const rest = pathname.substring('/schedules/'.length, pathname.length - '/copy'.length);
      const [scheduleId, , sideId] = rest.split('/').map(decodeURIComponent);
      if (!scheduleId || !sideId) throw new Error('Brak ID rozkładu lub strony');
      if (req.method === 'POST') return await handleCopyScheduleSideStops(req, res, scheduleId, sideId);
      throw new Error('Metoda nieobsługiwana dla /schedules/:id/sides/:sideId/copy');
    }

    if (pathname.startsWith('/schedules/') && pathname.includes('/sides/') && pathname.endsWith('/stops')) {
      const rest = pathname.substring('/schedules/'.length, pathname.length - '/stops'.length);
      const [scheduleId, , sideId] = rest.split('/').map(decodeURIComponent);
      if (!scheduleId || !sideId) throw new Error('Brak ID rozkładu lub strony');
      if (req.method === 'GET') return await handleGetScheduleSideStops(req, res, scheduleId, sideId, query);
      if (req.method === 'PUT') return await handleSetScheduleSideStops(req, res, scheduleId, sideId, query);
      throw new Error('Metoda nieobsługiwana dla /schedules/:id/sides/:sideId/stops');
    }

    if (pathname.startsWith('/schedules/')) {
      const scheduleId = decodeURIComponent(pathname.substring('/schedules/'.length));
      if (!scheduleId) throw new Error('Brak ID rozkładu');
      if (req.method === 'GET') return await handleGetScheduleById(req, res, scheduleId);
      if (req.method === 'PUT') return await handleUpdateSchedule(req, res, scheduleId);
      if (req.method === 'DELETE') return await handleDeleteSchedule(req, res, scheduleId);
      throw new Error('Metoda nieobsługiwana dla /schedules/:id');
    }

    if (pathname === '/service-days') {
      if (req.method === 'GET') return await handleServiceDays(req, res);
      throw new Error('Metoda nieobsługiwana dla /service-days');
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
  initScheduleSchema
};