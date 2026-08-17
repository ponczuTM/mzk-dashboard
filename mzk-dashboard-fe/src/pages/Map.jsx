import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useBackend } from '../context/BackendContext';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Bus, MapPin, LayoutGrid, AlertTriangle } from 'lucide-react';
import styles from './Map.module.css';


// ---------- Tryby widoku ----------
const MODE = {
  ALL: 'ALL',
  BUSES: 'BUSES',
  STOPS: 'STOPS',
  ROUTE: 'ROUTE', // aktywny gdy wybrano konkretną trasę
};


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


const DEFAULT_CENTER = [53.02809365240993, 18.631034929317966]; // Warszawa
const DEFAULT_ZOOM = 13;


// ---------- Kontroler mapy: płynny przelot bez remontu MapContainer ----------
const MapController = ({ target }) => {
  const map = useMap();


  useEffect(() => {
    if (!target) return;
    const { lat, lng, zoom } = target;
    if (lat == null || lng == null) return;


    map.flyTo([lat, lng], zoom ?? map.getZoom(), {
      duration: 0.8,
    });
  }, [target, map]);


  return null;
};


// ---------- Komponent ----------
const Map = () => {
  const { api, vehicles, fetchVehicles, routes, fetchRoutes } = useBackend();


  const [allStops, setAllStops] = useState([]);
  const [mode, setMode] = useState(MODE.ALL); // domyślnie: wszystko
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [flyTarget, setFlyTarget] = useState(null);
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
  // Odświeżamy zawsze, gdy pojazdy są widoczne (tryb ALL, BUSES lub ROUTE).
  const busesVisible =
    mode === MODE.ALL || mode === MODE.BUSES || mode === MODE.ROUTE;


  useEffect(() => {
    if (!busesVisible) return;


    const refreshVehicles = async () => {
      try {
        await fetchVehicles();
      } catch (err) {
        console.error('Błąd odświeżania pojazdów:', err);
      }
    };


    refreshVehicles();
    intervalRef.current = setInterval(refreshVehicles, 5000);


    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [busesVisible, fetchVehicles]);


  // ---------- Zmiana trybu ----------
  const handleModeChange = (nextMode) => {
    setMode(nextMode);
    setSelectedRouteId('');
    setFlyTarget(null);
  };


  const handleRouteChange = (e) => {
    const id = e.target.value;
    setSelectedRouteId(id);
    setMode(id ? MODE.ROUTE : MODE.ALL);
    setFlyTarget(null);
  };


  // ---------- Wybrana trasa ----------
  const selectedRoute = useMemo(
    () =>
      routes.find(
        (r) =>
          String(r.id) === String(selectedRouteId) ||
          String(r.code) === String(selectedRouteId)
      ) || null,
    [routes, selectedRouteId]
  );


  // ---------- Przystanki wybranej trasy w kolejności ----------
  const routeStops = useMemo(() => {
    if (!selectedRoute) return [];


    const stopsInRoute = [...(selectedRoute.stops || [])];


    // Sortujemy po kolejności, jeśli backend podaje pole sequence/order/position.
    stopsInRoute.sort((a, b) => {
      const oa = a.sequence ?? a.order ?? a.position ?? 0;
      const ob = b.sequence ?? b.order ?? b.position ?? 0;
      return oa - ob;
    });


    return stopsInRoute
      .map((rs) => {
        const stop = allStops.find((s) => s.id === rs.stop_id);
        return {
          stop_id: rs.stop_id,
          name: stop?.name || rs.stop_id,
          latitude: stop?.latitude,
          longitude: stop?.longitude,
        };
      })
      .filter((s) => s.latitude != null && s.longitude != null);
  }, [selectedRoute, allStops]);


  // Współrzędne polyline (kolejność zachowana)
  const routePolyline = useMemo(
    () => routeStops.map((s) => [s.latitude, s.longitude]),
    [routeStops]
  );


  // ---------- Pojazdy z lokalizacją ----------
  const vehiclesWithPosition = useMemo(
    () =>
      vehicles.filter(
        (v) => v.last_latitude != null && v.last_longitude != null
      ),
    [vehicles]
  );


  // ---------- Przystanki z lokalizacją ----------
  const stopsWithPosition = useMemo(
    () =>
      allStops.filter(
        (s) => s.latitude != null && s.longitude != null
      ),
    [allStops]
  );


  // ---------- Pojazdy przypisane do wybranej trasy ----------
  const routeVehicles = useMemo(() => {
    if (!selectedRoute) return [];
    return vehiclesWithPosition.filter(
      (v) =>
        String(v.line_id) === String(selectedRoute.id) ||
        String(v.line_id) === String(selectedRoute.code)
    );
  }, [selectedRoute, vehiclesWithPosition]);


  // ---------- Co pokazać na mapie w danym trybie ----------
  const displayedVehicles = useMemo(() => {
    if (mode === MODE.STOPS) return [];
    if (mode === MODE.ROUTE) return routeVehicles;
    return vehiclesWithPosition; // ALL, BUSES
  }, [mode, routeVehicles, vehiclesWithPosition]);


  const displayedStops = useMemo(() => {
    if (mode === MODE.BUSES) return [];
    if (mode === MODE.ROUTE) return routeStops;
    return stopsWithPosition; // ALL, STOPS
  }, [mode, routeStops, stopsWithPosition]);


  // ---------- Kliknięcie elementu w panelu -> przelot mapy ----------
  const flyToVehicle = useCallback((v) => {
    setFlyTarget({
      lat: v.last_latitude,
      lng: v.last_longitude,
      zoom: 16,
    });
  }, []);


  const flyToStop = useCallback((s) => {
    setFlyTarget({
      lat: s.latitude,
      lng: s.longitude,
      zoom: 16,
    });
  }, []);


  // ---------- UI: panel boczny zależny od trybu ----------
  const showBusList = mode === MODE.ALL || mode === MODE.BUSES || mode === MODE.ROUTE;
  const showStopList = mode === MODE.ALL || mode === MODE.STOPS || mode === MODE.ROUTE;


  return (
    <div className={styles.container}>
      {/* ---------- PANEL BOCZNY ---------- */}
      <aside className={styles.sidebar}>
        <div className={styles.controls}>
          <div className={styles.modeGroup}>
            <button
              type="button"
              className={`${styles.modeButton} ${mode === MODE.ALL ? styles.modeActive : ''}`}
              onClick={() => handleModeChange(MODE.ALL)}
            >
              <LayoutGrid size={16} /> Wszystko
            </button>
            <button
              type="button"
              className={`${styles.modeButton} ${mode === MODE.BUSES ? styles.modeActive : ''}`}
              onClick={() => handleModeChange(MODE.BUSES)}
            >
              <Bus size={16} /> Autobusy
            </button>
            <button
              type="button"
              className={`${styles.modeButton} ${mode === MODE.STOPS ? styles.modeActive : ''}`}
              onClick={() => handleModeChange(MODE.STOPS)}
            >
              <MapPin size={16} /> Przystanki
            </button>
          </div>


          <label htmlFor="routeSelect" className={styles.label}>
            Wybierz trasę:
          </label>
          <select
            id="routeSelect"
            className={styles.select}
            value={selectedRouteId}
            onChange={handleRouteChange}
          >
            <option value="">-- brak (widok ogólny) --</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code ? `${r.code} — ` : ''}{r.name || `Trasa ${r.id}`}
              </option>
            ))}
          </select>


          {mode === MODE.ROUTE && selectedRoute && (
            <div className={styles.info}>
              <span className={styles.infoOk}>
                <Bus size={14} /> {routeVehicles.length} pojazdów na trasie
              </span>
              <span className={styles.infoOk}>
                <MapPin size={14} /> {routeStops.length} przystanków
              </span>
              {routeStops.length === 0 && (
                <span className={styles.infoWarning}>
                  <AlertTriangle size={14} /> Trasa nie ma przystanków ze współrzędnymi
                </span>
              )}
            </div>
          )}
        </div>


        {/* ---------- LISTA POJAZDÓW ---------- */}
        {showBusList && (
          <div className={styles.listSection}>
            <h3 className={styles.listHeading}>
              Autobusy ({displayedVehicles.length})
            </h3>
            {displayedVehicles.length === 0 ? (
              <p className={styles.listEmpty}>Brak pojazdów z lokalizacją.</p>
            ) : (
              <ul className={styles.list}>
                {displayedVehicles.map((v) => (
                  <li
                    key={v.pcName}
                    className={styles.listItem}
                    onClick={() => flyToVehicle(v)}
                  >
                    <span className={styles.listItemName}><Bus size={14} /> {v.pcName}</span>
                    <span className={styles.listItemMeta}>
                      {v.line_id ? `Trasa ${v.line_id}` : 'Brak trasy'}
                    </span>
                    <span className={styles.listItemCoords}>
                      {v.last_latitude.toFixed(5)}, {v.last_longitude.toFixed(5)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}


        {/* ---------- LISTA PRZYSTANKÓW ---------- */}
        {showStopList && (
          <div className={styles.listSection}>
            <h3 className={styles.listHeading}>
              Przystanki ({displayedStops.length})
            </h3>
            {displayedStops.length === 0 ? (
              <p className={styles.listEmpty}>Brak przystanków z lokalizacją.</p>
            ) : (
              <ul className={styles.list}>
                {displayedStops.map((s, idx) => (
                  <li
                    key={s.stop_id || s.id}
                    className={styles.listItem}
                    onClick={() => flyToStop(s)}
                  >
                    <span className={styles.listItemName}>
                      {mode === MODE.ROUTE ? `${idx + 1}. ` : <MapPin size={14} />}
                      {' '}{s.name}
                    </span>
                    <span className={styles.listItemCoords}>
                      {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>


      {/* ---------- MAPA ---------- */}
      <div className={styles.mapWrapper}>
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className={styles.mapContainer}
          zoomControl={true}
          attributionControl={true}
        >
          <TileLayer
  url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
/>


          <MapController target={flyTarget} />


          {/* Linia trasy łącząca przystanki w kolejności */}
          {mode === MODE.ROUTE && routePolyline.length >= 2 && (
            <Polyline
              positions={routePolyline}
              pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.8 }}
            />
          )}


          {/* Markery pojazdów */}
          {displayedVehicles.map((v) => (
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
          ))}


          {/* Markery przystanków */}
          {displayedStops.map((stop, idx) => (
            <Marker
              key={stop.stop_id || stop.id}
              position={[stop.latitude, stop.longitude]}
              icon={stopIcon}
            >
              <Popup>
                <div className={styles.popupStop}>
                  <strong>
                    {mode === MODE.ROUTE ? `${idx + 1}. ` : ''}
                    {stop.name}
                  </strong>
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