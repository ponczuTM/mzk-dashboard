import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
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
 * MapController ustawia widok mapy DOKŁADNIE JEDEN RAZ w całym cyklu
 * życia komponentu — w momencie, gdy po raz pierwszy pojawią się
 * jakiekolwiek punkty (pozycje autobusów / przystanków).
 *
 * Po tym pierwszym ("init") ustawieniu widoku flaga hasInitializedRef
 * jest ustawiana na true i JUŻ NIGDY więcej widok mapy nie jest ruszany.
 *
 * Dzięki temu:
 *  - przy starcie mapa sama wyśrodkuje się na lokalnych autobusach/przystankach,
 *  - a każda kolejna aktualizacja danych (GPS co 5 s) NIE przesuwa
 *    ani nie przybliża mapy — użytkownik zostaje dokładnie tam,
 *    gdzie sam ustawił widok.
 *
 * Punkty czytamy przez ref, więc ich ciągłe zmiany nie wyzwalają
 * żadnej logiki po inicjalizacji.
 */
const MapController = ({ initialPoints, singleVehicleMode }) => {
  const map = useMap();

  const hasInitializedRef = useRef(false);

  const pointsRef = useRef(initialPoints);
  pointsRef.current = initialPoints;

  const singleVehicleModeRef = useRef(singleVehicleMode);
  singleVehicleModeRef.current = singleVehicleMode;

  /*
   * Ostatni widok ustawiony ŚWIADOMIE:
   *  - albo przez init (jednorazowe wyśrodkowanie),
   *  - albo przez samego użytkownika (przeciągnięcie / zoom).
   *
   * To jest jedyne źródło prawdy o tym, gdzie ma być kadr mapy.
   * Jakikolwiek inny ruch (np. auto-pan popupu przy aktualizacji
   * pozycji markera) jest natychmiast cofany do tej wartości.
   */
  const userViewRef = useRef(null);

  // Chroni przed pętlą: nasze własne przywracanie widoku nie może
  // być traktowane jako "ruch użytkownika".
  const isRestoringRef = useRef(false);

  // Init — dokładnie raz, gdy pojawią się pierwsze punkty.
  useEffect(() => {
    if (hasInitializedRef.current) {
      return;
    }

    const points = pointsRef.current;

    if (!points.length) {
      return;
    }

    hasInitializedRef.current = true;

    if (points.length === 1) {
      map.setView(points[0], singleVehicleModeRef.current ? 14 : 13, {
        animate: false,
      });
    } else {
      map.fitBounds(L.latLngBounds(points), {
        padding: [50, 50],
        maxZoom: 15,
        animate: false,
      });
    }

    // Zapamiętujemy widok po inicjalizacji jako źródło prawdy.
    userViewRef.current = {
      center: map.getCenter(),
      zoom: map.getZoom(),
    };
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps

  /*
   * Strażnik widoku.
   *
   * moveend/zoomend odpalają się ZARÓWNO przy ruchu użytkownika,
   * JAK I przy auto-panie wywołanym przez Leaflet (np. popup goniący
   * przesunięty marker autobusu).
   *
   * Rozróżniamy je flagą isRestoringRef:
   *  - jeśli to nasze przywracanie -> ignorujemy,
   *  - jeśli ruch pochodzi od interakcji użytkownika (dragging /
   *    zoom przez kółko lub przyciski) -> zapisujemy nowy widok,
   *  - w pozostałych przypadkach (auto-pan) -> przywracamy zapamiętany
   *    widok, więc mapa NIE goni autobusu.
   */
  useEffect(() => {
    const handleMoveEnd = () => {
      if (isRestoringRef.current) {
        isRestoringRef.current = false;
        return;
      }

      // Ruch pochodzący od użytkownika: aktualizujemy źródło prawdy.
      userViewRef.current = {
        center: map.getCenter(),
        zoom: map.getZoom(),
      };
    };

    const handleUnexpectedPan = () => {
      // Auto-pan (np. z popupu) nie jest interakcją użytkownika.
      // Jeśli mamy zapamiętany widok, natychmiast go przywracamy.
      if (!userViewRef.current) {
        return;
      }

      const current = { center: map.getCenter(), zoom: map.getZoom() };
      const saved = userViewRef.current;

      const moved =
        current.zoom !== saved.zoom ||
        Math.abs(current.center.lat - saved.center.lat) > 1e-9 ||
        Math.abs(current.center.lng - saved.center.lng) > 1e-9;

      if (!moved) {
        return;
      }

      isRestoringRef.current = true;
      map.setView(saved.center, saved.zoom, { animate: false });
    };

    // Ruch inicjowany przez użytkownika => zapis nowego widoku.
    map.on('dragend', handleMoveEnd);
    map.on('zoomend', handleMoveEnd);

    // Auto-pan (np. popup) => cofnięcie do zapamiętanego widoku.
    map.on('autopanstart', handleUnexpectedPan);
    map.on('moveend', handleUnexpectedPan);

    return () => {
      map.off('dragend', handleMoveEnd);
      map.off('zoomend', handleMoveEnd);
      map.off('autopanstart', handleUnexpectedPan);
      map.off('moveend', handleUnexpectedPan);
    };
  }, [map]);

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

  /*
   * Aktualizacja danych mapy następuje co pięć sekund.
   *
   * Ten proces zmienia tylko markery i ich pozycje.
   * Nie zmienia center ani zoom MapContainer.
   */
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
   * Początkowo wybieramy pierwszy autobus z lokalizacją.
   * Późniejsze aktualizacje nie zmieniają już wybranego pojazdu.
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
   * Harmonogram pobieramy tylko dla widoku pojedynczego pojazdu.
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
   * Odczyt przystanków z konkretnych kursów przypisanych do pojazdu.
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

  const activeRouteIds = useMemo(() => {
    const routeIds = [];

    (vehicleSchedule?.trips || []).forEach((trip) => {
      const routeId = normalizeId(trip.route_id);

      if (routeId && !routeIds.includes(routeId)) {
        routeIds.push(routeId);
      }
    });

    /*
     * Fallback: line_id pojazdu wskazuje ID trasy.
     */
    const lineId = normalizeId(selectedVehicle?.line_id);

    if (lineId && !routeIds.includes(lineId)) {
      routeIds.push(lineId);
    }

    return routeIds;
  }, [vehicleSchedule, selectedVehicle]);

  const activeRoutes = useMemo(() => {
    return routes.filter((route) =>
      activeRouteIds.includes(normalizeId(route.id))
    );
  }, [routes, activeRouteIds]);

  /*
   * Jeśli harmonogram ma kursy, ich lista przystanków jest nadrzędna.
   *
   * Fallback: wykorzystujemy route.stops z danych tras.
   */
  const visibleStopReferences = useMemo(() => {
    if (tripStopReferences.length > 0) {
      return tripStopReferences;
    }

    const routeStops = [];

    activeRoutes.forEach((route) => {
      (route.stops || []).forEach((stop, index) => {
        routeStops.push({
          stop_id: stop.stop_id,
          name: stop.name || stop.stop_name,
          planned_time: null,
          route_id: route.id,
          trip_id: null,
          trip_index: index,
        });
      });
    });

    return routeStops;
  }, [tripStopReferences, activeRoutes]);

  /*
   * Dopasowuje stop_id z harmonogramu do rekordów GET /stops,
   * z których otrzymujemy latitude i longitude.
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

  const displayedVehicles = useMemo(() => {
    if (shouldShowAllVehicles) {
      return vehicles.filter(hasVehicleCoordinates);
    }

    if (selectedVehicle && hasVehicleCoordinates(selectedVehicle)) {
      return [selectedVehicle];
    }

    return [];
  }, [vehicles, selectedVehicle, shouldShowAllVehicles]);

  const displayedStops = useMemo(() => {
    if (shouldShowAllStops) {
      return stops.filter(hasStopCoordinates);
    }

    if (isAllVehiclesMode) {
      return [];
    }

    return vehicleRouteStops;
  }, [stops, vehicleRouteStops, shouldShowAllStops, isAllVehiclesMode]);

  /*
   * Polilinia jest dostępna wyłącznie w trybie pojedynczego pojazdu.
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

  const routeColor = activeRoutes[0]?.color || '#2563eb';

  /*
   * Punkty potrzebne WYŁĄCZNIE do jednorazowej inicjalizacji widoku.
   * Po pierwszym snapie MapController i tak ignoruje ich zmiany.
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
        zoomAnimation={false}
        fadeAnimation={false}
        markerZoomAnimation={false}
        style={{
          width: '100%',
          height: '100%',
        }}
      >
        <MapController
          initialPoints={viewportPoints}
          singleVehicleMode={Boolean(selectedVehicle)}
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
            <Popup autoPan={false}>
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
            <Popup autoPan={false}>
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