/**
 * Isarsoft Analytics Dashboard — Backend Cache Server v2
 *
 * Zmiany v2:
 * - Endpoint /api/debug pokazuje surowe odpowiedzi z każdego query
 * - Query uproszczone — bez pól które mogą nie istnieć w tej wersji API
 * - Pełne logowanie błędów per-query z detalami
 * - Osobna obsługa błędów GraphQL (errors[]) vs HTTP errors
 * - count_live / count_data pobierane oddzielnie po weryfikacji że apps istnieją
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

const CONFIG = {
  graphqlUrl: 'https://localhost:8443/isarsoft/api/graphql',
  authUrl: 'https://localhost:8443/isarsoft/auth/realms/perception/protocol/openid-connect/token',
  clientId: 'perception',
  username: 'perception',
  password: 'perception',
  pollIntervalMs: 5 * 60 * 1000,
};

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let cachedData = null;
let debugLog = {}; // surowe odpowiedzi per-query
let lastSuccess = null;
let lastError = null;
let isPolling = false;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── AUTH ──────────────────────────────────────────────────────────────────────
async function fetchToken() {
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: CONFIG.clientId,
    username: CONFIG.username,
    password: CONFIG.password,
  });
  const response = await axios.post(CONFIG.authUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    httpsAgent,
    timeout: 10000,
  });
  return response.data.access_token;
}

// ─── GQL — zwraca { data, errors, raw } bez rzucania wyjątku ─────────────────
async function gqlSafe(token, query, label) {
  try {
    const response = await axios.post(
      CONFIG.graphqlUrl,
      { query },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        httpsAgent,
        timeout: 20000,
      }
    );
    const raw = response.data;
    if (raw.errors && raw.errors.length) {
      console.error(`[GQL ERROR] ${label}:`, JSON.stringify(raw.errors, null, 2));
    }
    return { data: raw.data || null, errors: raw.errors || null, raw };
  } catch (err) {
    console.error(`[HTTP ERROR] ${label}:`, err.message);
    return { data: null, errors: null, raw: null, httpError: err.message };
  }
}

// ─── QUERIES ──────────────────────────────────────────────────────────────────

// Minimalne — tylko pola które na pewno są w bazowym schemacie
const Q_CAMERAS = `query { allCameras { uuid name } }`;

// Bez count_live, bez output_stream, bez coordinates — najpierw sprawdzamy czy w ogóle działa
const Q_APPS_MINIMAL = `
query {
  allApplications {
    __typename
    ... on ObjectFlow {
      uuid name tags status last_online created_at updated_at
      camera { uuid name }
      model { uuid name }
    }
    ... on ObjectCount {
      uuid name tags status last_online created_at updated_at
      camera { uuid name }
      model { uuid name }
    }
    ... on CrowdCount {
      uuid name tags status last_online current_count created_at updated_at
      camera { uuid name }
      model { uuid name }
    }
  }
}`;

// Linie i strefy (geometria) — osobne query
const Q_APPS_GEOMETRY = `
query {
  allApplications {
    ... on ObjectFlow {
      uuid
      lines { uuid name tags coordinates }
      areas { uuid name tags coordinates }
    }
  }
}`;

// count_live dla linii
const Q_LINES_LIVE = `
query {
  allApplications {
    ... on ObjectFlow {
      uuid
      lines {
        uuid name
        count_live(object_classes: [{ name: "PERSON" }]) {
          count_in
          count_out
        }
      }
    }
  }
}`;

// count_live dla stref ObjectFlow
const Q_AREAS_LIVE = `
query {
  allApplications {
    ... on ObjectFlow {
      uuid
      areas {
        uuid name
        count_live(object_classes: [{ name: "PERSON" }]) {
          count_min count_avg count_max
        }
      }
    }
  }
}`;

// Historia 12h — linie
const Q_HISTORY_12H = `
query {
  allApplications {
    ... on ObjectFlow {
      uuid name
      lines {
        uuid name
        count_data(
          time_range: { time_range_preset: LAST_12_HOUR }
          object_classes: [{ name: "PERSON" }]
        ) {
          time_bucket
          number_of_samples
          count_in
          count_out
        }
      }
    }
  }
}`;

// Historia 1h — linie (szybsze, do live widgetów)
const Q_HISTORY_1H = `
query {
  allApplications {
    ... on ObjectFlow {
      uuid name
      lines {
        uuid name
        count_data(
          time_range: { time_range_preset: LAST_1_HOUR }
          object_classes: [{ name: "PERSON" }]
        ) {
          time_bucket number_of_samples count_in count_out
        }
      }
    }
  }
}`;

// Historia stref — ObjectFlow areas
const Q_AREA_HISTORY = `
query {
  allApplications {
    ... on ObjectFlow {
      uuid name
      areas {
        uuid name
        count_data(
          time_range: { time_range_preset: LAST_12_HOUR }
          object_classes: [{ name: "PERSON" }]
        ) {
          time_bucket number_of_samples count_min count_avg count_max
        }
      }
    }
  }
}`;

// ObjectCount areas historia
const Q_OC_AREA_HISTORY = `
query {
  allApplications {
    ... on ObjectCount {
      uuid name
      areas {
        uuid name
        count_data(
          time_range: { time_range_preset: LAST_12_HOUR }
          object_classes: [{ name: "PERSON" }]
        ) {
          time_bucket number_of_samples count_min count_avg count_max
        }
      }
    }
  }
}`;

// CrowdCount historia
const Q_CROWD_HISTORY = `
query {
  allApplications {
    ... on CrowdCount {
      uuid name
      count_data(time_range: { time_range_preset: LAST_12_HOUR }) {
        time_bucket number_of_samples count_min count_avg count_max
      }
    }
  }
}`;

// System health
const Q_HEALTH = `query { getSystemHealth {
  cameras_total cameras_online cameras_offline cameras_paused
  applications_total applications_online applications_offline applications_paused
} }`;

// Licencja
const Q_LICENSE = `query { getLicenseStatus {
  valid expires_at cameras_limit applications_limit models_limit
} }`;

// MQTT
const Q_MQTT = `query { getMQTTSettings { host port enabled } }`;

// VMS checks
const Q_VMS = `query {
  checkCayugaConnection { connected error }
  checkMilestoneConnection { connected error }
  checkGenetecConnection { connected error }
}`;

// ─── MERGE HELPERS ────────────────────────────────────────────────────────────
function mergeByUuid(baseApps, extraApps, fields) {
  if (!extraApps) return baseApps;
  const map = {};
  for (const app of extraApps) {
    if (app?.uuid) map[app.uuid] = app;
  }
  return baseApps.map((app) => {
    const extra = map[app.uuid];
    if (!extra) return app;
    const patch = {};
    for (const f of fields) {
      if (extra[f] !== undefined) patch[f] = extra[f];
    }
    return { ...app, ...patch };
  });
}

// ─── GŁÓWNA FUNKCJA AGREGACJI ─────────────────────────────────────────────────
async function fetchAndAggregate() {
  if (isPolling) return;
  isPolling = true;
  const log = {};
  console.log(`\n[${new Date().toISOString()}] === START POLL ===`);

  try {
    const token = await fetchToken();
    console.log('[AUTH] Token OK');

    // Krok 1: Kamery
    const rCameras = await gqlSafe(token, Q_CAMERAS, 'allCameras');
    log.cameras = rCameras;
    const cameras = rCameras.data?.allCameras || [];
    console.log(`[CAMERAS] ${cameras.length} kamer`);

    // Krok 2: Aplikacje — minimalne (bez pól które mogą nie istnieć)
    const rApps = await gqlSafe(token, Q_APPS_MINIMAL, 'allApplications-minimal');
    log.appsMinimal = rApps;
    let applications = rApps.data?.allApplications || [];
    console.log(`[APPS] ${applications.length} aplikacji, typy: ${[...new Set(applications.map(a => a.__typename))].join(', ')}`);

    if (applications.length > 0) {
      // Krok 3: Geometria linii/stref
      const rGeo = await gqlSafe(token, Q_APPS_GEOMETRY, 'apps-geometry');
      log.geometry = rGeo;
      if (rGeo.data?.allApplications) {
        applications = mergeByUuid(applications, rGeo.data.allApplications, ['lines', 'areas']);
        console.log('[GEO] Geometria załadowana');
      }

      // Krok 4: Live count dla linii
      const rLiveLine = await gqlSafe(token, Q_LINES_LIVE, 'lines-count-live');
      log.linesLive = rLiveLine;
      if (rLiveLine.data?.allApplications) {
        // Merge na poziomie linii
        const liveMap = {};
        for (const app of rLiveLine.data.allApplications) {
          if (app?.uuid && app.lines) {
            for (const line of app.lines) {
              liveMap[line.uuid] = line.count_live;
            }
          }
        }
        applications = applications.map((app) => {
          if (!app.lines) return app;
          return {
            ...app,
            lines: app.lines.map((l) => ({
              ...l,
              count_live: liveMap[l.uuid] || null,
            })),
          };
        });
        console.log('[LIVE-LINES] OK');
      }

      // Krok 5: Historia 12h linii
      const rHist12 = await gqlSafe(token, Q_HISTORY_12H, 'history-12h-lines');
      log.history12h = rHist12;
      const hist12Map = {};
      if (rHist12.data?.allApplications) {
        for (const app of rHist12.data.allApplications) {
          if (app?.uuid) hist12Map[app.uuid] = app.lines || [];
        }
        console.log('[HIST-12H] OK, apps z danymi:', Object.keys(hist12Map).length);
      }

      // Krok 6: Historia 1h linii
      const rHist1 = await gqlSafe(token, Q_HISTORY_1H, 'history-1h-lines');
      log.history1h = rHist1;
      const hist1Map = {};
      if (rHist1.data?.allApplications) {
        for (const app of rHist1.data.allApplications) {
          if (app?.uuid) hist1Map[app.uuid] = app.lines || [];
        }
      }

      // Krok 7: Historia stref ObjectFlow
      const rAreaHist = await gqlSafe(token, Q_AREA_HISTORY, 'area-history-12h');
      log.areaHistory = rAreaHist;
      const areaHistMap = {};
      if (rAreaHist.data?.allApplications) {
        for (const app of rAreaHist.data.allApplications) {
          if (app?.uuid) areaHistMap[app.uuid] = app.areas || [];
        }
      }

      // Krok 8: ObjectCount areas historia
      const rOcHist = await gqlSafe(token, Q_OC_AREA_HISTORY, 'oc-area-history');
      log.ocAreaHistory = rOcHist;

      // Krok 9: CrowdCount historia
      const rCrowd = await gqlSafe(token, Q_CROWD_HISTORY, 'crowd-history');
      log.crowdHistory = rCrowd;

      // Pakujemy historię do aplikacji
      applications = applications.map((app) => {
        const extra = {
          _hist12h_lines: hist12Map[app.uuid] || null,
          _hist1h_lines: hist1Map[app.uuid] || null,
          _hist12h_areas: areaHistMap[app.uuid] || null,
        };
        return { ...app, ...extra };
      });
    }

    // Krok 10: Health, License, MQTT, VMS (opcjonalne)
    const [rHealth, rLicense, rMqtt, rVms] = await Promise.allSettled([
      gqlSafe(token, Q_HEALTH, 'health'),
      gqlSafe(token, Q_LICENSE, 'license'),
      gqlSafe(token, Q_MQTT, 'mqtt'),
      gqlSafe(token, Q_VMS, 'vms'),
    ]);
    log.health = rHealth.value;
    log.license = rLicense.value;
    log.mqtt = rMqtt.value;
    log.vms = rVms.value;

    const health = rHealth.value?.data?.getSystemHealth || null;
    const license = rLicense.value?.data?.getLicenseStatus || null;
    const mqtt = rMqtt.value?.data?.getMQTTSettings || null;
    const vmsRaw = rVms.value?.data || null;

    console.log(`[HEALTH] ${health ? 'OK' : 'null'} | [LICENSE] ${license ? 'OK' : 'null'} | [MQTT] ${mqtt ? 'OK' : 'null'}`);

    // ─── AGREGATY ───────────────────────────────────────────────────────────
    const objectFlowApps = applications.filter((a) => a.__typename === 'ObjectFlow');
    const statusBreakdown = applications.reduce((acc, app) => {
      const s = app.status || 'Unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    // Timeline 12h — suma wszystkich linii wszystkich ObjectFlow
    const timelineMap = {};
    for (const app of objectFlowApps) {
      for (const line of app._hist12h_lines || []) {
        for (const b of line.count_data || []) {
          if (!timelineMap[b.time_bucket]) {
            timelineMap[b.time_bucket] = { time_bucket: b.time_bucket, count_in: 0, count_out: 0, samples: 0 };
          }
          timelineMap[b.time_bucket].count_in += b.count_in || 0;
          timelineMap[b.time_bucket].count_out += b.count_out || 0;
          timelineMap[b.time_bucket].samples += b.number_of_samples || 0;
        }
      }
    }
    const timeline = Object.values(timelineMap).sort((a, b) => a.time_bucket.localeCompare(b.time_bucket));

    // Timeline 1h
    const timeline1hMap = {};
    for (const app of objectFlowApps) {
      for (const line of app._hist1h_lines || []) {
        for (const b of line.count_data || []) {
          if (!timeline1hMap[b.time_bucket]) {
            timeline1hMap[b.time_bucket] = { time_bucket: b.time_bucket, count_in: 0, count_out: 0 };
          }
          timeline1hMap[b.time_bucket].count_in += b.count_in || 0;
          timeline1hMap[b.time_bucket].count_out += b.count_out || 0;
        }
      }
    }
    const timeline1h = Object.values(timeline1hMap).sort((a, b) => a.time_bucket.localeCompare(b.time_bucket));

    const totalCountIn12h = timeline.reduce((s, b) => s + b.count_in, 0);
    const totalCountOut12h = timeline.reduce((s, b) => s + b.count_out, 0);

    let liveTotalIn = 0, liveTotalOut = 0;
    for (const app of objectFlowApps) {
      for (const line of app.lines || []) {
        liveTotalIn += line.count_live?.count_in || 0;
        liveTotalOut += line.count_live?.count_out || 0;
      }
    }

    // Per-kamera agregaty (ile przejść per kamera w 12h)
    const perCamera = {};
    for (const app of objectFlowApps) {
      const camUuid = app.camera?.uuid;
      const camName = app.camera?.name || 'Unknown';
      if (!camUuid) continue;
      if (!perCamera[camUuid]) perCamera[camUuid] = { uuid: camUuid, name: camName, count_in: 0, count_out: 0, apps: 0 };
      perCamera[camUuid].apps += 1;
      for (const line of app._hist12h_lines || []) {
        for (const b of line.count_data || []) {
          perCamera[camUuid].count_in += b.count_in || 0;
          perCamera[camUuid].count_out += b.count_out || 0;
        }
      }
    }

    cachedData = {
      meta: { fetchedAt: new Date().toISOString(), pollIntervalMs: CONFIG.pollIntervalMs },
      summary: {
        totalCameras: cameras.length,
        totalApplications: applications.length,
        objectFlowCount: objectFlowApps.length,
        objectCountCount: applications.filter((a) => a.__typename === 'ObjectCount').length,
        crowdCountCount: applications.filter((a) => a.__typename === 'CrowdCount').length,
        statusBreakdown,
        totalCountIn12h,
        totalCountOut12h,
        liveTotalIn,
        liveTotalOut,
      },
      health,
      license,
      mqtt,
      vms: vmsRaw ? {
        cayuga: vmsRaw.checkCayugaConnection || null,
        milestone: vmsRaw.checkMilestoneConnection || null,
        genetec: vmsRaw.checkGenetecConnection || null,
      } : null,
      cameras,
      applications,
      timeline,
      timeline1h,
      perCamera: Object.values(perCamera),
    };

    lastSuccess = new Date().toISOString();
    lastError = null;
    debugLog = log;
    console.log(`[${lastSuccess}] DONE — ${cameras.length} kamer, ${applications.length} aplikacji, ${totalCountIn12h} wejść 12h`);

  } catch (err) {
    lastError = err.message;
    console.error(`[FATAL] ${err.message}\n`, err.stack);
  } finally {
    isPolling = false;
  }
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────
app.get('/api/dashboard-data', (req, res) => {
  if (!cachedData) {
    return res.status(503).json({
      error: 'Dane jeszcze nie zostały pobrane. Spróbuj za chwilę.',
      lastError,
      polling: isPolling,
    });
  }
  res.json({
    ...cachedData,
    _cache: { lastSuccess, lastError, ageMs: lastSuccess ? Date.now() - new Date(lastSuccess).getTime() : null },
  });
});

// ⚠️ ENDPOINT DIAGNOSTYCZNY — pokazuje surowe odpowiedzi z każdego query
// Usuń lub zabezpiecz hasłem przed deploymentem na produkcję!
app.get('/api/debug', (req, res) => {
  res.json({
    lastSuccess,
    lastError,
    isPolling,
    queries: Object.fromEntries(
      Object.entries(debugLog).map(([k, v]) => [
        k,
        {
          hasData: !!v?.data,
          hasErrors: !!(v?.errors?.length),
          errors: v?.errors || null,
          httpError: v?.httpError || null,
          // surowe dane (pierwsze 3 elementy jeśli tablica)
          dataSample: v?.data
            ? JSON.parse(JSON.stringify(v.data, null, 0).substring(0, 2000))
            : null,
        },
      ])
    ),
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), lastSuccess, lastError, isPolling });
});

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Isarsoft Cache Backend na http://0.0.0.0:${PORT}`);
  await fetchAndAggregate();
  setInterval(fetchAndAggregate, CONFIG.pollIntervalMs);
});

module.exports = app;