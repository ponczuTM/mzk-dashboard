import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import styles from './Map.module.css';
import { useBackend } from '../context/BackendContext';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
});

const stopIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
  iconSize: [18, 30],        // domyślnie 25x41 → 73% ≈ 18x30
  iconAnchor: [9, 30],
  popupAnchor: [1, -28],
  shadowSize: [30, 30],
});

const busSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 258.167 258.167" fill="#d32f2f">
  <path d="M41.562,130.891c-12.271,0-22.237,9.946-22.237,22.11c0,12.222,9.966,22.198,22.237,22.198
    c12.154,0,22.051-9.975,22.051-22.198C63.614,140.817,53.716,130.891,41.562,130.891z M41.562,166.747
    c-7.611,0-13.786-6.185-13.786-13.756c0-7.523,6.175-13.639,13.786-13.639c7.484,0,13.6,6.106,13.6,13.639
    C55.162,160.563,49.046,166.747,41.562,166.747z"/>
  <path d="M41.504,145.106c-4.426,0-7.972,3.566-7.972,7.924c0,4.436,3.556,7.943,7.972,7.943
    c4.367,0,7.894-3.498,7.894-7.943C49.398,148.663,45.871,145.106,41.504,145.106z"/>
  <path d="M249.081,81.376H0v73.266h18.856l-0.039-1.593c0-12.496,10.122-22.647,22.745-22.647
    c12.457,0,22.569,10.151,22.569,22.647l-0.039,1.602h105.361l-0.059-1.602c0-12.496,10.19-22.647,22.745-22.647
    c12.457,0,22.628,10.151,22.628,22.647l-0.107,1.602h43.507v-32.945L249.081,81.376z M27.845,87.55v29.408H6.917l0.059-29.447
    L27.845,87.55L27.845,87.55z M70.668,116.92H32.808V87.531l37.859,0.068V116.92z M113.539,116.929H75.66v-29.33l37.879,0.059
    V116.929z M156.401,148.643h-37.859V87.648l37.859,0.166V148.643z M199.243,116.929h-37.879V87.717l37.879,0.098V116.929z
    M204.196,116.91L204.196,116.91V87.795l41.318,0.078l6.302,29.066L204.196,116.91z"/>
  <rect x="133.9" y="92.006" width="5.989" height="52.495"/>
  <path d="M192.521,132.474c-12.252,0-22.217,9.946-22.217,22.129c0,12.222,9.956,22.188,22.217,22.188
    c12.135,0,22.032-9.966,22.032-22.188C214.553,142.42,204.656,132.474,192.521,132.474z M192.482,168.311
    c-7.562,0-13.747-6.165-13.747-13.717c0-7.523,6.185-13.639,13.747-13.639c7.533,0,13.639,6.126,13.639,13.639
    C206.111,162.175,200.005,168.311,192.482,168.311z"/>
  <path d="M192.482,146.699c-4.445,0-7.982,3.517-7.982,7.933s3.537,7.933,7.982,7.933
    c4.348,0,7.894-3.507,7.894-7.933C200.367,150.246,196.83,146.699,192.482,146.699z"/>
</svg>

`;

// Data URL z kodowaniem UTF-8 – unikamy btoa i problemów z polskimi znakami
const busIconUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(busSvg)}`;

const busIcon = new L.Icon({
  iconUrl: busIconUrl,
  iconSize: [50, 50],        // szerokość 50px, wysokość auto (zachowuje proporcje)
  iconAnchor: [25, 50],
  popupAnchor: [0, -50],
});

const Map = () => {
  const { api } = useBackend();
  const [vehicles, setVehicles] = useState([]);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);

  // Pobieranie danych
  const fetchData = useCallback(async () => {
    try {
      const [vehiclesData, stopsData] = await Promise.all([
        api.getVehicles(),
        api.getStops(),
      ]);
      setVehicles(vehiclesData.vehicles || []);
      setStops(stopsData.stops || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać danych.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  // Start – załaduj dane i uruchom interwał co 5 sekund
  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData]);

  // Środek mapy – pierwszy pojazd z pozycją, albo domyślnie Polska
  const centerVehicle = vehicles.find(
    (v) => v.last_latitude && v.last_longitude
  );
  const defaultCenter = [52.0, 19.0];
  const center = centerVehicle
    ? [centerVehicle.last_latitude, centerVehicle.last_longitude]
    : defaultCenter;
  const zoom = centerVehicle ? 13 : 6;

  if (loading) {
    return <div className={styles.loading}>Ładowanie mapy…</div>;
  }

  if (error) {
    return <div className={styles.error}>Błąd: {error}</div>;
  }

  return (
    <div className={styles.mapWrapper}>
      <MapContainer
        center={center}
        zoom={zoom}
        className={styles.mapContainer}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Przystanki – niebieskie, 73% */}
        {stops.map((stop) => (
          <Marker
            key={stop.id}
            position={[stop.latitude, stop.longitude]}
            icon={stopIcon}
          >
            <Popup>
              <strong>{stop.name}</strong>
              <br />
              ID: {stop.id}
              <br />
              Szer: {stop.latitude.toFixed(5)}, Dł: {stop.longitude.toFixed(5)}
            </Popup>
          </Marker>
        ))}

        {/* Pojazdy – autobusy */}
        {vehicles
          .filter((v) => v.last_latitude && v.last_longitude)
          .map((vehicle) => (
            <Marker
              key={vehicle.pcName}
              position={[vehicle.last_latitude, vehicle.last_longitude]}
              icon={busIcon}
            >
              <Popup>
                <strong>{vehicle.pcName}</strong>
                <br />
                Status: {vehicle.status || 'brak'}
                <br />
                Linia: {vehicle.line_id || 'brak'}
                <br />
                Ostatnio: {new Date(vehicle.last_seen_at).toLocaleString()}
              </Popup>
            </Marker>
          ))}
      </MapContainer>
    </div>
  );
};

export default Map;