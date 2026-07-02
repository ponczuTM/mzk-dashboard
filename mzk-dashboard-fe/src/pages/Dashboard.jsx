// Dashboard.jsx
import React, { useState, useEffect, useCallback } from 'react';
import styles from './Dashboard.module.css';

const BASE_URL = 'http://192.168.77.152:3001';

// ------------------- Generatory przedziałów czasowych -------------------
function getRange(rangeKey) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  switch (rangeKey) {
    case 'lastMinute':
      start.setMinutes(now.getMinutes() - 1);
      break;
    case 'lastHour':
      start.setHours(now.getHours() - 1);
      break;
    case 'last24h':
      start.setDate(now.getDate() - 1);
      break;
    case 'thisWeek': {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1); // poniedziałek
      start.setDate(diff);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'prevWeek': {
      const day = now.getDay();
      const diff = now.getDate() - day + (day === 0 ? -6 : 1) - 7;
      start.setDate(diff);
      start.setHours(0, 0, 0, 0);
      const endPrev = new Date(start);
      endPrev.setDate(start.getDate() + 6);
      endPrev.setHours(23, 59, 59, 999);
      return { start: start.toISOString(), end: endPrev.toISOString() };
    }
    case 'thisMonth': {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'prevMonth': {
      start.setMonth(now.getMonth() - 1);
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      const endPrevMonth = new Date(start);
      endPrevMonth.setMonth(start.getMonth() + 1);
      endPrevMonth.setDate(0);
      endPrevMonth.setHours(23, 59, 59, 999);
      return { start: start.toISOString(), end: endPrevMonth.toISOString() };
    }
    case 'thisYear': {
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'prevYear': {
      start.setFullYear(now.getFullYear() - 1);
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      const endPrevYear = new Date(start);
      endPrevYear.setFullYear(start.getFullYear() + 1);
      endPrevYear.setDate(0);
      endPrevYear.setHours(23, 59, 59, 999);
      return { start: start.toISOString(), end: endPrevYear.toISOString() };
    }
    default:
      return null;
  }

  // Dla przypadków z jednym końcem (do teraz)
  if (rangeKey !== 'prevWeek' && rangeKey !== 'prevMonth' && rangeKey !== 'prevYear') {
    return { start: start.toISOString(), end: now.toISOString() };
  }
  return null;
}

const RANGE_OPTIONS = [
  { value: 'lastMinute', label: 'Ostatnia minuta' },
  { value: 'lastHour', label: 'Ostatnia godzina' },
  { value: 'last24h', label: 'Ostatnie 24h' },
  { value: 'thisWeek', label: 'Ten tydzień' },
  { value: 'prevWeek', label: 'Poprzedni tydzień' },
  { value: 'thisMonth', label: 'Ten miesiąc' },
  { value: 'prevMonth', label: 'Poprzedni miesiąc' },
  { value: 'thisYear', label: 'Ten rok' },
  { value: 'prevYear', label: 'Poprzedni rok' },
];

// ------------------- Główny komponent -------------------
export default function Dashboard() {
  // Stan dla głównych danych (wszystkie endpointy)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({
    ip: null,
    stops: null,
    schedules: null,
    holidays: null,
    trips: null,
    vehicles: null,
    settings: null,
    currentStatus: null,
    stopUsage: null,
    onDemandStops: null,
    linePerformance: null,
    adminZone: null,
  });

  // Stan dla historycznych lokalizacji
  const [historyRange, setHistoryRange] = useState('last24h');
  const [historyData, setHistoryData] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);

  // Funkcja pomocnicza do fetch
  const fetchData = async (url, label) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} – ${response.statusText}`);
      const json = await response.json();
      return { label, data: json, error: null };
    } catch (err) {
      return { label, data: null, error: err.message };
    }
  };

  // Ładowanie wszystkich danych podstawowych
  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      setError(null);

      const endpoints = [
        { url: `${BASE_URL}/api/ip`, label: 'ip' },
        { url: `${BASE_URL}/stops`, label: 'stops' },
        { url: `${BASE_URL}/schedules`, label: 'schedules' },
        { url: `${BASE_URL}/holidays`, label: 'holidays' },
        { url: `${BASE_URL}/trips?page=1&limit=10`, label: 'trips' },
        { url: `${BASE_URL}/vehicles`, label: 'vehicles' },
        { url: `${BASE_URL}/settings`, label: 'settings' },
        { url: `${BASE_URL}/reports/trip/current`, label: 'currentStatus' },
        { url: `${BASE_URL}/reports/stop-usage`, label: 'stopUsage' },
        { url: `${BASE_URL}/reports/on-demand-stops`, label: 'onDemandStops' },
        { url: `${BASE_URL}/reports/line-performance`, label: 'linePerformance' },
        { url: `${BASE_URL}/reports/admin-zone`, label: 'adminZone' },
      ];

      const results = await Promise.all(endpoints.map(({ url, label }) => fetchData(url, label)));

      const newData = {};
      let hasError = false;
      results.forEach(({ label, data, error }) => {
        newData[label] = data;
        if (error) {
          hasError = true;
          setError(prev => prev ? `${prev} | ${label}: ${error}` : `${label}: ${error}`);
        }
      });

      setData(prev => ({ ...prev, ...newData }));
      setLoading(false);
    };

    loadAll();
  }, []);

  // Ładowanie danych historycznych na podstawie zakresu
  const loadHistory = useCallback(async () => {
    const range = getRange(historyRange);
    if (!range) return;

    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const url = `${BASE_URL}/trips?start=${encodeURIComponent(range.start)}&end=${encodeURIComponent(range.end)}&limit=5000`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} – ${response.statusText}`);
      const json = await response.json();
      setHistoryData(json);
    } catch (err) {
      setHistoryError(err.message);
      setHistoryData(null);
    } finally {
      setHistoryLoading(false);
    }
  }, [historyRange]);

  // Pobieranie historii przy zmianie zakresu
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  if (loading) {
    return (
      <div className={styles.container}>
        <h1>📊 Dashboard</h1>
        <div className={styles.loading}>Ładowanie danych z backendu…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <h1>📊 Dashboard</h1>
        <div className={styles.error}>
          <strong>Wystąpiły błędy podczas pobierania danych:</strong>
          <pre>{error}</pre>
          <p>Sprawdź, czy serwer jest uruchomiony pod adresem {BASE_URL} i czy CORS jest włączony.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>📊 Dashboard</h1>
        <p className={styles.subtitle}>
          Podgląd wszystkich danych z backendu • Serwer: {BASE_URL}
        </p>
      </header>

      {/* Panel historii lokalizacji */}
      <section className={styles.historyPanel}>
        <h2>📍 Historia lokalizacji</h2>
        <div className={styles.historyControls}>
          <select
            value={historyRange}
            onChange={(e) => setHistoryRange(e.target.value)}
            className={styles.select}
          >
            {RANGE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button onClick={loadHistory} className={styles.button} disabled={historyLoading}>
            {historyLoading ? 'Ładowanie…' : 'Pobierz'}
          </button>
          {historyError && <span className={styles.errorText}>{historyError}</span>}
        </div>
        {historyData && historyData.ok && (
          <div className={styles.historyResult}>
            <div className={styles.historyMeta}>
              Znaleziono {historyData.rows?.length || 0} rekordów
              {historyData.total && ` (łącznie ${historyData.total})`}
            </div>
            <HistoryTable rows={historyData.rows || []} />
          </div>
        )}
        {historyData && !historyData.ok && (
          <div className={styles.empty}>Błąd: {historyData.error}</div>
        )}
        {!historyData && !historyLoading && !historyError && (
          <div className={styles.empty}>Wybierz zakres i kliknij "Pobierz"</div>
        )}
      </section>

      {/* Pozostałe sekcje */}
      <div className={styles.grid}>
        <Section title="🌐 Informacje o serwerze" data={data.ip} />
        <Section title="🚏 Przystanki" data={data.stops} />
        <Section title="📅 Rozkłady jazdy" data={data.schedules} />
        <Section title="🎉 Święta / dni niestandardowe" data={data.holidays} />
        <Section title="🚌 Pojazdy" data={data.vehicles} />
        <Section title="🕒 Ostatnie zdarzenia (trips)" data={data.trips} />
        <Section title="📡 Aktualny status pojazdów" data={data.currentStatus} />
        <Section title="⚙️ Ustawienia" data={data.settings} />
        <Section title="📊 Raport wykorzystania przystanków" data={data.stopUsage} />
        <Section title="🔄 Przystanki na żądanie" data={data.onDemandStops} />
        <Section title="📈 Wydajność linii" data={data.linePerformance} />
        <Section title="🗺️ Raport stref administracyjnych" data={data.adminZone} />
      </div>
    </div>
  );
}

// ------------------- Komponent tabeli historycznej -------------------
function HistoryTable({ rows }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows || rows.length === 0) {
    return <div className={styles.empty}>Brak danych dla wybranego zakresu</div>;
  }

  const displayRows = expanded ? rows : rows.slice(0, 50);

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>PC Name</th>
            <th>Latitude</th>
            <th>Longitude</th>
            <th>Stop ID</th>
            <th>Line ID</th>
            <th>Delay (s)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map((row, idx) => (
            <tr key={idx}>
              <td>{row.timestamp || row.received_at}</td>
              <td>{row.pcName}</td>
              <td>{row.latitude?.toFixed(6) || '—'}</td>
              <td>{row.longitude?.toFixed(6) || '—'}</td>
              <td>{row.stop_id || '—'}</td>
              <td>{row.line_id || '—'}</td>
              <td>{row.delay_seconds ?? '—'}</td>
              <td>{row.punctuality_status || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 50 && (
        <button className={styles.toggleButton} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Zwiń' : `Pokaż wszystkie (${rows.length})`}
        </button>
      )}
    </div>
  );
}

// ------------------- Komponent sekcji -------------------
function Section({ title, data }) {
  const [expanded, setExpanded] = useState(false);

  if (!data) {
    return (
      <div className={styles.section}>
        <h2>{title}</h2>
        <div className={styles.empty}>Brak danych</div>
      </div>
    );
  }

  let displayData = data;
  if (data.ok === true && data.rows !== undefined) {
    displayData = data.rows;
  } else if (data.ok === true && data.stops !== undefined) {
    displayData = data.stops;
  } else if (data.ok === true && data.schedules !== undefined) {
    displayData = data.schedules;
  } else if (data.ok === true && data.vehicles !== undefined) {
    displayData = data.vehicles;
  } else if (data.ok === true && data.current_status !== undefined) {
    displayData = data.current_status;
  } else if (data.ok === true && data.holidays !== undefined) {
    displayData = data.holidays;
  } else if (data.ok === true && data.settings !== undefined) {
    displayData = data.settings;
  }

  const isObject = typeof displayData === 'object' && displayData !== null && !Array.isArray(displayData);
  const isArray = Array.isArray(displayData);

  return (
    <div className={styles.section}>
      <h2>{title}</h2>
      <div className={styles.sectionContent}>
        {isArray && displayData.length === 0 && <div className={styles.empty}>Brak rekordów</div>}
        {isArray && displayData.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {Object.keys(displayData[0]).map(key => (
                    <th key={key}>{key}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayData.slice(0, expanded ? displayData.length : 10).map((row, idx) => (
                  <tr key={idx}>
                    {Object.values(row).map((val, i) => (
                      <td key={i}>{formatValue(val)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {displayData.length > 10 && (
              <button className={styles.toggleButton} onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Zwiń' : `Pokaż wszystkie (${displayData.length})`}
              </button>
            )}
          </div>
        )}
        {isObject && (
          <pre className={styles.json}>{JSON.stringify(displayData, null, 2)}</pre>
        )}
        {!isArray && !isObject && (
          <div className={styles.scalar}>{String(displayData)}</div>
        )}
      </div>
    </div>
  );
}

function formatValue(val) {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? '✅' : '❌';
  if (typeof val === 'object') return JSON.stringify(val).slice(0, 100) + (JSON.stringify(val).length > 100 ? '…' : '');
  return String(val);
}