/**
 * Isarsoft Analytics Dashboard — Backend Cache Server
 * Node.js + Express aggregating proxy for Isarsoft GraphQL API
 *
 * Chroni produkcyjne API przed bezpośrednim odpytywaniem przez przeglądarki.
 * Dane odświeżane co 5 minut, serwowane pod GET /api/dashboard-data.
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── KONFIGURACJA ──────────────────────────────────────────────────────────────
const CONFIG = {
  graphqlUrl: 'https://localhost:8443/isarsoft/api/graphql',
  authUrl:
    'https://localhost:8443/isarsoft/auth/realms/perception/protocol/openid-connect/token',
  clientId: 'perception',
  username: 'perception',
  password: 'perception',
  pollIntervalMs: 5 * 60 * 1000, // 5 minut
};

// Axios agent ignorujący self-signed SSL
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ─── STAN W PAMIĘCI ────────────────────────────────────────────────────────────
let cachedData = null;
let lastSuccess = null;
let lastError = null;
let isPolling = false;

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);
app.use(express.json());

// ─── AUTENTYKACJA ──────────────────────────────────────────────────────────────
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

// ─── ZAPYTANIE GRAPHQL ─────────────────────────────────────────────────────────
async function gqlQuery(token, query, variables = {}) {
  const response = await axios.post(
    CONFIG.graphqlUrl,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      httpsAgent,
      timeout: 15000,
    }
  );

  if (response.data.errors) {
    throw new Error(
      `GraphQL errors: ${response.data.errors.map((e) => e.message).join(', ')}`
    );
  }

  return response.data.data;
}

// ─── QUERY DEFINICJE ──────────────────────────────────────────────────────────
const QUERIES = {
  allCameras: `
    query AllCameras {
      allCameras {
        uuid
        name
      }
    }
  `,

  allApplications: `
    query AllApplications {
      allApplications {
        __typename
        ... on ObjectFlow {
          uuid
          name
          tags
          status
          last_online
          created_at
          updated_at
          camera { uuid name }
          model { uuid name }
          lines {
            uuid
            name
            tags
            coordinates
            count_live(object_classes: [{ name: "PERSON" }]) {
              count_in
              count_out
            }
          }
          areas {
            uuid
            name
            tags
            coordinates
            count_live(object_classes: [{ name: "PERSON" }]) {
              count_min
              count_avg
              count_max
            }
          }
          alarms {
            uuid
            name
          }
          output_stream {
            uuid
          }
        }
        ... on ObjectCount {
          uuid
          name
          tags
          status
          last_online
          created_at
          updated_at
          camera { uuid name }
          model { uuid name }
          areas {
            uuid
            name
            tags
            coordinates
            count_live(object_classes: [{ name: "PERSON" }]) {
              count_min
              count_avg
              count_max
            }
          }
          alarms {
            uuid
            name
          }
        }
        ... on CrowdCount {
          uuid
          name
          tags
          status
          last_online
          current_count
          created_at
          updated_at
          camera { uuid name }
          model { uuid name }
          alarms {
            uuid
            name
          }
        }
      }
    }
  `,

  systemHealth: `
    query SystemHealth {
      getSystemHealth {
        cameras_total
        cameras_online
        cameras_offline
        cameras_paused
        applications_total
        applications_online
        applications_offline
        applications_paused
      }
    }
  `,

  licenseStatus: `
    query LicenseStatus {
      getLicenseStatus {
        valid
        expires_at
        cameras_limit
        applications_limit
        models_limit
        features
      }
    }
  `,

  featureFlags: `
    query FeatureFlags {
      getFeatureFlags {
        name
        enabled
      }
    }
  `,

  mqttSettings: `
    query MQTTSettings {
      getMQTTSettings {
        host
        port
        enabled
      }
    }
  `,

  vmsIntegrations: `
    query VMSCheck {
      checkCayugaConnection { connected error }
      checkMilestoneConnection { connected error }
      checkGenetecConnection { connected error }
    }
  `,

  objectFlowHistory: `
    query ObjectFlowHistory {
      allApplications {
        ... on ObjectFlow {
          uuid
          name
          lines {
            uuid
            name
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
          areas {
            uuid
            name
            count_data(
              time_range: { time_range_preset: LAST_12_HOUR }
              object_classes: [{ name: "PERSON" }]
            ) {
              time_bucket
              number_of_samples
              count_min
              count_avg
              count_max
            }
          }
        }
      }
    }
  `,
};

// ─── AGREGACJA DANYCH ──────────────────────────────────────────────────────────
async function fetchAndAggregate() {
  if (isPolling) return;
  isPolling = true;

  console.log(`[${new Date().toISOString()}] Pobieranie danych z API...`);

  try {
    const token = await fetchToken();

    // Pobieramy dane równolegle (health, licencja, kamery, aplikacje)
    const [
      camerasData,
      applicationsData,
      healthData,
      licenseData,
      mqttData,
    ] = await Promise.allSettled([
      gqlQuery(token, QUERIES.allCameras),
      gqlQuery(token, QUERIES.allApplications),
      gqlQuery(token, QUERIES.systemHealth),
      gqlQuery(token, QUERIES.licenseStatus),
      gqlQuery(token, QUERIES.mqttSettings),
    ]);

    // Pobieramy dane historyczne ObjectFlow (może być wolniejsze)
    let historyData = null;
    try {
      historyData = await gqlQuery(token, QUERIES.objectFlowHistory);
    } catch (e) {
      console.warn('History data unavailable:', e.message);
    }

    // Próba pobrania danych VMS (opcjonalne, może nie być skonfigurowane)
    let vmsData = null;
    try {
      vmsData = await gqlQuery(token, QUERIES.vmsIntegrations);
    } catch (e) {
      console.warn('VMS check unavailable:', e.message);
    }

    // Składamy zagregowany obiekt
    const cameras =
      camerasData.status === 'fulfilled' ? camerasData.value.allCameras || [] : [];
    const applications =
      applicationsData.status === 'fulfilled'
        ? applicationsData.value.allApplications || []
        : [];
    const health =
      healthData.status === 'fulfilled'
        ? healthData.value.getSystemHealth || null
        : null;
    const license =
      licenseData.status === 'fulfilled'
        ? licenseData.value.getLicenseStatus || null
        : null;
    const mqtt =
      mqttData.status === 'fulfilled'
        ? mqttData.value.getMQTTSettings || null
        : null;

    // Agregaty aplikacji per typ
    const objectFlowApps = applications.filter((a) => a.__typename === 'ObjectFlow');
    const objectCountApps = applications.filter((a) => a.__typename === 'ObjectCount');
    const crowdCountApps = applications.filter((a) => a.__typename === 'CrowdCount');

    // Statystyki statusów
    const statusBreakdown = applications.reduce((acc, app) => {
      const s = app.status || 'Unknown';
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    // Historia linii dla wykresów — mergujemy do aplikacji
    const historyMap = {};
    if (historyData?.allApplications) {
      for (const app of historyData.allApplications) {
        if (app && app.uuid) historyMap[app.uuid] = app;
      }
    }

    // Oblicz łączne przejścia z ostatnich 12h (sum across all lines)
    let totalCountIn12h = 0;
    let totalCountOut12h = 0;
    for (const app of objectFlowApps) {
      const hist = historyMap[app.uuid];
      if (hist?.lines) {
        for (const line of hist.lines) {
          if (line.count_data) {
            for (const bucket of line.count_data) {
              totalCountIn12h += bucket.count_in || 0;
              totalCountOut12h += bucket.count_out || 0;
            }
          }
        }
      }
    }

    // Przygotuj dane czasowe dla głównego wykresu (agregacja po godzinach)
    const timelineMap = {};
    for (const app of objectFlowApps) {
      const hist = historyMap[app.uuid];
      if (hist?.lines) {
        for (const line of hist.lines) {
          if (line.count_data) {
            for (const bucket of line.count_data) {
              const key = bucket.time_bucket;
              if (!timelineMap[key]) {
                timelineMap[key] = { time_bucket: key, count_in: 0, count_out: 0 };
              }
              timelineMap[key].count_in += bucket.count_in || 0;
              timelineMap[key].count_out += bucket.count_out || 0;
            }
          }
        }
      }
    }
    const timeline = Object.values(timelineMap).sort((a, b) =>
      a.time_bucket.localeCompare(b.time_bucket)
    );

    // Live total (suma count_in z linii ObjectFlow)
    let liveTotalIn = 0;
    let liveTotalOut = 0;
    for (const app of objectFlowApps) {
      if (app.lines) {
        for (const line of app.lines) {
          if (line.count_live) {
            liveTotalIn += line.count_live.count_in || 0;
            liveTotalOut += line.count_live.count_out || 0;
          }
        }
      }
    }

    cachedData = {
      meta: {
        fetchedAt: new Date().toISOString(),
        pollIntervalMs: CONFIG.pollIntervalMs,
      },
      summary: {
        totalCameras: cameras.length,
        totalApplications: applications.length,
        objectFlowCount: objectFlowApps.length,
        objectCountCount: objectCountApps.length,
        crowdCountCount: crowdCountApps.length,
        statusBreakdown,
        totalCountIn12h,
        totalCountOut12h,
        liveTotalIn,
        liveTotalOut,
      },
      health,
      license,
      mqtt,
      vms: vmsData
        ? {
            cayuga: vmsData.checkCayugaConnection || null,
            milestone: vmsData.checkMilestoneConnection || null,
            genetec: vmsData.checkGenetecConnection || null,
          }
        : null,
      cameras,
      applications: applications.map((app) => ({
        ...app,
        _history: historyMap[app.uuid] || null,
      })),
      timeline,
    };

    lastSuccess = new Date().toISOString();
    lastError = null;
    console.log(
      `[${lastSuccess}] OK — ${cameras.length} kamer, ${applications.length} aplikacji`
    );
  } catch (err) {
    lastError = err.message;
    console.error(`[${new Date().toISOString()}] BŁĄD: ${err.message}`);
  } finally {
    isPolling = false;
  }
}

// ─── ENDPOINT ─────────────────────────────────────────────────────────────────
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
    _cache: {
      lastSuccess,
      lastError,
      ageMs: lastSuccess ? Date.now() - new Date(lastSuccess).getTime() : null,
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    lastSuccess,
    lastError,
    isPolling,
    cachedAt: cachedData?.meta?.fetchedAt || null,
  });
});

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Isarsoft Cache Backend na http://0.0.0.0:${PORT}`);
  console.log(`Poll interval: ${CONFIG.pollIntervalMs / 1000}s`);

  // Pierwsze pobranie od razu
  await fetchAndAggregate();

  // Cykliczne odświeżanie
  setInterval(fetchAndAggregate, CONFIG.pollIntervalMs);
});

module.exports = app;