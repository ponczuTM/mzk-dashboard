import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBackend } from '../context/BackendContext';
import {
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { AlertTriangle, Bus, LayoutGrid, MapPin } from 'lucide-react';
import styles from './Map.module.css';

// -----------------------------------------------------------------------------
// Tryby widoku
// -----------------------------------------------------------------------------

const MODE = {
  ALL: 'ALL',
  BUSES: 'BUSES',
  STOPS: 'STOPS',
  ROUTE: 'ROUTE',
};

const DEFAULT_CENTER = [53.02809365240993, 18.631034929317966];
const DEFAULT_ZOOM = 13;

const VEHICLES_REFRESH_MS = 5000;

// Dodatkowy obszar wokół ekranu dla pojazdów. Zapobiega miganiu markerów
// przy samej krawędzi mapy podczas przesuwania.
const VIEWPORT_PADDING = 0.15;

// -----------------------------------------------------------------------------
// Ikony
//
// Tworzone jeden raz poza komponentami. Nie generujemy nowych divIcon podczas
// renderowania Reacta ani podczas kolejnych aktualizacji GPS.
// -----------------------------------------------------------------------------

const busSvg = `
  <svg xmlns="http://www.w3.org/2000/svg"
       width="32"
       height="32"
       viewBox="0 0 24 24"
       fill="#2563eb"
       stroke="#ffffff"
       stroke-width="1.5"
       stroke-linecap="round"
       stroke-linejoin="round">
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="8" cy="18" r="2" fill="#2563eb" stroke="#ffffff" />
    <circle cx="16" cy="18" r="2" fill="#2563eb" stroke="#ffffff" />
    <path d="M8 6v4" />
    <path d="M16 6v4" />
  </svg>
`;

const stopSvg = `
  <svg xmlns="http://www.w3.org/2000/svg"
       width="26"
       height="26"
       viewBox="0 0 24 24"
       fill="#ffffff"
       stroke="#3b82f6"
       stroke-width="2">
    <circle cx="12" cy="12" r="10" />
    <text x="12"
          y="16"
          text-anchor="middle"
          font-size="10"
          fill="#3b82f6"
          font-weight="bold">P</text>
  </svg>
`;

const busIcon = L.divIcon({
  className: 'custom-bus-icon',
  html: busSvg,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -16],
});

const stopIcon = L.divIcon({
  className: 'custom-stop-icon',
  html: stopSvg,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
  popupAnchor: [0, -13],
});

// -----------------------------------------------------------------------------
// Funkcje pomocnicze
// -----------------------------------------------------------------------------

const getVehicleId = (vehicle, index = 0) =>
  String(
    vehicle.id ??
      vehicle.vehicle_id ??
      vehicle.pcName ??
      `vehicle-${index}`
  );

const getStopId = (stop, index = 0) =>
  String(stop.stop_id ?? stop.id ?? `stop-${index}`);

const hasPosition = (item, latitudeKey, longitudeKey) => {
  const latitude = Number(item?.[latitudeKey]);
  const longitude = Number(item?.[longitudeKey]);

  return Number.isFinite(latitude) && Number.isFinite(longitude);
};

const formatCoords = (latitude, longitude) =>
  `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;

const normalizeVehicle = (vehicle, index) => ({
  ...vehicle,
  _id: getVehicleId(vehicle, index),
  _lat: Number(vehicle.last_latitude),
  _lng: Number(vehicle.last_longitude),
});

const isInsideExtendedBounds = (
  bounds,
  latitude,
  longitude,
  padding = VIEWPORT_PADDING
) => {
  if (!bounds) {
    return false;
  }

  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  const latitudePadding = (north - south) * padding;
  const longitudePadding = (east - west) * padding;

  return (
    latitude >= south - latitudePadding &&
    latitude <= north + latitudePadding &&
    longitude >= west - longitudePadding &&
    longitude <= east + longitudePadding
  );
};

// -----------------------------------------------------------------------------
// Popup tworzone bez Reacta
//
// Markery znajdują się poza drzewem Reacta, dlatego popup jest tworzony
// imperatywnie przez zwykłe elementy DOM.
// -----------------------------------------------------------------------------

const createBusPopup = (vehicle) => {
  const wrapper = document.createElement('div');
  wrapper.className = styles.popupBus;

  const name = document.createElement('strong');
  name.textContent = vehicle.pcName || vehicle._id;

  const route = document.createElement('p');
  route.textContent = vehicle.line_id
    ? `Trasa: ${vehicle.line_id}`
    : 'Brak trasy';

  if (!vehicle.line_id) {
    route.style.color = '#dc2626';
  }

  const coordinates = document.createElement('p');
  coordinates.className = styles.popupCoords;
  coordinates.textContent = formatCoords(vehicle._lat, vehicle._lng);

  wrapper.append(name, route, coordinates);

  return wrapper;
};

const createStopPopup = (stop, index, isRouteMode) => {
  const wrapper = document.createElement('div');
  wrapper.className = styles.popupStop;

  const name = document.createElement('strong');
  name.textContent = `${isRouteMode ? `${index + 1}. ` : ''}${
    stop.name || 'Przystanek'
  }`;

  const coordinates = document.createElement('p');
  coordinates.className = styles.popupCoords;
  coordinates.textContent = formatCoords(stop.latitude, stop.longitude);

  wrapper.append(name, coordinates);

  return wrapper;
};

// -----------------------------------------------------------------------------
// Sterowanie mapą
// -----------------------------------------------------------------------------

const MapController = memo(({ target }) => {
  const map = useMap();

  useEffect(() => {
    if (!target) {
      return;
    }

    const latitude = Number(target.lat);
    const longitude = Number(target.lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return;
    }

    map.flyTo([latitude, longitude], target.zoom ?? map.getZoom(), {
      animate: true,
      duration: 0.65,
    });
  }, [map, target]);

  return null;
});

MapController.displayName = 'MapController';

// -----------------------------------------------------------------------------
// Obserwator viewportu
//
// Używamy moveend i zoomend, nie `move`. Aktualizacje listy widocznych pojazdów
// nie uruchamiają Reacta podczas każdego piksela dragowania mapy.
// -----------------------------------------------------------------------------

const ViewportObserver = memo(({ onBoundsChange }) => {
  const map = useMap();

  const updateBounds = useCallback(() => {
    onBoundsChange(map.getBounds());
  }, [map, onBoundsChange]);

  useMapEvents({
    moveend: updateBounds,
    zoomend: updateBounds,
  });

  useEffect(() => {
    updateBounds();
  }, [updateBounds]);

  return null;
});

ViewportObserver.displayName = 'ViewportObserver';

// -----------------------------------------------------------------------------
// Warstwa przystanków: natywny Leaflet.markercluster
//
// Brak react-leaflet-cluster:
// - brak konfliktu hooków / React 19,
// - brak dodatkowego Reactowego renderowania setek <Marker />,
// - cała klasteryzacja działa w Leaflecie.
//
// Każda zmiana trybu/przystanków podmienia warstwę klastrową jednorazowo.
// Tick GPS pojazdów NIE powoduje przebudowy tej warstwy.
// -----------------------------------------------------------------------------

const ClusteredStopsLayer = memo(({ stops, routeMode }) => {
  const map = useMap();
  const clusterRef = useRef(null);

  useEffect(() => {
    if (!clusterRef.current) {
      clusterRef.current = L.markerClusterGroup({
        chunkedLoading: true,
        chunkInterval: 100,
        chunkDelay: 20,
        maxClusterRadius: 55,
        disableClusteringAtZoom: 17,
        removeOutsideVisibleBounds: true,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        iconCreateFunction: (cluster) => {
          const count = cluster.getChildCount();

          return L.divIcon({
            html: `<div class="map-stop-cluster"><span>${count}</span></div>`,
            className: 'map-stop-cluster-wrapper',
            iconSize: L.point(42, 42, true),
          });
        },
      });

      clusterRef.current.addTo(map);
    }

    const cluster = clusterRef.current;

    // clearLayers + addLayers wykonuje Leaflet, bez Reactowych markerów.
    // Przystanki są statyczne, więc dzieje się to tylko po ich pobraniu
    // albo po przełączeniu trybu / trasy.
    cluster.clearLayers();

    if (stops.length > 0) {
      const markers = stops.map((stop, index) => {
        const marker = L.marker(
          [Number(stop.latitude), Number(stop.longitude)],
          {
            icon: stopIcon,
            keyboard: false,
            riseOnHover: true,
          }
        );

        marker.bindPopup(createStopPopup(stop, index, routeMode), {
          autoPan: true,
          closeButton: true,
        });

        return marker;
      });

      cluster.addLayers(markers);
    }

    return undefined;
  }, [map, routeMode, stops]);

  useEffect(() => {
    return () => {
      if (clusterRef.current) {
        map.removeLayer(clusterRef.current);
        clusterRef.current = null;
      }
    };
  }, [map]);

  return null;
});

ClusteredStopsLayer.displayName = 'ClusteredStopsLayer';

// -----------------------------------------------------------------------------
// Dynamiczna warstwa pojazdów
//
// Kluczowa optymalizacja:
// - instancje L.Marker trzymamy w globalThis.Map,
// - istniejący marker dostaje setLatLng(),
// - nie ma Reactowego <Marker> dla pojazdu,
// - poza viewportem marker jest usuwany z mapy i DOM,
// - przy 150 pojazdach renderowane są tylko te widoczne.
//
// globalThis.Map jest użyte, ponieważ główny komponent nazywa się Map.
// -----------------------------------------------------------------------------

const DynamicVehiclesLayer = memo(({ vehicles, bounds, enabled }) => {
  const map = useMap();

  const markersRef = useRef(new globalThis.Map());
  const latestVehiclesRef = useRef(new globalThis.Map());

  const syncMarkers = useCallback(() => {
    if (!enabled || !bounds) {
      markersRef.current.forEach((marker) => {
        map.removeLayer(marker);
      });

      markersRef.current.clear();
      return;
    }

    const visibleVehicleIds = new Set();

    latestVehiclesRef.current.forEach((vehicle, vehicleId) => {
      const visible = isInsideExtendedBounds(
        bounds,
        vehicle._lat,
        vehicle._lng
      );

      if (!visible) {
        return;
      }

      visibleVehicleIds.add(vehicleId);

      const existingMarker = markersRef.current.get(vehicleId);

      if (existingMarker) {
        const oldPosition = existingMarker.getLatLng();

        // Aktualizacja pozycji bez remountu / bez usunięcia HTML markera.
        if (
          oldPosition.lat !== vehicle._lat ||
          oldPosition.lng !== vehicle._lng
        ) {
          existingMarker.setLatLng([vehicle._lat, vehicle._lng]);
        }

        if (existingMarker.isPopupOpen()) {
          existingMarker.setPopupContent(createBusPopup(vehicle));
        }

        return;
      }

      const marker = L.marker([vehicle._lat, vehicle._lng], {
        icon: busIcon,
        keyboard: false,
        riseOnHover: true,
      });

      marker.bindPopup(createBusPopup(vehicle), {
        autoPan: true,
        closeButton: true,
      });

      marker.addTo(map);
      markersRef.current.set(vehicleId, marker);
    });

    // Usuń markery poza viewportem lub nieobecne w świeżych danych.
    markersRef.current.forEach((marker, vehicleId) => {
      if (!visibleVehicleIds.has(vehicleId)) {
        map.removeLayer(marker);
        markersRef.current.delete(vehicleId);
      }
    });
  }, [bounds, enabled, map]);

  useEffect(() => {
    const normalizedVehicles = new globalThis.Map();

    vehicles.forEach((vehicle, index) => {
      const normalized = normalizeVehicle(vehicle, index);

      if (
        Number.isFinite(normalized._lat) &&
        Number.isFinite(normalized._lng)
      ) {
        normalizedVehicles.set(normalized._id, normalized);
      }
    });

    latestVehiclesRef.current = normalizedVehicles;
    syncMarkers();
  }, [syncMarkers, vehicles]);

  useEffect(() => {
    syncMarkers();
  }, [bounds, enabled, syncMarkers]);

  useEffect(() => {
    return () => {
      markersRef.current.forEach((marker) => {
        map.removeLayer(marker);
      });

      markersRef.current.clear();
    };
  }, [map]);

  return null;
});

DynamicVehiclesLayer.displayName = 'DynamicVehiclesLayer';

// -----------------------------------------------------------------------------
// Warstwa polilinii trasy
// -----------------------------------------------------------------------------

const RouteLayer = memo(({ positions }) => {
  const pathOptions = useMemo(
    () => ({
      color: '#2563eb',
      weight: 4,
      opacity: 0.8,
      lineCap: 'round',
      lineJoin: 'round',
    }),
    []
  );

  if (positions.length < 2) {
    return null;
  }

  return <Polyline positions={positions} pathOptions={pathOptions} />;
});

RouteLayer.displayName = 'RouteLayer';

// -----------------------------------------------------------------------------
// Główny komponent
// -----------------------------------------------------------------------------

const Map = () => {
  const { api, vehicles, fetchVehicles, routes, fetchRoutes } = useBackend();

  const [allStops, setAllStops] = useState([]);
  const [mode, setMode] = useState(MODE.ALL);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [flyTarget, setFlyTarget] = useState(null);
  const [mapBounds, setMapBounds] = useState(null);

  const refreshInFlightRef = useRef(false);

  // Początkowe pobranie danych.
  useEffect(() => {
    let cancelled = false;

    const loadInitialData = async () => {
      try {
        const [, , stopsData] = await Promise.all([
          fetchVehicles(),
          fetchRoutes(),
          api.getStops(),
        ]);

        if (!cancelled) {
          setAllStops(stopsData?.stops || []);
        }
      } catch (error) {
        console.error('Błąd inicjalizacji mapy:', error);
      }
    };

    loadInitialData();

    return () => {
      cancelled = true;
    };
  }, [api, fetchRoutes, fetchVehicles]);

  const busesVisible =
    mode === MODE.ALL ||
    mode === MODE.BUSES ||
    mode === MODE.ROUTE;

  // Aktualizuj dane GPS tylko wtedy, kiedy pojazdy są potrzebne.
  // Chronimy przed nakładaniem requestów przy wolniejszym backendzie.
  useEffect(() => {
    if (!busesVisible) {
      return undefined;
    }

    let disposed = false;

    const refreshVehicles = async () => {
      if (disposed || refreshInFlightRef.current) {
        return;
      }

      refreshInFlightRef.current = true;

      try {
        await fetchVehicles();
      } catch (error) {
        console.error('Błąd odświeżania pojazdów:', error);
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    refreshVehicles();

    const intervalId = window.setInterval(
      refreshVehicles,
      VEHICLES_REFRESH_MS
    );

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [busesVisible, fetchVehicles]);

  const handleModeChange = useCallback((nextMode) => {
    setMode(nextMode);
    setSelectedRouteId('');
    setFlyTarget(null);
  }, []);

  const handleRouteChange = useCallback((event) => {
    const routeId = event.target.value;

    setSelectedRouteId(routeId);
    setMode(routeId ? MODE.ROUTE : MODE.ALL);
    setFlyTarget(null);
  }, []);

  const selectedRoute = useMemo(() => {
    return (
      routes.find(
        (route) =>
          String(route.id) === String(selectedRouteId) ||
          String(route.code) === String(selectedRouteId)
      ) || null
    );
  }, [routes, selectedRouteId]);

  // Indeksowanie przystanków usuwa wielokrotne allStops.find(...) w routeStops.
  const stopsById = useMemo(() => {
    const result = new globalThis.Map();

    allStops.forEach((stop) => {
      const id = stop.id ?? stop.stop_id;

      if (id != null) {
        result.set(String(id), stop);
      }
    });

    return result;
  }, [allStops]);

  const routeStops = useMemo(() => {
    if (!selectedRoute?.stops?.length) {
      return [];
    }

    return [...selectedRoute.stops]
      .sort((a, b) => {
        const orderA = a.sequence ?? a.order ?? a.position ?? 0;
        const orderB = b.sequence ?? b.order ?? b.position ?? 0;

        return orderA - orderB;
      })
      .map((routeStop) => {
        const stopId = routeStop.stop_id ?? routeStop.id;
        const stop = stopsById.get(String(stopId));

        return {
          ...routeStop,
          id: stop?.id ?? stopId,
          stop_id: stop?.stop_id ?? stopId,
          name: stop?.name ?? routeStop.name ?? `Przystanek ${stopId}`,
          latitude: stop?.latitude ?? routeStop.latitude,
          longitude: stop?.longitude ?? routeStop.longitude,
        };
      })
      .filter((stop) => hasPosition(stop, 'latitude', 'longitude'));
  }, [selectedRoute, stopsById]);

  const routePolyline = useMemo(
    () =>
      routeStops.map((stop) => [
        Number(stop.latitude),
        Number(stop.longitude),
      ]),
    [routeStops]
  );

  const vehiclesWithPosition = useMemo(
    () =>
      vehicles.filter((vehicle) =>
        hasPosition(vehicle, 'last_latitude', 'last_longitude')
      ),
    [vehicles]
  );

  const stopsWithPosition = useMemo(
    () =>
      allStops.filter((stop) =>
        hasPosition(stop, 'latitude', 'longitude')
      ),
    [allStops]
  );

  const routeVehicles = useMemo(() => {
    if (!selectedRoute) {
      return [];
    }

    const routeIdentifiers = new Set(
      [selectedRoute.id, selectedRoute.code]
        .filter((value) => value != null)
        .map(String)
    );

    return vehiclesWithPosition.filter((vehicle) =>
      routeIdentifiers.has(String(vehicle.line_id))
    );
  }, [selectedRoute, vehiclesWithPosition]);

  const displayedVehicles = useMemo(() => {
    if (mode === MODE.STOPS) {
      return [];
    }

    if (mode === MODE.ROUTE) {
      return routeVehicles;
    }

    return vehiclesWithPosition;
  }, [mode, routeVehicles, vehiclesWithPosition]);

  const displayedStops = useMemo(() => {
    if (mode === MODE.BUSES) {
      return [];
    }

    if (mode === MODE.ROUTE) {
      return routeStops;
    }

    return stopsWithPosition;
  }, [mode, routeStops, stopsWithPosition]);

  const flyToVehicle = useCallback((vehicle) => {
    setFlyTarget({
      lat: Number(vehicle.last_latitude),
      lng: Number(vehicle.last_longitude),
      zoom: 16,
    });
  }, []);

  const flyToStop = useCallback((stop) => {
    setFlyTarget({
      lat: Number(stop.latitude),
      lng: Number(stop.longitude),
      zoom: 16,
    });
  }, []);

  const handleBoundsChange = useCallback((bounds) => {
    setMapBounds(bounds);
  }, []);

  const showBusList =
    mode === MODE.ALL ||
    mode === MODE.BUSES ||
    mode === MODE.ROUTE;

  const showStopList =
    mode === MODE.ALL ||
    mode === MODE.STOPS ||
    mode === MODE.ROUTE;

  return (
    <div className={styles.container}>
      <aside className={styles.sidebar}>
        <div className={styles.controls}>
          <div className={styles.modeGroup}>
            <button
              type="button"
              className={`${styles.modeButton} ${
                mode === MODE.ALL ? styles.modeActive : ''
              }`}
              onClick={() => handleModeChange(MODE.ALL)}
            >
              <LayoutGrid size={16} />
              Wszystko
            </button>

            <button
              type="button"
              className={`${styles.modeButton} ${
                mode === MODE.BUSES ? styles.modeActive : ''
              }`}
              onClick={() => handleModeChange(MODE.BUSES)}
            >
              <Bus size={16} />
              Autobusy
            </button>

            <button
              type="button"
              className={`${styles.modeButton} ${
                mode === MODE.STOPS ? styles.modeActive : ''
              }`}
              onClick={() => handleModeChange(MODE.STOPS)}
            >
              <MapPin size={16} />
              Przystanki
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

            {routes.map((route) => (
              <option key={route.id} value={route.id}>
                {route.code ? `${route.code} — ` : ''}
                {route.name || `Trasa ${route.id}`}
              </option>
            ))}
          </select>

          {mode === MODE.ROUTE && selectedRoute && (
            <div className={styles.info}>
              <span className={styles.infoOk}>
                <Bus size={14} />
                {routeVehicles.length} pojazdów na trasie
              </span>

              <span className={styles.infoOk}>
                <MapPin size={14} />
                {routeStops.length} przystanków
              </span>

              {routeStops.length === 0 && (
                <span className={styles.infoWarning}>
                  <AlertTriangle size={14} />
                  Trasa nie ma przystanków ze współrzędnymi
                </span>
              )}
            </div>
          )}
        </div>

        {showBusList && (
          <div className={styles.listSection}>
            <h3 className={styles.listHeading}>
              Autobusy ({displayedVehicles.length})
            </h3>

            {displayedVehicles.length === 0 ? (
              <p className={styles.listEmpty}>
                Brak pojazdów z lokalizacją.
              </p>
            ) : (
              <ul className={styles.list}>
                {displayedVehicles.map((vehicle, index) => (
                  <li
                    key={getVehicleId(vehicle, index)}
                    className={styles.listItem}
                    onClick={() => flyToVehicle(vehicle)}
                  >
                    <span className={styles.listItemName}>
                      <Bus size={14} />
                      {vehicle.pcName || `Pojazd ${index + 1}`}
                    </span>

                    <span className={styles.listItemMeta}>
                      {vehicle.line_id
                        ? `Trasa ${vehicle.line_id}`
                        : 'Brak trasy'}
                    </span>

                    <span className={styles.listItemCoords}>
                      {formatCoords(
                        vehicle.last_latitude,
                        vehicle.last_longitude
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {showStopList && (
          <div className={styles.listSection}>
            <h3 className={styles.listHeading}>
              Przystanki ({displayedStops.length})
            </h3>

            {displayedStops.length === 0 ? (
              <p className={styles.listEmpty}>
                Brak przystanków z lokalizacją.
              </p>
            ) : (
              <ul className={styles.list}>
                {displayedStops.map((stop, index) => (
                  <li
                    key={getStopId(stop, index)}
                    className={styles.listItem}
                    onClick={() => flyToStop(stop)}
                  >
                    <span className={styles.listItemName}>
                      {mode === MODE.ROUTE ? (
                        `${index + 1}. ${stop.name}`
                      ) : (
                        <>
                          <MapPin size={14} />
                          {stop.name}
                        </>
                      )}
                    </span>

                    <span className={styles.listItemCoords}>
                      {formatCoords(stop.latitude, stop.longitude)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </aside>

      <div className={styles.mapWrapper}>
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className={styles.mapContainer}
          zoomControl
          attributionControl
          preferCanvas
          renderer={L.canvas({ padding: 0.5 })}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            updateWhenIdle
            keepBuffer={2}
          />

          <MapController target={flyTarget} />

          <ViewportObserver onBoundsChange={handleBoundsChange} />

          {mode === MODE.ROUTE && (
            <RouteLayer positions={routePolyline} />
          )}

          <DynamicVehiclesLayer
            vehicles={displayedVehicles}
            bounds={mapBounds}
            enabled={busesVisible}
          />

          <ClusteredStopsLayer
            stops={displayedStops}
            routeMode={mode === MODE.ROUTE}
          />
        </MapContainer>
      </div>
    </div>
  );
};

export default Map;