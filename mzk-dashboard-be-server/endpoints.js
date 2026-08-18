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
  pruneHistory,
  formatDateKey,
  DAY_TYPES_UPPER
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
  toFiniteInt,
  normalizeStop,
  stopFromRow,
  findStopById,
  normalizeTimeHHMM,
  buildTripsWhere,
  weekdayNameSqlExpression,
  addDistribution,
  tripFromRow,
  reportResponse,
  analyzeVehiclePayload,
  logReceivedDataConsole,
  determineDayType,
  timeToSeconds,
  getRouteStopsCumulative,
  secondsToHHMM,
  buildVehicleDaySequence
} = funcs;

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

function firstParam(value) {
  if (Array.isArray(value)) return value.length ? value[0] : undefined;
  return value;
}

const SCHEDULE_DAY_TYPES = DAY_TYPES_UPPER;

// =====================================================================
//  MODEL: TRASA (route) -> uporządkowane przystanki z offsetem minut
//         KURS (trip_assignment) -> pojazd + trasa + start + typ dnia
// =====================================================================

// --------------------- KONWERSJE WIERSZY ---------------------
function routeFromRow(row) {
  if (!row) return null;
  const isActive = row.isActive !== 0;
  return {
    id: row.id,
    name: row.name,
    code: row.code || null,
    color: row.color || '#3B82F6',
    isActive,
    active: isActive, // alias zgodności wstecznej dla starszych widoków
    metadata: jsonParse(row.metadata, {})
  };
}

function routeStopViewFromCumulative(rs) {
  const metadata = jsonParse(rs.stop_metadata, {});
  return {
    stop_id: rs.stop_id,
    id: rs.stop_id,
    sequence_order: rs.sequence_order,
    minutes_from_previous: rs.minutes_from_previous,
    offset_minutes: Math.round(rs.offset_seconds / 60),
    name: rs.stop_name,
    number: metadata.number || '',
    latitude: rs.latitude,
    longitude: rs.longitude,
    lat: rs.latitude,
    lng: rs.longitude,
    admin_zone: rs.zone || metadata.admin_zone || 'nieokreślona',
    zone: rs.zone || 'nieokreślona',
    zone_type: metadata.zone_type || 'nieokreślony'
  };
}

function assignmentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    pcName: row.pcName,
    route_id: row.route_id,
    day_type: row.day_type,
    start_time: row.start_time,
    date: row.date || null,
    block_id: row.block_id || null,
    metadata: jsonParse(row.metadata, {})
  };
}

// --------------------- POBIERANIE ---------------------
function findRouteById(id) {
  return routeFromRow(db.connection.prepare('SELECT * FROM routes WHERE id = ?').get(id));
}

function findAssignmentById(id) {
  return assignmentFromRow(db.connection.prepare('SELECT * FROM trip_assignments WHERE id = ?').get(id));
}

// Buduje pełny obiekt trasy wraz z uporządkowanymi przystankami i skumulowanymi
// offsetami (w minutach) — czyli tym, co front pokazuje jako "rozkład" trasy.
function buildRouteTree(routeId) {
  const route = findRouteById(routeId);
  if (!route) return null;
  const stops = getRouteStopsCumulative(routeId).map(routeStopViewFromCumulative);
  const totalMinutes = stops.length ? stops[stops.length - 1].offset_minutes : 0;
  return {
    ...route,
    stops,
    stop_count: stops.length,
    total_minutes: totalMinutes
  };
}

function buildRouteTrees(routeIds) {
  const conn = db.connection;
  const rows = routeIds
    ? (routeIds.length
        ? conn.prepare(`SELECT * FROM routes WHERE id IN (${routeIds.map(() => '?').join(',')}) ORDER BY name COLLATE NOCASE`).all(...routeIds)
        : [])
    : conn.prepare('SELECT * FROM routes ORDER BY name COLLATE NOCASE').all();

  return rows.map(row => {
    const route = routeFromRow(row);
    const stops = getRouteStopsCumulative(route.id).map(routeStopViewFromCumulative);
    return {
      ...route,
      stops,
      stop_count: stops.length,
      total_minutes: stops.length ? stops[stops.length - 1].offset_minutes : 0
    };
  });
}

// --------------------- NORMALIZACJA PAYLOADÓW ---------------------
function normalizeRoutePayload(body, existing) {
  const name = requiredString(body.name, 'name');
  return {
    name,
    code: optionalString(body.code, existing ? existing.code || '' : '') || null,
    color: optionalString(body.color, existing ? existing.color : '#3B82F6') || '#3B82F6',
    isActive: body.isActive !== undefined ? Boolean(body.isActive) : (body.active !== undefined ? Boolean(body.active) : (existing ? existing.isActive : true)),
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : (existing ? existing.metadata : {})
  };
}

// Przystanki trasy: [{stop_id, minutes_from_previous}] w KOLEJNOŚCI.
// Pierwszy przystanek ma z definicji minutes_from_previous = 0.
function normalizeRouteStopsPayload(routeId, stops) {
  // Jeśli brak lub pusta tablica – zwróć pustą tablicę (dla tworzenia trasy bez przystanków)
  if (!Array.isArray(stops) || stops.length === 0) {
    return [];
  }

  return stops.map((item, i) => {
    const entry = item || {};
    const stopId = requiredString(firstDefined(entry.stop_id, entry.id), `stops[${i}].stop_id`);
    if (!findStopById(stopId)) {
      throw new Error(`Nie znaleziono przystanku o id: ${stopId}`);
    }

    let minutes;
    if (i === 0) {
      minutes = 0; // pierwszy przystanek zawsze 0
    } else {
      const raw = firstDefined(entry.minutes_from_previous, entry.minutes, entry.offset_minutes, entry.time);
      minutes = toFiniteInt(raw);
      if (minutes === null) {
        throw new Error(`stops[${i}].minutes_from_previous musi być liczbą minut (>= 0)`);
      }
      if (minutes < 0) {
        throw new Error(`stops[${i}].minutes_from_previous nie może być ujemne`);
      }
    }

    return {
      id: generateId(),
      route_id: routeId,
      stop_id: stopId,
      sequence_order: i + 1,
      minutes_from_previous: minutes,
      metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : {}
    };
  });
}

function replaceRouteStops(routeId, stops) {
  const conn = db.connection;
  conn.prepare('DELETE FROM route_stops WHERE route_id = ?').run(routeId);
  const insert = conn.prepare(`
    INSERT INTO route_stops(id, route_id, stop_id, sequence_order, minutes_from_previous, metadata)
    VALUES(@id, @route_id, @stop_id, @sequence_order, @minutes_from_previous, @metadata)
  `);
  for (const stop of stops) {
    insert.run({ ...stop, metadata: jsonStringify(stop.metadata) });
  }
}

// =====================================================================
//  HANDLERY: infrastruktura / dane wejściowe
// =====================================================================
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
    // Wyliczony przyrost (delta) względem ostatniego znanego stanu licznika
    // kamery — patrz functions.js#processPassengerCounts. currentStatus
    // zawiera te same dane zagnieżdżone w polu `passengers`.
    passengerCount: {
      raw_in: result.status.passengers?.raw_in ?? null,
      raw_out: result.status.passengers?.raw_out ?? null,
      delta_in: result.status.passengers?.delta_in ?? 0,
      delta_out: result.status.passengers?.delta_out ?? 0,
      current_occupancy: result.status.passengers?.current_occupancy ?? 0,
      reset_detected: Boolean(result.status.passengers?.reset_detected)
    },
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

// =====================================================================
//  HANDLERY: PRZYSTANKI
// =====================================================================
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

// =====================================================================
//  HANDLERY: TRASY (routes)
// =====================================================================

// POST /api/routes
// body: { name, code?, color?, isActive?, stops:[{stop_id, minutes_from_previous}] }
async function handleCreateRoute(req, res) {
  const body = await readJsonBody(req);
  const data = normalizeRoutePayload(body);
  const id = optionalString(body.id, '') || generateId();
  const stops = normalizeRouteStopsPayload(id, body.stops);

  const tx = db.connection.transaction(() => {
    db.connection.prepare(`
      INSERT INTO routes(id, name, code, color, isActive, metadata)
      VALUES(@id, @name, @code, @color, @isActive, @metadata)
    `).run({
      id,
      name: data.name,
      code: data.code,
      color: data.color,
      isActive: data.isActive ? 1 : 0,
      metadata: jsonStringify(data.metadata)
    });

    replaceRouteStops(id, stops);
  });

  tx();

  sendJson(res, 201, {
    ok: true,
    message: `Trasa utworzona z ${stops.length} przystankami`,
    route: buildRouteTree(id)
  });
}

async function handleGetRoutes(req, res, query) {
  const clauses = [];
  const params = {};

  const id = optionalString(firstParam(query.id), '');
  const q = optionalString(firstParam(query.q) || firstParam(query.search), '');
  const activeParam = firstDefined(firstParam(query.active), firstParam(query.isActive));

  if (id) {
    clauses.push('id = @id');
    params.id = id;
  }
  if (q) {
    clauses.push('(name LIKE @q OR code LIKE @q)');
    params.q = `%${q}%`;
  }
  if (activeParam !== undefined) {
    clauses.push('isActive = @isActive');
    params.isActive = (activeParam === 'true' || activeParam === '1') ? 1 : 0;
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const idRows = db.connection.prepare(`SELECT id FROM routes ${whereSql} ORDER BY name COLLATE NOCASE`).all(params);
  const routes = buildRouteTrees(idRows.map(row => row.id));

  sendJson(res, 200, {
    ok: true,
    count: routes.length,
    routes
  });
}

async function handleGetRouteById(req, res, routeId) {
  const route = buildRouteTree(routeId);
  if (!route) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);
  sendJson(res, 200, { ok: true, route });
}

// PUT /api/routes/:id — aktualizuje metadane trasy; jeśli body.stops podane,
// zastępuje CAŁĄ sekwencję przystanków.
async function handleUpdateRoute(req, res, routeId) {
  const existing = findRouteById(routeId);
  if (!existing) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const body = await readJsonBody(req);
  const data = normalizeRoutePayload(body, existing);
  const hasStops = body.stops !== undefined;
  const stops = hasStops ? normalizeRouteStopsPayload(routeId, body.stops) : null;

  const tx = db.connection.transaction(() => {
    db.connection.prepare(`
      UPDATE routes
      SET name = @name, code = @code, color = @color, isActive = @isActive, metadata = @metadata
      WHERE id = @id
    `).run({
      id: routeId,
      name: data.name,
      code: data.code,
      color: data.color,
      isActive: data.isActive ? 1 : 0,
      metadata: jsonStringify(data.metadata)
    });

    if (hasStops) replaceRouteStops(routeId, stops);
  });

  tx();

  sendJson(res, 200, {
    ok: true,
    message: hasStops ? 'Trasa zaktualizowana (wraz z przystankami)' : 'Trasa zaktualizowana',
    route: buildRouteTree(routeId)
  });
}

// PUT /api/routes/:id/stops — zastępuje tylko listę przystanków trasy.
async function handleReplaceRouteStops(req, res, routeId) {
  const existing = findRouteById(routeId);
  if (!existing) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);

  const body = await readJsonBody(req);
  const stops = normalizeRouteStopsPayload(routeId, body.stops);

  const tx = db.connection.transaction(() => {
    replaceRouteStops(routeId, stops);
  });
  tx();

  sendJson(res, 200, {
    ok: true,
    message: `Zaktualizowano przystanki trasy (${stops.length})`,
    route: buildRouteTree(routeId)
  });
}

async function handleDeleteRoute(req, res, routeId) {
  const info = db.connection.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
  if (info.changes === 0) throw new Error(`Nie znaleziono trasy o id: ${routeId}`);
  sendJson(res, 200, {
    ok: true,
    message: 'Trasa usunięta (kaskadowo usunięto jej przystanki oraz przypisane kursy)',
    deletedCount: info.changes
  });
}

// =====================================================================
//  HANDLERY: KURSY / PRZYPISANIA (trip_assignments)
// =====================================================================

// Normalizuje pojedynczy kurs do przypisania: {route_id, start_time, day_type?, block_id?}
function normalizeAssignmentEntry(entry, defaults, index) {
  const obj = entry || {};
  const routeId = requiredString(firstDefined(obj.route_id, obj.routeId, defaults.route_id), `assignments[${index}].route_id`);
  if (!findRouteById(routeId)) {
    throw new Error(`Nie znaleziono trasy o id: ${routeId}`);
  }

  const startTime = normalizeTimeHHMM(requiredString(firstDefined(obj.start_time, obj.start, obj.departure_time), `assignments[${index}].start_time`));

  const dayTypeRaw = optionalString(firstDefined(obj.day_type, obj.dayType, defaults.day_type), '').toUpperCase();
  if (!dayTypeRaw) throw new Error(`Brak day_type dla assignments[${index}]`);
  if (!SCHEDULE_DAY_TYPES.includes(dayTypeRaw)) {
    throw new Error(`Nieprawidłowy typ dnia: ${dayTypeRaw}. Dozwolone: ${SCHEDULE_DAY_TYPES.join(', ')}`);
  }

  const blockId = optionalString(firstDefined(obj.block_id, obj.brigade), '') || null;
  const metadata = obj.metadata && typeof obj.metadata === 'object' ? obj.metadata : {};

  return {
    route_id: routeId,
    start_time: startTime,
    day_type: dayTypeRaw,
    block_id: blockId,
    metadata
  };
}

// POST /api/vehicles/assign-trips
// Przypisuje pojazdowi (pcName) listę KURSÓW = (trasa + godzina startu + typ dnia).
// body:
// {
//   pcName,
//   date?: "YYYY-MM-DD",            // globalny domyślny date dla wszystkich kursów
//   day_type?: "WEEKDAY",          // globalny domyślny typ dnia
//   route_id?: "...",              // globalna domyślna trasa
//   replace?: true,                // jeśli true -> usuwa istniejące przypisania pojazdu
//                                  //   dla (day_type, date) przed wstawieniem nowych
//   assignments: [ {route_id, start_time, day_type?, block_id?}, ... ]
// }
async function handleAssignVehicleTrips(req, res) {
  const body = await readJsonBody(req);
  const pcName = requiredString(body.pcName, 'pcName');

  const rawAssignments = Array.isArray(body.assignments)
    ? body.assignments
    : (Array.isArray(body.trips) ? body.trips : null);

  if (!rawAssignments || rawAssignments.length === 0) {
    throw new Error('assignments musi być niepustą tablicą kursów {route_id, start_time, day_type}');
  }

  const globalDate = optionalString(body.date, '') || null;
  if (globalDate && !/^\d{4}-\d{2}-\d{2}$/.test(globalDate)) {
    throw new Error('Pole date musi mieć format YYYY-MM-DD albo być puste (przypisanie stałe/szablonowe)');
  }

  const defaults = {
    route_id: optionalString(body.route_id, '') || undefined,
    day_type: optionalString(body.day_type, '') || undefined
  };

  const normalized = rawAssignments.map((entry, i) => {
    const item = normalizeAssignmentEntry(entry, defaults, i);
    const entryDate = optionalString((entry || {}).date, globalDate === null ? '' : globalDate) || null;
    if (entryDate && !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      throw new Error(`assignments[${i}].date musi mieć format YYYY-MM-DD`);
    }
    return { ...item, date: entryDate };
  });

  const now = new Date().toISOString();
  const replace = Boolean(body.replace);

  const tx = db.connection.transaction(() => {
    db.connection.prepare(`
      INSERT INTO vehicles(pcName, first_seen, last_seen, metadata)
      VALUES(@pcName, @now, @now, '{}')
      ON CONFLICT(pcName) DO NOTHING
    `).run({ pcName, now });

    if (replace) {
      // Usuwamy istniejące przypisania pojazdu w zakresie (day_type, date)
      // reprezentowanym przez nowe kursy.
      const del = db.connection.prepare(`
        DELETE FROM trip_assignments
        WHERE pcName = ? AND day_type = ? AND ((date IS NULL AND ? IS NULL) OR date = ?)
      `);
      const seen = new Set();
      for (const a of normalized) {
        const key = `${a.day_type}||${a.date || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        del.run(pcName, a.day_type, a.date, a.date);
      }
    }

    const insert = db.connection.prepare(`
      INSERT INTO trip_assignments(id, pcName, route_id, day_type, start_time, date, block_id, metadata)
      VALUES(@id, @pcName, @route_id, @day_type, @start_time, @date, @block_id, @metadata)
    `);

    // Deduplikacja identycznych kursów (trasa+start+day_type+date) w ramach żądania.
    const dedup = new Set();
    const insertedIds = [];
    for (const a of normalized) {
      const key = `${a.route_id}||${a.start_time}||${a.day_type}||${a.date || ''}`;
      if (dedup.has(key)) continue;
      dedup.add(key);

      // Jeśli nie replace — usuwamy ewentualny dokładny duplikat już w bazie,
      // by uniknąć podwójnych identycznych kursów.
      if (!replace) {
        db.connection.prepare(`
          DELETE FROM trip_assignments
          WHERE pcName = ? AND route_id = ? AND start_time = ? AND day_type = ?
            AND ((date IS NULL AND ? IS NULL) OR date = ?)
        `).run(pcName, a.route_id, a.start_time, a.day_type, a.date, a.date);
      }

      const id = generateId();
      insert.run({
        id,
        pcName,
        route_id: a.route_id,
        day_type: a.day_type,
        start_time: a.start_time,
        date: a.date,
        block_id: a.block_id,
        metadata: jsonStringify(a.metadata)
      });
      insertedIds.push(id);
    }

    return insertedIds;
  });

  const insertedIds = tx();

  const assignments = insertedIds.length
    ? db.connection.prepare(`
        SELECT * FROM trip_assignments
        WHERE id IN (${insertedIds.map(() => '?').join(',')})
        ORDER BY day_type, start_time
      `).all(...insertedIds).map(assignmentFromRow)
    : [];

  sendJson(res, 200, {
    ok: true,
    message: `Przypisano ${assignments.length} kurs(ów) do pojazdu ${pcName}`,
    pcName,
    replace,
    assignments
  });
}

// GET /api/vehicles/:pcName/assignments?day_type=&date=
// Lista surowych przypisań (kursów) pojazdu.
async function handleGetVehicleAssignments(req, res, pcName, query) {
  const vehicle = db.connection.prepare('SELECT pcName FROM vehicles WHERE pcName = ?').get(pcName);
  if (!vehicle) throw new Error(`Nie znaleziono pojazdu o pcName: ${pcName}`);

  const clauses = ['pcName = @pcName'];
  const params = { pcName };

  const dayType = optionalString(firstParam(query.day_type), '').toUpperCase();
  if (dayType) {
    if (!SCHEDULE_DAY_TYPES.includes(dayType)) throw new Error(`Nieprawidłowy typ dnia: ${dayType}`);
    clauses.push('day_type = @dayType');
    params.dayType = dayType;
  }

  const dateParam = optionalString(firstParam(query.date), '');
  if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) throw new Error('Pole date musi mieć format YYYY-MM-DD');
    clauses.push('(date IS NULL OR date = @date)');
    params.date = dateParam;
  }

  const rows = db.connection.prepare(`
    SELECT * FROM trip_assignments
    WHERE ${clauses.join(' AND ')}
    ORDER BY day_type, start_time
  `).all(params);

  sendJson(res, 200, {
    ok: true,
    pcName,
    count: rows.length,
    assignments: rows.map(assignmentFromRow)
  });
}

// DELETE /api/trips/:assignmentId — usuwa pojedynczy kurs (przypisanie).
async function handleDeleteAssignment(req, res, assignmentId) {
  const info = db.connection.prepare('DELETE FROM trip_assignments WHERE id = ?').run(assignmentId);
  if (info.changes === 0) throw new Error(`Nie znaleziono kursu (przypisania) o id: ${assignmentId}`);
  sendJson(res, 200, {
    ok: true,
    message: 'Kurs (przypisanie) usunięty',
    deletedCount: info.changes
  });
}

// GET /api/vehicles/:pcName/schedule?date=YYYY-MM-DD&day_type=
// Zwraca rozwinięty, chronologiczny rozkład dnia pojazdu: każdy przystanek z
// wyliczoną godziną (start kursu + skumulowany offset minut) oraz "legs"
// (przerwy między kolejnymi kursami).
async function handleGetVehicleSchedule(req, res, pcName, query) {
  const vehicle = db.connection.prepare('SELECT pcName FROM vehicles WHERE pcName = ?').get(pcName);
  if (!vehicle) throw new Error(`Nie znaleziono pojazdu o pcName: ${pcName}`);

  const dateParam = optionalString(firstParam(query.date), '');
  const dayTypeParam = optionalString(firstParam(query.day_type), '').toUpperCase();

  let dateKey;
  let dayTypeUpper;

  if (dateParam) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) throw new Error('Pole date musi mieć format YYYY-MM-DD');
    const [y, m, d] = dateParam.split('-').map(Number);
    dateKey = dateParam;
    dayTypeUpper = determineDayType(new Date(y, m - 1, d)).toUpperCase();
  } else {
    const now = new Date();
    dateKey = formatDateKey(now);
    dayTypeUpper = determineDayType(now).toUpperCase();
  }

  if (dayTypeParam) {
    if (!SCHEDULE_DAY_TYPES.includes(dayTypeParam)) throw new Error(`Nieprawidłowy typ dnia: ${dayTypeParam}. Dozwolone: ${SCHEDULE_DAY_TYPES.join(', ')}`);
    dayTypeUpper = dayTypeParam;
  }

  const dayTypeLower = dayTypeUpper.toLowerCase();
  const sequence = buildVehicleDaySequence(pcName, dayTypeLower, dateKey);

  // Grupujemy sekwencję z powrotem w kursy (po trip_id = id przypisania),
  // zachowując porządek chronologiczny startów.
  const tripsMap = new Map();
  for (const entry of sequence) {
    if (!tripsMap.has(entry.trip_id)) {
      tripsMap.set(entry.trip_id, {
        trip_id: entry.trip_id,
        route_id: entry.route_id,
        line_number: entry.line_number,
        start_time: entry.start_time,
        block_id: entry.block_id,
        stops: []
      });
    }
    tripsMap.get(entry.trip_id).stops.push({
      stop_id: entry.stop_id,
      name: entry.stop_name,
      number: entry.stop_number,
      latitude: entry.latitude,
      longitude: entry.longitude,
      admin_zone: entry.admin_zone,
      zone: entry.zone,
      zone_type: entry.zone_type,
      sequence_index: entry.sequence_index,
      minutes_from_previous: entry.minutes_from_previous,
      planned_time: entry.planned_time,
      planned_seconds: entry.planned_seconds
    });
  }

  const trips = [...tripsMap.values()]
    .map(trip => {
      trip.stops.sort((a, b) => a.sequence_index - b.sequence_index);
      return trip;
    })
    .sort((a, b) => timeToSeconds(a.start_time) - timeToSeconds(b.start_time));

  // Przerwy między kursami: od ostatniego przystanku kursu N do pierwszego
  // przystanku kursu N+1.
  const legs = [];
  for (let i = 0; i < trips.length - 1; i++) {
    const current = trips[i];
    const next = trips[i + 1];
    const lastStop = current.stops[current.stops.length - 1];
    const firstStop = next.stops[0];
    if (!lastStop || !firstStop) continue;

    const pauseSeconds = firstStop.planned_seconds - lastStop.planned_seconds;
    legs.push({
      from_trip_id: current.trip_id,
      to_trip_id: next.trip_id,
      arrival_stop_id: lastStop.stop_id,
      arrival_time: lastStop.planned_time,
      departure_stop_id: firstStop.stop_id,
      departure_time: firstStop.planned_time,
      pause_minutes: Math.round(pauseSeconds / 60)
    });
  }

  sendJson(res, 200, {
    ok: true,
    pcName,
    date: dateKey,
    day_type: dayTypeUpper,
    trip_count: trips.length,
    trips,
    legs
  });
}

// =====================================================================
//  HANDLERY: DNI SERWISOWE / ŚWIĘTA
// =====================================================================
async function handleServiceDays(req, res) {
  const days = SCHEDULE_DAY_TYPES.map(dt => ({ id: dt, day_type: dt }));

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

// =====================================================================
//  HANDLERY: POJAZDY
// =====================================================================
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

// =====================================================================
//  HANDLERY: ZDARZENIA (trips) + RAPORTY
// =====================================================================
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
    model: 'TRASA (uporządkowane przystanki z offsetem minut) + KURS (pojazd + trasa + godzina startu + typ dnia). Kierunek wynika z kolejności przystanków trasy.',
    endpoints: {
      apiIp: 'GET /api/ip',
      dataSink: 'POST /api/data',
      isarsoftLatest: 'GET /api/isarsoft/latest',
      stops: 'GET /stops, POST /stops, GET /stops/:id, PUT /stops/:id, DELETE /stops/:id',
      routes: 'GET /api/routes, POST /api/routes (body: {name, code?, color?, stops:[{stop_id, minutes_from_previous}]}), GET /api/routes/:id, PUT /api/routes/:id, DELETE /api/routes/:id',
      routeStops: 'PUT /api/routes/:id/stops (body: {stops:[{stop_id, minutes_from_previous}]}) — zastępuje całą sekwencję',
      vehicleAssignments: 'POST /api/vehicles/assign-trips (body: {pcName, replace?, date?, assignments:[{route_id, start_time:"HH:MM", day_type, block_id?}]}), GET /api/vehicles/:pcName/assignments, DELETE /api/trips/:assignmentId',
      vehicleSchedule: 'GET /api/vehicles/:pcName/schedule?date=YYYY-MM-DD (rozwinięty rozkład dnia z wyliczonymi godzinami)',
      serviceDays: 'GET /service-days',
      holidays: 'GET /holidays, POST /holidays, DELETE /holidays/:date',
      vehicles: 'GET /vehicles, GET /api/vehicles',
      trackingTrips: 'GET /trips, DELETE /trips',
      reports: 'GET /reports/trip/current, /reports/stop-usage, /reports/on-demand-stops, /reports/line-performance, /reports/admin-zone',
      settings: 'GET /settings'
    }
  });
}

// =====================================================================
//  ROUTER
// =====================================================================
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

    // ---------- PRZYSTANKI ----------
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

    // ---------- TRASY ----------
    if (pathname === '/api/routes') {
      if (req.method === 'POST') return await handleCreateRoute(req, res);
      if (req.method === 'GET') return await handleGetRoutes(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /api/routes');
    }

    if (pathname.startsWith('/api/routes/') && pathname.endsWith('/stops')) {
      const rest = pathname.substring('/api/routes/'.length, pathname.length - '/stops'.length);
      const routeId = decodeURIComponent(rest);
      if (!routeId) throw new Error('Brak ID trasy');
      if (req.method === 'PUT' || req.method === 'PATCH') return await handleReplaceRouteStops(req, res, routeId);
      throw new Error('Metoda nieobsługiwana dla /api/routes/:id/stops');
    }

    if (pathname.startsWith('/api/routes/')) {
      const routeId = decodeURIComponent(pathname.substring('/api/routes/'.length));
      if (!routeId) throw new Error('Brak ID trasy');
      if (req.method === 'GET') return await handleGetRouteById(req, res, routeId);
      if (req.method === 'PUT' || req.method === 'PATCH') return await handleUpdateRoute(req, res, routeId);
      if (req.method === 'DELETE') return await handleDeleteRoute(req, res, routeId);
      throw new Error('Metoda nieobsługiwana dla /api/routes/:id');
    }

    // ---------- KURSY / PRZYPISANIA ----------
    if (pathname === '/api/vehicles/assign-trips') {
      if (req.method === 'POST') return await handleAssignVehicleTrips(req, res);
      throw new Error('Metoda nieobsługiwana dla /api/vehicles/assign-trips');
    }

    if (pathname.startsWith('/api/trips/')) {
      const assignmentId = decodeURIComponent(pathname.substring('/api/trips/'.length));
      if (!assignmentId) throw new Error('Brak ID kursu (przypisania)');
      if (req.method === 'DELETE') return await handleDeleteAssignment(req, res, assignmentId);
      throw new Error('Metoda nieobsługiwana dla /api/trips/:assignmentId');
    }

    if (pathname === '/api/vehicles') {
      if (req.method === 'GET') return await handleVehicles(req, res);
      throw new Error('Metoda nieobsługiwana dla /api/vehicles');
    }

    if (pathname.startsWith('/api/vehicles/') && pathname.endsWith('/schedule')) {
      const pcName = decodeURIComponent(pathname.substring('/api/vehicles/'.length, pathname.length - '/schedule'.length));
      if (!pcName) throw new Error('Brak nazwy pojazdu');
      if (req.method === 'GET') return await handleGetVehicleSchedule(req, res, pcName, query);
      throw new Error('Metoda nieobsługiwana dla /api/vehicles/:pcName/schedule');
    }

    if (pathname.startsWith('/api/vehicles/') && pathname.endsWith('/assignments')) {
      const pcName = decodeURIComponent(pathname.substring('/api/vehicles/'.length, pathname.length - '/assignments'.length));
      if (!pcName) throw new Error('Brak nazwy pojazdu');
      if (req.method === 'GET') return await handleGetVehicleAssignments(req, res, pcName, query);
      throw new Error('Metoda nieobsługiwana dla /api/vehicles/:pcName/assignments');
    }

    // ---------- DNI / ŚWIĘTA ----------
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

    // ---------- POJAZDY / ZDARZENIA ----------
    if (pathname === '/vehicles') {
      if (req.method === 'GET') return await handleVehicles(req, res);
      throw new Error('Metoda nieobsługiwana dla /vehicles');
    }

    if (pathname === '/trips') {
      if (req.method === 'GET') return await handleGetTrips(req, res, query);
      if (req.method === 'DELETE') return await handleDeleteTrips(req, res, query);
      throw new Error('Metoda nieobsługiwana dla /trips');
    }

    // ---------- RAPORTY ----------
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
  routeRequest
};