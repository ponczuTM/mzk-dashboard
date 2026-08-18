import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useBackend } from '../context/BackendContext';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import {
  BusFront,
  CalendarRange,
  Activity,
  TrendingUp,
  AlertCircle,
  AlertTriangle,
  LoaderCircle,
  ChevronDown,
  Clock3,
  Route,
  MapPinned,
  Users,
  LogIn,
  LogOut,
  TimerReset,
  CircleAlert,
} from 'lucide-react';
import styles from './Dashboard.module.css';

const Dashboard = () => {
  const { api } = useBackend();

  const [vehicles, setVehicles] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [recentTrips, setRecentTrips] = useState([]);
  const [passengerHistory, setPassengerHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [vehicleOptions, setVehicleOptions] = useState([]);
  const [currentStatusMap, setCurrentStatusMap] = useState({});
  const [occupancyLoading, setOccupancyLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
  
    try {
      // Najpierw trzeba pobrać pojazdy, ponieważ harmonogram wymaga pcName.
      const vehData = await api.getVehicles();
  
      const nextVehicles = vehData.vehicles || [];
  
      const vehicleNames = nextVehicles
        .map((vehicle) => vehicle.pcName)
        .filter(Boolean);
  
      // Pobieranie ostatnich zdarzeń oraz rozkładów wszystkich pojazdów.
      const [tripsData, scheduleResults] = await Promise.all([
        api.getTrips({ limit: 50, page: 1 }),
  
        Promise.all(
          vehicleNames.map(async (pcName) => {
            try {
              const result = await api.getVehicleSchedule(pcName);
  
              return {
                pcName,
                ...result,
              };
            } catch (scheduleError) {
              console.warn(
                `Nie udało się pobrać rozkładu pojazdu ${pcName}:`,
                scheduleError.message
              );
  
              return null;
            }
          })
        ),
      ]);
  
      // Backend może zwrócić `trips`, `assignments` albo pustą odpowiedź.
      // Zapisujemy obiekty rozkładów, aby zachować także pcName pojazdu.
      const nextSchedules = scheduleResults.filter(Boolean);
      const nextTrips = tripsData.rows || [];
  
      setVehicles(nextVehicles);
      setSchedules(nextSchedules);
      setRecentTrips(nextTrips);
      setVehicleOptions(vehicleNames);
  
      setSelectedVehicle((previousVehicle) => {
        if (previousVehicle && vehicleNames.includes(previousVehicle)) {
          return previousVehicle;
        }
  
        return vehicleNames[0] || '';
      });
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać danych dashboardu.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadPassengerHistory = useCallback(
    async (pcName) => {
      if (!pcName) {
        setPassengerHistory([]);
        return;
      }

      setHistoryLoading(true);

      try {
        const data = await api.getTrips({ pcName, limit: 100, page: 1 });
        const rows = data.rows || [];
        const grouped = {};

        rows.forEach((row) => {
          const rawDate = row.received_at || row.timestamp;
          const date = rawDate ? rawDate.split('T')[0] : null;

          if (date) {
            grouped[date] = (grouped[date] || 0) + (row.passenger_events || 0);
          }
        });

        const history = Object.entries(grouped)
          .map(([date, count]) => ({
            date,
            passengers: count,
          }))
          .sort((a, b) => a.date.localeCompare(b.date));

        setPassengerHistory(history);
      } catch (err) {
        console.error('Błąd ładowania historii pasażerów:', err);
        setPassengerHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    },
    [api]
  );

  // Aktualna liczba osób w pojazdach — dane oparte o skorygowane delty
  // (nie surowe, narastające liczniki kamery), patrz be-server/functions.js.
  const loadCurrentStatus = useCallback(async () => {
    setOccupancyLoading(true);

    try {
      const data = await api.getReportCurrent();
      setCurrentStatusMap(data.current_status || {});
    } catch (err) {
      console.error('Błąd ładowania aktualnego obłożenia pojazdów:', err);
    } finally {
      setOccupancyLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedVehicle) {
      loadPassengerHistory(selectedVehicle);
    }
  }, [selectedVehicle, loadPassengerHistory]);

  useEffect(() => {
    loadCurrentStatus();

    const interval = setInterval(loadCurrentStatus, 10000);
    return () => clearInterval(interval);
  }, [loadCurrentStatus]);

  const handleVehicleChange = (event) => {
    setSelectedVehicle(event.target.value);
  };

  const totalVehicles = vehicles.length;
  const activeSchedules = useMemo(() => {
    return schedules.reduce((total, schedule) => {
      const trips = schedule.trips || [];
  
      return total + trips.length;
    }, 0);
  }, [schedules]);
  const totalTrips = recentTrips.length;

  const avgPassengers = useMemo(() => {
    if (!recentTrips.length) return 0;

    const total = recentTrips.reduce(
      (sum, trip) => sum + (trip.passenger_events || 0),
      0
    );

    return Math.round(total / recentTrips.length);
  }, [recentTrips]);

  const occupancyRows = useMemo(() => {
    return Object.values(currentStatusMap)
      .map((status) => {
        const passengers = status.passengers || {};

        return {
          pcName: status.pcName,
          lineNumber: status.line_number || status.line_id || '',
          currentOccupancy: Math.max(0, Number(passengers.current_occupancy || 0)),
          deltaIn: Number(passengers.delta_in || 0),
          deltaOut: Number(passengers.delta_out || 0),
          resetDetected: Boolean(passengers.reset_detected),
          updatedAt: status.updated_at || status.received_at || null,
        };
      })
      .sort((a, b) => (a.pcName || '').localeCompare(b.pcName || ''));
  }, [currentStatusMap]);

  const totalOnboard = useMemo(
    () => occupancyRows.reduce((sum, row) => sum + row.currentOccupancy, 0),
    [occupancyRows]
  );

  const chartData = useMemo(
    () =>
      passengerHistory.map((item) => ({
        ...item,
        shortDate: item.date.slice(5),
      })),
    [passengerHistory]
  );

  const formatDateTime = (value) => {
    if (!value) return '—';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;

    return date.toLocaleString('pl-PL', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  };

  const renderStatus = (status) => {
    if (!status || status === '—') {
      return <span className={styles.statusNeutral}>Brak</span>;
    }

    const normalized = String(status).toLowerCase();

    if (
      normalized.includes('ontime') ||
      normalized.includes('on_time') ||
      normalized.includes('punkt') ||
      normalized.includes('czas')
    ) {
      return <span className={styles.statusSuccess}>{status}</span>;
    }

    if (
      normalized.includes('delay') ||
      normalized.includes('late') ||
      normalized.includes('spoź') ||
      normalized.includes('spóź')
    ) {
      return <span className={styles.statusDanger}>{status}</span>;
    }

    return <span className={styles.statusNeutral}>{status}</span>;
  };

  if (loading) {
    return (
      <section className={styles.dashboardShell}>
        <div className={styles.stateCard}>
          <LoaderCircle className={`${styles.stateIcon} ${styles.spin}`} />
          <div>
            <h2 className={styles.stateTitle}>Ładowanie dashboardu</h2>
            <p className={styles.stateText}>
              Trwa pobieranie pojazdów, rozkładów i ostatnich zdarzeń.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.dashboardShell}>
        <div className={styles.stateCard}>
          <AlertCircle className={styles.stateIconError} />
          <div>
            <h2 className={styles.stateTitle}>Nie udało się załadować danych</h2>
            <p className={styles.stateText}>Błąd: {error}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.dashboardShell}>
      <div className={styles.dashboard}>
        <header className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Panel operacyjny</p>
            <h1 className={styles.title}>Dashboard floty</h1>
            <p className={styles.subtitle}>
              Przegląd pojazdów, aktywnych rozkładów, zdarzeń i historii pasażerów
              w jednym miejscu.
            </p>
          </div>

          <div className={styles.filterCard}>
            <label htmlFor="vehicle-select" className={styles.filterLabel}>
              Wybrany pojazd
            </label>

            <div className={styles.selectWrap}>
              <select
                id="vehicle-select"
                className={styles.select}
                value={selectedVehicle}
                onChange={handleVehicleChange}
              >
                {vehicleOptions.map((vehicle) => (
                  <option key={vehicle} value={vehicle}>
                    {vehicle}
                  </option>
                ))}
              </select>

              <ChevronDown className={styles.selectIcon} aria-hidden="true" />
            </div>
          </div>
        </header>

        <div className={styles.statsGrid}>
          <article className={styles.statCard}>
            <div className={styles.statIconWrap}>
              <BusFront className={styles.statIcon} />
            </div>
            <div>
              <span className={styles.statLabel}>Pojazdy</span>
              <strong className={styles.statValue}>{totalVehicles}</strong>
            </div>
          </article>

          <article className={styles.statCard}>
            <div className={styles.statIconWrap}>
              <CalendarRange className={styles.statIcon} />
            </div>
            <div>
              <span className={styles.statLabel}>Aktywne rozkłady</span>
              <strong className={styles.statValue}>{activeSchedules}</strong>
            </div>
          </article>

          <article className={styles.statCard}>
            <div className={styles.statIconWrap}>
              <Activity className={styles.statIcon} />
            </div>
            <div>
              <span className={styles.statLabel}>Ostatnie zdarzenia</span>
              <strong className={styles.statValue}>{totalTrips}</strong>
            </div>
          </article>

          <article className={styles.statCard}>
            <div className={styles.statIconWrap}>
              <TrendingUp className={styles.statIcon} />
            </div>
            <div>
              <span className={styles.statLabel}>Śr. pasażerów / zdarzenie</span>
              <strong className={styles.statValue}>{avgPassengers}</strong>
            </div>
          </article>
        </div>

        <section className={styles.occupancySection}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Aktualna liczba osób w pojazdach</h2>
              <p className={styles.sectionText}>
                Obłożenie wyliczone z przyrostów (delt) liczników kamer Isarsoft —
                odporne na powtórzone paczki i restarty kamery.
              </p>
            </div>

            <div className={styles.occupancySummary}>
              {occupancyLoading && (
                <div className={styles.inlineLoading}>
                  <LoaderCircle className={`${styles.inlineLoadingIcon} ${styles.spin}`} />
                  <span>Odświeżanie</span>
                </div>
              )}

              <div className={styles.occupancyTotal}>
                <Users className={styles.occupancyTotalIcon} />
                <div>
                  <span className={styles.occupancyTotalLabel}>Łącznie na pokładzie</span>
                  <strong className={styles.occupancyTotalValue}>{totalOnboard}</strong>
                </div>
              </div>
            </div>
          </div>

          {occupancyRows.length > 0 ? (
            <div className={styles.occupancyGrid}>
              {occupancyRows.map((row) => (
                <article key={row.pcName} className={styles.occupancyCard}>
                  <div className={styles.occupancyCardHeader}>
                    <span className={styles.occupancyVehicle}>
                      <BusFront className={styles.occupancyVehicleIcon} />
                      {row.pcName}
                      {row.lineNumber ? ` · ${row.lineNumber}` : ''}
                    </span>

                    {row.resetDetected && (
                      <span
                        className={styles.occupancyResetBadge}
                        title="Wykryto reset licznika kamery — przyrost policzony od zera"
                      >
                        <AlertTriangle className={styles.occupancyResetIcon} />
                        Reset
                      </span>
                    )}
                  </div>

                  <div className={styles.occupancyCount}>
                    <span className={styles.occupancyCountValue}>{row.currentOccupancy}</span>
                    <span className={styles.occupancyCountLabel}>osób na pokładzie</span>
                  </div>

                  <div className={styles.occupancyDeltaRow}>
                    <span className={styles.occupancyDeltaIn}>
                      <LogIn className={styles.occupancyDeltaIcon} />+{row.deltaIn}
                    </span>
                    <span className={styles.occupancyDeltaOut}>
                      <LogOut className={styles.occupancyDeltaIcon} />-{row.deltaOut}
                    </span>
                  </div>

                  <span className={styles.occupancyUpdatedAt}>
                    Ostatnia aktualizacja: {formatDateTime(row.updatedAt)}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <CircleAlert className={styles.emptyStateIcon} />
              <p className={styles.emptyStateText}>
                Brak danych o obłożeniu pojazdów — poczekaj na pierwszy pakiet z kamer.
              </p>
            </div>
          )}
        </section>

        <div className={styles.mainGrid}>
          <section className={styles.chartCard}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>Ruch pasażerów</h2>
                <p className={styles.sectionText}>
                  Ostatnie 100 zdarzeń zagregowane dziennie dla pojazdu{' '}
                  <span className={styles.inlineValue}>{selectedVehicle || '—'}</span>.
                </p>
              </div>

              {historyLoading && (
                <div className={styles.inlineLoading}>
                  <LoaderCircle className={`${styles.inlineLoadingIcon} ${styles.spin}`} />
                  <span>Aktualizacja wykresu</span>
                </div>
              )}
            </div>

            <div className={styles.chartArea}>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="rgba(17, 24, 39, 0.08)"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="shortDate"
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'rgba(17, 24, 39, 0.48)', fontSize: 12 }}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'rgba(17, 24, 39, 0.48)', fontSize: 12 }}
                    />
                    <Tooltip
                      cursor={{ stroke: 'rgba(0, 122, 255, 0.14)', strokeWidth: 1 }}
                      contentStyle={{
                        borderRadius: 16,
                        border: '1px solid rgba(255,255,255,0.5)',
                        background: 'rgba(255,255,255,0.86)',
                        backdropFilter: 'blur(18px)',
                        boxShadow: '0 12px 28px rgba(15,23,42,0.08)',
                      }}
                      labelStyle={{ color: '#111827', fontWeight: 700 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="passengers"
                      name="Pasażerowie"
                      stroke="#007aff"
                      strokeWidth={3}
                      dot={{ r: 3, strokeWidth: 0, fill: '#007aff' }}
                      activeDot={{
                        r: 5,
                        fill: '#007aff',
                        stroke: 'rgba(255,255,255,0.95)',
                        strokeWidth: 2,
                      }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className={styles.emptyState}>
                  <CircleAlert className={styles.emptyStateIcon} />
                  <p className={styles.emptyStateText}>
                    Brak danych dla wybranego pojazdu.
                  </p>
                </div>
              )}
            </div>
          </section>

          <aside className={styles.sidePanel}>
            <section className={styles.infoCard}>
              <h2 className={styles.sectionTitle}>Aktualny filtr</h2>
              <div className={styles.metaList}>
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Pojazd</span>
                  <span className={styles.metaValue}>{selectedVehicle || '—'}</span>
                </div>
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Warianty</span>
                  <span className={styles.metaValue}>{vehicleOptions.length}</span>
                </div>
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Zdarzenia w tabeli</span>
                  <span className={styles.metaValue}>{Math.min(recentTrips.length, 10)}</span>
                </div>
              </div>
            </section>

            <section className={styles.infoCard}>
              <h2 className={styles.sectionTitle}>Szybki podgląd</h2>
              <div className={styles.quickStats}>
                <div className={styles.quickStat}>
                  <Users className={styles.quickStatIcon} />
                  <div>
                    <span className={styles.quickStatLabel}>Średni ruch</span>
                    <strong className={styles.quickStatValue}>{avgPassengers}</strong>
                  </div>
                </div>

                <div className={styles.quickStat}>
                  <Clock3 className={styles.quickStatIcon} />
                  <div>
                    <span className={styles.quickStatLabel}>Ostatnia próbka</span>
                    <strong className={styles.quickStatValue}>
                      {recentTrips[0]
                        ? formatDateTime(recentTrips[0].received_at || recentTrips[0].timestamp)
                        : '—'}
                    </strong>
                  </div>
                </div>
              </div>
            </section>
          </aside>
        </div>

        <section className={styles.tableCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Ostatnie zdarzenia</h2>
              <p className={styles.sectionText}>
                Dziesięć najnowszych wpisów z podglądem czasu, linii, przystanku i statusu.
              </p>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>
                    <span className={styles.thContent}>
                      <Clock3 className={styles.thIcon} />
                      Czas
                    </span>
                  </th>
                  <th>
                    <span className={styles.thContent}>
                      <BusFront className={styles.thIcon} />
                      Pojazd
                    </span>
                  </th>
                  <th>
                    <span className={styles.thContent}>
                      <Route className={styles.thIcon} />
                      Linia
                    </span>
                  </th>
                  <th>
                    <span className={styles.thContent}>
                      <MapPinned className={styles.thIcon} />
                      Przystanek
                    </span>
                  </th>
                  <th>
                    <span className={styles.thContent}>
                      <Users className={styles.thIcon} />
                      Pasażerowie
                    </span>
                  </th>
                  <th>
                    <span className={styles.thContent}>
                      <TimerReset className={styles.thIcon} />
                      Opóźnienie
                    </span>
                  </th>
                  <th>
                    <span className={styles.thContent}>
                      <AlertCircle className={styles.thIcon} />
                      Status
                    </span>
                  </th>
                </tr>
              </thead>

              <tbody>
                {recentTrips.slice(0, 10).map((trip) => (
                  <tr key={trip.id}>
                    <td>{formatDateTime(trip.received_at || trip.timestamp)}</td>
                    <td>{trip.pcName || '—'}</td>
                    <td>{trip.line_id || '—'}</td>
                    <td>{trip.stop_name || trip.stop_id || '—'}</td>
                    <td>{trip.passenger_events || 0}</td>
                    <td>
                      {trip.delay_seconds !== null && trip.delay_seconds !== undefined
                        ? `${trip.delay_seconds} s`
                        : '—'}
                    </td>
                    <td>{renderStatus(trip.punctuality_status || '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
};

export default Dashboard;