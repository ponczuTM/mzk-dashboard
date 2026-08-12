import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
import styles from './Map.module.css';
import { useBackend } from '../context/BackendContext';

const SHOW_ALL_VEHICLES = '__SHOW_ALL_VEHICLES__';
const SHOW_ALL_STOPS = '__SHOW_ALL_STOPS__';
const SHOW_ALL_VEHICLES_AND_STOPS = '__SHOW_ALL_VEHICLES_AND_STOPS__';

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const stopIcon = new L.Icon({
  iconUrl:
    'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl:
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
  iconSize: [18, 30],
  iconAnchor: [9, 30],
  popupAnchor: [1, -28],
  shadowSize: [30, 30],
});

const busSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="12" y="18" width="76" height="57" rx="8" fill="#d32f2f"/>
  <rect x="22" y="28" width="24" height="19" rx="2" fill="#ffffff"/>
  <rect x="54" y="28" width="24" height="19" rx="2" fill="#ffffff"/>
  <rect x="22" y="54" width="56" height="11" rx="2" fill="#ffffff"/>
  <circle cx="30" cy="78" r="10" fill="#263238"/>
  <circle cx="70" cy="78" r="10" fill="#263238"/>
  <circle cx="30" cy="78" r="4" fill="#cfd8dc"/>
  <circle cx="70" cy="78" r="4" fill="#cfd8dc"/>
</svg>
`;

const busIcon = new L.Icon({
  iconUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(busSvg)}`,
  iconSize: [50, 50],
  iconAnchor: [25, 40],
  popupAnchor: [0, -40],
});

const normalizeId = (value) => String(value ?? '').trim();

const hasVehicleCoordinates = (vehicle) =>
  Number.isFinite(Number(vehicle?.last_latitude)) &&
  Number.isFinite(Number(vehicle?.last_longitude));

const hasStopCoordinates = (stop) =>
  Number.isFinite(Number(stop?.latitude)) &&
  Number.isFinite(Number(stop?.longitude));

const formatSeen = (value) => {
  if (!value) return 'brak danych';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString('pl-PL', {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
};

const todayKey = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}`;
};

/*
 * Przesuwa mapę do pojedynczego pojazdu albo dopasowuje widok
 * do wszystkich aktualnie widocznych markerów.
 */
const MapViewport = ({ points, selectedVehicleMode }) => {
  const map = useMap();

  useEffect(() => {
    if (!points.length) {
      map.flyTo([52.0, 19.0], 6, {
        animate: true,
        duration: 0.6,
      });
      return;
    }

    if (points.length === 1) {
      map.flyTo(points[0], selectedVehicleMode ? 14 : 13, {
        animate: true,
        duration: 0.6,
      });
      return;
    }

    const bounds = L.latLngBounds(points);

    map.fitBounds(bounds, {
      padding: [50, 50],
      maxZoom: 15,
      animate: true,
      duration: 0.6,
    });
  }, [map, points, selectedVehicleMode]);

  return null;
};

const Map = () => {
  const {
    api,
    vehicles,
    routes,
    vehiclesLoading,
    routesLoading,
    fetchVehicles,
    fetchRoutes,
    fetchVehicleSchedule,
  } = useBackend();

  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(true);

  const [selectedPcName, setSelectedPcName] = useState('');
  const [vehicleSchedule, setVehicleSchedule] = useState(null);

  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [error, setError] = useState(null);
  const [scheduleError, setScheduleError] = useState(null);

  const isAllVehiclesMode = selectedPcName === SHOW_ALL_VEHICLES;
  const isAllStopsMode = selectedPcName === SHOW_ALL_STOPS;
  const isAllVehiclesAndStopsMode =
    selectedPcName === SHOW_ALL_VEHICLES_AND_STOPS;

  const isGlobalMode =
    isAllVehiclesMode || isAllStopsMode || isAllVehiclesAndStopsMode;

  const shouldShowAllVehicles =
    isAllVehiclesMode || isAllVehiclesAndStopsMode;

  const shouldShowAllStops =
    isAllStopsMode || isAllVehiclesAndStopsMode;

  const loadBaseData = useCallback(async () => {
    try {
      setError(null);

      const [, , stopsResponse] = await Promise.all([
        fetchVehicles(),
        fetchRoutes(),
        api.getStops(),
      ]);

      setStops(stopsResponse?.stops || []);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać danych mapy.');
    } finally {
      setStopsLoading(false);
    }
  }, [api, fetchRoutes, fetchVehicles]);

  useEffect(() => {
    loadBaseData();

    const intervalId = setInterval(loadBaseData, 5000);

    return () => clearInterval(intervalId);
  }, [loadBaseData]);

  /*
   * Przy pierwszym uruchomieniu automatycznie wybieramy pierwszy
   * pojazd mający aktualne współrzędne GPS.
   */
  useEffect(() => {
    if (!selectedPcName) {
      const firstVehicleWithLocation = vehicles.find(hasVehicleCoordinates);

      if (firstVehicleWithLocation) {
        setSelectedPcName(firstVehicleWithLocation.pcName);
      }

      return;
    }

    if (isGlobalMode) {
      return;
    }

    const selectedVehicleStillExists = vehicles.some(
      (vehicle) => vehicle.pcName === selectedPcName
    );

    if (!selectedVehicleStillExists) {
      const firstVehicleWithLocation = vehicles.find(hasVehicleCoordinates);

      setSelectedPcName(firstVehicleWithLocation?.pcName || '');
    }
  }, [vehicles, selectedPcName, isGlobalMode]);

  /*
   * Pobiera plan kursów tylko dla pojedynczego wybranego pojazdu.
   * W trybach "Pokaż wszystkie..." harmonogram nie jest potrzebny.
   */
  const loadSelectedVehicleSchedule = useCallback(
    async (pcName) => {
      if (!pcName || isGlobalMode) {
        setVehicleSchedule(null);
        setScheduleError(null);
        setLoadingSchedule(false);
        return;
      }

      setLoadingSchedule(true);
      setScheduleError(null);

      try {
        const response = await fetchVehicleSchedule(pcName, {
          date: todayKey(),
        });

        setVehicleSchedule(response || null);
      } catch (err) {
        setVehicleSchedule(null);
        setScheduleError(
          err.message || 'Nie udało się pobrać harmonogramu pojazdu.'
        );
      } finally {
        setLoadingSchedule(false);
      }
    },
    [fetchVehicleSchedule, isGlobalMode]
  );

  useEffect(() => {
    loadSelectedVehicleSchedule(selectedPcName);
  }, [selectedPcName, loadSelectedVehicleSchedule]);

  const selectedVehicle = useMemo(() => {
    if (isGlobalMode) {
      return null;
    }

    return (
      vehicles.find((vehicle) => vehicle.pcName === selectedPcName) || null
    );
  }, [vehicles, selectedPcName, isGlobalMode]);

  /*
   * Faktyczne przystanki kursów wybranego pojazdu.
   *
   * Struktura z BackendContext:
   * vehicleSchedule.trips[].stops[] = {
   *   stop_id,
   *   name,
   *   planned_time
   * }
   */
  const tripStopReferences = useMemo(() => {
    const trips = vehicleSchedule?.trips || [];

    return trips.flatMap((trip) =>
      (trip.stops || []).map((stop, index) => ({
        stop_id: stop.stop_id,
        name: stop.name,
        planned_time: stop.planned_time,
        route_id: trip.route_id,
        trip_id: trip.id,
        trip_index: index,
      }))
    );
  }, [vehicleSchedule]);

  /*
   * Trasy przypisane do kursów pojazdu.
   *
   * Jeśli nie ma jeszcze pobranego harmonogramu, line_id pojazdu jest
   * traktowane jako awaryjne ID trasy.
   */
  const activeRouteIds = useMemo(() => {
    const ids = [];

    (vehicleSchedule?.trips || []).forEach((trip) => {
      const routeId = normalizeId(trip.route_id);

      if (routeId && !ids.includes(routeId)) {
        ids.push(routeId);
      }
    });

    const fallbackLineId = normalizeId(selectedVehicle?.line_id);

    if (fallbackLineId && !ids.includes(fallbackLineId)) {
      ids.push(fallbackLineId);
    }

    return ids;
  }, [vehicleSchedule, selectedVehicle]);

  const activeRoutes = useMemo(() => {
    return routes.filter((route) =>
      activeRouteIds.includes(normalizeId(route.id))
    );
  }, [routes, activeRouteIds]);

  /*
   * Jeżeli istnieje harmonogram, używamy przystanków z kursów.
   * Jeśli nie, pobieramy przystanki przypisane bezpośrednio do trasy:
   * routes[].stops[].
   */
  const visibleStopReferences = useMemo(() => {
    if (tripStopReferences.length > 0) {
      return tripStopReferences;
    }

    const fallbackRouteStops = [];

    activeRoutes.forEach((route) => {
      (route.stops || []).forEach((stop, index) => {
        fallbackRouteStops.push({
          stop_id: stop.stop_id,
          name: stop.name || stop.stop_name,
          planned_time: null,
          route_id: route.id,
          trip_id: null,
          trip_index: index,
        });
      });
    });

    return fallbackRouteStops;
  }, [tripStopReferences, activeRoutes]);

  /*
   * Łączy stop_id kursu z rekordem pobranym z GET /stops,
   * który zawiera współrzędne latitude i longitude.
   */
  const vehicleRouteStops = useMemo(() => {
    const result = [];
    const addedStopIds = [];

    visibleStopReferences.forEach((reference) => {
      const stopId = normalizeId(reference.stop_id);

      if (!stopId || addedStopIds.includes(stopId)) {
        return;
      }

      const stopFromDatabase = stops.find(
        (stop) => normalizeId(stop.id) === stopId
      );

      if (!stopFromDatabase || !hasStopCoordinates(stopFromDatabase)) {
        return;
      }

      addedStopIds.push(stopId);

      result.push({
        ...stopFromDatabase,
        planned_time: reference.planned_time,
        route_id: reference.route_id,
        trip_id: reference.trip_id,
        order: reference.trip_index,
      });
    });

    return result;
  }, [visibleStopReferences, stops]);

  /*
   * Markery autobusów widoczne na mapie.
   */
  const displayedVehicles = useMemo(() => {
    if (shouldShowAllVehicles) {
      return vehicles.filter(hasVehicleCoordinates);
    }

    if (selectedVehicle && hasVehicleCoordinates(selectedVehicle)) {
      return [selectedVehicle];
    }

    return [];
  }, [vehicles, selectedVehicle, shouldShowAllVehicles]);

  /*
   * Markery przystanków widoczne na mapie.
   */
  const displayedStops = useMemo(() => {
    if (shouldShowAllStops) {
      return stops.filter(hasStopCoordinates);
    }

    if (isAllVehiclesMode) {
      return [];
    }

    return vehicleRouteStops;
  }, [stops, vehicleRouteStops, shouldShowAllStops, isAllVehiclesMode]);

  const routeColor = activeRoutes[0]?.color || '#2563eb';

  /*
   * Linię trasy pokazujemy tylko przy widoku pojedynczego pojazdu.
   * W widoku globalnym polilinia byłaby myląca, bo wiele pojazdów
   * może jechać różnymi trasami.
   */
  const routePolylinePositions = useMemo(() => {
    if (isGlobalMode) {
      return [];
    }

    return vehicleRouteStops.map((stop) => [
      Number(stop.latitude),
      Number(stop.longitude),
    ]);
  }, [vehicleRouteStops, isGlobalMode]);

  /*
   * Punkty używane do automatycznego ustawienia widoku mapy.
   */
  const viewportPoints = useMemo(() => {
    const points = [];

    displayedVehicles.forEach((vehicle) => {
      points.push([
        Number(vehicle.last_latitude),
        Number(vehicle.last_longitude),
      ]);
    });

    displayedStops.forEach((stop) => {
      points.push([Number(stop.latitude), Number(stop.longitude)]);
    });

    return points;
  }, [displayedVehicles, displayedStops]);

  const vehicleHasRoute = Boolean(
    selectedVehicle?.line_id ||
      selectedVehicle?.has_schedule ||
      vehicleSchedule?.trips?.length ||
      activeRoutes.length
  );

  if (vehiclesLoading || routesLoading || stopsLoading) {
    return <div className={styles.loading}>Ładowanie mapy…</div>;
  }

  if (error) {
    return <div className={styles.error}>Błąd: {error}</div>;
  }

  return (
    <div
      className={styles.mapWrapper}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
      }}
    >
      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          top: 12,
          left: 12,
          width: 'min(400px, calc(100% - 24px))',
          padding: 12,
          borderRadius: 10,
          background: 'rgba(255, 255, 255, 0.97)',
          boxShadow: '0 3px 14px rgba(0, 0, 0, 0.25)',
        }}
      >
        <label
          htmlFor="vehicle-select"
          style={{
            display: 'block',
            marginBottom: 6,
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          Widok mapy / pojazd
        </label>

        <select
          id="vehicle-select"
          value={selectedPcName}
          onChange={(event) => setSelectedPcName(event.target.value)}
          style={{
            display: 'block',
            width: '100%',
            padding: 9,
            border: '1px solid #bdbdbd',
            borderRadius: 6,
            background: '#fff',
          }}
        >
          <option value="">— wybierz pojazd —</option>

          <option value={SHOW_ALL_VEHICLES}>
            Pokaż wszystkie autobusy
          </option>

          <option value={SHOW_ALL_STOPS}>
            Pokaż wszystkie przystanki z bazy
          </option>

          <option value={SHOW_ALL_VEHICLES_AND_STOPS}>
            Pokaż wszystkie autobusy i przystanki
          </option>

          <optgroup label="Pojedyncze pojazdy">
            {vehicles.map((vehicle) => (
              <option key={vehicle.pcName} value={vehicle.pcName}>
                {vehicle.pcName}
                {vehicle.line_id
                  ? ` — linia ${vehicle.line_id}`
                  : ' — bez przypisanej trasy'}
              </option>
            ))}
          </optgroup>
        </select>

        {isAllVehiclesMode && (
          <div
            style={{
              marginTop: 10,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong>Widok globalny:</strong> wszystkie autobusy z aktualną
            pozycją GPS.
            <br />
            Widoczne autobusy: {displayedVehicles.length}
          </div>
        )}

        {isAllStopsMode && (
          <div
            style={{
              marginTop: 10,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong>Widok globalny:</strong> wszystkie przystanki zapisane w
            bazie.
            <br />
            Widoczne przystanki: {displayedStops.length}
          </div>
        )}

        {isAllVehiclesAndStopsMode && (
          <div
            style={{
              marginTop: 10,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <strong>Widok globalny:</strong> wszystkie autobusy oraz wszystkie
            przystanki z bazy.
            <br />
            Autobusy: {displayedVehicles.length}
            <br />
            Przystanki: {displayedStops.length}
          </div>
        )}

        {selectedVehicle && (
          <div
            style={{
              marginTop: 10,
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            <div>
              <strong>Pojazd:</strong> {selectedVehicle.pcName}
            </div>

            <div>
              <strong>Status:</strong> {selectedVehicle.status || 'brak'}
            </div>

            <div>
              <strong>Linia:</strong>{' '}
              {selectedVehicle.line_id || 'brak przypisanej trasy'}
            </div>

            <div>
              <strong>Kursy dzisiaj:</strong>{' '}
              {vehicleSchedule?.trips?.length || 0}
            </div>

            <div>
              <strong>Przystanki na mapie:</strong>{' '}
              {vehicleRouteStops.length}
            </div>

            {loadingSchedule && (
              <div style={{ marginTop: 6, color: '#1d4ed8' }}>
                Pobieranie kursów pojazdu…
              </div>
            )}

            {!loadingSchedule &&
              vehicleHasRoute &&
              visibleStopReferences.length > 0 &&
              vehicleRouteStops.length === 0 && (
                <div style={{ marginTop: 6, color: '#b45309' }}>
                  Kurs zawiera przystanki, ale ich ID nie zostały odnalezione w
                  danych <code>GET /stops</code>.
                </div>
              )}

            {!loadingSchedule &&
              vehicleHasRoute &&
              visibleStopReferences.length === 0 &&
              !scheduleError && (
                <div style={{ marginTop: 6, color: '#b45309' }}>
                  Pojazd ma przypisaną trasę, ale nie znaleziono dla niej
                  przystanków.
                </div>
              )}

            {!vehicleHasRoute && (
              <div style={{ marginTop: 6, color: '#b91c1c' }}>
                Ten pojazd nie ma przypisanej trasy. Wyświetlana jest tylko
                jego aktualna lokalizacja.
              </div>
            )}

            {scheduleError && (
              <div style={{ marginTop: 6, color: '#b91c1c' }}>
                Nie udało się pobrać harmonogramu. Lokalizacja autobusu jest
                nadal widoczna.
              </div>
            )}
          </div>
        )}
      </div>

      <MapContainer
        center={[52.0, 19.0]}
        zoom={6}
        className={styles.mapContainer}
        scrollWheelZoom
        style={{
          width: '100%',
          height: '100%',
        }}
      >
        <MapViewport
          points={viewportPoints}
          selectedVehicleMode={Boolean(selectedVehicle)}
        />

        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {routePolylinePositions.length >= 2 && (
          <Polyline
            positions={routePolylinePositions}
            pathOptions={{
              color: routeColor,
              weight: 4,
              opacity: 0.75,
            }}
          />
        )}

        {displayedStops.map((stop, index) => (
          <Marker
            key={`stop-${stop.id}`}
            position={[Number(stop.latitude), Number(stop.longitude)]}
            icon={stopIcon}
          >
            <Popup>
              <strong>
                {shouldShowAllStops || isAllVehiclesAndStopsMode
                  ? stop.name
                  : `${index + 1}. ${stop.name}`}
              </strong>
              <br />
              ID: {stop.id}
              {stop.planned_time && (
                <>
                  <br />
                  Planowany czas: {stop.planned_time}
                </>
              )}
              <br />
              Szer: {Number(stop.latitude).toFixed(5)}
              <br />
              Dł: {Number(stop.longitude).toFixed(5)}
            </Popup>
          </Marker>
        ))}

        {displayedVehicles.map((vehicle) => (
          <Marker
            key={`vehicle-${vehicle.pcName}`}
            position={[
              Number(vehicle.last_latitude),
              Number(vehicle.last_longitude),
            ]}
            icon={busIcon}
          >
            <Popup>
              <strong>{vehicle.pcName}</strong>
              <br />
              Status: {vehicle.status || 'brak'}
              <br />
              Linia: {vehicle.line_id || 'brak przypisanej trasy'}
              <br />
              Ostatni sygnał: {formatSeen(vehicle.last_seen_at)}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
};

export default Map;