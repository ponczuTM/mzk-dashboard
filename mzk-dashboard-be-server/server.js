'use strict';

const http = require('http');
const url = require('url');
const os = require('os');

// --------------------- KONFIGURACJA ---------------------
const PORT = Number(process.env.ROOM_PORT || 3001);

// Przechowujemy ostatnie dane dla każdego PC (opcjonalnie)
const pcDataStore = new Map();

// --------------------- FUNKCJE POMOCNICZE ---------------------
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, iface] of Object.entries(interfaces)) {
    for (const addr of iface) {
      // Pomijamy wewnętrzne (localhost) i IPv6 (na razie skupiamy się na IPv4)
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

// --------------------- SERWER HTTP ---------------------
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // Obsługa CORS (ułatwia testy)
  const setCors = () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  if (req.method === 'OPTIONS') {
    setCors();
    res.writeHead(204);
    res.end();
    return;
  }

  // Endpoint do pobierania adresu IP (przydatne dla klientów)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/ip') {
    setCors();
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ips = getLocalIPs();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      serverPort: PORT,
      serverUrls: ips.map(ip => ip.url),
      yourClientIp: clientIp,
      fullUrls: ips.map(ip => ({
        interface: ip.interface,
        url: ip.url,
        envVariable: `export ROOM_SERVER_URL="${ip.url}"`
      }))
    }));
    return;
  }

  // Tylko POST na /api/data
  if (req.method !== 'POST' || parsedUrl.pathname !== '/api/data') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  setCors();

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const payload = JSON.parse(body);

      // Walidacja
      const pcId = payload.pcId;
      const pcName = payload.pcName;
      const timestamp = payload.timestamp;
      const data = payload.data;

      // Pobieramy współrzędne GPS (mogą być null, jeśli brak fixu)
      const latitude = payload.latitude !== undefined ? payload.latitude : null;
      const longitude = payload.longitude !== undefined ? payload.longitude : null;

      if (pcId == null || pcName == null) {
        throw new Error('Brak wymaganych pól: pcId, pcName');
      }

      // Zapisujemy w pamięci (opcjonalnie)
      pcDataStore.set(String(pcId), {
        pcName,
        timestamp,
        latitude,
        longitude,
        data,
        receivedAt: new Date().toISOString()
      });

      // ---------- WYŚWIETLANIE W KONSOLI (z GPS) ----------
      console.log('\n╔════════════════════════════════════════════════════════════════╗');
      console.log('║                    📥 ODEBRANO DANE Z PC                    ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');
      console.log(`║  PC ID:          ${String(pcId).padEnd(40)}║`);
      console.log(`║  PC Name:        ${String(pcName).padEnd(40)}║`);
      console.log(`║  Czas nadania:   ${String(timestamp).padEnd(40)}║`);
      console.log(`║  Czas odbioru:   ${new Date().toISOString().padEnd(40)}║`);
      // Wyświetlamy współrzędne GPS
      const latStr = latitude !== null && latitude !== undefined ? latitude.toFixed(6) : 'BRAK';
      const lonStr = longitude !== null && longitude !== undefined ? longitude.toFixed(6) : 'BRAK';
      console.log(`║  Szerokość GPS:  ${String(latStr).padEnd(40)}║`);
      console.log(`║  Długość GPS:    ${String(lonStr).padEnd(40)}║`);
      console.log('╠════════════════════════════════════════════════════════════════╣');
      if (data && data.totals) {
        console.log(`║  Aplikacje:      ${String(data.totals.objectflow_apps).padEnd(40)}║`);
        console.log(`║  Suma IN:        ${String(data.totals.selected_in).padEnd(40)}║`);
        console.log(`║  Suma OUT:       ${String(data.totals.selected_out).padEnd(40)}║`);
        console.log(`║  Śr. obszarów:   ${String(data.totals.selected_area_avg.toFixed(2)).padEnd(40)}║`);
        console.log(`║  Licznik obsz.:  ${String(data.totals.selected_area_count).padEnd(40)}║`);
      } else {
        console.log(`║  (brak danych lub struktura niezgodna)                      ║`);
      }
      console.log('╚════════════════════════════════════════════════════════════════╝\n');

      // Odpowiedź
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: 'Data received',
        receivedAt: new Date().toISOString()
      }));
    } catch (err) {
      console.error('[serverRoom] Błąd przetwarzania żądania:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

// --------------------- URUCHOMIENIE ---------------------
server.listen(PORT, () => {
  const ips = getLocalIPs();

  console.log('\n' + '═'.repeat(70));
  console.log('║     🚀 SERWER POKOJOWY (Isarsoft Room Server) URUCHOMIONY     ║');
  console.log('═'.repeat(70));
  console.log(`║  Port: ${PORT}`);
  console.log(`║  Status: Aktywny ✅`);
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
  console.log('║  3. Przykład dla Windows (PowerShell):');
  console.log('║     $env:ROOM_SERVER_URL="http://192.168.68.212:3001/api/data"');
  console.log('║  4. Przykład dla Windows (CMD):');
  console.log('║     set ROOM_SERVER_URL=http://192.168.68.212:3001/api/data');
  console.log('═'.repeat(70));
  console.log('║  📊 Serwer nasłuchuje na ścieżce: POST /api/data');
  console.log('║  📊 Endpoint pomocniczy: GET /api/ip (pokaże adresy IP)');
  console.log('═'.repeat(70) + '\n');

  // Dodatkowo wyświetlamy w formacie JSON dla łatwiejszego parsowania
  console.log('📋 ŁATWE KOPIOWANIE (JSON):');
  console.log(JSON.stringify({
    serverInfo: {
      port: PORT,
      time: new Date().toISOString()
    },
    availableUrls: ips.map(ip => ({
      interface: ip.interface,
      url: ip.url,
      envExport: `export ROOM_SERVER_URL="${ip.url}"`,
      windowsPowerShell: `$env:ROOM_SERVER_URL="${ip.url}"`,
      windowsCmd: `set ROOM_SERVER_URL=${ip.url}`
    }))
  }, null, 2));
  console.log('\n');
});

// --------------------- ZAMYKANIE ---------------------
process.on('SIGINT', () => {
  console.log('\n[serverRoom] Zamykam serwer...');
  server.close(() => {
    console.log('[serverRoom] Serwer zamknięty.');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[serverRoom] Zamykam serwer...');
  server.close(() => {
    console.log('[serverRoom] Serwer zamknięty.');
    process.exit(0);
  });
});