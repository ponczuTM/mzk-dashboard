'use strict';

const http = require('http');

// Importujemy moduły
const sqlite = require('./sqlite');
const funcs = require('./functions');
const endpoints = require('./endpoints');

// Wyciągamy potrzebne zmienne
const { ensureDatabaseReady, PORT, SYNC_INTERVAL_MS } = sqlite;
const { analyzeAllCurrentVehicles } = funcs;
const { routeRequest } = endpoints;

let server = null;

// --------------------- URUCHOMIENIE ---------------------
async function startServer() {
  ensureDatabaseReady();

  server = http.createServer((req, res) => {
    routeRequest(req, res).catch(err => {
      console.error('[serverRoom] Krytyczny błąd obsługi HTTP:', err);

      if (!res.headersSent) {
        const { sendJson } = require('./functions');
        sendJson(res, 500, {
          ok: false,
          error: 'Internal server error'
        });
      } else {
        res.end();
      }
    });
  });

  server.listen(PORT, () => {
    const { getLocalIPs } = require('./functions');
    const ips = getLocalIPs();

    console.log('\n' + '═'.repeat(70));
    console.log('║     🚀 SERWER POKOJOWY (Isarsoft Room Server) URUCHOMIONY     ║');
    console.log('═'.repeat(70));
    console.log(`║  Port: ${PORT}`);
    console.log('║  Status: Aktywny ✅');
    console.log(`║  Baza danych SQLite: ${sqlite.DB_FILE}`);
    console.log(`║  Tryb ramek: SQLite raw_frames, bez plików JSON`);
    console.log('║');
    console.log('║  📍 DOSTĘPNE ADRESY URL DO KOPIOWANIA:');
    console.log('║');

    if (ips.length === 0) {
      console.log('║  ⚠️  Nie znaleziono żadnych zewnętrznych adresów IPv4!');
      console.log('║  Sprawdź połączenie sieciowe.');
    } else {
      ips.forEach((ip, index) => {
        const prefix = index === 0 ? '▶' : ' ';
        console.log(`║  ${prefix} Interfejs: ${ip.interface.padEnd(20)}`);
        console.log(`║     URL: ${ip.url}`);
        console.log(`║     Kopiuj: ${'export ROOM_SERVER_URL="' + ip.url + '"'}`);
        console.log('║');
      });
    }

    console.log('║  💡 WSKAZÓWKI:');
    console.log('║  1. Wybierz odpowiedni adres IP z listy powyżej');
    console.log('║  2. Skopiuj komendę export i wklej w terminalu serverPc.js');
    console.log('║  3. Windows PowerShell:');
    console.log('║     $env:ROOM_SERVER_URL="http://192.168.68.212:3001/api/data"');
    console.log('║  4. Windows CMD:');
    console.log('║     set ROOM_SERVER_URL=http://192.168.68.212:3001/api/data');
    console.log('═'.repeat(70));
    console.log('║  📊 Sink: POST /api/data');
    console.log('║  📊 IP: GET /api/ip');
    console.log('║  📊 Przystanki: POST/GET /stops, GET/PUT/DELETE /stops/:id');
    console.log('║  📊 Rozkłady: POST/GET /schedules, GET/PUT/DELETE /schedules/:id');
    console.log('║  📊 Święta: POST/GET /holidays, DELETE /holidays/:date');
    console.log('║  📊 Zdarzenia: GET /trips, DELETE /trips');
    console.log('║  📊 Dashboard: GET /reports/trip/current');
    console.log('═'.repeat(70) + '\n');

    console.log('📋 ŁATWE KOPIOWANIE (JSON):');
    console.log(JSON.stringify({
      serverInfo: {
        port: PORT,
        time: new Date().toISOString(),
        databaseFile: sqlite.DB_FILE,
        databaseRoot: sqlite.DB_ROOT,
        syncIntervalMs: sqlite.SYNC_INTERVAL_MS,
        geofenceRadiusMeters: sqlite.GEOFENCE_RADIUS_METERS,
        punctualityToleranceSeconds: sqlite.PUNCTUALITY_TOLERANCE_SECONDS,
        frameStorageMode: 'sqlite_raw_frames'
      },
      availableUrls: ips.map(ip => ({
        interface: ip.interface,
        url: ip.url,
        envVariable: `export ROOM_SERVER_URL="${ip.url}"`
      })),
      endpoints: {
        dataSink: 'POST /api/data',
        apiIp: 'GET /api/ip',
        createStop: 'POST /stops',
        listStops: 'GET /stops',
        createSchedule: 'POST /schedules',
        listSchedules: 'GET /schedules',
        createHoliday: 'POST /holidays',
        listHolidays: 'GET /holidays',
        getTrips: 'GET /trips?page=1&limit=100',
        vehicles: 'GET /vehicles',
        currentTrip: 'GET /reports/trip/current',
        stopUsage: 'GET /reports/stop-usage',
        onDemandStops: 'GET /reports/on-demand-stops',
        linePerformance: 'GET /reports/line-performance',
        adminZone: 'GET /reports/admin-zone'
      }
    }, null, 2));

    console.log('\n');
  });

  // Cykliczna analiza wszystkich pojazdów
  setInterval(() => {
    try {
      analyzeAllCurrentVehicles();
    } catch (err) {
      console.error('[serverRoom] Błąd pętli 5s:', err.message);
    }
  }, SYNC_INTERVAL_MS);
}

startServer().catch(err => {
  console.error('[serverRoom] Nie udało się uruchomić serwera:', err);
  process.exit(1);
});

// --------------------- ZAMYKANIE ---------------------
function gracefulShutdown(signal) {
  console.log(`\n[serverRoom] Otrzymano ${signal}. Zamykam serwer...`);

  try {
    if (sqlite.db) {
      sqlite.db.close();
      console.log('[serverRoom] Połączenie SQLite zamknięte.');
    }
  } catch (err) {
    console.error('[serverRoom] Błąd zamykania SQLite:', err.message);
  }

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(() => {
    console.log('[serverRoom] Serwer zamknięty.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[serverRoom] Wymuszone zamknięcie po przekroczeniu czasu oczekiwania.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

process.on('unhandledRejection', err => {
  console.error('[serverRoom] Nieobsłużone odrzucenie Promise:', err);
});

process.on('uncaughtException', err => {
  console.error('[serverRoom] Nieobsłużony wyjątek:', err);
  gracefulShutdown('uncaughtException');
});