import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import './Cameras.css';

const Cameras = () => {
  const { api } = useBackend();
  const [vehicles, setVehicles] = useState([]);
  const [statusMap, setStatusMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const vehData = await api.getVehicles();
      const vehiclesList = vehData.vehicles || [];
      setVehicles(vehiclesList);
      const statusPromises = vehiclesList.map(v => api.getCurrentStatus({ pcName: v.pcName }).catch(() => ({ current_status: {} })));
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
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api, selectedVehicle]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleVehicleChange = (e) => {
    setSelectedVehicle(e.target.value);
  };

  const filteredVehicles = selectedVehicle
    ? vehicles.filter(v => v.pcName === selectedVehicle)
    : vehicles;

  if (loading) return <div className="loading">Ładowanie danych...</div>;
  if (error) return <div className="error">Błąd: {error}</div>;

  return (
    <div className="cameras">
      <h1>📹 Kamery i status pojazdów</h1>
      <div className="filter-bar">
        <label>Pojazd: </label>
        <select value={selectedVehicle} onChange={handleVehicleChange}>
          <option value="">Wszystkie</option>
          {vehicles.map(v => <option key={v.pcName} value={v.pcName}>{v.pcName}</option>)}
        </select>
      </div>
      <div className="vehicle-grid">
        {filteredVehicles.map(vehicle => {
          const status = statusMap[vehicle.pcName] || {};
          const passengers = status.passengers || {};
          return (
            <div className="vehicle-card" key={vehicle.pcName}>
              <div className="vehicle-header">
                <span className="vehicle-name">{vehicle.pcName}</span>
                <span className={`status-badge ${status.status === 'o czasie' ? 'ontime' : status.status === 'opóźniony' ? 'delayed' : status.status === 'za szybko' ? 'early' : 'unknown'}`}>
                  {status.status || 'brak danych'}
                </span>
              </div>
              <div className="vehicle-details">
                <div><strong>Linia:</strong> {status.line_id || vehicle.line_id || '—'}</div>
                <div><strong>Opóźnienie:</strong> {status.delay_seconds !== undefined && status.delay_seconds !== null ? status.delay_seconds + ' s' : '—'}</div>
                <div><strong>Pasażerowie:</strong> IN: {passengers.selected_in || 0}, OUT: {passengers.selected_out || 0}, onboard: {passengers.onboard || 0}</div>
                <div><strong>Lokalizacja:</strong> {status.latitude !== undefined && status.longitude !== undefined ? `${status.latitude.toFixed(5)}, ${status.longitude.toFixed(5)}` : '—'}</div>
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
    </div>
  );
};

export default Cameras;