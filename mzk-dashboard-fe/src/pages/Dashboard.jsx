import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import './Dashboard.css';

const Dashboard = () => {
  const { api } = useBackend();
  const [vehicles, setVehicles] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [recentTrips, setRecentTrips] = useState([]);
  const [passengerHistory, setPassengerHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [vehicleOptions, setVehicleOptions] = useState([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [vehData, schData, tripsData] = await Promise.all([
        api.getVehicles(),
        api.getSchedules({ active: 'true' }),
        api.getTrips({ limit: 50, page: 1 })
      ]);
      setVehicles(vehData.vehicles || []);
      setSchedules(schData.schedules || []);
      setRecentTrips(tripsData.rows || []);
      const opts = (vehData.vehicles || []).map(v => v.pcName).filter(Boolean);
      setVehicleOptions(opts);
      if (opts.length > 0 && !selectedVehicle) {
        setSelectedVehicle(opts[0]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api, selectedVehicle]);

  const loadPassengerHistory = useCallback(async (pcName) => {
    if (!pcName) return;
    try {
      const data = await api.getTrips({ pcName, limit: 100, page: 1 });
      const rows = data.rows || [];
      const map = {};
      rows.forEach(row => {
        const date = row.received_at ? row.received_at.split('T')[0] : row.timestamp?.split('T')[0];
        if (date) {
          map[date] = (map[date] || 0) + (row.passenger_events || 0);
        }
      });
      const history = Object.entries(map).map(([date, count]) => ({ date, passengers: count }));
      history.sort((a, b) => a.date.localeCompare(b.date));
      setPassengerHistory(history);
    } catch (err) {
      console.error('Błąd ładowania historii pasażerów:', err);
    }
  }, [api]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (selectedVehicle) {
      loadPassengerHistory(selectedVehicle);
    }
  }, [selectedVehicle, loadPassengerHistory]);

  const handleVehicleChange = (e) => {
    setSelectedVehicle(e.target.value);
  };

  const totalVehicles = vehicles.length;
  const activeSchedules = schedules.filter(s => s.active).length;
  const totalTrips = recentTrips.length;

  if (loading) return <div className="loading">Ładowanie danych...</div>;
  if (error) return <div className="error">Błąd: {error}</div>;

  return (
    <div className="dashboard">
      <h1>📊 Dashboard</h1>
      <div className="filter-bar">
        <label>Pojazd: </label>
        <select value={selectedVehicle} onChange={handleVehicleChange}>
          {vehicleOptions.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Pojazdy</span>
          <span className="stat-value">{totalVehicles}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Aktywne rozkłady</span>
          <span className="stat-value">{activeSchedules}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Ostatnie zdarzenia</span>
          <span className="stat-value">{totalTrips}</span>
        </div>
      </div>

      <div className="chart-container">
        <h2>Liczba pasażerów (ostatnie 100 zdarzeń) – {selectedVehicle}</h2>
        {passengerHistory.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={passengerHistory}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="passengers" stroke="#3b82f6" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p>Brak danych dla wybranego pojazdu.</p>
        )}
      </div>

      <div className="recent-trips">
        <h2>Ostatnie zdarzenia</h2>
        <table>
          <thead>
            <tr>
              <th>Czas</th>
              <th>Pojazd</th>
              <th>Linia</th>
              <th>Przystanek</th>
              <th>Pasażerowie</th>
              <th>Opóźnienie</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {recentTrips.slice(0, 10).map(trip => (
              <tr key={trip.id}>
                <td>{trip.received_at ? new Date(trip.received_at).toLocaleString() : trip.timestamp}</td>
                <td>{trip.pcName}</td>
                <td>{trip.line_id}</td>
                <td>{trip.stop_name || trip.stop_id}</td>
                <td>{trip.passenger_events || 0}</td>
                <td>{trip.delay_seconds !== null ? trip.delay_seconds + ' s' : '—'}</td>
                <td>{trip.punctuality_status || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Dashboard;