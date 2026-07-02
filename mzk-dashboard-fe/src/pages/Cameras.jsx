import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import './Cameras.css';

const Cameras = () => {
  const { api } = useBackend();

  // === Stan dla pojazdów (dotychczasowy) ===
  const [vehicles, setVehicles] = useState([]);
  const [statusMap, setStatusMap] = useState({});
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [vehiclesError, setVehiclesError] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('');

  // === Stan dla danych Isarsoft ===
  const [isarsoftData, setIsarsoftData] = useState(null);
  const [loadingIsarsoft, setLoadingIsarsoft] = useState(true);
  const [isarsoftError, setIsarsoftError] = useState(null);

  // ---- Ładowanie pojazdów ----
  const loadVehicles = useCallback(async () => {
    setLoadingVehicles(true);
    setVehiclesError(null);
    try {
      const vehData = await api.getVehicles();
      const vehiclesList = vehData.vehicles || [];
      setVehicles(vehiclesList);

      // Pobieramy statusy dla każdego pojazdu
      const statusPromises = vehiclesList.map(v =>
        api.getCurrentStatus({ pcName: v.pcName }).catch(() => ({ current_status: {} }))
      );
      const statusResults = await Promise.all(statusPromises);
      const map = {};
      vehiclesList.forEach((v, idx) => {
        const status = statusResults[idx]?.current_status?.[v.pcName] || {};
        map[v.pcName] = status;
      });
      setStatusMap(map);

      if (vehiclesList.length > 0 && !selectedVehicle) {
        setSelectedVehicle(vehiclesList[0].pcName);
      }
    } catch (err) {
      setVehiclesError(err.message);
    } finally {
      setLoadingVehicles(false);
    }
  }, [api, selectedVehicle]);

  // ---- Ładowanie danych Isarsoft ----
  const loadIsarsoft = useCallback(async () => {
    setLoadingIsarsoft(true);
    setIsarsoftError(null);
    try {
      const response = await api.getIsarsoftLatest(); // zakładamy, że metoda istnieje w api
      if (response.ok && response.data) {
        setIsarsoftData(response.data);
      } else {
        setIsarsoftError('Brak danych lub odpowiedź nieprawidłowa');
      }
    } catch (err) {
      setIsarsoftError(err.message || 'Nie udało się pobrać danych Isarsoft');
    } finally {
      setLoadingIsarsoft(false);
    }
  }, [api]);

  // ---- Odświeżanie cykliczne (co 10s) ----
  useEffect(() => {
    loadVehicles();
    loadIsarsoft();

    const interval = setInterval(() => {
      loadVehicles();
      loadIsarsoft();
    }, 10000); // co 10 sekund

    return () => clearInterval(interval);
  }, [loadVehicles, loadIsarsoft]);

  // ---- Obsługa wyboru pojazdu ----
  const handleVehicleChange = (e) => {
    setSelectedVehicle(e.target.value);
  };

  const filteredVehicles = selectedVehicle
    ? vehicles.filter(v => v.pcName === selectedVehicle)
    : vehicles;

  // ---- Renderowanie ----
  return (
    <div className="cameras">
      <h1>📹 Kamery i status pojazdów</h1>

      {/* ===== SEKCJA: Pojazdy (z SQL) ===== */}
      <section className="vehicles-section">
        <h2>🚌 Pojazdy</h2>
        <div className="filter-bar">
          <label>Pojazd: </label>
          <select value={selectedVehicle} onChange={handleVehicleChange}>
            <option value="">Wszystkie</option>
            {vehicles.map(v => (
              <option key={v.pcName} value={v.pcName}>
                {v.pcName}
              </option>
            ))}
          </select>
        </div>

        {loadingVehicles && <div className="loading">Ładowanie pojazdów...</div>}
        {vehiclesError && <div className="error">Błąd pojazdów: {vehiclesError}</div>}

        {!loadingVehicles && !vehiclesError && (
          <div className="vehicle-grid">
            {filteredVehicles.map(vehicle => {
              const status = statusMap[vehicle.pcName] || {};
              const passengers = status.passengers || {};
              return (
                <div className="vehicle-card" key={vehicle.pcName}>
                  <div className="vehicle-header">
                    <span className="vehicle-name">{vehicle.pcName}</span>
                    <span className={`status-badge ${
                      status.status === 'o czasie' ? 'ontime' :
                      status.status === 'opóźniony' ? 'delayed' :
                      status.status === 'za szybko' ? 'early' : 'unknown'
                    }`}>
                      {status.status || 'brak danych'}
                    </span>
                  </div>
                  <div className="vehicle-details">
                    <div><strong>Linia:</strong> {status.line_id || vehicle.line_id || '—'}</div>
                    <div><strong>Opóźnienie:</strong> {status.delay_seconds != null ? status.delay_seconds + ' s' : '—'}</div>
                    <div><strong>Pasażerowie:</strong> IN: {passengers.selected_in || 0}, OUT: {passengers.selected_out || 0}, onboard: {passengers.onboard || 0}</div>
                    <div><strong>Lokalizacja:</strong> {status.latitude != null && status.longitude != null ? `${status.latitude.toFixed(5)}, ${status.longitude.toFixed(5)}` : '—'}</div>
                    <div><strong>Przystanek:</strong> {status.current_stop_id || status.nearest_stop_id || '—'}</div>
                  </div>
                  <div className="camera-simulation">
                    <span className="camera-icon">📷</span>
                    <span className="camera-status">
                      {status.data_quality?.complete ? '✅ Wszystkie kamery działają' : '⚠️ Brak obrazu z niektórych kamer'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ===== SEKCJA: Dane Isarsoft (aplikacje, linie, obszary) ===== */}
      <section className="isarsoft-section">
        <h2>📊 Dane Isarsoft (na żywo)</h2>
        {loadingIsarsoft && <div className="loading">Ładowanie danych Isarsoft...</div>}
        {isarsoftError && <div className="error">Błąd Isarsoft: {isarsoftError}</div>}

        {!loadingIsarsoft && !isarsoftError && isarsoftData && (
          <div className="isarsoft-container">
            {/* Aplikacje (kamery) */}
            <div className="isarsoft-applications">
              <h3>📷 Aplikacje / Kamery</h3>
              {isarsoftData.applications && isarsoftData.applications.length > 0 ? (
                <div className="app-grid">
                  {isarsoftData.applications.map(app => (
                    <div className="app-card" key={app.uuid}>
                      <div className="app-header">
                        <span className="app-name">{app.name}</span>
                        <span className={`app-status ${app.status === 'Online' ? 'online' : 'offline'}`}>
                          {app.status || 'Nieznany'}
                        </span>
                      </div>
                      <div className="app-details">
                        <div><strong>Kamera:</strong> {app.camera?.name || '—'}</div>
                        <div><strong>Model:</strong> {app.model?.name || '—'}</div>
                        <div><strong>Ostatnio online:</strong> {app.last_online ? new Date(app.last_online).toLocaleString() : '—'}</div>
                        <div><strong>Utworzono:</strong> {app.created_at ? new Date(app.created_at).toLocaleString() : '—'}</div>
                        <div><strong>Suma IN:</strong> {app.totals?.in || 0}</div>
                        <div><strong>Suma OUT:</strong> {app.totals?.out || 0}</div>
                      </div>
                      {/* Linie wewnątrz aplikacji */}
                      {app.lines && app.lines.length > 0 && (
                        <div className="app-lines">
                          <h4>Linie w tej aplikacji:</h4>
                          <ul>
                            {app.lines.map(line => (
                              <li key={line.uuid}>
                                <span className="line-name">{line.name}</span>
                                <span className="line-totals">
                                  IN: {line.totals?.in || 0}, OUT: {line.totals?.out || 0}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {/* Obszary */}
                      {app.areas && app.areas.length > 0 && (
                        <div className="app-areas">
                          <h4>Obszary:</h4>
                          <ul>
                            {app.areas.map(area => (
                              <li key={area.uuid}>
                                <span className="area-name">{area.name}</span>
                                <span className="area-totals">
                                  min: {area.area_totals?.min || 0}, avg: {area.area_totals?.avg || 0}, max: {area.area_totals?.max || 0}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p>Brak aplikacji w danych Isarsoft</p>
              )}
            </div>

            {/* Zagregowane linie (z sekcji lines) */}
            <div className="isarsoft-lines">
              <h3>📊 Wszystkie linie (agregat)</h3>
              {isarsoftData.lines && isarsoftData.lines.length > 0 ? (
                <table className="lines-table">
                  <thead>
                    <tr>
                      <th>Aplikacja</th>
                      <th>Kamera</th>
                      <th>Linia</th>
                      <th>IN (total)</th>
                      <th>OUT (total)</th>
                      <th>IN (live)</th>
                      <th>OUT (live)</th>
                      <th>Przedziały</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isarsoftData.lines.map((line, idx) => (
                      <tr key={idx}>
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
              ) : (
                <p>Brak linii w danych Isarsoft</p>
              )}
            </div>

            {/* Kamery */}
            <div className="isarsoft-cameras">
              <h3>📷 Lista kamer</h3>
              {isarsoftData.cameras && isarsoftData.cameras.length > 0 ? (
                <ul className="camera-list">
                  {isarsoftData.cameras.map(cam => (
                    <li key={cam.uuid}>{cam.name} ({cam.uuid})</li>
                  ))}
                </ul>
              ) : (
                <p>Brak kamer</p>
              )}
            </div>

            {/* Obszary (agregat) */}
            <div className="isarsoft-areas">
              <h3>📌 Obszary (agregat)</h3>
              {isarsoftData.areas && isarsoftData.areas.length > 0 ? (
                <table className="areas-table">
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
                    {isarsoftData.areas.map((area, idx) => (
                      <tr key={idx}>
                        <td>{area.application_name || '—'}</td>
                        <td>{area.camera_name || '—'}</td>
                        <td>{area.area_name || '—'}</td>
                        <td>{area.avg_avg != null ? area.avg_avg.toFixed(2) : '—'}</td>
                        <td>{area.avg_max != null ? area.avg_max.toFixed(2) : '—'}</td>
                        <td>{area.avg_min != null ? area.avg_min.toFixed(2) : '—'}</td>
                        <td>{area.live_count || 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p>Brak obszarów</p>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

export default Cameras;