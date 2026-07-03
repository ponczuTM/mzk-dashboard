import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useBackend } from '../context/BackendContext';
import {
  Video,
  BusFront,
  LoaderCircle,
  AlertCircle,
  ChevronDown,
  MapPinned,
  Users,
  TimerReset,
  Route,
  Radar,
  Camera,
  Activity,
  Server,
  Wifi,
  WifiOff,
  CircleAlert,
  Database,
  RefreshCw,
  Clock3,
  ScanSearch,
} from 'lucide-react';
import styles from './Cameras.module.css';

const Cameras = () => {
  const { api } = useBackend();

  const [vehicles, setVehicles] = useState([]);
  const [statusMap, setStatusMap] = useState({});
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [vehiclesError, setVehiclesError] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('');

  const [isarsoftData, setIsarsoftData] = useState(null);
  const [loadingIsarsoft, setLoadingIsarsoft] = useState(true);
  const [isarsoftError, setIsarsoftError] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const loadVehicles = useCallback(async () => {
    setLoadingVehicles(true);
    setVehiclesError(null);

    try {
      const vehData = await api.getVehicles();
      const vehiclesList = vehData.vehicles || [];
      setVehicles(vehiclesList);

      const statusPromises = vehiclesList.map((vehicle) =>
        api
          .getCurrentStatus({ pcName: vehicle.pcName })
          .catch(() => ({ current_status: {} }))
      );

      const statusResults = await Promise.all(statusPromises);
      const nextStatusMap = {};

      vehiclesList.forEach((vehicle, index) => {
        const status = statusResults[index]?.current_status?.[vehicle.pcName] || {};
        nextStatusMap[vehicle.pcName] = status;
      });

      setStatusMap(nextStatusMap);

      setSelectedVehicle((prev) => {
        if (prev && vehiclesList.some((vehicle) => vehicle.pcName === prev)) {
          return prev;
        }

        return vehiclesList[0]?.pcName || '';
      });
    } catch (err) {
      setVehiclesError(err.message || 'Nie udało się pobrać danych pojazdów.');
    } finally {
      setLoadingVehicles(false);
    }
  }, [api]);

  const loadIsarsoft = useCallback(async () => {
    setLoadingIsarsoft(true);
    setIsarsoftError(null);

    try {
      const response = await api.getIsarsoftLatest();

      if (response?.ok && response.data) {
        let normalizedData = response.data;

        if (
          response.data.data &&
          typeof response.data.data === 'object' &&
          (response.data.data.applications ||
            response.data.data.lines ||
            response.data.data.areas ||
            response.data.data.cameras)
        ) {
          normalizedData = response.data.data;
        }

        setIsarsoftData(normalizedData);
        setLastRefresh(new Date().toISOString());
      } else {
        setIsarsoftError('Brak danych lub odpowiedź nieprawidłowa');
        setIsarsoftData(null);
      }
    } catch (err) {
      setIsarsoftError(err.message || 'Nie udało się pobrać danych Isarsoft');
      setIsarsoftData(null);
    } finally {
      setLoadingIsarsoft(false);
    }
  }, [api]);

  useEffect(() => {
    loadVehicles();
    loadIsarsoft();

    const interval = setInterval(() => {
      loadVehicles();
      loadIsarsoft();
    }, 10000);

    return () => clearInterval(interval);
  }, [loadVehicles, loadIsarsoft]);

  const handleVehicleChange = (event) => {
    setSelectedVehicle(event.target.value);
  };

  const filteredVehicles = selectedVehicle
    ? vehicles.filter((vehicle) => vehicle.pcName === selectedVehicle)
    : vehicles;

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';

    try {
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) return dateStr;

      return date.toLocaleString('pl-PL', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    } catch {
      return dateStr;
    }
  };

  const getVehicleStatusTone = (status) => {
    if (!status) return styles.badgeNeutral;

    const normalized = String(status).toLowerCase();

    if (normalized === 'o czasie') return styles.badgeSuccess;
    if (normalized === 'opóźniony') return styles.badgeDanger;
    if (normalized === 'za szybko') return styles.badgeWarning;

    return styles.badgeNeutral;
  };

  const isarsoftStats = useMemo(() => {
    return {
      applications: isarsoftData?.applications?.length || 0,
      lines: isarsoftData?.lines?.length || 0,
      areas: isarsoftData?.areas?.length || 0,
      cameras: isarsoftData?.cameras?.length || 0,
    };
  }, [isarsoftData]);

  const isUnexpectedPayload =
    isarsoftData &&
    (!isarsoftData.applications || isarsoftData.applications.length === 0) &&
    (!isarsoftData.lines || isarsoftData.lines.length === 0) &&
    (!isarsoftData.areas || isarsoftData.areas.length === 0) &&
    (!isarsoftData.cameras || isarsoftData.cameras.length === 0);

  return (
    <section className={styles.pageShell}>
      <div className={styles.page}>
        <header className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Monitoring wizyjny</p>
            <h1 className={styles.title}>Kamery i status pojazdów</h1>
            <p className={styles.subtitle}>
              Podgląd danych pojazdów z backendu oraz pakietów Isarsoft
              aktualizowanych cyklicznie co 10 sekund.
            </p>
          </div>

          <div className={styles.heroMeta}>
            <div className={styles.heroMetaItem}>
              <RefreshCw className={styles.heroMetaIcon} />
              <div>
                <span className={styles.heroMetaLabel}>Ostatnie odświeżenie</span>
                <strong className={styles.heroMetaValue}>
                  {formatDate(lastRefresh)}
                </strong>
              </div>
            </div>

            <div className={styles.heroMetaItem}>
              <Server className={styles.heroMetaIcon} />
              <div>
                <span className={styles.heroMetaLabel}>Pakiet live</span>
                <strong className={styles.heroMetaValue}>Auto refresh 10 s</strong>
              </div>
            </div>
          </div>
        </header>

        <section className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Pojazdy</h2>
              <p className={styles.sectionText}>
                Dane operacyjne z backendu SQL z aktualnym statusem i jakością danych.
              </p>
            </div>

            <div className={styles.filterCard}>
              <label htmlFor="vehicle-filter" className={styles.filterLabel}>
                Filtr pojazdu
              </label>

              <div className={styles.selectWrap}>
                <select
                  id="vehicle-filter"
                  className={styles.select}
                  value={selectedVehicle}
                  onChange={handleVehicleChange}
                >
                  <option value="">Wszystkie</option>
                  {vehicles.map((vehicle) => (
                    <option key={vehicle.pcName} value={vehicle.pcName}>
                      {vehicle.pcName}
                    </option>
                  ))}
                </select>
                <ChevronDown className={styles.selectIcon} />
              </div>
            </div>
          </div>

          {loadingVehicles && (
            <div className={styles.stateInline}>
              <LoaderCircle className={`${styles.stateIcon} ${styles.spin}`} />
              <span>Ładowanie pojazdów...</span>
            </div>
          )}

          {vehiclesError && (
            <div className={styles.stateInlineError}>
              <AlertCircle className={styles.stateIconError} />
              <span>Błąd pojazdów: {vehiclesError}</span>
            </div>
          )}

          {!loadingVehicles && !vehiclesError && (
            <div className={styles.vehicleGrid}>
              {filteredVehicles.map((vehicle) => {
                const status = statusMap[vehicle.pcName] || {};
                const passengers = status.passengers || {};
                const cameraComplete = status.data_quality?.complete;

                return (
                  <article className={styles.vehicleCard} key={vehicle.pcName}>
                    <div className={styles.vehicleHeader}>
                      <div>
                        <h3 className={styles.vehicleName}>{vehicle.pcName}</h3>
                        <p className={styles.vehicleSubtext}>
                          Linia {status.line_id || vehicle.line_id || '—'}
                        </p>
                      </div>

                      <span
                        className={`${styles.statusBadge} ${getVehicleStatusTone(
                          status.status
                        )}`}
                      >
                        {status.status || 'Brak danych'}
                      </span>
                    </div>

                    <div className={styles.detailsGrid}>
                      <div className={styles.detailItem}>
                        <Route className={styles.detailIcon} />
                        <div>
                          <span className={styles.detailLabel}>Linia</span>
                          <strong className={styles.detailValue}>
                            {status.line_id || vehicle.line_id || '—'}
                          </strong>
                        </div>
                      </div>

                      <div className={styles.detailItem}>
                        <TimerReset className={styles.detailIcon} />
                        <div>
                          <span className={styles.detailLabel}>Opóźnienie</span>
                          <strong className={styles.detailValue}>
                            {status.delay_seconds != null
                              ? `${status.delay_seconds} s`
                              : '—'}
                          </strong>
                        </div>
                      </div>

                      <div className={styles.detailItem}>
                        <Users className={styles.detailIcon} />
                        <div>
                          <span className={styles.detailLabel}>Pasażerowie</span>
                          <strong className={styles.detailValue}>
                            IN {passengers.selected_in || 0} · OUT{' '}
                            {passengers.selected_out || 0} · Onboard{' '}
                            {passengers.onboard || 0}
                          </strong>
                        </div>
                      </div>

                      <div className={styles.detailItem}>
                        <MapPinned className={styles.detailIcon} />
                        <div>
                          <span className={styles.detailLabel}>Lokalizacja</span>
                          <strong className={styles.detailValue}>
                            {status.latitude != null && status.longitude != null
                              ? `${status.latitude.toFixed(5)}, ${status.longitude.toFixed(5)}`
                              : '—'}
                          </strong>
                        </div>
                      </div>

                      <div className={styles.detailItem}>
                        <Radar className={styles.detailIcon} />
                        <div>
                          <span className={styles.detailLabel}>Przystanek</span>
                          <strong className={styles.detailValue}>
                            {status.current_stop_id || status.nearest_stop_id || '—'}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <div className={styles.cameraState}>
                      <div className={styles.cameraStateIconWrap}>
                        <Camera className={styles.cameraStateIcon} />
                      </div>

                      <div className={styles.cameraStateContent}>
                        <span className={styles.cameraStateTitle}>Stan kamer</span>
                        <span className={styles.cameraStateText}>
                          {cameraComplete
                            ? 'Wszystkie kamery działają'
                            : 'Brak obrazu z części kamer'}
                        </span>
                      </div>

                      <span
                        className={`${styles.statusBadge} ${
                          cameraComplete ? styles.badgeSuccess : styles.badgeWarning
                        }`}
                      >
                        {cameraComplete ? 'Pełne dane' : 'Częściowe dane'}
                      </span>
                    </div>
                  </article>
                );
              })}

              {!filteredVehicles.length && (
                <div className={styles.emptyState}>
                  <BusFront className={styles.emptyStateIcon} />
                  <p className={styles.emptyStateTitle}>Brak wyników dla filtra</p>
                  <p className={styles.emptyStateText}>
                    Zmień wybrany pojazd lub wyczyść filtr, aby zobaczyć wszystkie rekordy.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        <section className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <div>
              <h2 className={styles.sectionTitle}>Dane Isarsoft</h2>
              <p className={styles.sectionText}>
                Pakiet danych na żywo z aplikacjami, liniami, kamerami i obszarami.
              </p>
            </div>

            <div className={styles.statPills}>
              <span className={styles.statPill}>
                <Video className={styles.statPillIcon} />
                Aplikacje: {isarsoftStats.applications}
              </span>
              <span className={styles.statPill}>
                <Activity className={styles.statPillIcon} />
                Linie: {isarsoftStats.lines}
              </span>
              <span className={styles.statPill}>
                <ScanSearch className={styles.statPillIcon} />
                Obszary: {isarsoftStats.areas}
              </span>
              <span className={styles.statPill}>
                <Camera className={styles.statPillIcon} />
                Kamery: {isarsoftStats.cameras}
              </span>
            </div>
          </div>

          {loadingIsarsoft && (
            <div className={styles.stateInline}>
              <LoaderCircle className={`${styles.stateIcon} ${styles.spin}`} />
              <span>Ładowanie danych Isarsoft...</span>
            </div>
          )}

          {isarsoftError && (
            <div className={styles.stateInlineError}>
              <AlertCircle className={styles.stateIconError} />
              <span>Błąd Isarsoft: {isarsoftError}</span>
            </div>
          )}

          {!loadingIsarsoft && !isarsoftError && !isarsoftData && (
            <div className={styles.emptyState}>
              <Database className={styles.emptyStateIcon} />
              <p className={styles.emptyStateTitle}>Brak danych Isarsoft</p>
              <p className={styles.emptyStateText}>
                Oczekiwanie na pierwszy poprawny pakiet danych.
              </p>
            </div>
          )}

          {!loadingIsarsoft && !isarsoftError && isarsoftData && (
            <div className={styles.liveGrid}>
              {isUnexpectedPayload && (
                <div className={styles.rawCard}>
                  <div className={styles.rawHeader}>
                    <CircleAlert className={styles.rawIcon} />
                    <div>
                      <h3 className={styles.rawTitle}>Nieoczekiwany format danych</h3>
                      <p className={styles.rawText}>
                        Odpowiedź nie zawiera pól applications, lines, areas ani cameras.
                      </p>
                    </div>
                  </div>
                  <pre className={styles.rawPre}>
                    {JSON.stringify(isarsoftData, null, 2)}
                  </pre>
                </div>
              )}

              <section className={styles.liveSection}>
                <div className={styles.liveSectionHeader}>
                  <h3 className={styles.liveSectionTitle}>Aplikacje / kamery</h3>
                </div>

                {isarsoftData.applications && isarsoftData.applications.length > 0 ? (
                  <div className={styles.appGrid}>
                    {isarsoftData.applications.map((app) => (
                      <article className={styles.appCard} key={app.uuid}>
                        <div className={styles.appHeader}>
                          <div>
                            <h4 className={styles.appName}>{app.name}</h4>
                            <p className={styles.appSubtext}>
                              Kamera: {app.camera?.name || '—'}
                            </p>
                          </div>

                          <span
                            className={`${styles.statusBadge} ${
                              app.status === 'Online'
                                ? styles.badgeSuccess
                                : styles.badgeNeutral
                            }`}
                          >
                            {app.status === 'Online' ? (
                              <>
                                <Wifi className={styles.badgeIcon} />
                                Online
                              </>
                            ) : (
                              <>
                                <WifiOff className={styles.badgeIcon} />
                                {app.status || 'Nieznany'}
                              </>
                            )}
                          </span>
                        </div>

                        <div className={styles.appMeta}>
                          <div className={styles.metaRow}>
                            <span className={styles.metaLabel}>Model</span>
                            <span className={styles.metaValue}>
                              {app.model?.name || '—'}
                            </span>
                          </div>
                          <div className={styles.metaRow}>
                            <span className={styles.metaLabel}>Ostatnio online</span>
                            <span className={styles.metaValue}>
                              {formatDate(app.last_online)}
                            </span>
                          </div>
                          <div className={styles.metaRow}>
                            <span className={styles.metaLabel}>Utworzono</span>
                            <span className={styles.metaValue}>
                              {formatDate(app.created_at)}
                            </span>
                          </div>
                          <div className={styles.metaRow}>
                            <span className={styles.metaLabel}>Suma IN</span>
                            <span className={styles.metaValue}>
                              {app.totals?.in || 0}
                            </span>
                          </div>
                          <div className={styles.metaRow}>
                            <span className={styles.metaLabel}>Suma OUT</span>
                            <span className={styles.metaValue}>
                              {app.totals?.out || 0}
                            </span>
                          </div>
                        </div>

                        {app.lines && app.lines.length > 0 && (
                          <div className={styles.nestedBlock}>
                            <h5 className={styles.nestedTitle}>Linie w aplikacji</h5>
                            <ul className={styles.inlineList}>
                              {app.lines.map((line) => (
                                <li className={styles.inlineListItem} key={line.uuid}>
                                  <span className={styles.inlineName}>{line.name}</span>
                                  <span className={styles.inlineMeta}>
                                    IN {line.totals?.in || 0} · OUT {line.totals?.out || 0}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {app.areas && app.areas.length > 0 && (
                          <div className={styles.nestedBlock}>
                            <h5 className={styles.nestedTitle}>Obszary</h5>
                            <ul className={styles.inlineList}>
                              {app.areas.map((area) => (
                                <li className={styles.inlineListItem} key={area.uuid}>
                                  <span className={styles.inlineName}>{area.name}</span>
                                  <span className={styles.inlineMeta}>
                                    min {area.area_totals?.min || 0} · avg{' '}
                                    {area.area_totals?.avg || 0} · max{' '}
                                    {area.area_totals?.max || 0}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className={styles.fallbackText}>Brak aplikacji w danych Isarsoft.</p>
                )}
              </section>

              <section className={styles.liveSection}>
                <div className={styles.liveSectionHeader}>
                  <h3 className={styles.liveSectionTitle}>Wszystkie linie</h3>
                </div>

                {isarsoftData.lines && isarsoftData.lines.length > 0 ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Aplikacja</th>
                          <th>Kamera</th>
                          <th>Linia</th>
                          <th>IN total</th>
                          <th>OUT total</th>
                          <th>IN live</th>
                          <th>OUT live</th>
                          <th>Przedziały</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isarsoftData.lines.map((line, index) => (
                          <tr key={`${line.line_name || 'line'}-${index}`}>
                            <td>{line.application_name || '—'}</td>
                            <td>{line.camera_name || '—'}</td>
                            <td>{line.line_name || '—'}</td>
                            <td>{line.total_in || 0}</td>
                            <td>{line.total_out || 0}</td>
                            <td>{line.live_in || 0}</td>
                            <td>{line.live_out || 0}</td>
                            <td>{line.buckets || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={styles.fallbackText}>Brak linii w danych Isarsoft.</p>
                )}
              </section>

              <section className={styles.liveSection}>
                <div className={styles.liveSectionHeader}>
                  <h3 className={styles.liveSectionTitle}>Lista kamer</h3>
                </div>

                {isarsoftData.cameras && isarsoftData.cameras.length > 0 ? (
                  <ul className={styles.cameraList}>
                    {isarsoftData.cameras.map((camera) => (
                      <li className={styles.cameraListItem} key={camera.uuid}>
                        <Camera className={styles.cameraListIcon} />
                        <div>
                          <span className={styles.cameraListName}>{camera.name}</span>
                          <span className={styles.cameraListMeta}>{camera.uuid}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.fallbackText}>Brak kamer.</p>
                )}
              </section>

              <section className={styles.liveSection}>
                <div className={styles.liveSectionHeader}>
                  <h3 className={styles.liveSectionTitle}>Obszary</h3>
                </div>

                {isarsoftData.areas && isarsoftData.areas.length > 0 ? (
                  <div className={styles.tableWrap}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th>Aplikacja</th>
                          <th>Kamera</th>
                          <th>Obszar</th>
                          <th>Średnia</th>
                          <th>Max</th>
                          <th>Min</th>
                          <th>Live</th>
                        </tr>
                      </thead>
                      <tbody>
                        {isarsoftData.areas.map((area, index) => (
                          <tr key={`${area.area_name || 'area'}-${index}`}>
                            <td>{area.application_name || '—'}</td>
                            <td>{area.camera_name || '—'}</td>
                            <td>{area.area_name || '—'}</td>
                            <td>
                              {area.avg_avg != null ? area.avg_avg.toFixed(2) : '—'}
                            </td>
                            <td>
                              {area.avg_max != null ? area.avg_max.toFixed(2) : '—'}
                            </td>
                            <td>
                              {area.avg_min != null ? area.avg_min.toFixed(2) : '—'}
                            </td>
                            <td>{area.live_count || 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className={styles.fallbackText}>Brak obszarów.</p>
                )}
              </section>
            </div>
          )}
        </section>
      </div>
    </section>
  );
};

export default Cameras;