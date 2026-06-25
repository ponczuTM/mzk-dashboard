// server.js — Backend Cache dla GraphQL API (Isarsoft Perception)
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = 3001;

// ===== KONFIGURACJA =====
const CONFIG = {
  // Adresy API
  AUTH_URL: 'https://localhost:8443/isarsoft/auth/realms/perception/protocol/openid-connect/token',
  GRAPHQL_URL: 'https://localhost:8443/isarsoft/api/graphql',

  // Dane logowania (password grant)
  CLIENT_ID: 'perception',
  USERNAME: 'perception',
  PASSWORD: 'perception',

  // Interwał odświeżania cache (5 minut)
  POLL_INTERVAL_MS: 5 * 60 * 1000,

  // Agent HTTPS z wyłączoną weryfikacją certyfikatu (dla samopodpisanego)
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
};

// ===== STAN CACHE =====
let cache = {
  data: null,
  lastSuccess: null,
  lastAttempt: null,
  error: null,
  token: null,
};

// ===== POMOCNICY =====

// 1. Pobranie tokena OAuth2 (password grant)
async function fetchToken() {
  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', CONFIG.CLIENT_ID);
  params.append('username', CONFIG.USERNAME);
  params.append('password', CONFIG.PASSWORD);

  const response = await axios.post(CONFIG.AUTH_URL, params, {
    httpsAgent: CONFIG.httpsAgent,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data.access_token;
}

// 2. Wykonanie zapytania GraphQL z autoryzacją
async function graphqlQuery(query, token) {
  const response = await axios.post(
    CONFIG.GRAPHQL_URL,
    { query },
    {
      httpsAgent: CONFIG.httpsAgent,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

// 3. Główne zapytanie agregujące wszystkie dane dla dashboardu
// Używam dokładnie takich samych zapytań jak w twoich przykładach curl
function buildDashboardQuery() {
  return `
    query DashboardQuery {
      # 1. Wszystkie kamery (działa)
      allCameras {
        uuid
        name
      }

      # 2. Wszystkie aplikacje z podstawowymi danymi (działa)
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
          camera {
            uuid
            name
          }
          model {
            uuid
            name
          }
          lines {
            uuid
            name
            tags
            coordinates
            count_live(object_classes: [{ name: "PERSON" }]) {
              count_in
              count_out
            }
            count_data(
              time_range: { time_range_preset: LAST_1_HOUR }
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
            tags
            coordinates
            count_live(object_classes: [{ name: "PERSON" }]) {
              count_min
              count_avg
              count_max
            }
            count_data(
              time_range: { time_range_preset: LAST_1_HOUR }
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
        ... on ObjectCount {
          uuid
          name
          tags
          status
          last_online
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
        }
        ... on CrowdCount {
          uuid
          name
          tags
          status
          last_online
          camera { uuid name }
          model { uuid name }
          current_count
          count_data(time_range: { time_range_preset: LAST_1_HOUR }) {
            time_bucket
            count
          }
        }
      }

      # 3. Stan zdrowia systemu
      getSystemHealth {
        status
        camera_count
        application_count
        online_cameras
        online_applications
      }

      # 4. Status licencji
      getLicenseStatus {
        valid
        expiry_date
        features
        max_cameras
        max_applications
        used_cameras
        used_applications
      }
    }
  `;
}

// 4. Funkcja odświeżająca cache (wywoływana cyklicznie)
async function refreshCache() {
  cache.lastAttempt = new Date().toISOString();
  console.log(`[${new Date().toISOString()}] Odświeżanie cache...`);

  try {
    // Krok 1: Pobierz token
    const token = await fetchToken();
    cache.token = token;
    console.log(`[${new Date().toISOString()}] Token pobrany pomyślnie`);

    // Krok 2: Wykonaj zapytanie GraphQL
    const query = buildDashboardQuery();
    const result = await graphqlQuery(query, token);

    // Sprawdź błędy GraphQL
    if (result.errors && result.errors.length > 0) {
      console.error(`[${new Date().toISOString()}] GraphQL errors:`, JSON.stringify(result.errors, null, 2));
      throw new Error(`GraphQL errors: ${result.errors.map(e => e.message).join(', ')}`);
    }

    // Krok 3: Agreguj dane
    const raw = result.data;
    const aggregated = aggregateDashboardData(raw);

    // Krok 4: Zapisz w cache
    cache.data = aggregated;
    cache.lastSuccess = new Date().toISOString();
    cache.error = null;

    console.log(`[${new Date().toISOString()}] ✅ Cache odświeżony pomyślnie.`);
    console.log(`  → Kamery: ${aggregated.stats.totalCameras}`);
    console.log(`  → Aplikacje ObjectFlow: ${aggregated.stats.totalObjectFlowApps}`);
    console.log(`  → Aktywne: ${aggregated.stats.activeApps}, Offline: ${aggregated.stats.offlineApps}`);
    
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Błąd odświeżania cache:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}] Status: ${error.response.status}`);
      console.error(`[${new Date().toISOString()}] Data:`, JSON.stringify(error.response.data, null, 2));
    }
    cache.error = {
      message: error.message,
      timestamp: new Date().toISOString(),
    };
    // Jeśli mamy stare dane, pozostają one w cache
    return false;
  }
}

// 5. Agregacja surowych danych do struktury dashboardu
function aggregateDashboardData(raw) {
  const applications = raw.allApplications || [];
  const cameras = raw.allCameras || [];

  // Podział aplikacji na typy
  const objectFlowApps = applications.filter((app) => app.__typename === 'ObjectFlow');
  const objectCountApps = applications.filter((app) => app.__typename === 'ObjectCount');
  const crowdCountApps = applications.filter((app) => app.__typename === 'CrowdCount');

  // Statystyki statusów
  const statusMap = {
    Online: 0,
    Offline: 0,
    Initializing: 0,
    Paused: 0,
    Pending: 0,
  };
  applications.forEach((app) => {
    const s = app.status || 'Offline';
    if (statusMap[s] !== undefined) statusMap[s]++;
    else statusMap.Offline++;
  });

  // Licencja
  const license = raw.getLicenseStatus || null;

  // Health
  const health = raw.getSystemHealth || null;

  return {
    timestamp: new Date().toISOString(),
    cameras,
    applications,
    objectFlowApps,
    objectCountApps,
    crowdCountApps,
    health,
    license,
    stats: {
      totalCameras: cameras.length,
      totalApplications: applications.length,
      totalObjectFlowApps: objectFlowApps.length,
      totalObjectCountApps: objectCountApps.length,
      totalCrowdCountApps: crowdCountApps.length,
      activeApps: statusMap.Online || 0,
      offlineApps: statusMap.Offline || 0,
      initializingApps: statusMap.Initializing || 0,
      pausedApps: statusMap.Paused || 0,
      pendingApps: statusMap.Pending || 0,
      statusMap,
      licenseValid: license ? license.valid : false,
      licenseExpiry: license ? license.expiry_date : null,
      healthStatus: health ? health.status : 'unknown',
    },
  };
}

// ===== SERWER EXPRESS =====

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);

app.use(express.json());

// Endpoint dla dashboardu
app.get('/api/dashboard-data', (req, res) => {
  if (!cache.data) {
    return res.status(503).json({
      error: 'Dane jeszcze nie są dostępne. Poczekaj na pierwsze odświeżenie cache.',
      lastAttempt: cache.lastAttempt,
    });
  }

  res.json({
    success: true,
    data: cache.data,
    lastSuccess: cache.lastSuccess,
    lastAttempt: cache.lastAttempt,
    error: cache.error,
    isStale: cache.error !== null,
  });
});

// Endpoint zdrowia samego backendu
app.get('/api/health', (req, res) => {
  res.json({
    status: cache.data ? 'ok' : 'initializing',
    uptime: process.uptime(),
    lastSuccess: cache.lastSuccess,
    lastAttempt: cache.lastAttempt,
    hasData: cache.data !== null,
    error: cache.error,
  });
});

// ===== URUCHOMIENIE Z CZEKANIEM NA PIERWSZE DANE =====

async function startServer() {
  console.log(`========================================`);
  console.log(`🚀 Uruchamianie backend cache...`);
  console.log(`📡 Adres API: ${CONFIG.GRAPHQL_URL}`);
  console.log(`========================================`);

  // KROK 1: Najpierw sprawdźmy czy token działa
  console.log(`⏳ Testowanie połączenia...`);
  try {
    const token = await fetchToken();
    console.log(`✅ Token pobrany pomyślnie (długość: ${token.length} znaków)`);
    cache.token = token;
  } catch (error) {
    console.error(`❌ Nie udało się pobrać tokena:`, error.message);
    console.log(`⚠️  Serwer wystartuje, ale będzie w trybie awaryjnym.`);
  }

  // KROK 2: Pobierz dane przy starcie (SYNCHRONICZNIE - czekamy!)
  console.log(`⏳ Pobieranie danych inicjalnych...`);
  const success = await refreshCache();

  if (success) {
    console.log(`✅ Inicjalne dane pobrane pomyślnie!`);
  } else {
    console.log(`⚠️  Nie udało się pobrać danych inicjalnych.`);
    console.log(`   Serwer wystartuje, ale zwróci błąd 503 do momentu pierwszego udanego odświeżenia.`);
  }

  // KROK 3: Uruchom serwer
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`========================================`);
    console.log(`🚀 Backend cache uruchomiony`);
    console.log(`📡 Nasłuchuje na: http://0.0.0.0:${PORT}`);
    console.log(`📊 Endpoint: http://192.168.77.212:${PORT}/api/dashboard-data`);
    console.log(`🔄 Interwał odświeżania: ${CONFIG.POLL_INTERVAL_MS / 1000 / 60} min`);
    console.log(`📦 Stan cache: ${cache.data ? 'DANE DOSTĘPNE ✅' : 'BRAK DANYCH ⚠️'}`);
    console.log(`========================================`);
  });

  // KROK 4: Uruchom cykliczne odświeżanie
  setInterval(async () => {
    await refreshCache();
  }, CONFIG.POLL_INTERVAL_MS);
}

// ===== URUCHOM =====
startServer().catch((error) => {
  console.error(`❌ Krytyczny błąd podczas uruchamiania:`, error);
  process.exit(1);
});

// Obsługa wyłączenia
process.on('SIGTERM', () => {
  console.log('🛑 Otrzymano SIGTERM, zamykam serwer...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Otrzymano SIGINT, zamykam serwer...');
  process.exit(0);
});