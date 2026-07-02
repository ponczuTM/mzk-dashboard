import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import './Schedule.css';

const Schedule = () => {
  const { api } = useBackend();
  const [schedules, setSchedules] = useState([]);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [formData, setFormData] = useState({
    pcName: '',
    line_id: '',
    day_types: {
      weekday: [],
      weekend: [],
      holiday: []
    },
    active: true
  });
  const [selectedDayType, setSelectedDayType] = useState('weekday');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schData, stopsData] = await Promise.all([
        api.getSchedules(),
        api.getStops()
      ]);
      setSchedules(schData.schedules || []);
      setStops(stopsData.stops || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = () => {
    setEditingSchedule(null);
    setFormData({
      pcName: '',
      line_id: '',
      day_types: { weekday: [], weekend: [], holiday: [] },
      active: true
    });
    setSelectedDayType('weekday');
  };

  const handleEdit = (schedule) => {
    setEditingSchedule(schedule);
    setFormData({
      pcName: schedule.pcName || '',
      line_id: schedule.line_id || '',
      day_types: schedule.day_types || { weekday: [], weekend: [], holiday: [] },
      active: schedule.active !== false
    });
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Czy na pewno usunąć ten rozkład?')) return;
    try {
      await api.deleteSchedule(id);
      loadData();
    } catch (err) {
      alert('Błąd usuwania: ' + err.message);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        pcName: formData.pcName,
        line_id: formData.line_id,
        day_types: formData.day_types,
        active: formData.active
      };
      if (editingSchedule) {
        await api.updateSchedule(editingSchedule.schedule_id, payload);
      } else {
        await api.createSchedule(payload);
      }
      resetForm();
      loadData();
    } catch (err) {
      alert('Błąd zapisu: ' + err.message);
    }
  };

  const addStopToSequence = () => {
    const sequence = formData.day_types[selectedDayType] || [];
    sequence.push({ stop_id: '', planned_time: '00:00:00' });
    setFormData({
      ...formData,
      day_types: { ...formData.day_types, [selectedDayType]: sequence }
    });
  };

  const removeStopFromSequence = (index) => {
    const sequence = formData.day_types[selectedDayType] || [];
    sequence.splice(index, 1);
    setFormData({
      ...formData,
      day_types: { ...formData.day_types, [selectedDayType]: sequence }
    });
  };

  const updateStopInSequence = (index, field, value) => {
    const sequence = formData.day_types[selectedDayType] || [];
    sequence[index][field] = value;
    setFormData({
      ...formData,
      day_types: { ...formData.day_types, [selectedDayType]: sequence }
    });
  };

  if (loading) return <div className="loading">Ładowanie...</div>;
  if (error) return <div className="error">Błąd: {error}</div>;

  return (
    <div className="schedule">
      <h1>📅 Zarządzanie rozkładami</h1>
      <div className="schedule-form">
        <h2>{editingSchedule ? 'Edytuj rozkład' : 'Dodaj nowy rozkład'}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <label>Pojazd (pcName):</label>
            <input type="text" value={formData.pcName} onChange={e => setFormData({...formData, pcName: e.target.value})} required />
          </div>
          <div className="form-row">
            <label>Linia:</label>
            <input type="text" value={formData.line_id} onChange={e => setFormData({...formData, line_id: e.target.value})} required />
          </div>
          <div className="form-row">
            <label>Aktywny:</label>
            <input type="checkbox" checked={formData.active} onChange={e => setFormData({...formData, active: e.target.checked})} />
          </div>

          <div className="day-type-selector">
            {['weekday', 'weekend', 'holiday'].map(dt => (
              <button key={dt} type="button" className={selectedDayType === dt ? 'active' : ''} onClick={() => setSelectedDayType(dt)}>
                {dt === 'weekday' ? 'Dzień powszedni' : dt === 'weekend' ? 'Weekend' : 'Święto'}
              </button>
            ))}
          </div>

          <div className="sequence-editor">
            <h4>Sekwencja przystanków dla {selectedDayType}</h4>
            {(formData.day_types[selectedDayType] || []).map((item, idx) => (
              <div key={idx} className="sequence-row">
                <select value={item.stop_id} onChange={e => updateStopInSequence(idx, 'stop_id', e.target.value)} required>
                  <option value="">Wybierz przystanek</option>
                  {stops.map(s => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
                </select>
                <input type="time" step="1" value={item.planned_time ? item.planned_time.substring(0,5) : ''} onChange={e => updateStopInSequence(idx, 'planned_time', e.target.value + ':00')} required />
                <button type="button" onClick={() => removeStopFromSequence(idx)}>🗑️</button>
              </div>
            ))}
            <button type="button" onClick={addStopToSequence}>➕ Dodaj przystanek</button>
          </div>

          <div className="form-actions">
            <button type="submit">{editingSchedule ? 'Zapisz zmiany' : 'Dodaj rozkład'}</button>
            <button type="button" onClick={resetForm}>Anuluj</button>
          </div>
        </form>
      </div>

      <div className="schedule-list">
        <h2>Lista rozkładów</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Pojazd</th>
              <th>Linia</th>
              <th>Aktywny</th>
              <th>Akcje</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map(sch => (
              <tr key={sch.schedule_id}>
                <td>{sch.schedule_id}</td>
                <td>{sch.pcName}</td>
                <td>{sch.line_id}</td>
                <td>{sch.active ? '✅' : '❌'}</td>
                <td>
                  <button onClick={() => handleEdit(sch)}>✏️</button>
                  <button onClick={() => handleDelete(sch.schedule_id)}>🗑️</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default Schedule;