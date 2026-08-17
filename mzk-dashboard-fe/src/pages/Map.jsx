import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useBackend } from '../context/BackendContext';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import styles from './Map.module.css';

// ---------- Ikony SVG ----------
const busSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="#2563eb" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="8" cy="18" r="2" fill="#2563eb" stroke="#ffffff" />
    <circle cx="16" cy="18" r="2" fill="#2563eb" stroke="#ffffff" />
    <path d="M8 6v4" />
    <path d="M16 6v4" />
  </svg>
`;

const stopSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="#ffffff" stroke="#3b82f6" stroke-width="2">
    <circle cx="12" cy="12" r="10" />
    <text x="12" y="16" text-anchor="middle" font-size="10" fill="#3b82f6" font-weight="bold">P</text>
  </svg>
`;

const busIcon = L.divIcon({
  className: 'custom-bus-icon',
  html: busSvg,
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
});

const stopIcon = L.divIcon({
  className: 'custom-stop-icon',
  html: stopSvg,
  iconSize: [26, 26],
  iconAnchor: [13, 26],
  popupAnchor: [0, -26],
});

// ---------- Komponent ----------
const Map = () => {
  const { api, vehicles, fetchVehicles, routes, fetchRoutes } = useBackend();

  const [allStops, setAllStops] = useState([]);
  const [selectedPcName, setSelectedPcName] = useState('');
  const [showAllStops, setShowAllStops] = useState(false);
  const intervalRef = useRef(null);

  // ---------- Pobranie danych początkowych ----------
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        await fetchVehicles();
        await fetchRoutes();
        const stopsData = await api.getStops();
        setAllStops(stopsData.stops || []);
      } catch (err) {
        console.error('Błąd inicjalizacji mapy:', err);
      }
    };
    loadInitialData();
  }, [api, fetchVehicles, fetchRoutes]);

  // ---------- Cykliczne odświeżanie pojazdów co 5 s ----------
  useEffect(() => {
    if (!selectedPcName) return;

    const refreshVehicles = async () => {
      await fetchVehicles();
    };

    refreshVehicles(); // pierwsze odświeżenie

    intervalRef.current = setInterval(refreshVehicles, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [selectedPcName, fetchVehicles]);

  // ---------- Wyznaczenie przystanków do wyświetlenia ----------
  const visibleStops = useMemo(() => {
    // Jeśli wybrano wszystkie pojazdy -> pokaż wszystkie przystanki
    if (selectedPcName === 'ALL_VEHICLES') {
      return allStops;
    }

    // Jeśli wybrano konkretny pojazd
    if (selectedPcName) {
      const vehicle = vehicles.find(v => v.pcName === selectedPcName);
      if (!vehicle) return [];

      const lineId = vehicle.line_id;
      if (!lineId) return showAllStops ? allStops : [];

      const route = routes.find(r => r.id === lineId || r.code === lineId);
      if (!route) return showAllStops ? allStops : [];

      const stopsInRoute = route.stops || [];
      const fullStops = stopsInRoute
        .map(rs => {
          const stop = allStops.find(s => s.id === rs.stop_id);
          return {
            ...rs,
            name: stop?.name || rs.stop_id,
            latitude: stop?.latitude,
            longitude: stop?.longitude,
          };
        })
        .filter(s => s.latitude != null && s.longitude != null);

      // Jeśli włączono "pokaż wszystkie przystanki" – doklejamy pozostałe
      if (showAllStops) {
        const routeStopIds = new Set(fullStops.map(s => s.stop_id));
        const extraStops = allStops.filter(s => !routeStopIds.has(s.id));
        return [...fullStops, ...extraStops.map(s => ({
          stop_id: s.id,
          name: s.name,
          latitude: s.latitude,
          longitude: s.longitude,
        }))];
      }
      return fullStops;
    }

    return [];
  }, [selectedPcName, vehicles, routes, allStops, showAllStops]);

  // ---------- Wybór pojazdu ----------
  const handleVehicleChange = (e) => {
    setSelectedPcName(e.target.value);
  };

  // ---------- Obsługa checkboxa ----------
  const handleShowAllStopsChange = (e) => {
    setShowAllStops(e.target.checked);
  };

  // ---------- Pobranie wybranego pojazdu ----------
  const selectedVehicle = useMemo(
    () => vehicles.find(v => v.pcName === selectedPcName),
    [vehicles, selectedPcName]
  );

  const hasRoute = selectedVehicle && selectedVehicle.line_id;
  const routeExists = hasRoute && visibleStops.length > 0;

  // Czy pokazywać wszystkie pojazdy?
  const showAllVehicles = selectedPcName === 'ALL_VEHICLES';

  // Filtruj pojazdy z poprawną lokalizacją
  const vehiclesWithPosition = useMemo(
    () => vehicles.filter(v => v.last_latitude != null && v.last_longitude != null),
    [vehicles]
  );

  return (
    <div className={styles.container}>
      <div className={styles.controls}>
        <label htmlFor="vehicleSelect" className={styles.label}>
          Wybierz pojazd:
        </label>
        <select
          id="vehicleSelect"
          className={styles.select}
          value={selectedPcName}
          onChange={handleVehicleChange}
        >
          <option value="">-- wybierz pojazd --</option>
          {vehicles.map(v => (
            <option key={v.pcName} value={v.pcName}>
              {v.pcName} {v.line_id ? `(trasa ${v.line_id})` : ''}
            </option>
          ))}
          <option value="ALL_VEHICLES">🚌 Wszystkie pojazdy</option>
        </select>

        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={showAllStops}
            onChange={handleShowAllStopsChange}
            disabled={selectedPcName === 'ALL_VEHICLES'}
          />
          Pokaż wszystkie przystanki
        </label>

        {selectedPcName && !showAllVehicles && (
          <div className={styles.info}>
            {hasRoute ? (
              routeExists ? (
                <span className={styles.infoOk}>
                  ✅ Trasa: {selectedVehicle.line_id} – {visibleStops.length} przystanków
                </span>
              ) : (
                <span className={styles.infoWarning}>
                  ⚠️ Trasa {selectedVehicle.line_id} nie ma zdefiniowanych przystanków lub brak współrzędnych
                </span>
              )
            ) : (
              <span className={styles.infoError}>
                🚫 Brak przypisanej trasy
              </span>
            )}
            {selectedVehicle?.last_latitude != null && selectedVehicle?.last_longitude != null ? (
              <span className={styles.infoOk}>
                📍 Pozycja: {selectedVehicle.last_latitude.toFixed(5)}, {selectedVehicle.last_longitude.toFixed(5)}
              </span>
            ) : (
              <span className={styles.infoWarning}>⏳ Oczekiwanie na lokalizację…</span>
            )}
          </div>
        )}

        {showAllVehicles && (
          <div className={styles.info}>
            <span className={styles.infoOk}>
              🚌 Wyświetlono {vehiclesWithPosition.length} pojazdów
            </span>
            <span className={styles.infoOk}>
              📍 {visibleStops.length} przystanków
            </span>
          </div>
        )}
      </div>

      <div className={styles.mapWrapper}>
        <MapContainer
          center={[52.2297, 21.0122]} // środek Warszawy jako domyślny
          zoom={13}
          className={styles.mapContainer}
          zoomControl={true}
          attributionControl={true}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          />

          {/* Markery pojazdów */}
          {showAllVehicles
            ? vehiclesWithPosition.map(v => (
                <Marker
                  key={v.pcName}
                  position={[v.last_latitude, v.last_longitude]}
                  icon={busIcon}
                >
                  <Popup>
                    <div className={styles.popupBus}>
                      <strong>{v.pcName}</strong>
                      {v.line_id ? (
                        <p>Trasa: {v.line_id}</p>
                      ) : (
                        <p style={{ color: '#dc2626' }}>Brak trasy</p>
                      )}
                      <p className={styles.popupCoords}>
                        {v.last_latitude.toFixed(5)}, {v.last_longitude.toFixed(5)}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              ))
            : selectedVehicle && selectedVehicle.last_latitude != null && selectedVehicle.last_longitude != null && (
                <Marker
                  position={[selectedVehicle.last_latitude, selectedVehicle.last_longitude]}
                  icon={busIcon}
                >
                  <Popup>
                    <div className={styles.popupBus}>
                      <strong>{selectedVehicle.pcName}</strong>
                      {selectedVehicle.line_id ? (
                        <p>Trasa: {selectedVehicle.line_id}</p>
                      ) : (
                        <p style={{ color: '#dc2626' }}>Brak trasy</p>
                      )}
                      <p className={styles.popupCoords}>
                        {selectedVehicle.last_latitude.toFixed(5)}, {selectedVehicle.last_longitude.toFixed(5)}
                      </p>
                    </div>
                  </Popup>
                </Marker>
              )}

          {/* Markery przystanków */}
          {visibleStops.map(stop => (
            <Marker
              key={stop.stop_id || stop.id}
              position={[stop.latitude, stop.longitude]}
              icon={stopIcon}
            >
              <Popup>
                <div className={styles.popupStop}>
                  <strong>{stop.name}</strong>
                  <p className={styles.popupCoords}>
                    {stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}
                  </p>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
};

export default Map;