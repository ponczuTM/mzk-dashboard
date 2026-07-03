'use strict';

const url = require('url');
const crypto = require('crypto');

const sqlite = require('./sqlite');
const funcs = require('./functions');

const {
  db,
  dbState,
  DAY_TYPES,
  DIRECTIONS,
  GEOFENCE_RADIUS_METERS,
  PUNCTUALITY_TOLERANCE_SECONDS,
  SYNC_INTERVAL_MS,
  FRAME_HISTORY_LIMIT_IN_DB,
  DB_FILE,
  DB_ROOT,
  PORT,
  haversineMeters,
  pruneHistory,
  getPolishPublicHolidayKeys
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
  extractCoordinates,
  normalizeStop,
  stopFromRow,
  findStopById,
  findActiveScheduleForVehicle,
  buildTripsWhere,
  summarizeDataQualitySql,
  weekdayNameSqlExpression,
  addDistribution,
  tripFromRow,
  reportResponse,
  analyzeVehiclePayload,
  logReceivedDataConsole
} = funcs;

// ---------- NADPISUJEMY FUNKCJE DOTYCZĄCE ROZKŁADÓW ----------
function generateScheduleId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Normalizuje payload rozkładu jazdy z dwoma kierunkami.
 * Oczekiwane body:
 * {
 *   name: string,
 *   day_types: {
 *     weekday: {
 *       outbound: [ { stop_id, time }, ... ],
 *       inbound: [ { stop_id, time }, ... ]
 *     },
 *     weekend: { ... },
 *     holiday: { ... }
 *   },
 *   schedule_id?: string,
 *   metadata?: object
 * }
 */
function normalizeSchedulePayload(body, existingScheduleId) {
  const name = requiredString(body.name, 'name');
  const dayTypes = body.day_types || {};
  if (typeof dayTypes !== 'object' || Array.isArray(dayTypes)) {
    throw new Error('day_types musi być obiektem z kluczami weekday, weekend, holiday');
  }

  const scheduleId = existingScheduleId || body.schedule_id || generateScheduleId();

  const normalizedDayTypes = {};
  for (const dayType of DAY_TYPES) {
    const dirs = dayTypes[dayType] || {};
    const normalizedDirs = {};

    // Obsługa każdego kierunku
    for (const direction of DIRECTIONS) {
      let stops = dirs[direction];
      if (!Array.isArray(stops)) {
        stops = [];
      }
      const validated = stops.map((item, index) => {
        const stopId = requiredString(item.stop_id, `day_types.${dayType}.${direction}[${index}].stop_id`);
        const time = requiredString(item.time, `day_types.${dayType}.${direction}[${index}].time`);
        if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
          throw new Error(`Nieprawidłowy format czasu: ${time}, oczekiwano HH:MM`);
        }
        return { stop_id: stopId, time };
      });
      normalizedDirs[direction] = validated;
    }

    // Jeśli nie podano któregoś kierunku, ustawiamy pustą tablicę
    for (const direction of DIRECTIONS) {
      if (!normalizedDirs[direction]) normalizedDirs[direction] = [];
    }

    normalizedDayTypes[dayType] = normalizedDirs;
  }

  const metadata = body.metadata || {};
  metadata.created_at = metadata.created_at || new Date().toISOString();
  metadata.updated_at = new Date().toISOString();

  return {
    schedule_id: scheduleId,
    name,
    day_types: normalizedDayTypes,
    metadata,
    line_id: null,
    route_name: name,
    pcName: null,
    pcId: null,
    active: 1,
    updated_at: metadata.updated_at
  };
}

/**
 * Tworzy obiekt rozkładu z wierszy bazy danych.
 * sequence_json przechowuje obiekt: { outbound: [...], inbound: [...] }
 */
function scheduleFromRows(rows) {
  if (!rows || rows.length === 0) return null;

  const first = rows[0];
  const baseId = jsonParse(first.metadata, {}).schedule_id || String(first.id).split(':')[0];
  const name = first.route_name || '';

  const dayTypes = {};
  for (const row of rows) {
    const dayType = row.day_type;
    if (!DAY_TYPES.includes(dayType)) continue;
    let sequence = {};
    try {
      const parsed = JSON.parse(row.sequence_json || '{}');
      // Jeśli to stary format (tablica), konwertujemy na obiekt z outbound
      if (Array.isArray(parsed)) {
        sequence = { outbound: parsed, inbound: [] };
      } else if (typeof parsed === 'object' && parsed !== null) {
        sequence = {
          outbound: Array.isArray(parsed.outbound) ? parsed.outbound : [],
          inbound: Array.isArray(parsed.inbound) ? parsed.inbound : []
        };
      } else {
        sequence = { outbound: [], inbound: [] };
      }
    } catch (_) {
      sequence = { outbound: [], inbound: [] };
    }
    dayTypes[dayType] = sequence;
  }

  // Uzupełnij brakujące typy dni
  for (const dayType of DAY_TYPES) {
    if (!dayTypes[dayType]) {
      dayTypes[dayType] = { outbound: [], inbound: [] };
    }
  }

  // POPRAWA: zwracamy pole 'schedule_id' zamiast 'id', aby było zgodne z frontendem
  return {
    schedule_id: baseId,  // <-- zmiana
    name,
    day_types: dayTypes,
    metadata: jsonParse(first.metadata, {}),
    created_at: jsonParse(first.metadata, {}).created_at || first.updated_at,
    updated_at: first.updated_at
  };
}

/**
 * Znajduje wszystkie wiersze rozkładu dla danego baseId.
 */
function findScheduleRowsByBaseId(baseId) {
  return db.connection.prepare('SELECT * FROM schedules WHERE id LIKE ?').all(`${baseId}:%`);
}

/**
 * Zapisuje rozkład (dla każdego dnia i każdego kierunku).
 * sequence_json to obiekt { outbound: [...], inbound: [...] }.
 */
function saveSchedule(schedule) {
  const conn = db.connection;
  const insert = conn.prepare(`
    INSERT INTO schedules(
      id, line_id, route_name, day_type, sequence_json,
      metadata, pcName, pcId, active, updated_at
    ) VALUES(
      @id, @line_id, @route_name, @day_type, @sequence_json,
      @metadata, @pcName, @pcId, @active, @updated_at
    )
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

  const tx = conn.transaction(() => {
    // Usuwamy stare wiersze dla tego schedule_id
    conn.prepare('DELETE FROM schedules WHERE id LIKE ?').run(`${schedule.schedule_id}:%`);

    // Zapisujemy dla każdego typu dnia
    for (const dayType of DAY_TYPES) {
      const dirs = schedule.day_types[dayType] || { outbound: [], inbound: [] };
      // Upewniamy się, że oba kierunki istnieją
      const outbound = Array.isArray(dirs.outbound) ? dirs.outbound : [];
      const inbound = Array.isArray(dirs.inbound) ? dirs.inbound : [];
      const sequenceObj = { outbound, inbound };

      insert.run({
        id: `${schedule.schedule_id}:${dayType}`,
        line_id: null,
        route_name: schedule.name,
        day_type: dayType,
        sequence_json: JSON.stringify(sequenceObj),
        metadata: JSON.stringify({
          ...schedule.metadata,
          day_type: dayType,
          schedule_id: schedule.schedule_id
        }),
        pcName: null,
        pcId: null,
        active: 1,
        updated_at: schedule.updated_at
      });
    }
  });

  tx();
}

// ---------- NOWY ENDPOINT: KOPIOWANIE KIERUNKU ----------
async function handleCopyDirection(req, res, scheduleId) {
  const body = await readJsonBody(req);
  const source = requiredString(body.source, 'source');
  const target = requiredString(body.target, 'target');
  const reverse = body.reverse === true || body.reverse === 'true';

  if (!DIRECTIONS.includes(source)) {
    throw new Error(`Nieprawidłowy kierunek źródłowy: ${source}. Dozwolone: ${DIRECTIONS.join(', ')}`);
  }
  if (!DIRECTIONS.includes(target)) {
    throw new Error(`Nieprawidłowy kierunek docelowy: ${target}. Dozwolone: ${DIRECTIONS.join(', ')}`);
  }
  if (source === target) {
    throw new Error('Kierunek źródłowy i docelowy muszą być różne.');
  }

  // Pobierz istniejący rozkład
  const existing = scheduleFromRows(findScheduleRowsByBaseId(scheduleId));
  if (!existing) {
    throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);
  }

  // Dla każdego typu dnia skopiuj listę z source do target (opcjonalnie odwracając)
  const updatedDayTypes = {};
  for (const dayType of DAY_TYPES) {
    const dirs = existing.day_types[dayType] || { outbound: [], inbound: [] };
    const sourceList = dirs[source] || [];
    let targetList = sourceList.slice(); // kopia
    if (reverse) {
      targetList = targetList.slice().reverse();
    }
    // Budujemy nowy obiekt dla tego dnia
    const newDirs = {
      outbound: dirs.outbound,
      inbound: dirs.inbound
    };
    newDirs[target] = targetList;
    updatedDayTypes[dayType] = newDirs;
  }

  // Przygotuj zaktualizowany rozkład
  const updatedSchedule = {
    schedule_id: existing.schedule_id,  // POPRAWA: używamy schedule_id
    name: existing.name,
    day_types: updatedDayTypes,
    metadata: {
      ...existing.metadata,
      updated_at: new Date().toISOString()
    },
    updated_at: new Date().toISOString()
  };

  // Zapisz
  saveSchedule(updatedSchedule);

  // Zwróć zaktualizowany rozkład
  const saved = scheduleFromRows(findScheduleRowsByBaseId(scheduleId));
  sendJson(res, 200, {
    ok: true,
    message: `Skopiowano kierunek ${source} -> ${target}${reverse ? ' (odwrócono)' : ''}`,
    schedule: saved
  });
}

// ---------- POZOSTAŁE HANDLERY (stops, vehicles, holidays, trips, reports) ----------
// (reszta bez zmian, ale dla kompletności zamieszczam cały plik)

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
  console.log('[handleIncomingData] Otrzymano payload z Isarsoft. Rozmiar:', JSON.stringify(payload).length);

  latestIsarsoftData = payload;
  console.log('[handleIncomingData] Zapisano w cache. Czy dane mają applications?', !!payload?.applications);

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

let latestIsarsoftData = null;

async function handleGetIsarsoftLatest(req, res) {
  console.log('[handleGetIsarsoftLatest] Wywołano endpoint, latestIsarsoftData:', !!latestIsarsoftData);
  if (!latestIsarsoftData) {
    console.log('[handleGetIsarsoftLatest] Brak danych w cache');
    sendJson(res, 404, {
      ok: false,
      error: 'Brak danych Isarsoft – jeszcze nie odebrano żadnego pakietu.'
    });
    return;
  }
  console.log('[handleGetIsarsoftLatest] applications:', latestIsarsoftData.applications?.length);
  console.log('[handleGetIsarsoftLatest] lines:', latestIsarsoftData.lines?.length);
  console.log('[handleGetIsarsoftLatest] areas:', latestIsarsoftData.areas?.length);
  console.log('[handleGetIsarsoftLatest] cameras:', latestIsarsoftData.cameras?.length);

  sendJson(res, 200, {
    ok: true,
    data: latestIsarsoftData
  });
}

// ---------- HANDLERY PRZYSTANKÓW ----------
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

// ---------- HANDLERY ROZKŁADÓW ----------
async function handleCreateSchedule(req, res) {
  const body = await readJsonBody(req);
  const normalized = normalizeSchedulePayload(body);
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

  const id = optionalString(query.id, '');
  const name = optionalString(query.name || query.q, '');
  const dayType = optionalString(query.day_type || query.dayType, '');

  if (id) {
    clauses.push('id LIKE @idPattern');
    params.idPattern = `${id}:%`;
  }
  if (name) {
    clauses.push('route_name LIKE @name');
    params.name = `%${name}%`;
  }
  if (dayType) {
    clauses.push('day_type = @dayType');
    params.dayType = dayType;
  }

  clauses.push('active = 1');

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.connection.prepare(`
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
    const sched = scheduleFromRows(groupRows);
    if (sched) schedules.push(sched);
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
  const updated = normalizeSchedulePayload(body, scheduleId);
  updated.metadata.created_at = existing.metadata.created_at || updated.metadata.created_at;
  updated.metadata.updated_at = new Date().toISOString();
  updated.updated_at = updated.metadata.updated_at;

  saveSchedule(updated);

  sendJson(res, 200, {
    ok: true,
    message: 'Schedule updated',
    schedule: scheduleFromRows(findScheduleRowsByBaseId(scheduleId))
  });
}

async function handleDeleteSchedule(req, res, scheduleId) {
  const info = db.connection.prepare('DELETE FROM schedules WHERE id LIKE ?').run(`${scheduleId}:%`);
  if (info.changes === 0) throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);

  sendJson(res, 200, { ok: true, message: 'Schedule deleted', deletedCount: info.changes });
}

// ---------- HANDLERY POJAZDÓW ----------
async function handleUpdateVehicle(req, res, pcName) {
  const body = await readJsonBody(req);
  const scheduleId = optionalString(body.schedule_id, '');

  const vehicle = db.connection.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  if (!vehicle) {
    throw new Error(`Nie znaleziono pojazdu o pcName: ${pcName}`);
  }

  if (scheduleId) {
    const scheduleRows = findScheduleRowsByBaseId(scheduleId);
    if (scheduleRows.length === 0) {
      throw new Error(`Nie znaleziono rozkładu o id: ${scheduleId}`);
    }
  }

  const existingMetadata = jsonParse(vehicle.metadata, {});
  existingMetadata.schedule_id = scheduleId || null;
  existingMetadata.updated_at = new Date().toISOString();

  db.connection.prepare(`
    UPDATE vehicles
    SET metadata = @metadata
    WHERE pcName = @pcName
  `).run({
    pcName,
    metadata: jsonStringify(existingMetadata)
  });

  const updatedVehicle = db.connection.prepare('SELECT * FROM vehicles WHERE pcName = ?').get(pcName);
  sendJson(res, 200, {
    ok: true,
    message: 'Vehicle schedule updated',
    vehicle: {
      pcName: updatedVehicle.pcName,
      pcId: updatedVehicle.pcId || '',
      schedule_id: existingMetadata.schedule_id || null,
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

// ---------- POZOSTAŁE HANDLERY (holidays, trips, reports) ----------
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

async function handleGetTrips(req, res, query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(query.limit, 10) || 100));
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
  const pcName = optionalString(query.pcName || query.pc_name, '');
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
  const threshold = Number.isFinite(Number(query.threshold_percent))
    ? Number(query.threshold_percent)
    : 25;
  const showAll = query.all === 'true';

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
      copyDirection: 'POST /schedules/:id/copy-direction',
      createHoliday: 'POST /holidays',
      listHolidays: 'GET /holidays',
      deleteHoliday: 'DELETE /holidays/:date',
      getTrips: 'GET /trips?page=1&limit=100&pcName=...&line_id=...&stop_id=...&start=...&end=...',
      deleteTrips: 'DELETE /trips?all=true lub ?before=YYYY-MM-DD',
      vehicles: 'GET /vehicles',
      updateVehicle: 'PUT /vehicles/:pcName',
      settings: 'GET /settings',
      currentTrip: 'GET /reports/trip/current',
      stopUsage: 'GET /reports/stop-usage',
      onDemandStops: 'GET /reports/on-demand-stops',
      linePerformance: 'GET /reports/line-performance',
      adminZone: 'GET /reports/admin-zone',
      isarsoftLatest: 'GET /api/isarsoft/latest'
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

    // NOWY ENDPOINT: kopiowanie kierunku
    if (pathname.startsWith('/schedules/') && pathname.endsWith('/copy-direction')) {
      const scheduleId = decodeURIComponent(pathname.substring('/schedules/'.length, pathname.length - '/copy-direction'.length));
      if (!scheduleId) throw new Error('Brak ID rozkładu');
      if (req.method === 'POST') return await handleCopyDirection(req, res, scheduleId);
      throw new Error('Metoda nieobsługiwana dla /schedules/:id/copy-direction');
    }

    // Obsługa /vehicles/:pcName (PUT)
    if (pathname.startsWith('/vehicles/') && pathname !== '/vehicles') {
      const pcName = decodeURIComponent(pathname.substring('/vehicles/'.length));
      if (!pcName) throw new Error('Brak nazwy pojazdu');
      if (req.method === 'PUT') return await handleUpdateVehicle(req, res, pcName);
      throw new Error('Metoda nieobsługiwana dla /vehicles/:pcName');
    }

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

module.exports = {
  routeRequest
};