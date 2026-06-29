import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import styles from './Dashboard.module.css';

// ─── KONFIGURACJA ──────────────────────────────────────────────────────────────
const BACKEND_IP = '192.168.68.108';
const BACKEND_PORT = 3001;
const BACKEND_URL = `http://${BACKEND_IP}:${BACKEND_PORT}`;
const FRONTEND_POLL_MS = 30_000; // 30 sekund dla głównego dashboardu
const TRIP_POLL_MS = 5_000;      // 5 sekund dla danych o kursie

// ─── STAŁE UI ─────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  Online: '#22d3a0',
  Offline: '#f43f5e',
  Paused: '#f59e0b',
  Initializing: '#818cf8',
  Pending: '#64748b',
  Unknown: '#475569',
};

const PIE_PALETTE = ['#22d3a0', '#f43f5e', '#f59e0b', '#818cf8', '#64748b'];

const DELAY_STATUS = {
  'o czasie': { color: '#22d3a0', label: 'O CZASIE', icon: '✅' },
  'opóźniony': { color: '#f43f5e', label: 'OPÓŹNIONY', icon: '⚠️' },
  'za szybko': { color: '#f59e0b', label: 'ZA SZYBKO', icon: '⚡' },
};

// ─── UTILITY ──────────────────────────────────────────────────────────────────
function formatAge(isoString) {
  if (!isoString) return '–';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s temu`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min temu`;
  return `${Math.floor(diffMin / 60)}h temu`;
}

function formatDateTime(isoString) {
  if (!isoString) return '–';
  try {
    return new Date(isoString).toLocaleString('pl-PL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function formatTimeBucket(bucket) {
  if (!bucket) return '';
  try {
    return new Date(bucket).toLocaleTimeString('pl-PL', {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return bucket;
  }
}

function formatDelay(seconds) {
  if (seconds === undefined || seconds === null) return '–';
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = Math.floor(abs % 60);
  const sign = seconds < 0 ? '-' : '+';
  return `${sign} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── KOMPONENTY POMOCNICZE ────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const color = STATUS_COLORS[status] || STATUS_COLORS.Unknown;
  return (
    <span className={styles.badge} style={{ '--badge-color': color }}>
      <span className={styles.badgeDot} style={{ background: color }} />
      {status || 'Unknown'}
    </span>
  );
}

function KPICard({ label, value, sub, accent, alert }) {
  return (
    <div className={`${styles.kpiCard} ${alert ? styles.kpiAlert : ''}`}>
      <div className={styles.kpiValue} style={accent ? { color: accent } : {}}>
        {value ?? '–'}
      </div>
      <div className={styles.kpiLabel}>{label}</div>
      {sub && <div className={styles.kpiSub}>{sub}</div>}
    </div>
  );
}

function IntegrationPill({ name, connected, error }) {
  return (
    <div
      className={styles.integrationPill}
      title={error || (connected ? 'Połączono' : 'Brak połączenia')}
    >
      <span
        className={styles.integrationDot}
        style={{ background: connected ? '#22d3a0' : '#f43f5e' }}
      />
      {name}
    </div>
  );
}

function SectionHeader({ title, count }) {
  return (
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {count !== undefined && (
        <span className={styles.sectionCount}>{count}</span>
      )}
    </div>
  );
}

function FlowTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.chartTooltip}>
      <div className={styles.tooltipLabel}>{formatTimeBucket(label)}</div>
      {payload.map((p) => (
        <div key={p.name} className={styles.tooltipRow} style={{ color: p.color }}>
          <span>{p.name === 'count_in' ? 'Wejścia' : 'Wyjścia'}</span>
          <span className={styles.tooltipVal}>{p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── NOWE KOMPONENTY: Monitoring, Raporty, Konfiguracja ────────────────────

function TripMonitor({ tripData, loading, error, cameraAlert }) {
  if (loading) {
    return (
      <div className={styles.centeredState}>
        <div className={styles.spinner} />
        <p>Pobieranie danych o kursie…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.centeredState}>
        <p className={styles.errorText}>Błąd: {error}</p>
      </div>
    );
  }
  if (!tripData) {
    return (
      <div className={styles.centeredState}>
        <p>Brak danych o kursie</p>
      </div>
    );
  }

  const { current_position, next_stop, planned_time, actual_time, status, delay_seconds, last_update, data_quality } =
    tripData;
  const statusInfo = DELAY_STATUS[status] || DELAY_STATUS['o czasie'];
  const delayText = delay_seconds !== undefined ? formatDelay(delay_seconds) : '–';
  const isDelayed = status === 'opóźniony';
  const isEarly = status === 'za szybko';
  const statusColor = isDelayed ? '#f43f5e' : isEarly ? '#f59e0b' : '#22d3a0';

  return (
    <div className={styles.tripMonitor}>
      {/* Alert kamer */}
      {cameraAlert && (
        <div className={styles.alertBanner}>
          ⚠️ Wadliwość pomiaru: {cameraAlert}
        </div>
      )}

      <div className={styles.tripGrid}>
        {/* Lewa kolumna: pozycja i status */}
        <div className={styles.tripStatusCard}>
          <div className={styles.tripStatusHeader}>
            <span className={styles.tripStatusIcon}>{statusInfo.icon}</span>
            <span className={styles.tripStatusLabel} style={{ color: statusColor }}>
              {statusInfo.label}
            </span>
            <span className={styles.tripDelay} style={{ color: statusColor }}>
              {delayText}
            </span>
          </div>
          <div className={styles.tripCoords}>
            <span className={styles.coordLabel}>Lat:</span>
            <span className={styles.coordValue}>{current_position?.lat?.toFixed(6) ?? '–'}</span>
            <span className={styles.coordLabel}>Lng:</span>
            <span className={styles.coordValue}>{current_position?.lng?.toFixed(6) ?? '–'}</span>
          </div>
          <div className={styles.tripNextStop}>
            <span className={styles.nextStopLabel}>Najbliższy przystanek:</span>
            <span className={styles.nextStopName}>{next_stop?.name || '–'}</span>
            <span className={styles.nextStopTime}>
              plan: {next_stop?.planned_time || '–'}
            </span>
          </div>
          <div className={styles.tripMeta}>
            <span>Ostatnia aktualizacja: {formatAge(last_update)}</span>
            <span>|</span>
            <span>Planowany czas: {planned_time || '–'}</span>
            <span>|</span>
            <span>Rzeczywisty czas: {actual_time ? formatDateTime(actual_time) : '–'}</span>
          </div>
        </div>

        {/* Prawa kolumna: mini wykres historii opóźnień? Tutaj możemy dodać prosty wskaźnik */}
        <div className={styles.tripStatusCard}>
          <div className={styles.tripStatusHeader}>
            <span>Stan systemu</span>
          </div>
          <div className={styles.tripQuality}>
            <span>Jakość danych: </span>
            <span style={{ color: data_quality?.complete ? '#22d3a0' : '#f43f5e' }}>
              {data_quality?.complete ? '✅ Kompletna' : '❌ Niekompletna'}
            </span>
            {data_quality?.errors?.length > 0 && (
              <ul className={styles.errorList}>
                {data_quality.errors.map((err, i) => (
                  <li key={i}>• {err}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportsTab({ stopUsage, onDemandUsage, loading, error }) {
  if (loading) {
    return (
      <div className={styles.centeredState}>
        <div className={styles.spinner} />
        <p>Ładowanie raportów…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className={styles.centeredState}>
        <p className={styles.errorText}>Błąd: {error}</p>
      </div>
    );
  }

  // Przygotowanie danych dla wykresów
  const stopUsageData = stopUsage?.usage || [];
  const onDemandData = onDemandUsage?.on_demand_usage || [];

  // Podział administracyjny – na podstawie przystanków (brak danych, możemy symulować)
  // W praktyce powinniśmy pobrać listę przystanków z admin_zone, ale nie mamy endpointu.
  // Użyjemy danych z stopUsage, jeśli zawierają admin_zone? Nie ma. Zrobimy prosty podział na Toruń i inne.
  // Dla potrzeb demo, jeśli nie ma danych, pokażemy przykładowe.
  const adminData = [
    { name: 'Toruń', value: 70 },
    { name: 'Gminy ościenne', value: 30 },
  ];

  return (
    <div className={styles.reportsTab}>
      <div className={styles.reportsGrid}>
        {/* Wykorzystanie przystanków */}
        <div className={styles.card}>
          <SectionHeader title="Wykorzystanie przystanków" />
          {stopUsageData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stopUsageData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#22d3a0" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles.emptyChart}>Brak danych</div>
          )}
        </div>

        {/* Analiza na żądanie */}
        <div className={styles.card}>
          <SectionHeader title="Przystanki na żądanie" />
          {onDemandData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={onDemandData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 11 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="count" fill="#818cf8" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className={styles.emptyChart}>Brak danych</div>
          )}
        </div>

        {/* Wydajność linii (przykład) */}
        <div className={styles.card}>
          <SectionHeader title="Wydajność linii 113" />
          <div className={styles.performanceMetrics}>
            <div className={styles.metricItem}>
              <span>Średnie opóźnienie</span>
              <span className={styles.metricValue}>+00:02:15</span>
            </div>
            <div className={styles.metricItem}>
              <span>Punktualność</span>
              <span className={styles.metricValue}>87%</span>
            </div>
            <div className={styles.metricItem}>
              <span>Liczba kursów</span>
              <span className={styles.metricValue}>42</span>
            </div>
          </div>
        </div>

        {/* Podział administracyjny */}
        <div className={styles.card}>
          <SectionHeader title="Podział administracyjny" />
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={adminData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={3}
                dataKey="value"
              >
                {adminData.map((entry, i) => (
                  <Cell key={entry.name} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function ConfigTab({ stops, schedules, onAddStop, onAddSchedule, loading, error }) {
  const [newStop, setNewStop] = useState({
    stop_id: '',
    name: '',
    number: '',
    latitude: '',
    longitude: '',
    admin_zone: '',
    zone_type: 'stały',
  });

  const [newSchedule, setNewSchedule] = useState({
    line: '113',
    direction: '',
    day_type: 'weekday',
    stops_sequence: [],
  });

  // Stan dla dodawania przystanków do sekwencji
  const [seqStopId, setSeqStopId] = useState('');
  const [seqTime, setSeqTime] = useState('');

  const handleStopChange = (e) => {
    const { name, value } = e.target;
    setNewStop((prev) => ({ ...prev, [name]: value }));
  };

  const handleStopSubmit = async (e) => {
    e.preventDefault();
    await onAddStop(newStop);
    // Po dodaniu wyczyść formularz (opcjonalnie)
    setNewStop({
      stop_id: '',
      name: '',
      number: '',
      latitude: '',
      longitude: '',
      admin_zone: '',
      zone_type: 'stały',
    });
  };

  const handleScheduleChange = (e) => {
    const { name, value } = e.target;
    setNewSchedule((prev) => ({ ...prev, [name]: value }));
  };

  const addStopToSequence = () => {
    if (!seqStopId || !seqTime) return;
    setNewSchedule((prev) => ({
      ...prev,
      stops_sequence: [...prev.stops_sequence, { stop_id: seqStopId, planned_time: seqTime }],
    }));
    setSeqStopId('');
    setSeqTime('');
  };

  const removeStopFromSequence = (index) => {
    setNewSchedule((prev) => ({
      ...prev,
      stops_sequence: prev.stops_sequence.filter((_, i) => i !== index),
    }));
  };

  const handleScheduleSubmit = async (e) => {
    e.preventDefault();
    if (newSchedule.stops_sequence.length < 2) {
      alert('Sekwencja musi zawierać co najmniej 2 przystanki.');
      return;
    }
    await onAddSchedule(newSchedule);
    // Po dodaniu wyczyść formularz (opcjonalnie)
    setNewSchedule({
      line: '113',
      direction: '',
      day_type: 'weekday',
      stops_sequence: [],
    });
  };

  return (
    <div className={styles.configTab}>
      <div className={styles.configGrid}>
        {/* Formularz dodawania przystanków */}
        <div className={styles.card}>
          <SectionHeader title="Dodaj przystanek" />
          <form onSubmit={handleStopSubmit} className={styles.configForm}>
            <div className={styles.formRow}>
              <label>ID przystanku</label>
              <input
                type="text"
                name="stop_id"
                value={newStop.stop_id}
                onChange={handleStopChange}
                required
                placeholder="np. stop_6"
              />
            </div>
            <div className={styles.formRow}>
              <label>Nazwa</label>
              <input
                type="text"
                name="name"
                value={newStop.name}
                onChange={handleStopChange}
                required
                placeholder="np. Rondo"
              />
            </div>
            <div className={styles.formRow}>
              <label>Numer</label>
              <input
                type="text"
                name="number"
                value={newStop.number}
                onChange={handleStopChange}
                required
                placeholder="np. 06"
              />
            </div>
            <div className={styles.formRow}>
              <label>Szerokość (Lat)</label>
              <input
                type="number"
                step="any"
                name="latitude"
                value={newStop.latitude}
                onChange={handleStopChange}
                required
                placeholder="np. 53.0138"
              />
            </div>
            <div className={styles.formRow}>
              <label>Długość (Lng)</label>
              <input
                type="number"
                step="any"
                name="longitude"
                value={newStop.longitude}
                onChange={handleStopChange}
                required
                placeholder="np. 18.5982"
              />
            </div>
            <div className={styles.formRow}>
              <label>Strefa administracyjna</label>
              <input
                type="text"
                name="admin_zone"
                value={newStop.admin_zone}
                onChange={handleStopChange}
                required
                placeholder="np. Toruń"
              />
            </div>
            <div className={styles.formRow}>
              <label>Typ strefy</label>
              <select name="zone_type" value={newStop.zone_type} onChange={handleStopChange}>
                <option value="stały">Stały</option>
                <option value="na żądanie">Na żądanie</option>
              </select>
            </div>
            <button type="submit" className={styles.primaryBtn}>Dodaj przystanek</button>
          </form>
          {loading && <p>Ładowanie…</p>}
          {error && <p className={styles.errorText}>{error}</p>}
        </div>

        {/* Formularz dodawania rozkładu */}
        <div className={styles.card}>
          <SectionHeader title="Dodaj rozkład jazdy" />
          <form onSubmit={handleScheduleSubmit} className={styles.configForm}>
            <div className={styles.formRow}>
              <label>Linia</label>
              <input
                type="text"
                name="line"
                value={newSchedule.line}
                onChange={handleScheduleChange}
                required
                placeholder="113"
              />
            </div>
            <div className={styles.formRow}>
              <label>Kierunek</label>
              <input
                type="text"
                name="direction"
                value={newSchedule.direction}
                onChange={handleScheduleChange}
                required
                placeholder="np. Dworzec Główny → Włocławska"
              />
            </div>
            <div className={styles.formRow}>
              <label>Typ dnia</label>
              <select name="day_type" value={newSchedule.day_type} onChange={handleScheduleChange}>
                <option value="weekday">Dni powszednie</option>
                <option value="weekend">Weekend</option>
                <option value="holiday">Święta</option>
              </select>
            </div>

            <div className={styles.formRow}>
              <label>Sekwencja przystanków</label>
              <div className={styles.sequenceBuilder}>
                <div className={styles.sequenceInputs}>
                  <select
                    value={seqStopId}
                    onChange={(e) => setSeqStopId(e.target.value)}
                    className={styles.selectSmall}
                  >
                    <option value="">Wybierz przystanek</option>
                    {stops.map((stop) => (
                      <option key={stop.stop_id} value={stop.stop_id}>
                        {stop.name} ({stop.stop_id})
                      </option>
                    ))}
                  </select>
                  <input
                    type="time"
                    step="1"
                    value={seqTime}
                    onChange={(e) => setSeqTime(e.target.value)}
                    placeholder="HH:MM:SS"
                    className={styles.inputSmall}
                  />
                  <button type="button" onClick={addStopToSequence} className={styles.secondaryBtn}>
                    +
                  </button>
                </div>
                <ul className={styles.sequenceList}>
                  {newSchedule.stops_sequence.map((item, idx) => (
                    <li key={idx}>
                      {item.stop_id} – {item.planned_time}
                      <button
                        type="button"
                        onClick={() => removeStopFromSequence(idx)}
                        className={styles.removeBtn}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <button type="submit" className={styles.primaryBtn}>Dodaj rozkład</button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── GŁÓWNY KOMPONENT ─────────────────────────────────────────────────────────
export default function Dashboard() {
  // Istniejące stany
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connError, setConnError] = useState(null);
  const [selectedApp, setSelectedApp] = useState(null);
  const intervalRef = useRef(null);

  // Nowe stany
  const [activeTab, setActiveTab] = useState('live'); // 'live', 'reports', 'config'
  const [tripData, setTripData] = useState(null);
  const [tripLoading, setTripLoading] = useState(true);
  const [tripError, setTripError] = useState(null);

  const [stopUsage, setStopUsage] = useState(null);
  const [onDemandUsage, setOnDemandUsage] = useState(null);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsError, setReportsError] = useState(null);

  const [stops, setStops] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState(null);

  // ─── Fetch istniejących danych (główny dashboard) ──────────────────────
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/dashboard-data`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setConnError(null);
    } catch (err) {
      setConnError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ─── Fetch danych o kursie ──────────────────────────────────────────────
  const fetchTrip = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/reports/trip/current`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setTripData(json);
      setTripError(null);
    } catch (err) {
      setTripError(err.message);
    } finally {
      setTripLoading(false);
    }
  }, []);

  // ─── Fetch raportów ──────────────────────────────────────────────────────
  const fetchReports = useCallback(async () => {
    setReportsLoading(true);
    try {
      const [usageRes, onDemandRes] = await Promise.all([
        fetch(`${BACKEND_URL}/reports/stop-usage`),
        fetch(`${BACKEND_URL}/reports/on-demand-stops`),
      ]);
      if (!usageRes.ok) throw new Error(`HTTP ${usageRes.status} dla stop-usage`);
      if (!onDemandRes.ok) throw new Error(`HTTP ${onDemandRes.status} dla on-demand`);

      const usageJson = await usageRes.json();
      const onDemandJson = await onDemandRes.json();

      setStopUsage(usageJson);
      setOnDemandUsage(onDemandJson);
      setReportsError(null);
    } catch (err) {
      setReportsError(err.message);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  // ─── Fetch listy przystanków i rozkładów (dla konfiguracji) ────────────
  const fetchStopsAndSchedules = useCallback(async () => {
    setConfigLoading(true);
    try {
      const [stopsRes, schedulesRes] = await Promise.all([
        fetch(`${BACKEND_URL}/stops`),
        fetch(`${BACKEND_URL}/schedules`),
      ]);
      if (!stopsRes.ok) throw new Error(`HTTP ${stopsRes.status} dla stops`);
      if (!schedulesRes.ok) throw new Error(`HTTP ${schedulesRes.status} dla schedules`);

      const stopsJson = await stopsRes.json();
      const schedulesJson = await schedulesRes.json();

      // Zakładamy, że endpointy zwracają odpowiednio { stops: [...] } i { schedules: [...] }
      setStops(stopsJson.stops || []);
      setSchedules(schedulesJson.schedules || []);
      setConfigError(null);
    } catch (err) {
      setConfigError(err.message);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  // ─── Operacje dodawania ──────────────────────────────────────────────────
  const addStop = async (stopData) => {
    try {
      const res = await fetch(`${BACKEND_URL}/stops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stopData),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchStopsAndSchedules(); // odświeżenie listy
    } catch (err) {
      setConfigError(err.message);
      throw err;
    }
  };

  const addSchedule = async (scheduleData) => {
    try {
      const res = await fetch(`${BACKEND_URL}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scheduleData),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchStopsAndSchedules(); // odświeżenie listy
    } catch (err) {
      setConfigError(err.message);
      throw err;
    }
  };

  // ─── Efekty ──────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, FRONTEND_POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchData]);

  // Efekt dla trip – odświeżanie co 5 sekund
  useEffect(() => {
    fetchTrip();
    const tripInterval = setInterval(fetchTrip, TRIP_POLL_MS);
    return () => clearInterval(tripInterval);
  }, [fetchTrip]);

  // Efekt dla raportów – przy przejściu na zakładkę 'reports' lub co 30s
  useEffect(() => {
    if (activeTab === 'reports') {
      fetchReports();
      const reportsInterval = setInterval(fetchReports, FRONTEND_POLL_MS);
      return () => clearInterval(reportsInterval);
    }
  }, [activeTab, fetchReports]);

  // Efekt dla konfiguracji – pobierz listy przy pierwszym wejściu
  useEffect(() => {
    if (activeTab === 'config') {
      fetchStopsAndSchedules();
    }
  }, [activeTab, fetchStopsAndSchedules]);

  // ─── Wyodrębnienie danych dla istniejących KPI ─────────────────────────
  const { summary, health, license, mqtt, vms, applications, timeline, _cache } =
    data || {};

  const objectFlowApps = (applications || []).filter(
    (a) => a.__typename === 'ObjectFlow'
  );
  const objectCountApps = (applications || []).filter(
    (a) => a.__typename === 'ObjectCount'
  );
  const crowdCountApps = (applications || []).filter(
    (a) => a.__typename === 'CrowdCount'
  );

  const statusPieData = Object.entries(summary?.statusBreakdown || {}).map(
    ([name, value]) => ({ name, value })
  );

  const selectedAppData = selectedApp
    ? applications?.find((a) => a.uuid === selectedApp)
    : null;
  const selectedHistoryLines = selectedAppData?._history?.lines || [];
  const detailChartData =
    selectedHistoryLines[0]?.count_data?.map((b) => ({
      ...b,
      label: formatTimeBucket(b.time_bucket),
    })) || [];

  // Sprawdzenie alertu kamer
  const cameraAlert =
    tripData?.data_quality?.complete === false
      ? tripData.data_quality.errors?.join(', ') || 'Brak obrazu ze wszystkich kamer – pomiar wadliwy'
      : null;

  // ─── RENDER ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className={styles.centeredState}>
        <div className={styles.spinner} />
        <p>Łączenie z backendem…</p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {/* ── HEADER ── */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logoMark}>
            <span className={styles.logoIcon}>▶</span>
            <span className={styles.logoText}>Isarsoft</span>
            <span className={styles.logoSub}>Analytics Dashboard</span>
          </div>
        </div>

        <div className={styles.headerCenter}>
          {connError ? (
            <span className={styles.connBad}>
              ⚠ Brak połączenia z backendem ({connError})
            </span>
          ) : (
            <span className={styles.connGood}>● Backend online</span>
          )}
        </div>

        <div className={styles.headerRight}>
          <div className={styles.updateInfo}>
            <span className={styles.updateLabel}>Ostatnia aktualizacja</span>
            <span className={styles.updateTime}>
              {formatAge(_cache?.lastSuccess)}
            </span>
          </div>
          <div className={styles.updateInfo}>
            <span className={styles.updateLabel}>Dane z API</span>
            <span className={styles.updateTime}>
              {formatDateTime(_cache?.lastSuccess)}
            </span>
          </div>
        </div>
      </header>

      {/* ── NAVIGATION TABS ── */}
      <nav className={styles.tabNav}>
        <button
          className={`${styles.tabButton} ${activeTab === 'live' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('live')}
        >
          🚌 Monitoring na żywo
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'reports' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('reports')}
        >
          📊 Raporty
        </button>
        <button
          className={`${styles.tabButton} ${activeTab === 'config' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('config')}
        >
          ⚙️ Konfiguracja
        </button>
      </nav>

      <main className={styles.main}>
        {/* ── ZAWARTOŚĆ ZAKŁADEK ── */}

        {activeTab === 'live' && (
          <>
            {/* Alert kamer – jeśli występuje, wyświetlamy na samej górze */}
            {cameraAlert && (
              <div className={styles.alertBannerGlobal}>
                ⚠️ {cameraAlert}
              </div>
            )}

            {/* Komponent monitoringu */}
            <TripMonitor
              tripData={tripData}
              loading={tripLoading}
              error={tripError}
              cameraAlert={cameraAlert}
            />

            {/* Pozostałe KPI (istniejące) – można zostawić lub ukryć, ale wymaganie mówi o rozbudowie, więc zostawiamy */}
            <section className={styles.kpiGrid}>
              <KPICard
                label="Kamery"
                value={summary?.totalCameras}
                sub={`${health?.cameras_online ?? '?'} online`}
              />
              <KPICard
                label="Aplikacje"
                value={summary?.totalApplications}
                sub={`ObjectFlow: ${summary?.objectFlowCount}`}
              />
              <KPICard
                label="Aplikacje Offline"
                value={health?.applications_offline ?? summary?.statusBreakdown?.Offline ?? 0}
                alert={(health?.applications_offline || 0) > 0}
                accent={
                  (health?.applications_offline || 0) > 0 ? '#f43f5e' : '#22d3a0'
                }
              />
              <KPICard
                label="Wejścia (12h)"
                value={summary?.totalCountIn12h?.toLocaleString('pl-PL')}
                accent="#22d3a0"
              />
              <KPICard
                label="Wyjścia (12h)"
                value={summary?.totalCountOut12h?.toLocaleString('pl-PL')}
                accent="#818cf8"
              />
              <KPICard
                label="Live — Wejścia"
                value={summary?.liveTotalIn}
                sub="ostatnia chwila"
                accent="#22d3a0"
              />
              <KPICard
                label="Licencja"
                value={license?.valid ? 'Aktywna' : 'Nieaktywna'}
                sub={license?.expires_at ? `Wygasa: ${formatDateTime(license.expires_at)}` : undefined}
                accent={license?.valid ? '#22d3a0' : '#f43f5e'}
                alert={!license?.valid}
              />
              <KPICard
                label="MQTT"
                value={mqtt?.enabled ? 'Aktywny' : 'Wyłączony'}
                sub={mqtt?.host ? `${mqtt.host}:${mqtt.port}` : undefined}
                accent={mqtt?.enabled ? '#22d3a0' : '#64748b'}
              />
            </section>

            {/* Reszta istniejącego dashboardu (wykresy, tabele) – można zostawić */}
            {vms && (
              <section className={styles.card}>
                <SectionHeader title="Integracje VMS" />
                <div className={styles.integrationsRow}>
                  {vms.cayuga && (
                    <IntegrationPill
                      name="Cayuga"
                      connected={vms.cayuga.connected}
                      error={vms.cayuga.error}
                    />
                  )}
                  {vms.milestone && (
                    <IntegrationPill
                      name="Milestone"
                      connected={vms.milestone.connected}
                      error={vms.milestone.error}
                    />
                  )}
                  {vms.genetec && (
                    <IntegrationPill
                      name="Genetec"
                      connected={vms.genetec.connected}
                      error={vms.genetec.error}
                    />
                  )}
                </div>
              </section>
            )}

            <div className={styles.chartsRow}>
              <div className={`${styles.card} ${styles.chartCard}`}>
                <SectionHeader title="Przepływ obiektów — ostatnie 12h" />
                {timeline && timeline.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={timeline} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis
                        dataKey="time_bucket"
                        tickFormatter={formatTimeBucket}
                        tick={{ fill: '#64748b', fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fill: '#64748b', fontSize: 11 }}
                        tickLine={false}
                        axisLine={false}
                      />
                      <Tooltip content={<FlowTooltip />} />
                      <Legend
                        formatter={(v) => (v === 'count_in' ? 'Wejścia' : 'Wyjścia')}
                        wrapperStyle={{ fontSize: 12, color: '#94a3b8' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="count_in"
                        stroke="#22d3a0"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: '#22d3a0' }}
                      />
                      <Line
                        type="monotone"
                        dataKey="count_out"
                        stroke="#818cf8"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: '#818cf8' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className={styles.emptyChart}>Brak danych historycznych</div>
                )}
              </div>

              <div className={`${styles.card} ${styles.chartCardSm}`}>
                <SectionHeader title="Statusy aplikacji" />
                {statusPieData.length > 0 ? (
                  <div className={styles.pieWrapper}>
                    <ResponsiveContainer width="100%" height={180}>
                      <PieChart>
                        <Pie
                          data={statusPieData}
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={78}
                          paddingAngle={3}
                          dataKey="value"
                        >
                          {statusPieData.map((entry, i) => (
                            <Cell
                              key={entry.name}
                              fill={STATUS_COLORS[entry.name] || PIE_PALETTE[i % PIE_PALETTE.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(v, n) => [v, n]}
                          contentStyle={{
                            background: '#0f172a',
                            border: '1px solid #1e293b',
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className={styles.pieLegend}>
                      {statusPieData.map((entry, i) => (
                        <div key={entry.name} className={styles.pieLegendItem}>
                          <span
                            className={styles.pieLegendDot}
                            style={{
                              background:
                                STATUS_COLORS[entry.name] || PIE_PALETTE[i % PIE_PALETTE.length],
                            }}
                          />
                          <span className={styles.pieLegendName}>{entry.name}</span>
                          <span className={styles.pieLegendVal}>{entry.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className={styles.emptyChart}>Brak danych</div>
                )}
              </div>
            </div>

            <section className={styles.card}>
              <SectionHeader title="Aplikacje ObjectFlow" count={objectFlowApps.length} />
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Nazwa</th>
                      <th>Kamera</th>
                      <th>Status</th>
                      <th>Ostatnio online</th>
                      <th>Linie</th>
                      <th>Strefy</th>
                      <th>Live IN/OUT</th>
                      <th>Alarmy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {objectFlowApps.length === 0 && (
                      <tr>
                        <td colSpan={8} className={styles.tableEmpty}>
                          Brak aplikacji ObjectFlow
                        </td>
                      </tr>
                    )}
                    {objectFlowApps.map((app) => {
                      const liveIn = app.lines
                        ?.reduce((s, l) => s + (l.count_live?.count_in || 0), 0) ?? 0;
                      const liveOut = app.lines
                        ?.reduce((s, l) => s + (l.count_live?.count_out || 0), 0) ?? 0;

                      return (
                        <tr
                          key={app.uuid}
                          className={`${styles.tableRow} ${selectedApp === app.uuid ? styles.tableRowSelected : ''}`}
                          onClick={() =>
                            setSelectedApp(selectedApp === app.uuid ? null : app.uuid)
                          }
                        >
                          <td className={styles.tdName}>{app.name}</td>
                          <td className={styles.tdCamera}>{app.camera?.name || '–'}</td>
                          <td>
                            <StatusBadge status={app.status} />
                          </td>
                          <td className={styles.tdMuted}>
                            {formatDateTime(app.last_online)}
                          </td>
                          <td className={styles.tdCenter}>{app.lines?.length ?? 0}</td>
                          <td className={styles.tdCenter}>{app.areas?.length ?? 0}</td>
                          <td className={styles.tdFlow}>
                            <span className={styles.flowIn}>↑{liveIn}</span>
                            <span className={styles.flowOut}>↓{liveOut}</span>
                          </td>
                          <td className={styles.tdCenter}>{app.alarms?.length ?? 0}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {selectedAppData && (
                <div className={styles.appDetail}>
                  <div className={styles.appDetailHeader}>
                    <h3 className={styles.appDetailTitle}>
                      Szczegóły: {selectedAppData.name}
                    </h3>
                    <button
                      className={styles.closeBtn}
                      onClick={() => setSelectedApp(null)}
                    >
                      ✕
                    </button>
                  </div>

                  <div className={styles.appDetailGrid}>
                    <div>
                      <div className={styles.detailSection}>
                        <div className={styles.detailSectionTitle}>Linie pomiarowe</div>
                        {selectedAppData.lines?.length ? (
                          selectedAppData.lines.map((line) => (
                            <div key={line.uuid} className={styles.lineRow}>
                              <span className={styles.lineName}>{line.name}</span>
                              <span className={styles.flowIn}>
                                ↑{line.count_live?.count_in ?? 0}
                              </span>
                              <span className={styles.flowOut}>
                                ↓{line.count_live?.count_out ?? 0}
                              </span>
                            </div>
                          ))
                        ) : (
                          <span className={styles.tdMuted}>Brak linii</span>
                        )}
                      </div>

                      <div className={styles.detailSection}>
                        <div className={styles.detailSectionTitle}>Strefy</div>
                        {selectedAppData.areas?.length ? (
                          selectedAppData.areas.map((area) => (
                            <div key={area.uuid} className={styles.lineRow}>
                              <span className={styles.lineName}>{area.name}</span>
                              <span className={styles.tdMuted}>
                                avg:{' '}
                                {area.count_live?.count_avg?.toFixed(1) ?? '–'}
                              </span>
                            </div>
                          ))
                        ) : (
                          <span className={styles.tdMuted}>Brak stref</span>
                        )}
                      </div>
                    </div>

                    <div>
                      {detailChartData.length > 0 ? (
                        <>
                          <div className={styles.detailSectionTitle}>
                            Historia linii „{selectedHistoryLines[0]?.name}" (12h)
                          </div>
                          <ResponsiveContainer width="100%" height={180}>
                            <BarChart
                              data={detailChartData}
                              margin={{ top: 4, right: 8, bottom: 0, left: -20 }}
                              barSize={6}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                              <XAxis
                                dataKey="label"
                                tick={{ fill: '#64748b', fontSize: 10 }}
                                tickLine={false}
                                axisLine={false}
                                interval="preserveStartEnd"
                              />
                              <YAxis
                                tick={{ fill: '#64748b', fontSize: 10 }}
                                tickLine={false}
                                axisLine={false}
                              />
                              <Tooltip content={<FlowTooltip />} />
                              <Bar dataKey="count_in" fill="#22d3a0" radius={[2, 2, 0, 0]} />
                              <Bar dataKey="count_out" fill="#818cf8" radius={[2, 2, 0, 0]} />
                            </BarChart>
                          </ResponsiveContainer>
                        </>
                      ) : (
                        <div className={styles.emptyChart}>Brak danych historycznych linii</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>

            {(objectCountApps.length > 0 || crowdCountApps.length > 0) && (
              <div className={styles.chartsRow}>
                {objectCountApps.length > 0 && (
                  <section className={`${styles.card} ${styles.flexGrow}`}>
                    <SectionHeader
                      title="Aplikacje ObjectCount"
                      count={objectCountApps.length}
                    />
                    <div className={styles.tableWrapper}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Nazwa</th>
                            <th>Kamera</th>
                            <th>Status</th>
                            <th>Ostatnio online</th>
                            <th>Strefy</th>
                          </tr>
                        </thead>
                        <tbody>
                          {objectCountApps.map((app) => (
                            <tr key={app.uuid} className={styles.tableRow}>
                              <td className={styles.tdName}>{app.name}</td>
                              <td className={styles.tdCamera}>{app.camera?.name || '–'}</td>
                              <td>
                                <StatusBadge status={app.status} />
                              </td>
                              <td className={styles.tdMuted}>
                                {formatDateTime(app.last_online)}
                              </td>
                              <td className={styles.tdCenter}>{app.areas?.length ?? 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {crowdCountApps.length > 0 && (
                  <section className={`${styles.card} ${styles.flexGrow}`}>
                    <SectionHeader
                      title="Aplikacje CrowdCount"
                      count={crowdCountApps.length}
                    />
                    <div className={styles.tableWrapper}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th>Nazwa</th>
                            <th>Kamera</th>
                            <th>Status</th>
                            <th>Bieżąca liczba</th>
                            <th>Ostatnio online</th>
                          </tr>
                        </thead>
                        <tbody>
                          {crowdCountApps.map((app) => (
                            <tr key={app.uuid} className={styles.tableRow}>
                              <td className={styles.tdName}>{app.name}</td>
                              <td className={styles.tdCamera}>{app.camera?.name || '–'}</td>
                              <td>
                                <StatusBadge status={app.status} />
                              </td>
                              <td className={styles.tdCenter}>
                                <span className={styles.crowdNum}>
                                  {app.current_count ?? '–'}
                                </span>
                              </td>
                              <td className={styles.tdMuted}>
                                {formatDateTime(app.last_online)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            )}
          </>
        )}

        {activeTab === 'reports' && (
          <ReportsTab
            stopUsage={stopUsage}
            onDemandUsage={onDemandUsage}
            loading={reportsLoading}
            error={reportsError}
          />
        )}

        {activeTab === 'config' && (
          <ConfigTab
            stops={stops}
            schedules={schedules}
            onAddStop={addStop}
            onAddSchedule={addSchedule}
            loading={configLoading}
            error={configError}
          />
        )}
      </main>

      {/* ── FOOTER ── */}
      <footer className={styles.footer}>
        <span>Isarsoft Analytics Dashboard</span>
        <span>
          Backend: {BACKEND_URL} · Odświeżanie główne co {FRONTEND_POLL_MS / 1000}s
        </span>
        {_cache?.lastError && (
          <span className={styles.footerError}>
            Ostatni błąd API: {_cache.lastError}
          </span>
        )}
      </footer>
    </div>
  );
}