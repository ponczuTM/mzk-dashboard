import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './Dashboard.module.css';

const backendIP = '192.168.68.208';
const API_URL = `http://${backendIP}:3000/data`;

const PRESET_OPTIONS = [
  'LAST_1_MIN',
  'LAST_2_MIN',
  'LAST_5_MIN',
  'LAST_10_MIN',
  'LAST_15_MIN',
  'LAST_30_MIN',
  'LAST_45_MIN',
  'LAST_1_HOUR',
  'LAST_2_HOUR',
  'LAST_3_HOUR',
  'LAST_6_HOUR',
  'LAST_12_HOUR',
  'LAST_1_DAY',
  'LAST_2_DAY',
  'LAST_3_DAY',
  'LAST_7_DAY',
  'LAST_14_DAY',
  'LAST_1_MONTH',
  'LAST_2_MONTH',
  'LAST_3_MONTH',
  'LAST_6_MONTH',
  'LAST_1_YEAR',
  'LAST_2_YEAR',
  'LAST_5_YEAR',
  'THIS_DAY',
  'THIS_DAY_SO_FAR',
  'THIS_WEEK',
  'THIS_WEEK_SO_FAR',
  'THIS_MONTH',
  'THIS_MONTH_SO_FAR',
  'THIS_YEAR',
  'THIS_YEAR_SO_FAR',
  'PREVIOUS_DAY',
  'PREVIOUS_WEEK',
  'PREVIOUS_MONTH',
  'PREVIOUS_YEAR',
  'CUSTOM',
];

function formatNumber(value) {
  const num = Number(value ?? 0);
  return new Intl.NumberFormat('pl-PL').format(Number.isFinite(num) ? num : 0);
}

function formatPair(inValue, outValue) {
  return `${formatNumber(inValue)}-${formatNumber(outValue)}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('pl-PL', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatRelative(value) {
  if (!value) return 'brak danych';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'brak danych';

  const diffMs = date.getTime() - Date.now();
  const minutes = Math.round(diffMs / 60000);
  const hours = Math.round(diffMs / 3600000);
  const days = Math.round(diffMs / 86400000);

  if (Math.abs(minutes) < 60) {
    return minutes === 0 ? 'teraz' : `${Math.abs(minutes)} min ${minutes < 0 ? 'temu' : 'za chwilę'}`;
  }

  if (Math.abs(hours) < 24) {
    return `${Math.abs(hours)} h ${hours < 0 ? 'temu' : 'za chwilę'}`;
  }

  return `${Math.abs(days)} dni ${days < 0 ? 'temu' : 'za chwilę'}`;
}

function getStatusTone(status) {
  const normalized = String(status || '').toLowerCase();

  if (normalized.includes('running') || normalized.includes('online') || normalized.includes('active')) {
    return 'success';
  }

  if (normalized.includes('paused')) {
    return 'warning';
  }

  if (normalized.includes('offline') || normalized.includes('error') || normalized.includes('failed')) {
    return 'danger';
  }

  return 'neutral';
}

function getHealthTone(valid, pollError, isPolling) {
  if (isPolling) return 'info';
  if (pollError) return 'danger';
  if (valid) return 'success';
  return 'warning';
}

function buildQuery(filters) {
  const params = new URLSearchParams();

  Object.entries(filters).forEach(([key, value]) => {
    if (value && String(value).trim()) {
      params.set(key, value);
    }
  });

  return params.toString();
}

function SectionCard({ title, subtitle, actions, children, compact = false }) {
  return (
    <section className={`${styles.card} ${compact ? styles.cardCompact : ''}`}>
      <div className={styles.cardHeader}>
        <div>
          <h2 className={styles.cardTitle}>{title}</h2>
          {subtitle ? <p className={styles.cardSubtitle}>{subtitle}</p> : null}
        </div>
        {actions ? <div className={styles.cardActions}>{actions}</div> : null}
      </div>
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

function StatCard({ label, value, helper, tone = 'neutral' }) {
  return (
    <article className={`${styles.statCard} ${styles[`tone${tone}`]}`}>
      <span className={styles.statLabel}>{label}</span>
      <strong className={styles.statValue}>{value}</strong>
      {helper ? <span className={styles.statHelper}>{helper}</span> : null}
    </article>
  );
}

function Badge({ children, tone = 'neutral' }) {
  return <span className={`${styles.badge} ${styles[`badge${tone}`]}`}>{children}</span>;
}

function MiniBar({ value, max, tone = 'primary' }) {
  const width = max > 0 ? Math.max(4, (value / max) * 100) : 0;

  return (
    <div className={styles.miniBarTrack} aria-hidden="true">
      <div
        className={`${styles.miniBarFill} ${styles[`miniBar${tone}`]}`}
        style={{ width: `${Math.min(width, 100)}%` }}
      />
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('LAST_1_DAY');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [sortMode, setSortMode] = useState('traffic');

  const fetchData = useCallback(async (preset = selectedPreset) => {
    const isInitial = !data;
    if (isInitial) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    setError('');

    try {
      const query = buildQuery({ preset });
      const response = await fetch(`${API_URL}${query ? `?${query}` : ''}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      setData(json);

      if (json?.filters?.preset) {
        setSelectedPreset(json.filters.preset);
      }
    } catch (err) {
      setError(err?.message || 'Nie udało się pobrać danych');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [data, selectedPreset]);

  useEffect(() => {
    fetchData('LAST_1_DAY');
  }, [fetchData]);

  const applications = useMemo(() => data?.applications ?? [], [data]);
  const lines = useMemo(() => data?.lines ?? [], [data]);
  const areas = useMemo(() => data?.areas ?? [], [data]);
  const cameras = useMemo(() => data?.cameras ?? [], [data]);
  const presets = useMemo(() => data?.available_presets ?? PRESET_OPTIONS, [data]);

  const normalizedSearch = search.trim().toLowerCase();

  const filteredApps = useMemo(() => {
    let result = [...applications];

    if (normalizedSearch) {
      result = result.filter((app) => {
        const haystack = [
          app.name,
          app.camera?.name,
          app.model?.name,
          app.status,
          ...(app.lines || []).map((line) => line.name),
          ...(app.areas || []).map((area) => area.name),
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      });
    }

    if (statusFilter !== 'ALL') {
      result = result.filter((app) => String(app.status || '').toUpperCase() === statusFilter);
    }

    result.sort((a, b) => {
      const trafficA = Number(a?.totals?.in ?? 0) + Number(a?.totals?.out ?? 0);
      const trafficB = Number(b?.totals?.in ?? 0) + Number(b?.totals?.out ?? 0);

      if (sortMode === 'name') {
        return String(a.name || '').localeCompare(String(b.name || ''));
      }

      if (sortMode === 'status') {
        return String(a.status || '').localeCompare(String(b.status || '')) || trafficB - trafficA;
      }

      return trafficB - trafficA;
    });

    return result;
  }, [applications, normalizedSearch, statusFilter, sortMode]);

  const topLines = useMemo(() => [...lines].sort((a, b) => (b.total_in + b.total_out) - (a.total_in + a.total_out)).slice(0, 8), [lines]);
  const maxLineTraffic = useMemo(
    () => Math.max(0, ...topLines.map((line) => Number(line.total_in ?? 0) + Number(line.total_out ?? 0))),
    [topLines]
  );

  const appStatuses = useMemo(() => {
    const counts = applications.reduce(
      (acc, app) => {
        const key = String(app.status || 'Unknown').toUpperCase();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {}
    );

    return counts;
  }, [applications]);

  const totalTraffic = Number(data?.totals?.selected_in ?? 0) + Number(data?.totals?.selected_out ?? 0);
  const licenseValid = Boolean(data?.license?.valid);
  const healthTone = getHealthTone(licenseValid, data?.poll_error, data?.is_polling);

  if (loading) {
    return (
      <div className={styles.dashboardShell}>
        <div className={styles.loadingState}>
          <div className={styles.loaderOrb} />
          <h1 className={styles.loadingTitle}>Ładowanie dashboardu</h1>
          <p className={styles.loadingText}>Pobieram dane z backendu {backendIP}</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className={styles.dashboardShell}>
        <div className={styles.errorState}>
          <h1 className={styles.errorTitle}>Błąd połączenia</h1>
          <p className={styles.errorText}>Nie udało się pobrać danych z backendu {backendIP}.</p>
          <p className={styles.errorMeta}>{error}</p>
          <button className={styles.primaryButton} onClick={() => fetchData(selectedPreset)}>
            Spróbuj ponownie
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.dashboardShell}>
      <aside className={styles.sidebar}>
        <div className={styles.brandBlock}>
          <div className={styles.brandLogo} aria-hidden="true">
            <span className={styles.brandLogoInner} />
          </div>
          <div>
            <p className={styles.brandEyebrow}>Isarsoft Monitor</p>
            <h1 className={styles.brandTitle}>Traffic Dashboard</h1>
          </div>
        </div>

        <nav className={styles.sideNav} aria-label="Sekcje dashboardu">
          <a className={styles.sideNavItem} href="#overview">Overview</a>
          <a className={styles.sideNavItem} href="#applications">Applications</a>
          <a className={styles.sideNavItem} href="#lines">Lines</a>
          <a className={styles.sideNavItem} href="#areas">Areas</a>
          <a className={styles.sideNavItem} href="#system">System</a>
        </nav>

        <div className={styles.sidebarPanel}>
          <p className={styles.sidebarLabel}>Backend</p>
          <code className={styles.backendCode}>{backendIP}:3000</code>
        </div>

        <div className={styles.sidebarPanel}>
          <p className={styles.sidebarLabel}>Preset</p>
          <select
            className={styles.select}
            value={selectedPreset}
            onChange={(e) => setSelectedPreset(e.target.value)}
          >
            {presets.map((preset) => (
              <option key={preset} value={preset}>
                {preset}
              </option>
            ))}
          </select>
          <button className={styles.primaryButton} onClick={() => fetchData(selectedPreset)}>
            {refreshing ? 'Odświeżanie…' : 'Pobierz dane'}
          </button>
        </div>

        <div className={styles.sidebarPanel}>
          <p className={styles.sidebarLabel}>Status systemu</p>
          <div className={styles.statusList}>
            <div className={styles.statusRow}>
              <span>Licencja</span>
              <Badge tone={licenseValid ? 'success' : 'danger'}>
                {licenseValid ? 'Valid' : 'Invalid'}
              </Badge>
            </div>
            <div className={styles.statusRow}>
              <span>Polling</span>
              <Badge tone={data?.is_polling ? 'info' : 'neutral'}>
                {data?.is_polling ? 'Active' : 'Idle'}
              </Badge>
            </div>
            <div className={styles.statusRow}>
              <span>Cache</span>
              <Badge tone={healthTone}>
                {data?.poll_error ? 'Error' : 'Healthy'}
              </Badge>
            </div>
          </div>
        </div>
      </aside>

      <div className={styles.contentArea}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.pageEyebrow}>Live analytics</p>
            <h2 className={styles.pageTitle}>Ruch kamer i aplikacji</h2>
          </div>

          <div className={styles.topbarMeta}>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Generated</span>
              <span className={styles.metaValue}>{formatDateTime(data?.generated_at)}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Cached</span>
              <span className={styles.metaValue}>{formatDateTime(data?.cached_at)}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Last success</span>
              <span className={styles.metaValue}>{formatRelative(data?.last_success)}</span>
            </div>
          </div>
        </header>

        <main className={styles.mainContent}>
          <section id="overview" className={styles.section}>
            <div className={styles.statsGrid}>
              <StatCard
                label="Łączny ruch"
                value={formatPair(data?.totals?.selected_in, data?.totals?.selected_out)}
                helper={`Suma IN-OUT = ${formatNumber(totalTraffic)}`}
                tone="primary"
              />
              <StatCard
                label="Aplikacje"
                value={formatNumber(data?.totals?.objectflow_apps)}
                helper={`Widoczne kamery: ${formatNumber(cameras.length)}`}
                tone="success"
              />
              <StatCard
                label="Linie"
                value={formatNumber(lines.length)}
                helper={`Obszary: ${formatNumber(areas.length)}`}
                tone="warning"
              />
              <StatCard
                label="Area live"
                value={formatNumber(data?.totals?.selected_area_count)}
                helper={`Średnia area: ${formatNumber(data?.totals?.selected_area_avg)}`}
                tone="neutral"
              />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.doubleGrid}>
              <SectionCard
                title="Status aplikacji"
                subtitle="Szybki podgląd stanu wszystkich ObjectFlow apps"
                compact
              >
                <div className={styles.statusChips}>
                  {Object.keys(appStatuses).length === 0 ? (
                    <span className={styles.emptyInline}>Brak statusów</span>
                  ) : (
                    Object.entries(appStatuses).map(([status, count]) => (
                      <div key={status} className={styles.statusChip}>
                        <Badge tone={getStatusTone(status)}>{status}</Badge>
                        <strong>{formatNumber(count)}</strong>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>

              <SectionCard
                title="Największy ruch"
                subtitle="Top linie po sumie wejść i wyjść"
                compact
              >
                <div className={styles.topTrafficList}>
                  {topLines.map((line) => {
                    const traffic = Number(line.total_in ?? 0) + Number(line.total_out ?? 0);
                    return (
                      <div key={line.line_uuid} className={styles.topTrafficItem}>
                        <div className={styles.topTrafficHeader}>
                          <div>
                            <strong className={styles.listTitle}>{line.application_name}</strong>
                            <span className={styles.listSubtitle}>{line.line_name}</span>
                          </div>
                          <span className={styles.pairValue}>
                            {formatPair(line.total_in, line.total_out)}
                          </span>
                        </div>
                        <MiniBar value={traffic} max={maxLineTraffic} tone="primary" />
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            </div>
          </section>

          <section id="applications" className={styles.section}>
            <SectionCard
              title="Applications / Cameras"
              subtitle="Każda karta pokazuje status, kamerę, model i zawsze pełne IN-OUT"
              actions={
                <div className={styles.filters}>
                  <input
                    className={styles.input}
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Szukaj po aplikacji, kamerze, linii..."
                  />
                  <select
                    className={styles.select}
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="ALL">Wszystkie statusy</option>
                    {Object.keys(appStatuses).map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <select
                    className={styles.select}
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value)}
                  >
                    <option value="traffic">Sortuj: ruch</option>
                    <option value="name">Sortuj: nazwa</option>
                    <option value="status">Sortuj: status</option>
                  </select>
                </div>
              }
            >
              {filteredApps.length === 0 ? (
                <div className={styles.emptyState}>
                  <h3>Brak wyników</h3>
                  <p>Nie znaleziono aplikacji dla bieżących filtrów.</p>
                </div>
              ) : (
                <div className={styles.appGrid}>
                  {filteredApps.map((app) => {
                    const totalIn = Number(app?.totals?.in ?? 0);
                    const totalOut = Number(app?.totals?.out ?? 0);
                    const totalFlow = totalIn + totalOut;

                    const lineLiveIn = (app.lines || []).reduce((acc, item) => acc + Number(item?.live?.total_in ?? 0), 0);
                    const lineLiveOut = (app.lines || []).reduce((acc, item) => acc + Number(item?.live?.total_out ?? 0), 0);

                    return (
                      <article key={app.uuid} className={styles.appCard}>
                        <div className={styles.appHeader}>
                          <div>
                            <h3 className={styles.appTitle}>{app.name}</h3>
                            <p className={styles.appCamera}>{app.camera?.name || 'Brak kamery'}</p>
                          </div>
                          <Badge tone={getStatusTone(app.status)}>{app.status || 'Unknown'}</Badge>
                        </div>

                        <div className={styles.metricStrip}>
                          <div className={styles.metricBox}>
                            <span className={styles.metricLabel}>Total</span>
                            <strong className={styles.metricValue}>{formatPair(totalIn, totalOut)}</strong>
                            <span className={styles.metricHint}>Suma: {formatNumber(totalFlow)}</span>
                          </div>
                          <div className={styles.metricBox}>
                            <span className={styles.metricLabel}>Live</span>
                            <strong className={styles.metricValue}>{formatPair(lineLiveIn, lineLiveOut)}</strong>
                            <span className={styles.metricHint}>Aktualne liczenie linii</span>
                          </div>
                          <div className={styles.metricBox}>
                            <span className={styles.metricLabel}>Areas</span>
                            <strong className={styles.metricValue}>
                              {formatNumber(app?.area_totals?.count ?? 0)}
                            </strong>
                            <span className={styles.metricHint}>
                              Avg: {formatNumber(app?.area_totals?.avg ?? 0)}
                            </span>
                          </div>
                        </div>

                        <div className={styles.appMetaGrid}>
                          <div className={styles.metaRow}>
                            <span>Model</span>
                            <strong>{app.model?.name || '—'}</strong>
                          </div>
                          <div className={styles.metaRow}>
                            <span>Lines</span>
                            <strong>{formatNumber(app.lines?.length ?? 0)}</strong>
                          </div>
                          <div className={styles.metaRow}>
                            <span>Areas</span>
                            <strong>{formatNumber(app.areas?.length ?? 0)}</strong>
                          </div>
                          <div className={styles.metaRow}>
                            <span>Last online</span>
                            <strong>{formatRelative(app.last_online)}</strong>
                          </div>
                        </div>

                        {(app.lines?.length ?? 0) > 0 ? (
                          <div className={styles.subSection}>
                            <p className={styles.subSectionTitle}>Linie</p>
                            <div className={styles.inlineList}>
                              {app.lines.map((line) => (
                                <div key={line.uuid} className={styles.inlineItem}>
                                  <div>
                                    <strong>{line.name}</strong>
                                    <span>{formatDateTime(line?.data?.last_bucket)}</span>
                                  </div>
                                  <div className={styles.inlineMetrics}>
                                    <span>Total {formatPair(line?.totals?.in, line?.totals?.out)}</span>
                                    <span>Live {formatPair(line?.live?.total_in, line?.live?.total_out)}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {(app.areas?.length ?? 0) > 0 ? (
                          <div className={styles.subSection}>
                            <p className={styles.subSectionTitle}>Obszary</p>
                            <div className={styles.inlineList}>
                              {app.areas.map((area) => (
                                <div key={area.uuid} className={styles.inlineItem}>
                                  <div>
                                    <strong>{area.name}</strong>
                                    <span>Buckets: {formatNumber(area?.data?.buckets ?? 0)}</span>
                                  </div>
                                  <div className={styles.inlineMetrics}>
                                    <span>Live {formatNumber(area?.live?.total_count ?? 0)}</span>
                                    <span>Avg {formatNumber(area?.totals?.avg ?? 0)}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </SectionCard>
          </section>

          <section id="lines" className={styles.section}>
            <SectionCard
              title="Line traffic"
              subtitle="Tabela linii zawsze pokazuje obie wartości: IN-OUT i LIVE IN-OUT"
            >
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Aplikacja</th>
                      <th>Kamera</th>
                      <th>Linia</th>
                      <th>Total IN-OUT</th>
                      <th>Live IN-OUT</th>
                      <th>Buckets</th>
                      <th>Zakres</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 ? (
                      <tr>
                        <td colSpan="7" className={styles.tableEmpty}>Brak danych linii</td>
                      </tr>
                    ) : (
                      lines.map((line) => (
                        <tr key={line.line_uuid}>
                          <td>{line.application_name}</td>
                          <td>{line.camera_name || '—'}</td>
                          <td>{line.line_name}</td>
                          <td className={styles.tabularStrong}>{formatPair(line.total_in, line.total_out)}</td>
                          <td className={styles.tabularStrong}>{formatPair(line.live_in, line.live_out)}</td>
                          <td>{formatNumber(line.buckets)}</td>
                          <td>
                            <div className={styles.rangeCell}>
                              <span>{formatDateTime(line.first_bucket)}</span>
                              <span>{formatDateTime(line.last_bucket)}</span>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </section>

          <section id="areas" className={styles.section}>
            <SectionCard
              title="Area occupancy"
              subtitle="Zestawienie obszarów i ich średnich wartości"
            >
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Aplikacja</th>
                      <th>Kamera</th>
                      <th>Obszar</th>
                      <th>Avg min</th>
                      <th>Avg avg</th>
                      <th>Avg max</th>
                      <th>Live count</th>
                      <th>Buckets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {areas.length === 0 ? (
                      <tr>
                        <td colSpan="8" className={styles.tableEmpty}>Brak danych obszarów</td>
                      </tr>
                    ) : (
                      areas.map((area) => (
                        <tr key={area.area_uuid}>
                          <td>{area.application_name}</td>
                          <td>{area.camera_name || '—'}</td>
                          <td>{area.area_name}</td>
                          <td>{formatNumber(area.avg_min)}</td>
                          <td className={styles.tabularStrong}>{formatNumber(area.avg_avg)}</td>
                          <td>{formatNumber(area.avg_max)}</td>
                          <td>{formatNumber(area.live_count)}</td>
                          <td>{formatNumber(area.buckets)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </section>

          <section id="system" className={styles.section}>
            <div className={styles.tripleGrid}>
              <SectionCard title="Cache i backend" subtitle="Stan aktualizacji i źródła danych" compact>
                <div className={styles.systemList}>
                  <div className={styles.systemRow}>
                    <span>API URL</span>
                    <strong>{API_URL}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <span>Generated at</span>
                    <strong>{formatDateTime(data?.generated_at)}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <span>Cached at</span>
                    <strong>{formatDateTime(data?.cached_at)}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <span>Last success</span>
                    <strong>{formatDateTime(data?.last_success)}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <span>Poll error</span>
                    <strong>{data?.poll_error || 'Brak'}</strong>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Integracje" subtitle="MQTT i Kafka" compact>
                <div className={styles.systemList}>
                  <div className={styles.systemRow}>
                    <span>MQTT</span>
                    <Badge tone={data?.integrations?.mqtt ? 'success' : 'neutral'}>
                      {data?.integrations?.mqtt ? 'Configured' : 'Null'}
                    </Badge>
                  </div>
                  <div className={styles.systemRow}>
                    <span>Kafka</span>
                    <Badge tone={data?.integrations?.kafka ? 'success' : 'neutral'}>
                      {data?.integrations?.kafka ? 'Configured' : 'Null'}
                    </Badge>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Kamery" subtitle="Wszystkie wykryte kamery" compact>
                <div className={styles.cameraList}>
                  {cameras.map((camera) => (
                    <div key={camera.uuid} className={styles.cameraItem}>
                      <strong>{camera.name}</strong>
                      <span>{camera.uuid}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}