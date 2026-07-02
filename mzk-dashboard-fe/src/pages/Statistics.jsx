import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import './Statistics.css';

const Statistics = () => {
  const { api } = useBackend();
  const [activeTab, setActiveTab] = useState('stop-usage');
  const [filters, setFilters] = useState({
    pcName: '',
    line_id: '',
    start: '',
    end: ''
  });
  const [vehicles, setVehicles] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadVehicles = useCallback(async () => {
    try {
      const vehData = await api.getVehicles();
      setVehicles(vehData.vehicles || []);
    } catch (err) {
      console.error('Błąd ładowania pojazdów:', err);
    }
  }, [api]);

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let result;
      const params = {};
      if (filters.pcName) params.pcName = filters.pcName;
      if (filters.line_id) params.line_id = filters.line_id;
      if (filters.start) params.start = filters.start;
      if (filters.end) params.end = filters.end;

      switch (activeTab) {
        case 'stop-usage':
          result = await api.getStopUsage(params);
          break;
        case 'on-demand':
          result = await api.getOnDemandStops(params);
          break;
        case 'line-performance':
          result = await api.getLinePerformance(params);
          break;
        case 'admin-zone':
          result = await api.getAdminZone(params);
          break;
        default:
          result = { rows: [] };
      }
      setData(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeTab, filters, api]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const renderTable = (rows, columns) => {
    if (!rows || rows.length === 0) return <p>Brak danych.</p>;
    return (
      <table>
        <thead>
          <tr>
            {columns.map(col => <th key={col.key}>{col.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx}>
              {columns.map(col => <td key={col.key}>{row[col.key] !== undefined ? row[col.key] : '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderContent = () => {
    if (loading) return <div className="loading">Ładowanie raportu...</div>;
    if (error) return <div className="error">Błąd: {error}</div>;
    if (!data) return <p>Brak danych.</p>;

    const rows = data.rows || [];

    switch (activeTab) {
      case 'stop-usage':
        return (
          <div>
            <h3>Wykorzystanie przystanków</h3>
            {rows.length > 0 && (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={rows.slice(0, 20)}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="total_passenger_events" fill="#3b82f6" name="Pasażerowie" />
                </BarChart>
              </ResponsiveContainer>
            )}
            {renderTable(rows, [
              { key: 'stop_id', label: 'ID' },
              { key: 'name', label: 'Nazwa' },
              { key: 'total_passenger_events', label: 'Pasażerowie' },
              { key: 'share_of_all_passengers_percent', label: '% udziału' },
              { key: 'event_count', label: 'Zdarzenia' },
              { key: 'course_count', label: 'Kursy' }
            ])}
          </div>
        );
      case 'on-demand':
        return (
          <div>
            <h3>Przystanki na żądanie</h3>
            {renderTable(rows, [
              { key: 'stop_id', label: 'ID' },
              { key: 'name', label: 'Nazwa' },
              { key: 'courses_total', label: 'Kursy ogółem' },
              { key: 'courses_with_passengers', label: 'Kursy z pasażerami' },
              { key: 'percent_courses_with_passengers', label: '% kursów z pasażerami' },
              { key: 'suggested_status', label: 'Sugerowany status' }
            ])}
          </div>
        );
      case 'line-performance':
        return (
          <div>
            <h3>Wydajność linii</h3>
            {renderTable(rows, [
              { key: 'line_id', label: 'Linia' },
              { key: 'pcName', label: 'Pojazd' },
              { key: 'total_passenger_events', label: 'Pasażerowie' },
              { key: 'average_delay_seconds', label: 'Śr. opóźnienie [s]' },
              { key: 'on_time_percent', label: '% na czas' },
              { key: 'delayed_percent', label: '% opóźnionych' },
              { key: 'early_percent', label: '% za szybko' }
            ])}
          </div>
        );
      case 'admin-zone':
        return (
          <div>
            <h3>Strefy administracyjne</h3>
            {renderTable(rows, [
              { key: 'line_id', label: 'Linia' },
              { key: 'day_type', label: 'Typ dnia' },
              { key: 'admin_zone', label: 'Strefa' },
              { key: 'total_passenger_events', label: 'Pasażerowie' },
              { key: 'passengers_per_km', label: 'Pasażerów/km' },
              { key: 'course_count', label: 'Kursy' }
            ])}
          </div>
        );
      default:
        return <p>Nieznany raport.</p>;
    }
  };

  return (
    <div className="statistics">
      <h1>📈 Statystyki i raporty</h1>
      <div className="tabs">
        <button className={activeTab === 'stop-usage' ? 'active' : ''} onClick={() => setActiveTab('stop-usage')}>Wykorzystanie przystanków</button>
        <button className={activeTab === 'on-demand' ? 'active' : ''} onClick={() => setActiveTab('on-demand')}>Przystanki na żądanie</button>
        <button className={activeTab === 'line-performance' ? 'active' : ''} onClick={() => setActiveTab('line-performance')}>Wydajność linii</button>
        <button className={activeTab === 'admin-zone' ? 'active' : ''} onClick={() => setActiveTab('admin-zone')}>Strefy administracyjne</button>
      </div>

      <div className="filters">
        <div className="filter-group">
          <label>Pojazd:</label>
          <select name="pcName" value={filters.pcName} onChange={handleFilterChange}>
            <option value="">Wszystkie</option>
            {vehicles.map(v => <option key={v.pcName} value={v.pcName}>{v.pcName}</option>)}
          </select>
        </div>
        <div className="filter-group">
          <label>Linia:</label>
          <input type="text" name="line_id" value={filters.line_id} onChange={handleFilterChange} placeholder="np. 6" />
        </div>
        <div className="filter-group">
          <label>Data od:</label>
          <input type="date" name="start" value={filters.start} onChange={handleFilterChange} />
        </div>
        <div className="filter-group">
          <label>Data do:</label>
          <input type="date" name="end" value={filters.end} onChange={handleFilterChange} />
        </div>
        <button onClick={fetchReport}>Filtruj</button>
      </div>

      <div className="report-content">
        {renderContent()}
      </div>
    </div>
  );
};

export default Statistics;