import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import './Vehicles.css';

const Vehicles = () => {
  const { api } = useBackend();
  const [vehicles, setVehicles] = useState([]);
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [trips, setTrips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [history, setHistory] = useState([]);

  const loadVehicles = useCallback(async () => {
    try {
      const data = await api.getVehicles();
      const list = data.vehicles || [];
      setVehicles(list);
      if (list.length > 0 && !selectedVehicle) {
        setSelectedVehicle(list[0].pcName);
      }
    } catch (err) {
      setError(err.message);
    }
  }, [api, selectedVehicle]);

  const loadTrips = useCallback(async (pcName, pageNum = 1) => {
    if (!pcName) return;
    try {
      const data = await api.getTrips({ pcName, page: pageNum, limit: 20 });
      setTrips(data.rows || []);
      setTotalPages(data.totalPages || 1);
      setPage(pageNum);
    } catch (err) {
      console.error('Błąd ładowania tras:', err);
    }
  }, [api]);

  const loadHistory = useCallback(async (pcName) => {
    if (!pcName) return;
    try {
      const data = await api.getTrips({ pcName, limit: 100, page: 1 });
      const rows = data.rows || [];
      const historyData = rows.map(t => ({
        timestamp: t.received_at || t.timestamp,
        lat: t.latitude,
        lng: t.longitude,
        status: t.punctuality_status,
        delay: t.delay_seconds
      })).filter(t => t.lat && t.lng);
      setHistory(historyData);
    } catch (err) {
      console.error('Błąd ładowania historii lokalizacji:', err);
    }
  }, [api]);

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  useEffect(() => {
    if (selectedVehicle) {
      loadTrips(selectedVehicle, 1);
      loadHistory(selectedVehicle);
    }
  }, [selectedVehicle, loadTrips, loadHistory]);

  const handleVehicleChange = (e) => {
    setSelectedVehicle(e.target.value);
  };

  const handlePageChange = (newPage) => {
    if (newPage >= 1 && newPage <= totalPages) {
      loadTrips(selectedVehicle, newPage);
    }
  };

  if (loading) return <div className="loading">Ładowanie...</div>;
  if (error) return <div className="error">Błąd: {error}</div>;

  return (
    <div className="vehicles">
      <h1>🚌 Pojazdy</h1>
      <div className="filter-bar">
        <label>Wybierz pojazd: </label>
        <select value={selectedVehicle} onChange={handleVehicleChange}>
          {vehicles.map(v => <option key={v.pcName} value={v.pcName}>{v.pcName}</option>)}
        </select>
      </div>

      <div className="vehicle-detail">
        {vehicles.filter(v => v.pcName === selectedVehicle).map(v => (
          <div key={v.pcName} className="vehicle-info">
            <h2>{v.pcName}</h2>
            <p><strong>PC ID:</strong> {v.pcId}</p>
            <p><strong>Linia:</strong> {v.line_id || '—'}</p>
            <p><strong>Ostatnia lokalizacja:</strong> {v.last_latitude !== null ? `${v.last_latitude.toFixed(5)}, ${v.last_longitude.toFixed(5)}` : '—'}</p>
            <p><strong>Ostatnio widziany:</strong> {v.last_seen_at ? new Date(v.last_seen_at).toLocaleString() : '—'}</p>
          </div>
        ))}
      </div>

      <div className="history-section">
        <h3>Historia lokalizacji (ostatnie 100 punktów)</h3>
        {history.length > 0 ? (
          <div className="history-list">
            <table>
              <thead>
                <tr>
                  <th>Czas</th>
                  <th>Szerokość</th>
                  <th>Długość</th>
                  <th>Status</th>
                  <th>Opóźnienie</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 20).map((h, idx) => (
                  <tr key={idx}>
                    <td>{new Date(h.timestamp).toLocaleString()}</td>
                    <td>{h.lat.toFixed(5)}</td>
                    <td>{h.lng.toFixed(5)}</td>
                    <td>{h.status || '—'}</td>
                    <td>{h.delay !== null ? h.delay + ' s' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Brak danych o lokalizacji.</p>
        )}
      </div>

      <div className="trips-section">
        <h3>Zdarzenia pojazdu (kursy)</h3>
        <table>
          <thead>
            <tr>
              <th>Czas</th>
              <th>Linia</th>
              <th>Przystanek</th>
              <th>Pasażerowie</th>
              <th>Opóźnienie</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {trips.map(t => (
              <tr key={t.id}>
                <td>{t.received_at ? new Date(t.received_at).toLocaleString() : t.timestamp}</td>
                <td>{t.line_id}</td>
                <td>{t.stop_name || t.stop_id}</td>
                <td>{t.passenger_events || 0}</td>
                <td>{t.delay_seconds !== null ? t.delay_seconds + ' s' : '—'}</td>
                <td>{t.punctuality_status || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pagination">
          <button onClick={() => handlePageChange(page - 1)} disabled={page <= 1}>Poprzednia</button>
          <span>Strona {page} z {totalPages}</span>
          <button onClick={() => handlePageChange(page + 1)} disabled={page >= totalPages}>Następna</button>
        </div>
      </div>
    </div>
  );
};

export default Vehicles;