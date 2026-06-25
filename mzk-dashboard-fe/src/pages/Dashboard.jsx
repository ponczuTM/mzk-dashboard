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
const BACKEND_IP = '192.168.77.212';
const BACKEND_PORT = 3001;
const BACKEND_URL = `http://${BACKEND_IP}:${BACKEND_PORT}`;
const FRONTEND_POLL_MS = 30_000; // 30 sekund

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

// ─── CUSTOM TOOLTIP DLA WYKRESÓW ─────────────────────────────────────────────
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

// ─── GŁÓWNY KOMPONENT ─────────────────────────────────────────────────────────
export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connError, setConnError] = useState(null);
  const [selectedApp, setSelectedApp] = useState(null);
  const intervalRef = useRef(null);

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

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, FRONTEND_POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, [fetchData]);

  // ─── LOADING / ERROR STATES ────────────────────────────────────────────────
  if (loading) {
    return (
      <div className={styles.centeredState}>
        <div className={styles.spinner} />
        <p>Łączenie z backendem…</p>
      </div>
    );
  }

  const { summary, health, license, mqtt, vms, applications, timeline, _cache } =
    data || {};

  // Aplikacje
  const objectFlowApps = (applications || []).filter(
    (a) => a.__typename === 'ObjectFlow'
  );
  const objectCountApps = (applications || []).filter(
    (a) => a.__typename === 'ObjectCount'
  );
  const crowdCountApps = (applications || []).filter(
    (a) => a.__typename === 'CrowdCount'
  );

  // Dane do wykresu kołowego (statusy)
  const statusPieData = Object.entries(summary?.statusBreakdown || {}).map(
    ([name, value]) => ({ name, value })
  );

  // Szczegóły wybranej aplikacji (historia linii)
  const selectedAppData = selectedApp
    ? applications?.find((a) => a.uuid === selectedApp)
    : null;

  const selectedHistoryLines = selectedAppData?._history?.lines || [];

  // Dane wykresu dla wybranej aplikacji (pierwsza linia)
  const detailChartData =
    selectedHistoryLines[0]?.count_data?.map((b) => ({
      ...b,
      label: formatTimeBucket(b.time_bucket),
    })) || [];

  // ─── RENDER ───────────────────────────────────────────────────────────────
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

      <main className={styles.main}>
        {/* ── KPI GRID ── */}
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

        {/* ── VMS INTEGRACJE ── */}
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

        {/* ── WYKRESY ROW ── */}
        <div className={styles.chartsRow}>
          {/* Wykres czasowy przejść (12h) */}
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

          {/* Wykres kołowy statusów */}
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

        {/* ── TABELA APLIKACJI ── */}
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

          {/* Szczegóły wybranej aplikacji */}
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

                {/* Historia pierwszej linii */}
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

        {/* ── OBJECT COUNT / CROWD COUNT ── */}
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
      </main>

      {/* ── FOOTER ── */}
      <footer className={styles.footer}>
        <span>Isarsoft Analytics Dashboard</span>
        <span>
          Backend: {BACKEND_URL} · Odświeżanie co {FRONTEND_POLL_MS / 1000}s
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