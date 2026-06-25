// Dashboard.jsx — Frontend React z ciemnym motywem i wizualizacjami
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts';
import {
  Camera,
  Activity,
  WifiOff,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  Server,
  Database,
  RefreshCw,
  Zap,
  Layers,
  BarChart3,
  ShieldCheck,
  Network,
  HardDrive,
  Gauge,
} from 'lucide-react';
import styles from './Dashboard.module.css';

// ===== KONFIGURACJA =====
const BACKEND_IP = '192.168.77.212';
const BACKEND_PORT = 3001;
const BACKEND_URL = `http://${BACKEND_IP}:${BACKEND_PORT}/api/dashboard-data`;

// Interwał odświeżania frontendu (co 30 sekund)
const FRONTEND_POLL_INTERVAL_MS = 30000;

// Kolory dla wykresów
const COLORS = {
  Online: '#22c55e',
  Offline: '#ef4444',
  Initializing: '#f59e0b',
  Paused: '#8b5cf6',
  Pending: '#3b82f6',
  default: '#64748b',
};

const STATUS_COLORS = ['#22c55e', '#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6'];

// ===== KOMPONENT GŁÓWNY =====
const Dashboard = () => {
  const [dashboardData, setDashboardData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [isStale, setIsStale] = useState(false);
  const [timeSinceUpdate, setTimeSinceUpdate] = useState(0);

  const intervalRef = useRef(null);

  // ===== Pobieranie danych z backendu =====
  const fetchData = useCallback(async () => {
    try {
      const response = await fetch(BACKEND_URL, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();

      if (!result.success || !result.data) {
        throw new Error(result.error || 'Nieprawidłowa odpowiedź z backendu');
      }

      setDashboardData(result.data);
      setLastFetch(new Date());
      setIsStale(result.isStale || false);
      setError(null);
    } catch (err) {
      console.error('[Dashboard] Błąd pobierania:', err);
      setError(err.message);
      // Nie resetujemy danych – zostawiamy ostatnie poprawne
    } finally {
      setLoading(false);
    }
  }, []);

  // ===== Efekt: pierwsze pobranie i interwał =====
  useEffect(() => {
    fetchData();

    intervalRef.current = setInterval(() => {
      fetchData();
    }, FRONTEND_POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchData]);

  // ===== Licznik czasu od ostatniej aktualizacji =====
  useEffect(() => {
    const timer = setInterval(() => {
      if (lastFetch) {
        const diff = Math.floor((Date.now() - lastFetch.getTime()) / 1000);
        setTimeSinceUpdate(diff);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lastFetch]);

  // ===== Formatowanie czasu =====
  const formatTimeAgo = (seconds) => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const formatDate = (isoString) => {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleString('pl-PL', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  // ===== Stan ładowania =====
  if (loading && !dashboardData) {
    return (
      <div className={styles.loadingContainer}>
        <RefreshCw className={styles.loadingSpinner} size={48} />
        <p>Ładowanie danych z backendu...</p>
        <small>Backend: {BACKEND_URL}</small>
      </div>
    );
  }

  // ===== Brak danych =====
  if (!dashboardData) {
    return (
      <div className={styles.errorContainer}>
        <AlertCircle size={48} className={styles.errorIcon} />
        <h2>Brak danych</h2>
        <p>Nie udało się pobrać danych z backendu.</p>
        <p className={styles.errorDetail}>{error || 'Sprawdź połączenie z backendem.'}</p>
        <button onClick={fetchData} className={styles.retryButton}>
          <RefreshCw size={18} /> Spróbuj ponownie
        </button>
      </div>
    );
  }

  const { data } = dashboardData;
  const { stats, applications, cameras, objectFlowApps, health, license, vmsStatus, mqttSettings, featureFlags } = data;

  // ===== Przygotowanie danych dla wykresów =====
  const statusChartData = Object.entries(stats.statusMap || {}).map(([name, value]) => ({
    name,
    value,
    color: STATUS_COLORS[Object.keys(stats.statusMap || {}).indexOf(name)] || '#64748b',
  }));

  const appStatusData = statusChartData.filter((d) => d.value > 0);

  // Przygotowanie danych dla aplikacji ObjectFlow do tabeli
  const appTableData = (objectFlowApps || []).map((app) => ({
    uuid: app.uuid,
    name: app.name || 'Bez nazwy',
    camera: app.camera?.name || '—',
    status: app.status || 'Offline',
    lastOnline: app.last_online,
    linesCount: (app.lines || []).length,
    areasCount: (app.areas || []).length,
    totalZones: (app.lines || []).length + (app.areas || []).length,
    hasAlarms: (app.alarms || []).some((a) => a.enabled),
  }));

  // Live counts dla podglądu
  const liveCounts = (objectFlowApps || []).slice(0, 6).map((app) => {
    const totalIn = (app.lines || []).reduce((sum, line) => sum + (line.count_live?.count_in || 0), 0);
    const totalOut = (app.lines || []).reduce((sum, line) => sum + (line.count_live?.count_out || 0), 0);
    return {
      name: app.name || '—',
      in: totalIn,
      out: totalOut,
      status: app.status,
    };
  });

  // ===== RENDER =====
  return (
    <div className={styles.dashboard}>
      {/* === HEADER === */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.logo}>
            <ShieldCheck size={28} className={styles.logoIcon} />
            <span className={styles.logoText}>Perception Monitor</span>
          </div>
          <div className={styles.headerStatus}>
            <span className={`${styles.statusDot} ${error ? styles.statusDotError : styles.statusDotOk}`} />
            <span className={styles.statusLabel}>
              {error ? 'Błąd połączenia' : 'Połączono z backendem'}
            </span>
          </div>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.updateInfo}>
            <Clock size={16} className={styles.updateIcon} />
            <span>
              Ostatnia aktualizacja:{' '}
              <strong>{lastFetch ? formatDate(lastFetch.toISOString()) : '—'}</strong>
            </span>
            <span className={styles.updateAge}>
              ({formatTimeAgo(timeSinceUpdate)} temu)
            </span>
            {isStale && (
              <span className={styles.staleBadge}>
                <AlertCircle size={14} /> DANE NIEAKTUALNE
              </span>
            )}
          </div>
          <button onClick={fetchData} className={styles.refreshButton} title="Odśwież ręcznie">
            <RefreshCw size={18} className={loading ? styles.spinning : ''} />
          </button>
        </div>
      </header>

      {/* === KPI METRICS === */}
      <section className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <div className={styles.kpiIcon} style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)' }}>
            <Camera size={24} color="#3b82f6" />
          </div>
          <div className={styles.kpiContent}>
            <span className={styles.kpiValue}>{stats.totalCameras || 0}</span>
            <span className={styles.kpiLabel}>Kamery</span>
          </div>
          <div className={styles.kpiSub}>
            <span className={styles.kpiSubOk}>{stats.healthStatus === 'ok' ? '✓' : '⚠'} System: {stats.healthStatus || '—'}</span>
          </div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiIcon} style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)' }}>
            <Activity size={24} color="#22c55e" />
          </div>
          <div className={styles.kpiContent}>
            <span className={styles.kpiValue}>{stats.activeApps || 0}</span>
            <span className={styles.kpiLabel}>Aktywne aplikacje</span>
          </div>
          <div className={styles.kpiSub}>
            <span className={styles.kpiSubOk}>Online</span>
            <span className={styles.kpiSubDivider}>·</span>
            <span className={styles.kpiSubOff}>Offline: {stats.offlineApps || 0}</span>
          </div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiIcon} style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)' }}>
            <AlertCircle size={24} color="#ef4444" />
          </div>
          <div className={styles.kpiContent}>
            <span className={styles.kpiValue}>{stats.offlineApps || 0}</span>
            <span className={styles.kpiLabel}>Aplikacje offline</span>
          </div>
          <div className={styles.kpiSub}>
            <span className={styles.kpiSubOff}>Wymagają uwagi</span>
          </div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiIcon} style={{ backgroundColor: stats.licenseValid ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)' }}>
            <ShieldCheck size={24} color={stats.licenseValid ? '#22c55e' : '#ef4444'} />
          </div>
          <div className={styles.kpiContent}>
            <span className={styles.kpiValue} style={{ color: stats.licenseValid ? '#22c55e' : '#ef4444' }}>
              {stats.licenseValid ? '✔' : '✖'}
            </span>
            <span className={styles.kpiLabel}>Licencja</span>
          </div>
          <div className={styles.kpiSub}>
            <span className={stats.licenseValid ? styles.kpiSubOk : styles.kpiSubOff}>
              {stats.licenseValid ? 'Ważna' : 'NIEWAŻNA'}
            </span>
            {stats.licenseExpiry && (
              <>
                <span className={styles.kpiSubDivider}>·</span>
                <span>do {formatDate(stats.licenseExpiry)}</span>
              </>
            )}
          </div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiIcon} style={{ backgroundColor: 'rgba(139, 92, 246, 0.15)' }}>
            <Network size={24} color="#8b5cf6" />
          </div>
          <div className={styles.kpiContent}>
            <span className={styles.kpiValue}>{stats.vmsConnected ? '✔' : '✖'}</span>
            <span className={styles.kpiLabel}>Integracja VMS</span>
          </div>
          <div className={styles.kpiSub}>
            <span className={stats.vmsConnected ? styles.kpiSubOk : styles.kpiSubOff}>
              {stats.vmsConnected ? 'Połączono' : 'Rozłączono'}
            </span>
            {vmsStatus?.vms_type && (
              <>
                <span className={styles.kpiSubDivider}>·</span>
                <span>{vmsStatus.vms_type}</span>
              </>
            )}
          </div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiIcon} style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)' }}>
            <Zap size={24} color="#fbbf24" />
          </div>
          <div className={styles.kpiContent}>
            <span className={styles.kpiValue}>{stats.totalObjectFlowApps || 0}</span>
            <span className={styles.kpiLabel}>Aplikacje ObjectFlow</span>
          </div>
          <div className={styles.kpiSub}>
            <span>Linie + strefy: </span>
            <span className={styles.kpiSubOk}>
              {(objectFlowApps || []).reduce((sum, a) => sum + (a.lines?.length || 0) + (a.areas?.length || 0), 0)}
            </span>
          </div>
        </div>
      </section>

      {/* === WYKRESY === */}
      <section className={styles.chartsRow}>
        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <BarChart3 size={18} />
            <span>Status aplikacji</span>
          </div>
          <div className={styles.chartBody}>
            {appStatusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={appStatusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    labelLine={false}
                  >
                    {appStatusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color || COLORS.default} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, name) => [`${value} aplikacji`, name]}
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f1f5f9' }}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className={styles.chartEmpty}>Brak danych o statusach</div>
            )}
          </div>
        </div>

        <div className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <Gauge size={18} />
            <span>Live: Wejścia / Wyjścia</span>
          </div>
          <div className={styles.chartBody}>
            {liveCounts.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={liveCounts} layout="vertical" margin={{ left: 80, right: 20, top: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis type="number" stroke="#94a3b8" />
                  <YAxis type="category" dataKey="name" stroke="#94a3b8" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#f1f5f9' }}
                  />
                  <Legend />
                  <Bar dataKey="in" name="Wejścia" fill="#3b82f6" stackId="a" />
                  <Bar dataKey="out" name="Wyjścia" fill="#f59e0b" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className={styles.chartEmpty}>Brak danych live</div>
            )}
          </div>
        </div>
      </section>

      {/* === TABELA APLIKACJI === */}
      <section className={styles.tableSection}>
        <div className={styles.tableHeader}>
          <div className={styles.tableTitle}>
            <Layers size={18} />
            <span>Aplikacje ObjectFlow</span>
            <span className={styles.tableBadge}>{objectFlowApps?.length || 0}</span>
          </div>
          <div className={styles.tableFilters}>
            <span className={styles.filterPill}>
              <span className={styles.filterDot} style={{ backgroundColor: '#22c55e' }} /> Online
            </span>
            <span className={styles.filterPill}>
              <span className={styles.filterDot} style={{ backgroundColor: '#ef4444' }} /> Offline
            </span>
          </div>
        </div>

        <div className={styles.tableWrapper}>
          <table className={styles.appTable}>
            <thead>
              <tr>
                <th>Nazwa aplikacji</th>
                <th>Kamera</th>
                <th>Status</th>
                <th>Ostatnio online</th>
                <th>Linie</th>
                <th>Strefy</th>
                <th>Alarmy</th>
              </tr>
            </thead>
            <tbody>
              {appTableData.length > 0 ? (
                appTableData.map((app) => (
                  <tr key={app.uuid} className={app.status === 'Offline' ? styles.rowOffline : ''}>
                    <td className={styles.appName}>{app.name}</td>
                    <td>{app.camera}</td>
                    <td>
                      <span className={`${styles.statusBadge} ${styles[`statusBadge_${app.status.toLowerCase()}`]}`}>
                        <span className={styles.statusBadgeDot} />
                        {app.status}
                      </span>
                    </td>
                    <td>{app.lastOnline ? formatDate(app.lastOnline) : '—'}</td>
                    <td>{app.linesCount}</td>
                    <td>{app.areasCount}</td>
                    <td>
                      {app.hasAlarms ? (
                        <span className={styles.alarmActive}>🔔</span>
                      ) : (
                        <span className={styles.alarmInactive}>—</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan="7" className={styles.tableEmpty}>Brak aplikacji ObjectFlow</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* === STOPKA Z FEATURE FLAGS === */}
      <footer className={styles.footer}>
        <div className={styles.footerLeft}>
          <span>Perception Monitor v1.0</span>
          <span className={styles.footerDivider}>·</span>
          <span>Backend: {BACKEND_IP}:{BACKEND_PORT}</span>
          <span className={styles.footerDivider}>·</span>
          <span>Dane z: {formatDate(data.timestamp)}</span>
        </div>
        <div className={styles.footerRight}>
          {featureFlags && featureFlags.length > 0 && (
            <>
              <span className={styles.featureLabel}>Feature Flags:</span>
              {featureFlags.slice(0, 5).map((flag, idx) => (
                <span key={idx} className={`${styles.featurePill} ${flag.enabled ? styles.featureOn : styles.featureOff}`}>
                  {flag.enabled ? '✔' : '✖'} {flag.name}
                </span>
              ))}
              {featureFlags.length > 5 && <span className={styles.featureMore}>+{featureFlags.length - 5}</span>}
            </>
          )}
        </div>
      </footer>
    </div>
  );
};

export default Dashboard;