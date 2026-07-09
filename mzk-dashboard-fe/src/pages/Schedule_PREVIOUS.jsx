
import React, { useState, useEffect, useCallback } from 'react';
import { useBackend } from '../context/BackendContext';
import {
  CalendarClock,
  Plus,
  Pencil,
  Trash2,
  Save,
  RotateCcw,
  LoaderCircle,
  AlertCircle,
  ChevronDown,
  BusFront,
  Route,
  CircleCheck,
  CircleX,
  Clock3,
  MapPinned,
  Layers3,
  ListOrdered,
  ArrowRightLeft,
  ArrowUpDown,
  Copy,
  MapPin,
  Truck,
} from 'lucide-react';
import styles from './Schedule.module.css';

// Stałe dla rozkładów
const DAY_TYPE_LABELS = {
  weekday: 'Dzień powszedni',
  weekend: 'Weekend',
  holiday: 'Święto',
};

const DIRECTION_LABELS = {
  outbound: 'Tam',
  inbound: 'Z powrotem',
};

// Pusty formularz rozkładu
const createEmptyScheduleForm = () => ({
  name: '',
  day_types: {
    weekday: { outbound: [], inbound: [] },
    weekend: { outbound: [], inbound: [] },
    holiday: { outbound: [], inbound: [] },
  },
});

// Pusty formularz przystanku
const createEmptyStopForm = () => ({
  id: '',
  name: '',
  latitude: '',
  longitude: '',
});

/**
 * Funkcja normalizująca czas do formatu HH:MM.
 *
 * Naprawiona wersja: zamiast polegać na sztywnym `substring(0, 5)` + regex
 * (co psuło się np. dla zdegenerowanych wartości typu "11:11:01:00" i
 * zwracało wtedy domyślne "00:00" albo przepuszczało śmieci dalej),
 * dzielimy string po dwukropku i zawsze bierzemy tylko pierwsze dwa
 * segmenty (godziny i minuty), niezależnie od tego, ile dodatkowych
 * fragmentów (sekundy, milisekundy, powielone dane) znajduje się dalej.
 */
const normalizeTime = (time) => {
  if (time === null || time === undefined || time === '') return '00:00';

  const raw = String(time).trim();
  const parts = raw.split(':');

  if (parts.length < 2) return '00:00';

  const hoursRaw = parts[0];
  const minutesRaw = parts[1];

  const hours = parseInt(hoursRaw, 10);
  const minutes = parseInt(minutesRaw, 10);

  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return '00:00';
  }

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${hh}:${mm}`;
};

const Schedule = () => {
  const { api } = useBackend();

  // Zakładki
  const [activeTab, setActiveTab] = useState('stops'); // 'stops', 'schedules', 'vehicles'

  // ---------- PRZYSTANKI ----------
  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopForm, setStopForm] = useState(createEmptyStopForm());
  const [editingStop, setEditingStop] = useState(null);

  // ---------- ROZKŁADY ----------
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [scheduleForm, setScheduleForm] = useState(createEmptyScheduleForm());
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [selectedDayType, setSelectedDayType] = useState('weekday');
  const [selectedDirection, setSelectedDirection] = useState('outbound');
  const [savingSchedule, setSavingSchedule] = useState(false);

  // ---------- POJAZDY ----------
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  // ---------- WSPÓLNE ----------
  const [error, setError] = useState(null);

  // ---------- FUNKCJE WSPÓLNE ----------
  const loadAll = useCallback(async () => {
    try {
      setError(null);
      await Promise.all([loadStops(), loadSchedules(), loadVehicles()]);
    } catch (err) {
      setError(err.message || 'Nie udało się załadować danych.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- PRZYSTANKI ----------
  const loadStops = useCallback(async () => {
    setStopsLoading(true);
    try {
      const data = await api.getStops();
      setStops(data.stops || []);
    } catch (err) {
      setError(err.message || 'Błąd ładowania przystanków.');
    } finally {
      setStopsLoading(false);
    }
  }, [api]);

  const resetStopForm = () => {
    setEditingStop(null);
    setStopForm(createEmptyStopForm());
  };

  const handleEditStop = (stop) => {
    setEditingStop(stop);
    setStopForm({
      id: stop.id,
      name: stop.name,
      latitude: stop.latitude !== undefined ? String(stop.latitude) : '',
      longitude: stop.longitude !== undefined ? String(stop.longitude) : '',
    });
  };

  const handleDeleteStop = async (id) => {
    if (!window.confirm(`Czy na pewno usunąć przystanek ${id}?`)) return;
    try {
      await api.deleteStop(id);
      await loadStops();
      if (editingStop?.id === id) resetStopForm();
    } catch (err) {
      window.alert(`Błąd usuwania: ${err.message}`);
    }
  };

  const handleSubmitStop = async (e) => {
    e.preventDefault();
    try {
      const payload = {
        id: stopForm.id.trim(),
        name: stopForm.name.trim(),
        latitude: parseFloat(stopForm.latitude),
        longitude: parseFloat(stopForm.longitude),
      };
      if (isNaN(payload.latitude) || isNaN(payload.longitude)) {
        throw new Error('Współrzędne muszą być liczbami.');
      }
      if (editingStop) {
        await api.updateStop(editingStop.id, payload);
      } else {
        await api.createStop(payload);
      }
      resetStopForm();
      await loadStops();
    } catch (err) {
      window.alert(`Błąd zapisu przystanku: ${err.message}`);
    }
  };

  const updateStopField = (field, value) => {
    setStopForm((prev) => ({ ...prev, [field]: value }));
  };

  // ---------- ROZKŁADY ----------
  const loadSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    try {
      const data = await api.getSchedules();
      setSchedules(data.schedules || []);
    } catch (err) {
      setError(err.message || 'Błąd ładowania rozkładów.');
    } finally {
      setSchedulesLoading(false);
    }
  }, [api]);

  const resetScheduleForm = () => {
    setEditingSchedule(null);
    setScheduleForm(createEmptyScheduleForm());
    setSelectedDayType('weekday');
    setSelectedDirection('outbound');
  };

  const handleEditSchedule = (schedule) => {
    setEditingSchedule(schedule);
    const dayTypes = {};
    ['weekday', 'weekend', 'holiday'].forEach((day) => {
      const dayData = schedule.day_types?.[day] || { outbound: [], inbound: [] };
      dayTypes[day] = {
        outbound: (dayData.outbound || []).map((item) => ({
          ...item,
          planned_time: normalizeTime(item.planned_time),
        })),
        inbound: (dayData.inbound || []).map((item) => ({
          ...item,
          planned_time: normalizeTime(item.planned_time),
        })),
      };
    });
    setScheduleForm({
      name: schedule.name || '',
      day_types: dayTypes,
    });
    setSelectedDayType('weekday');
    setSelectedDirection('outbound');
  };

  const handleDeleteSchedule = async (id) => {
    if (!window.confirm(`Czy na pewno usunąć rozkład ${id}?`)) return;
    try {
      await api.deleteSchedule(id);
      await loadSchedules();
      if (editingSchedule?.schedule_id === id) resetScheduleForm();
    } catch (err) {
      window.alert(`Błąd usuwania: ${err.message}`);
    }
  };

  // Przed wysłaniem normalizujemy wszystkie czasy w całym formularzu
  const handleSubmitSchedule = async (e) => {
    e.preventDefault();
    setSavingSchedule(true);
    try {
      // Normalizuj wszystkie czasy przed wysłaniem (odporne na "śmieciowe" wartości)
      // UWAGA: backend (endpoints.js) oczekuje pola "time", a nie "planned_time",
      // dlatego przy budowaniu payloadu mapujemy klucz na wyjściu.
      const normalizedDayTypes = {};
      Object.keys(scheduleForm.day_types).forEach((day) => {
        const dayData = scheduleForm.day_types[day];
        normalizedDayTypes[day] = {
          outbound: (dayData.outbound || []).map((item) => ({
            stop_id: item.stop_id,
            time: normalizeTime(item.planned_time),
          })),
          inbound: (dayData.inbound || []).map((item) => ({
            stop_id: item.stop_id,
            time: normalizeTime(item.planned_time),
          })),
        };
      });

      const payload = {
        name: scheduleForm.name.trim(),
        day_types: normalizedDayTypes,
      };

      if (editingSchedule) {
        await api.updateSchedule(editingSchedule.schedule_id, payload);
      } else {
        await api.createSchedule(payload);
      }
      resetScheduleForm();
      await loadSchedules();
    } catch (err) {
      window.alert(`Błąd zapisu rozkładu: ${err.message}`);
    } finally {
      setSavingSchedule(false);
    }
  };

  // Funkcje do modyfikacji sekwencji
  const getCurrentSequence = () => {
    return scheduleForm.day_types[selectedDayType]?.[selectedDirection] || [];
  };

  const addStopToSequence = () => {
    setScheduleForm((prev) => {
      const newDay = { ...prev.day_types[selectedDayType] };
      newDay[selectedDirection] = [
        ...(newDay[selectedDirection] || []),
        { stop_id: '', planned_time: '00:00' },
      ];
      return {
        ...prev,
        day_types: {
          ...prev.day_types,
          [selectedDayType]: newDay,
        },
      };
    });
  };

  const removeStopFromSequence = (index) => {
    setScheduleForm((prev) => {
      const newDay = { ...prev.day_types[selectedDayType] };
      newDay[selectedDirection] = (newDay[selectedDirection] || []).filter(
        (_, idx) => idx !== index
      );
      return {
        ...prev,
        day_types: {
          ...prev.day_types,
          [selectedDayType]: newDay,
        },
      };
    });
  };

  const updateStopInSequence = (index, field, value) => {
    setScheduleForm((prev) => {
      const newDay = { ...prev.day_types[selectedDayType] };
      newDay[selectedDirection] = (newDay[selectedDirection] || []).map(
        (item, idx) => {
          if (idx === index) {
            // Jeśli aktualizujemy czas, zawsze normalizujemy go do HH:MM
            if (field === 'planned_time') {
              return { ...item, planned_time: normalizeTime(value) };
            }
            return { ...item, [field]: value };
          }
          return item;
        }
      );
      return {
        ...prev,
        day_types: {
          ...prev.day_types,
          [selectedDayType]: newDay,
        },
      };
    });
  };

  const moveStopUp = (index) => {
    if (index === 0) return;
    setScheduleForm((prev) => {
      const newDay = { ...prev.day_types[selectedDayType] };
      const seq = newDay[selectedDirection] || [];
      const swapped = [...seq];
      [swapped[index - 1], swapped[index]] = [swapped[index], swapped[index - 1]];
      newDay[selectedDirection] = swapped;
      return {
        ...prev,
        day_types: {
          ...prev.day_types,
          [selectedDayType]: newDay,
        },
      };
    });
  };

  const moveStopDown = (index) => {
    const seq = getCurrentSequence();
    if (index >= seq.length - 1) return;
    setScheduleForm((prev) => {
      const newDay = { ...prev.day_types[selectedDayType] };
      const swapped = [...seq];
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      newDay[selectedDirection] = swapped;
      return {
        ...prev,
        day_types: {
          ...prev.day_types,
          [selectedDayType]: newDay,
        },
      };
    });
  };

  // Kopiowanie kierunku (lokalne)
  const handleCopyDirection = () => {
    const source = window.prompt(
      `Podaj kierunek źródłowy (outbound lub inbound) do skopiowania:`,
      'outbound'
    );
    if (!source || !['outbound', 'inbound'].includes(source)) {
      window.alert('Nieprawidłowy kierunek źródłowy.');
      return;
    }
    const target = window.prompt(
      `Podaj kierunek docelowy (outbound lub inbound):`,
      'inbound'
    );
    if (!target || !['outbound', 'inbound'].includes(target)) {
      window.alert('Nieprawidłowy kierunek docelowy.');
      return;
    }
    if (source === target) {
      window.alert('Kierunek źródłowy i docelowy muszą być różne.');
      return;
    }
    const reverse = window.confirm(
      `Czy chcesz odwrócić kolejność przystanków podczas kopiowania?`
    );

    setScheduleForm((prev) => {
      const newDayTypes = { ...prev.day_types };
      Object.keys(newDayTypes).forEach((day) => {
        const dayData = { ...newDayTypes[day] };
        const sourceList = dayData[source] || [];
        let targetList = sourceList.map((item) => ({
          ...item,
          planned_time: normalizeTime(item.planned_time),
        }));
        if (reverse) {
          targetList = targetList.slice().reverse();
        }
        dayData[target] = targetList;
        newDayTypes[day] = dayData;
      });
      return {
        ...prev,
        day_types: newDayTypes,
      };
    });
  };

  // ---------- POJAZDY ----------
  const loadVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    try {
      const data = await api.getVehicles();
      setVehicles(data.vehicles || []);
    } catch (err) {
      setError(err.message || 'Błąd ładowania pojazdów.');
    } finally {
      setVehiclesLoading(false);
    }
  }, [api]);

  const handleUpdateVehicleSchedule = async (pcName, scheduleId) => {
    try {
      await api.updateVehicle(pcName, { schedule_id: scheduleId || '' });
      await loadVehicles();
    } catch (err) {
      window.alert(`Błąd aktualizacji pojazdu: ${err.message}`);
    }
  };

  // ---------- EFEKT ----------
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // ---------- RENDER ----------
  if (error && !stops.length && !schedules.length && !vehicles.length) {
    return (
      <section className={styles.pageShell}>
        <div className={styles.stateCard}>
          <AlertCircle className={styles.stateIconError} />
          <div>
            <h2 className={styles.stateTitle}>Błąd ładowania</h2>
            <p className={styles.stateText}>{error}</p>
            <button onClick={loadAll} className={styles.primaryButton}>
              Spróbuj ponownie
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.pageShell}>
      <div className={styles.page}>
        <header className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>Zarządzanie infrastrukturą</p>
            <h1 className={styles.title}>Konfiguracja rozkładów</h1>
            <p className={styles.subtitle}>
              Zarządzaj przystankami, rozkładami i przypisuj je do pojazdów.
            </p>
          </div>
        </header>

        {/* Zakładki główne */}
        <div className={styles.mainTabs}>
          <button
            className={`${styles.mainTab} ${activeTab === 'stops' ? styles.mainTabActive : ''}`}
            onClick={() => setActiveTab('stops')}
          >
            <MapPin className={styles.mainTabIcon} />
            Przystanki
          </button>
          <button
            className={`${styles.mainTab} ${activeTab === 'schedules' ? styles.mainTabActive : ''}`}
            onClick={() => setActiveTab('schedules')}
          >
            <CalendarClock className={styles.mainTabIcon} />
            Rozkłady
          </button>
          <button
            className={`${styles.mainTab} ${activeTab === 'vehicles' ? styles.mainTabActive : ''}`}
            onClick={() => setActiveTab('vehicles')}
          >
            <Truck className={styles.mainTabIcon} />
            Pojazdy
          </button>
        </div>

        {/* ZAWARTOŚĆ ZAKŁADKI PRZYSTANKI */}
        {activeTab === 'stops' && (
          <div className={styles.contentGrid}>
            <section className={styles.formCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>
                    {editingStop ? 'Edytuj przystanek' : 'Dodaj nowy przystanek'}
                  </h2>
                  <p className={styles.sectionText}>
                    Wprowadź unikalne ID, nazwę oraz współrzędne geograficzne.
                  </p>
                </div>
              </div>
              <form onSubmit={handleSubmitStop} className={styles.form}>
                <div className={styles.formGrid}>
                  <div className={styles.field}>
                    <label htmlFor="stopId" className={styles.label}>ID przystanku</label>
                    <input
                      id="stopId"
                      type="text"
                      className={styles.input}
                      value={stopForm.id}
                      onChange={(e) => updateStopField('id', e.target.value)}
                      required
                      disabled={!!editingStop}
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="stopName" className={styles.label}>Nazwa</label>
                    <input
                      id="stopName"
                      type="text"
                      className={styles.input}
                      value={stopForm.name}
                      onChange={(e) => updateStopField('name', e.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="stopLat" className={styles.label}>Szerokość geograficzna</label>
                    <input
                      id="stopLat"
                      type="number"
                      step="any"
                      className={styles.input}
                      value={stopForm.latitude}
                      onChange={(e) => updateStopField('latitude', e.target.value)}
                      required
                    />
                  </div>
                  <div className={styles.field}>
                    <label htmlFor="stopLng" className={styles.label}>Długość geograficzna</label>
                    <input
                      id="stopLng"
                      type="number"
                      step="any"
                      className={styles.input}
                      value={stopForm.longitude}
                      onChange={(e) => updateStopField('longitude', e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className={styles.formActions}>
                  <button type="submit" className={styles.primaryButton}>
                    <Save className={styles.buttonIcon} />
                    {editingStop ? 'Zapisz zmiany' : 'Dodaj przystanek'}
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={resetStopForm}>
                    <RotateCcw className={styles.buttonIcon} />
                    Anuluj
                  </button>
                </div>
              </form>
            </section>

            <section className={styles.listCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>Lista przystanków</h2>
                  <p className={styles.sectionText}>
                    {stops.length} przystanków w bazie.
                  </p>
                </div>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>ID</th><th>Nazwa</th><th>Szerokość</th><th>Długość</th><th>Akcje</th></tr>
                  </thead>
                  <tbody>
                    {stops.length === 0 ? (
                      <tr><td colSpan="5"><div className={styles.emptyTable}>Brak przystanków.</div></td></tr>
                    ) : (
                      stops.map((stop) => (
                        <tr key={stop.id}>
                          <td>{stop.id}</td>
                          <td>{stop.name}</td>
                          <td>{stop.latitude}</td>
                          <td>{stop.longitude}</td>
                          <td>
                            <div className={styles.tableActions}>
                              <button className={styles.iconButton} onClick={() => handleEditStop(stop)}>
                                <Pencil className={styles.buttonIcon} />
                              </button>
                              <button className={styles.iconButtonDanger} onClick={() => handleDeleteStop(stop.id)}>
                                <Trash2 className={styles.buttonIcon} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ZAWARTOŚĆ ZAKŁADKI ROZKŁADY */}
        {activeTab === 'schedules' && (
          <div className={styles.contentGrid}>
            <section className={styles.formCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>
                    {editingSchedule ? 'Edytuj rozkład' : 'Dodaj nowy rozkład'}
                  </h2>
                  <p className={styles.sectionText}>
                    Podaj nazwę, a następnie dla każdego dnia i kierunku zdefiniuj sekwencję przystanków.
                  </p>
                </div>
              </div>
              <form onSubmit={handleSubmitSchedule} className={styles.form}>
                <div className={styles.field}>
                  <label htmlFor="scheduleName" className={styles.label}>Nazwa rozkładu</label>
                  <input
                    id="scheduleName"
                    type="text"
                    className={styles.input}
                    value={scheduleForm.name}
                    onChange={(e) => setScheduleForm((prev) => ({ ...prev, name: e.target.value }))}
                    required
                  />
                </div>

                {/* Zakładki dni */}
                <div className={styles.dayTabs}>
                  {Object.keys(DAY_TYPE_LABELS).map((day) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => setSelectedDayType(day)}
                      className={selectedDayType === day ? `${styles.dayTab} ${styles.dayTabActive}` : styles.dayTab}
                    >
                      <CalendarClock className={styles.dayTabIcon} />
                      {DAY_TYPE_LABELS[day]}
                    </button>
                  ))}
                </div>

                {/* Zakładki kierunków */}
                <div className={styles.directionTabs}>
                  {Object.keys(DIRECTION_LABELS).map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      onClick={() => setSelectedDirection(dir)}
                      className={selectedDirection === dir ? `${styles.directionTab} ${styles.directionTabActive}` : styles.directionTab}
                    >
                      <ArrowRightLeft className={styles.directionTabIcon} />
                      {DIRECTION_LABELS[dir]}
                    </button>
                  ))}
                </div>

                <div className={styles.copyRow}>
                  <button type="button" className={styles.secondaryButton} onClick={handleCopyDirection}>
                    <Copy className={styles.buttonIcon} />
                    Kopiuj z innego kierunku
                  </button>
                  <span className={styles.copyHint}>Skopiuj sekwencję z wybranego kierunku (z opcją odwrócenia)</span>
                </div>

                {/* Sekwencja */}
                <div className={styles.sequenceCard}>
                  <div className={styles.sequenceHeader}>
                    <div>
                      <h3 className={styles.sequenceTitle}>
                        Sekwencja: {DAY_TYPE_LABELS[selectedDayType]} – {DIRECTION_LABELS[selectedDirection]}
                      </h3>
                    </div>
                    <button type="button" className={styles.secondaryButton} onClick={addStopToSequence}>
                      <Plus className={styles.buttonIcon} />
                      Dodaj przystanek
                    </button>
                  </div>
                  <div className={styles.sequenceList}>
                    {getCurrentSequence().length === 0 ? (
                      <div className={styles.emptySequence}>
                        <MapPinned className={styles.emptySequenceIcon} />
                        <p className={styles.emptySequenceTitle}>Brak przystanków</p>
                        <p className={styles.emptySequenceText}>Dodaj pierwszy przystanek.</p>
                      </div>
                    ) : (
                      getCurrentSequence().map((item, idx) => (
                        <div key={`${selectedDayType}-${selectedDirection}-${idx}`} className={styles.sequenceRow}>
                          <div className={styles.sequenceIndex}>
                            <ListOrdered className={styles.sequenceIndexIcon} />
                            <span>{idx + 1}</span>
                          </div>
                          <div className={styles.sequenceFieldWide}>
                            <div className={styles.selectWrap}>
                              <select
                                className={styles.select}
                                value={item.stop_id}
                                onChange={(e) => updateStopInSequence(idx, 'stop_id', e.target.value)}
                                required
                              >
                                <option value="">Wybierz przystanek</option>
                                {stops.map((stop) => (
                                  <option key={stop.id} value={stop.id}>
                                    {stop.name} ({stop.id})
                                  </option>
                                ))}
                              </select>
                              <ChevronDown className={styles.selectIcon} />
                            </div>
                          </div>
                          <div className={styles.sequenceField}>
                            <div className={styles.timeWrap}>
                              <Clock3 className={styles.timeIcon} />
                              <input
                                type="time"
                                className={styles.input}
                                value={normalizeTime(item.planned_time)}
                                onChange={(e) =>
                                  updateStopInSequence(idx, 'planned_time', e.target.value)
                                }
                                required
                              />
                            </div>
                          </div>
                          <div className={styles.sequenceMoveButtons}>
                            <button type="button" className={styles.iconButton} onClick={() => moveStopUp(idx)} disabled={idx === 0}>
                              <ArrowUpDown className={styles.buttonIcon} />
                            </button>
                            <button type="button" className={styles.iconButton} onClick={() => moveStopDown(idx)} disabled={idx === getCurrentSequence().length - 1}>
                              <ArrowUpDown className={styles.buttonIcon} style={{ transform: 'rotate(180deg)' }} />
                            </button>
                          </div>
                          <button type="button" className={styles.iconButtonDanger} onClick={() => removeStopFromSequence(idx)}>
                            <Trash2 className={styles.buttonIcon} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className={styles.formActions}>
                  <button type="submit" className={styles.primaryButton} disabled={savingSchedule}>
                    {savingSchedule ? (
                      <><LoaderCircle className={`${styles.buttonIcon} ${styles.spin}`} /> Zapisywanie...</>
                    ) : (
                      <><Save className={styles.buttonIcon} /> {editingSchedule ? 'Zapisz zmiany' : 'Dodaj rozkład'}</>
                    )}
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={resetScheduleForm}>
                    <RotateCcw className={styles.buttonIcon} /> Anuluj
                  </button>
                </div>
              </form>
            </section>

            <section className={styles.listCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>Lista rozkładów</h2>
                  <p className={styles.sectionText}>{schedules.length} rozkładów</p>
                </div>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Nazwa</th><th>ID</th><th>Akcje</th></tr></thead>
                  <tbody>
                    {schedules.length === 0 ? (
                      <tr><td colSpan="3"><div className={styles.emptyTable}>Brak rozkładów.</div></td></tr>
                    ) : (
                      schedules.map((s) => (
                        <tr key={s.schedule_id}>
                          <td>{s.name}</td>
                          <td>{s.schedule_id}</td>
                          <td>
                            <div className={styles.tableActions}>
                              <button className={styles.iconButton} onClick={() => handleEditSchedule(s)}>
                                <Pencil className={styles.buttonIcon} />
                              </button>
                              <button className={styles.iconButtonDanger} onClick={() => handleDeleteSchedule(s.schedule_id)}>
                                <Trash2 className={styles.buttonIcon} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ZAWARTOŚĆ ZAKŁADKI POJAZDY */}
        {activeTab === 'vehicles' && (
          <div className={styles.contentGridSingle}>
            <section className={styles.listCard}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle}>Pojazdy</h2>
                  <p className={styles.sectionText}>
                    Przypisz rozkład do każdego pojazdu.
                  </p>
                </div>
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr><th>Pojazd (pcName)</th><th>Przypisany rozkład</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {vehicles.length === 0 ? (
                      <tr><td colSpan="3"><div className={styles.emptyTable}>Brak pojazdów.</div></td></tr>
                    ) : (
                      vehicles.map((vehicle) => {
                        const currentScheduleId = vehicle.schedule_id || '';
                        return (
                          <tr key={vehicle.pcName}>
                            <td>{vehicle.pcName}</td>
                            <td>
                              <div className={styles.selectWrap} style={{ maxWidth: '300px' }}>
                                <select
                                  className={styles.select}
                                  value={currentScheduleId}
                                  onChange={(e) => handleUpdateVehicleSchedule(vehicle.pcName, e.target.value)}
                                >
                                  <option value="">Brak</option>
                                  {schedules.map((s) => (
                                    <option key={s.schedule_id} value={s.schedule_id}>
                                      {s.name} ({s.schedule_id})
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className={styles.selectIcon} />
                              </div>
                            </td>
                            <td>
                              <span className={currentScheduleId ? styles.statusSuccess : styles.statusDanger}>
                                {currentScheduleId ? (
                                  <><CircleCheck className={styles.statusIcon} /> Przypisany</>
                                ) : (
                                  <><CircleX className={styles.statusIcon} /> Brak</>
                                )}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </section>
  );
};

export default Schedule;