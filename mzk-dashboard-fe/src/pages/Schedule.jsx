import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
  Route as RouteIcon,
  Clock3,
  MapPinned,
  ListOrdered,
  ArrowUpDown,
  Copy,
  MapPin,
  Truck,
  Sparkles,
  Radio,
  CircleCheck,
  CircleSlash,
} from 'lucide-react';
import styles from './Schedule.module.css';

const DAY_TYPES = [
  { key: 'WEEKDAY', label: 'Dzień powszedni' },
  { key: 'WEEKEND', label: 'Weekend' },
  { key: 'HOLIDAY', label: 'Święto' },
];

const DIRECTION_LABELS = {
  FROM_START: 'Tam (od pętli)',
  TO_START: 'Powrót (do pętli)',
};

const createEmptyStopForm = () => ({
  id: '',
  name: '',
  latitude: '',
  longitude: '',
});

const createEmptyScheduleForm = () => ({
  name: '',
  direction: 'FROM_START',
  is_extended: false,
});

const normalizeTimeHHMM = (time) => {
  if (time === null || time === undefined || time === '') return '00:00';
  const parts = String(time).trim().split(':');
  if (parts.length < 2) return '00:00';
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
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
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const minutesFromTime = (time) => {
  const [h, m] = normalizeTimeHHMM(time).split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
};

const timeFromMinutes = (totalMinutes) => {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.floor(wrapped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const formatSeen = (value) => {
  if (!value) return 'nigdy';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return `${diffSec} s temu`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min temu`;
  return date.toLocaleString('pl-PL', { dateStyle: 'short', timeStyle: 'short' });
};

const Schedule = () => {
  const { api } = useBackend();

  const [activeTab, setActiveTab] = useState('schedules');
  const [error, setError] = useState(null);

  // ---------- PRZYSTANKI ----------
  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopForm, setStopForm] = useState(createEmptyStopForm());
  const [editingStop, setEditingStop] = useState(null);

  // ---------- ROZKŁADY ----------
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [scheduleForm, setScheduleForm] = useState(createEmptyScheduleForm());
  const [editingScheduleId, setEditingScheduleId] = useState(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // ---------- PRZYSTANKI NA ROZKŁADZIE ----------
  const [routeStops, setRouteStops] = useState([]);
  const [routeStopsLoading, setRouteStopsLoading] = useState(false);
  const [savingRouteStops, setSavingRouteStops] = useState(false);
  const [addStopId, setAddStopId] = useState('');

  // ---------- KURSY ----------
  const [selectedDayType, setSelectedDayType] = useState('WEEKDAY');
  const [scheduleTrips, setScheduleTrips] = useState([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [newDepartureTime, setNewDepartureTime] = useState('08:00');
  const [addingTrip, setAddingTrip] = useState(false);

  // ---------- PODGLĄD PASAŻERA ----------
  const [previewStop, setPreviewStop] = useState(null);

  // ---------- POJAZDY ----------
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  // =================== ŁADOWANIE ===================
  const loadStops = useCallback(async () => {
    setStopsLoading(true);
    try {
      const data = await api.getStops();
      setStops(data.stops || []);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać przystanków.');
    } finally {
      setStopsLoading(false);
    }
  }, [api]);

  const loadSchedules = useCallback(async () => {
    setSchedulesLoading(true);
    try {
      const data = await api.listSchedules();
      setSchedules(data.schedules || []);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać rozkładów.');
    } finally {
      setSchedulesLoading(false);
    }
  }, [api]);

  const loadRouteStops = useCallback(
    async (scheduleId) => {
      if (!scheduleId) {
        setRouteStops([]);
        return;
      }
      setRouteStopsLoading(true);
      try {
        const data = await api.getRouteStops(scheduleId);
        const sorted = (data.stops || [])
          .slice()
          .sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0))
          .map((s) => ({
            stop_id: s.stop_id,
            stop_name: s.stop_name || '',
            travel_time_from_start:
              s.travel_time_from_start === undefined ||
              s.travel_time_from_start === null
                ? 0
                : Number(s.travel_time_from_start),
          }));
        setRouteStops(sorted);
      } catch (err) {
        setError(err.message || 'Nie udało się pobrać przystanków rozkładu.');
      } finally {
        setRouteStopsLoading(false);
      }
    },
    [api]
  );

  const loadScheduleTrips = useCallback(
    async (scheduleId, dayType) => {
      if (!scheduleId) {
        setScheduleTrips([]);
        return;
      }
      setTripsLoading(true);
      try {
        const data = await api.getScheduleTrips({
          route_id: scheduleId,
          day_type: dayType,
        });
        const sorted = (data.trips || [])
          .slice()
          .sort((a, b) =>
            String(a.departure_time).localeCompare(String(b.departure_time))
          );
        setScheduleTrips(sorted);
      } catch (err) {
        setError(err.message || 'Nie udało się pobrać kursów.');
      } finally {
        setTripsLoading(false);
      }
    },
    [api]
  );

  const loadVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    try {
      const data = await api.getVehicles();
      setVehicles(data.vehicles || []);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać pojazdów.');
    } finally {
      setVehiclesLoading(false);
    }
  }, [api]);

  useEffect(() => {
    setError(null);
    loadStops();
    loadSchedules();
    loadVehicles();
  }, [loadStops, loadSchedules, loadVehicles]);

  useEffect(() => {
    if (selectedScheduleId) {
      loadRouteStops(selectedScheduleId);
      loadScheduleTrips(selectedScheduleId, selectedDayType);
      setPreviewStop(null);
    } else {
      setRouteStops([]);
      setScheduleTrips([]);
    }
  }, [selectedScheduleId, selectedDayType, loadRouteStops, loadScheduleTrips]);

  const selectedSchedule = useMemo(
    () => schedules.find((s) => s.id === selectedScheduleId) || null,
    [schedules, selectedScheduleId]
  );

  // =================== PRZYSTANKI (CRUD) ===================
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
    if (!window.confirm(`Usunąć przystanek ${id}?`)) return;
    try {
      await api.deleteStop(id);
      await loadStops();
      if (editingStop?.id === id) resetStopForm();
    } catch (err) {
      window.alert(`Nie udało się usunąć: ${err.message}`);
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
      if (Number.isNaN(payload.latitude) || Number.isNaN(payload.longitude)) {
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
      window.alert(`Nie udało się zapisać przystanku: ${err.message}`);
    }
  };

  const updateStopField = (field, value) => {
    setStopForm((prev) => ({ ...prev, [field]: value }));
  };

  // =================== ROZKŁADY ===================
  const resetScheduleForm = () => {
    setEditingScheduleId(null);
    setScheduleForm(createEmptyScheduleForm());
  };

  const handleEditScheduleMeta = (schedule) => {
    setEditingScheduleId(schedule.id);
    setScheduleForm({
      name: schedule.name || '',
      direction: schedule.direction || 'FROM_START',
      is_extended: Boolean(schedule.is_extended),
    });
  };

  const handleSubmitSchedule = async (e) => {
    e.preventDefault();
    if (!scheduleForm.name.trim()) {
      window.alert('Podaj nazwę rozkładu.');
      return;
    }
    setSavingSchedule(true);
    try {
      if (editingScheduleId) {
        await api.updateSchedule(editingScheduleId, {
          name: scheduleForm.name.trim(),
          direction: scheduleForm.direction,
          is_extended: scheduleForm.is_extended,
        });
        await loadSchedules();
      } else {
        const created = await api.createSchedule({
          name: scheduleForm.name.trim(),
          direction: scheduleForm.direction,
          is_extended: scheduleForm.is_extended,
        });
        await loadSchedules();
        if (created?.route?.id) setSelectedScheduleId(created.route.id);
      }
      resetScheduleForm();
    } catch (err) {
      window.alert(`Nie udało się zapisać rozkładu: ${err.message}`);
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleDeleteSchedule = async (id) => {
    if (
      !window.confirm(
        'Usunąć ten rozkład? Skasuje to jego przystanki i wszystkie kursy.'
      )
    )
      return;
    try {
      await api.deleteSchedule(id);
      if (selectedScheduleId === id) setSelectedScheduleId('');
      if (editingScheduleId === id) resetScheduleForm();
      await loadSchedules();
      await loadVehicles();
    } catch (err) {
      window.alert(`Nie udało się usunąć rozkładu: ${err.message}`);
    }
  };

  // =================== PRZYSTANKI NA ROZKŁADZIE ===================
  const availableStopsToAdd = useMemo(() => {
    const used = new Set(routeStops.map((rs) => rs.stop_id));
    return stops.filter((s) => !used.has(s.id));
  }, [stops, routeStops]);

  const handleAddStopToRoute = () => {
    if (!addStopId) return;
    const stop = stops.find((s) => s.id === addStopId);
    if (!stop) return;
    const lastTime =
      routeStops.length > 0
        ? routeStops[routeStops.length - 1].travel_time_from_start
        : 0;
    setRouteStops((prev) => [
      ...prev,
      {
        stop_id: stop.id,
        stop_name: stop.name,
        travel_time_from_start: routeStops.length === 0 ? 0 : lastTime,
      },
    ]);
    setAddStopId('');
    setPreviewStop(null);
  };

  const handleRemoveRouteStop = (index) => {
    setRouteStops((prev) => prev.filter((_, i) => i !== index));
    setPreviewStop(null);
  };

  const handleRouteStopTravelTime = (index, value) => {
    const num = parseInt(value, 10);
    setRouteStops((prev) =>
      prev.map((rs, i) =>
        i === index
          ? { ...rs, travel_time_from_start: Number.isNaN(num) ? 0 : num }
          : rs
      )
    );
    setPreviewStop(null);
  };

  const moveRouteStop = (index, delta) => {
    setRouteStops((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
    setPreviewStop(null);
  };

  const handleSaveRouteStops = async () => {
    if (!selectedScheduleId) return;
    for (const rs of routeStops) {
      if (!rs.stop_id) {
        window.alert('Każdy wiersz musi mieć wybrany przystanek.');
        return;
      }
      if (rs.travel_time_from_start < 0) {
        window.alert('Czas dojazdu nie może być ujemny.');
        return;
      }
    }
    setSavingRouteStops(true);
    try {
      const payload = routeStops.map((rs) => ({
        stop_id: rs.stop_id,
        travel_time_from_start: rs.travel_time_from_start,
      }));
      await api.setRouteStops(selectedScheduleId, payload);
      await loadRouteStops(selectedScheduleId);
      window.alert('Układ rozkładu zapisany.');
    } catch (err) {
      window.alert(`Nie udało się zapisać układu: ${err.message}`);
    } finally {
      setSavingRouteStops(false);
    }
  };

  const handleCopyFromOtherSchedule = async () => {
    if (!selectedScheduleId) return;
    const others = schedules.filter((s) => s.id !== selectedScheduleId);
    if (others.length === 0) {
      window.alert('Brak innego rozkładu do skopiowania.');
      return;
    }
    const list = others
      .map((s, i) => `${i + 1}. ${s.name} [${DIRECTION_LABELS[s.direction]}]`)
      .join('\n');
    const answer = window.prompt(
      `Z którego rozkładu skopiować przystanki? Podaj numer:\n${list}`,
      '1'
    );
    if (!answer) return;
    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= others.length) {
      window.alert('Nieprawidłowy numer.');
      return;
    }
    const source = others[idx];
    const reverse = window.confirm(
      'Odwrócić kolejność i czasy (rozkład powrotny)? OK = tak, Anuluj = kopiuj 1:1.'
    );
    try {
      await api.copyDirection(source.id, {
        target_route_id: selectedScheduleId,
        reverse,
      });
      await loadRouteStops(selectedScheduleId);
      window.alert('Skopiowano przystanki.');
    } catch (err) {
      window.alert(`Nie udało się skopiować: ${err.message}`);
    }
  };

  // =================== KURSY ===================
  const handleAddTrip = async (e) => {
    e.preventDefault();
    if (!selectedScheduleId) {
      window.alert('Najpierw wybierz rozkład.');
      return;
    }
    setAddingTrip(true);
    try {
      await api.createScheduleTrip({
        route_id: selectedScheduleId,
        day_type: selectedDayType,
        departure_time: normalizeTimeHHMM(newDepartureTime),
      });
      await loadScheduleTrips(selectedScheduleId, selectedDayType);
    } catch (err) {
      window.alert(`Nie udało się dodać kursu: ${err.message}`);
    } finally {
      setAddingTrip(false);
    }
  };

  const handleDeleteTrip = async (tripId) => {
    try {
      await api.deleteScheduleTrip(tripId);
      await loadScheduleTrips(selectedScheduleId, selectedDayType);
    } catch (err) {
      window.alert(`Nie udało się usunąć kursu: ${err.message}`);
    }
  };

  // =================== PODGLĄD PASAŻERA ===================
  const previewDepartures = useMemo(() => {
    if (!previewStop) return [];
    const rs = routeStops.find((s) => s.stop_id === previewStop);
    if (!rs) return [];
    return scheduleTrips
      .map((trip) =>
        timeFromMinutes(
          minutesFromTime(trip.departure_time) +
            Number(rs.travel_time_from_start || 0)
        )
      )
      .sort((a, b) => a.localeCompare(b));
  }, [previewStop, routeStops, scheduleTrips]);

  const previewStopName = useMemo(() => {
    const rs = routeStops.find((s) => s.stop_id === previewStop);
    return rs ? rs.stop_name || rs.stop_id : '';
  }, [previewStop, routeStops]);

  // =================== POJAZDY ===================
  const handleUpdateVehicleSchedule = async (pcName, scheduleId) => {
    try {
      await api.updateVehicle(pcName, { route_id: scheduleId || '' });
      await loadVehicles();
    } catch (err) {
      window.alert(`Nie udało się zaktualizować pojazdu: ${err.message}`);
    }
  };

  return (
    <section className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <p className={styles.headerLabel}>Zarządzanie infrastrukturą</p>
          <h1 className={styles.title}>Rozkłady, przystanki i pojazdy</h1>
          <p className={styles.subtitle}>
            Rozkłady jazdy to samodzielne elementy. Definiujesz je tutaj, a w
            zakładce Pojazdy przypisujesz do konkretnego pojazdu, który zgłasza
            się do serwera.
          </p>
        </header>

        {error && (
          <div className={styles.alert}>
            <AlertCircle size={20} className={styles.alertIcon} />
            <span>{error}</span>
          </div>
        )}

        <div className={styles.tabs}>
          {[
            { key: 'schedules', label: 'Rozkłady jazdy', icon: CalendarClock },
            { key: 'stops', label: 'Przystanki', icon: MapPin },
            { key: 'vehicles', label: 'Pojazdy', icon: Truck },
          ].map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`${styles.tab} ${active ? styles.tabActive : styles.tabInactive}`}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ================= ROZKŁADY JAZDY ================= */}
        {activeTab === 'schedules' && (
          <div className={styles.section}>
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>
                    {editingScheduleId ? 'Edytuj rozkład' : 'Nowy rozkład'}
                  </h2>
                  <p className={styles.cardDescription}>
                    Nadaj nazwę, wskaż kierunek i zaznacz, czy to trasa
                    wydłużona.
                  </p>
                </div>
                {editingScheduleId && (
                  <button className={styles.btnSecondary} onClick={resetScheduleForm}>
                    <RotateCcw size={16} />
                    Anuluj edycję
                  </button>
                )}
              </div>

              <form
                onSubmit={handleSubmitSchedule}
                className={styles.formSchedule}
              >
                <div className={styles.formScheduleName}>
                  <label className={styles.label}>Nazwa rozkładu</label>
                  <input
                    className={styles.input}
                    value={scheduleForm.name}
                    onChange={(e) =>
                      setScheduleForm((p) => ({ ...p, name: e.target.value }))
                    }
                    placeholder="np. Dworzec → Lotnisko"
                    required
                  />
                </div>
                <div className={styles.formScheduleDirection}>
                  <label className={styles.label}>Kierunek</label>
                  <div className={styles.selectWrapper}>
                    <select
                      className={styles.select}
                      value={scheduleForm.direction}
                      onChange={(e) =>
                        setScheduleForm((p) => ({
                          ...p,
                          direction: e.target.value,
                        }))
                      }
                    >
                      {Object.entries(DIRECTION_LABELS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} className={styles.selectIcon} />
                  </div>
                </div>
                <div className={styles.formScheduleExtended}>
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      className={styles.checkbox}
                      checked={scheduleForm.is_extended}
                      onChange={(e) =>
                        setScheduleForm((p) => ({
                          ...p,
                          is_extended: e.target.checked,
                        }))
                      }
                    />
                    Wydłużona
                  </label>
                </div>
                <div className={styles.formScheduleSubmit}>
                  <button
                    type="submit"
                    className={styles.btnPrimary}
                    disabled={savingSchedule}
                  >
                    {savingSchedule ? (
                      <LoaderCircle size={16} className={styles.spinner} />
                    ) : (
                      <Save size={16} />
                    )}
                    {editingScheduleId ? 'Zapisz' : 'Utwórz'}
                  </button>
                </div>
              </form>
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Rozkłady</h2>
                  <p className={styles.cardDescription}>
                    Wybierz rozkład, aby edytować jego przystanki i kursy.
                  </p>
                </div>
              </div>

              {schedulesLoading ? (
                <div className={styles.loading}>
                  <LoaderCircle size={16} className={styles.spinner} />
                  Ładowanie rozkładów…
                </div>
              ) : schedules.length === 0 ? (
                <div className={styles.emptyState}>
                  Nie ma jeszcze żadnego rozkładu. Utwórz pierwszy powyżej.
                </div>
              ) : (
                <div className={styles.scheduleList}>
                  {schedules.map((s) => {
                    const active = s.id === selectedScheduleId;
                    return (
                      <div
                        key={s.id}
                        className={`${styles.scheduleItem} ${active ? styles.scheduleItemActive : styles.scheduleItemInactive}`}
                      >
                        <button
                          className={styles.scheduleItemButton}
                          onClick={() => setSelectedScheduleId(s.id)}
                        >
                          <RouteIcon
                            size={16}
                            className={active ? styles.iconActive : styles.iconInactive}
                          />
                          <span className={styles.scheduleName}>{s.name}</span>
                          <span className={styles.scheduleDirection}>
                            {DIRECTION_LABELS[s.direction]}
                          </span>
                          {s.is_extended && (
                            <span className={styles.extendedBadge}>
                              <Sparkles size={12} />
                              Wydłużona
                            </span>
                          )}
                        </button>
                        <button
                          className={styles.btnIcon}
                          onClick={() => handleEditScheduleMeta(s)}
                          title="Zmień nazwę / kierunek"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className={styles.btnIconDanger}
                          onClick={() => handleDeleteSchedule(s.id)}
                          title="Usuń rozkład"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {selectedSchedule && (
              <div className={styles.twoColumn}>
                {/* EDYTOR PRZYSTANKÓW */}
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>
                        <ListOrdered size={20} className={styles.iconPrimary} />
                        Przystanki rozkładu
                      </h2>
                      <p className={styles.cardDescription}>
                        {selectedSchedule.name} ·{' '}
                        {DIRECTION_LABELS[selectedSchedule.direction]}
                        {selectedSchedule.is_extended ? ' · wydłużona' : ''}
                      </p>
                    </div>
                  </div>

                  <div className={styles.buttonGroup}>
                    <button
                      className={styles.btnSecondary}
                      onClick={handleCopyFromOtherSchedule}
                    >
                      <Copy size={16} />
                      Kopiuj z innego rozkładu (z odwróceniem)
                    </button>
                  </div>

                  <div className={styles.addStopRow}>
                    <div className={styles.selectWrapper}>
                      <select
                        className={styles.select}
                        value={addStopId}
                        onChange={(e) => setAddStopId(e.target.value)}
                      >
                        <option value="">— dodaj przystanek —</option>
                        {availableStopsToAdd.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.id})
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} className={styles.selectIcon} />
                    </div>
                    <button
                      className={styles.btnSecondary}
                      onClick={handleAddStopToRoute}
                      disabled={!addStopId}
                    >
                      <Plus size={16} />
                      Dodaj
                    </button>
                  </div>

                  {routeStopsLoading ? (
                    <div className={styles.loading}>
                      <LoaderCircle size={16} className={styles.spinner} />
                      Ładowanie…
                    </div>
                  ) : routeStops.length === 0 ? (
                    <div className={styles.emptyState}>
                      <MapPinned size={32} className={styles.emptyIcon} />
                      <p className={styles.emptyTitle}>Brak przystanków w rozkładzie</p>
                      <p className={styles.emptyDescription}>
                        Dodaj przystanki i zapisz układ.
                      </p>
                    </div>
                  ) : (
                    <ul className={styles.stopList}>
                      {routeStops.map((rs, idx) => (
                        <li
                          key={`${rs.stop_id}-${idx}`}
                          className={styles.stopItem}
                        >
                          <button
                            className={styles.stopIndex}
                            onClick={() => setPreviewStop(rs.stop_id)}
                            title="Podgląd odjazdów"
                          >
                            {idx + 1}
                          </button>
                          <button
                            className={styles.stopInfo}
                            onClick={() => setPreviewStop(rs.stop_id)}
                          >
                            <p className={styles.stopName}>
                              {rs.stop_name || rs.stop_id}
                            </p>
                            <p className={styles.stopId}>{rs.stop_id}</p>
                          </button>
                          <div className={styles.stopTime}>
                            <input
                              type="number"
                              min="0"
                              className={styles.stopTimeInput}
                              value={rs.travel_time_from_start}
                              onChange={(e) =>
                                handleRouteStopTravelTime(idx, e.target.value)
                              }
                              title="Czas dojazdu od pętli (min)"
                            />
                            <span className={styles.stopTimeLabel}>min</span>
                          </div>
                          <div className={styles.stopMove}>
                            <button
                              className={styles.btnIcon}
                              onClick={() => moveRouteStop(idx, -1)}
                              disabled={idx === 0}
                            >
                              <ArrowUpDown size={14} />
                            </button>
                            <button
                              className={styles.btnIcon}
                              onClick={() => moveRouteStop(idx, 1)}
                              disabled={idx === routeStops.length - 1}
                            >
                              <ArrowUpDown size={14} style={{ transform: 'rotate(180deg)' }} />
                            </button>
                          </div>
                          <button
                            className={styles.btnIconDanger}
                            onClick={() => handleRemoveRouteStop(idx)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className={styles.buttonGroup}>
                    <button
                      className={styles.btnPrimary}
                      onClick={handleSaveRouteStops}
                      disabled={savingRouteStops}
                    >
                      {savingRouteStops ? (
                        <>
                          <LoaderCircle size={16} className={styles.spinner} />
                          Zapisywanie…
                        </>
                      ) : (
                        <>
                          <Save size={16} />
                          Zapisz układ rozkładu
                        </>
                      )}
                    </button>
                    <button
                      className={styles.btnSecondary}
                      onClick={() => loadRouteStops(selectedScheduleId)}
                    >
                      <RotateCcw size={16} />
                      Przywróć
                    </button>
                  </div>

                  {previewStop && (
                    <div className={styles.preview}>
                      <div className={styles.previewHeader}>
                        <h3 className={styles.previewTitle}>
                          <Clock3 size={16} />
                          Odjazdy z: {previewStopName}
                        </h3>
                        <button
                          className={styles.previewClose}
                          onClick={() => setPreviewStop(null)}
                        >
                          Zamknij
                        </button>
                      </div>
                      <p className={styles.previewSub}>
                        {DAY_TYPES.find((d) => d.key === selectedDayType)?.label}{' '}
                        · odjazd z pętli + czas dojazdu
                      </p>
                      {previewDepartures.length === 0 ? (
                        <p className={styles.previewEmpty}>
                          Brak kursów dla tego typu dnia.
                        </p>
                      ) : (
                        <div className={styles.previewTimes}>
                          {previewDepartures.map((t, i) => (
                            <span key={`${t}-${i}`} className={styles.previewTime}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* KURSY */}
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>
                        <CalendarClock size={20} className={styles.iconPrimary} />
                        Kursy (odjazdy z pętli)
                      </h2>
                      <p className={styles.cardDescription}>
                        Godziny startu z pierwszego przystanku dla wybranego typu
                        dnia.
                      </p>
                    </div>
                  </div>

                  <div className={styles.dayTypeTabs}>
                    {DAY_TYPES.map((d) => {
                      const active = selectedDayType === d.key;
                      return (
                        <button
                          key={d.key}
                          onClick={() => setSelectedDayType(d.key)}
                          className={`${styles.dayTypeTab} ${active ? styles.dayTypeTabActive : styles.dayTypeTabInactive}`}
                        >
                          <CalendarClock size={16} />
                          {d.label}
                        </button>
                      );
                    })}
                  </div>

                  <form onSubmit={handleAddTrip} className={styles.addTripRow}>
                    <div className={styles.selectWrapper}>
                      <Clock3 size={16} className={styles.inputIcon} />
                      <input
                        type="time"
                        className={`${styles.input} ${styles.inputWithIcon}`}
                        value={newDepartureTime}
                        onChange={(e) => setNewDepartureTime(e.target.value)}
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      className={styles.btnPrimary}
                      disabled={addingTrip}
                    >
                      {addingTrip ? (
                        <LoaderCircle size={16} className={styles.spinner} />
                      ) : (
                        <Plus size={16} />
                      )}
                      Dodaj kurs
                    </button>
                  </form>

                  {tripsLoading ? (
                    <div className={styles.loading}>
                      <LoaderCircle size={16} className={styles.spinner} />
                      Ładowanie kursów…
                    </div>
                  ) : scheduleTrips.length === 0 ? (
                    <div className={styles.emptyState}>
                      Brak kursów dla tego typu dnia.
                    </div>
                  ) : (
                    <div className={styles.tripList}>
                      {scheduleTrips.map((trip) => (
                        <div key={trip.id} className={styles.tripItem}>
                          <span className={styles.tripTime}>
                            {normalizeTimeHHMM(trip.departure_time)}
                          </span>
                          <button
                            className={styles.tripDelete}
                            onClick={() => handleDeleteTrip(trip.id)}
                            title="Usuń kurs"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ================= PRZYSTANKI ================= */}
        {activeTab === 'stops' && (
          <div className={styles.twoColumn}>
            <div className={styles.card}>
              <h2 className={styles.cardTitle}>
                {editingStop ? 'Edytuj przystanek' : 'Nowy przystanek'}
              </h2>
              <p className={styles.cardDescription}>
                Unikalne ID, nazwa i współrzędne geograficzne.
              </p>
              <form onSubmit={handleSubmitStop} className={styles.stopForm}>
                <div className={styles.stopFormGrid}>
                  <div>
                    <label className={styles.label}>ID przystanku</label>
                    <input
                      className={styles.input}
                      value={stopForm.id}
                      onChange={(e) => updateStopField('id', e.target.value)}
                      required
                      disabled={!!editingStop}
                    />
                  </div>
                  <div>
                    <label className={styles.label}>Nazwa</label>
                    <input
                      className={styles.input}
                      value={stopForm.name}
                      onChange={(e) => updateStopField('name', e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className={styles.label}>Szerokość</label>
                    <input
                      type="number"
                      step="any"
                      className={styles.input}
                      value={stopForm.latitude}
                      onChange={(e) =>
                        updateStopField('latitude', e.target.value)
                      }
                      required
                    />
                  </div>
                  <div>
                    <label className={styles.label}>Długość</label>
                    <input
                      type="number"
                      step="any"
                      className={styles.input}
                      value={stopForm.longitude}
                      onChange={(e) =>
                        updateStopField('longitude', e.target.value)
                      }
                      required
                    />
                  </div>
                </div>
                <div className={styles.buttonGroup}>
                  <button type="submit" className={styles.btnPrimary}>
                    <Save size={16} />
                    {editingStop ? 'Zapisz zmiany' : 'Dodaj przystanek'}
                  </button>
                  <button
                    type="button"
                    className={styles.btnSecondary}
                    onClick={resetStopForm}
                  >
                    <RotateCcw size={16} />
                    Anuluj
                  </button>
                </div>
              </form>
            </div>

            <div className={styles.card}>
              <h2 className={styles.cardTitle}>Przystanki</h2>
              <p className={styles.cardDescription}>
                {stops.length} w bazie.
              </p>
              {stopsLoading ? (
                <div className={styles.loading}>
                  <LoaderCircle size={16} className={styles.spinner} />
                  Ładowanie…
                </div>
              ) : (
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr className={styles.tableHead}>
                        <th>ID</th>
                        <th>Nazwa</th>
                        <th>Szer.</th>
                        <th>Dł.</th>
                        <th>Akcje</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stops.length === 0 ? (
                        <tr>
                          <td colSpan="5" className={styles.tableEmpty}>
                            Brak przystanków.
                          </td>
                        </tr>
                      ) : (
                        stops.map((stop) => (
                          <tr key={stop.id} className={styles.tableRow}>
                            <td className={styles.tableCell}>{stop.id}</td>
                            <td className={styles.tableCell}>{stop.name}</td>
                            <td className={styles.tableCell}>{stop.latitude}</td>
                            <td className={styles.tableCell}>{stop.longitude}</td>
                            <td className={styles.tableCell}>
                              <div className={styles.tableActions}>
                                <button
                                  className={styles.btnIcon}
                                  onClick={() => handleEditStop(stop)}
                                >
                                  <Pencil size={16} />
                                </button>
                                <button
                                  className={styles.btnIconDanger}
                                  onClick={() => handleDeleteStop(stop.id)}
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= POJAZDY ================= */}
        {activeTab === 'vehicles' && (
          <div className={styles.card}>
            <div className={styles.cardHeader}>
              <div>
                <h2 className={styles.cardTitle}>Pojazdy</h2>
                <p className={styles.cardDescription}>
                  Pojazdy pojawiają się automatycznie, gdy zgłaszają się do
                  serwera. Przypisz każdemu rozkład jazdy.
                </p>
              </div>
              <button className={styles.btnSecondary} onClick={loadVehicles}>
                <RotateCcw size={16} />
                Odśwież
              </button>
            </div>
            {vehiclesLoading ? (
              <div className={styles.loading}>
                <LoaderCircle size={16} className={styles.spinner} />
                Ładowanie pojazdów…
              </div>
            ) : (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr className={styles.tableHead}>
                      <th>Pojazd (pcName)</th>
                      <th>Ostatni sygnał</th>
                      <th>Przypisany rozkład</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vehicles.length === 0 ? (
                      <tr>
                        <td colSpan="4" className={styles.tableEmpty}>
                          Żaden pojazd nie zgłosił się jeszcze do serwera.
                        </td>
                      </tr>
                    ) : (
                      vehicles.map((vehicle) => {
                        const currentScheduleId =
                          vehicle.route_id || vehicle.schedule_id || '';
                        return (
                          <tr key={vehicle.pcName} className={styles.tableRow}>
                            <td className={styles.tableCell}>
                              <div className={styles.vehicleName}>
                                <Radio size={16} className={styles.vehicleIcon} />
                                <span className={styles.vehiclePcName}>
                                  {vehicle.pcName}
                                </span>
                              </div>
                            </td>
                            <td className={styles.tableCell}>
                              {formatSeen(vehicle.last_seen_at)}
                            </td>
                            <td className={styles.tableCell}>
                              <div className={styles.selectWrapper}>
                                <select
                                  className={styles.select}
                                  value={currentScheduleId}
                                  onChange={(e) =>
                                    handleUpdateVehicleSchedule(
                                      vehicle.pcName,
                                      e.target.value
                                    )
                                  }
                                >
                                  <option value="">Brak</option>
                                  {schedules.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      {s.name} (
                                      {DIRECTION_LABELS[s.direction]}
                                      {s.is_extended ? ', wydł.' : ''})
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown size={16} className={styles.selectIcon} />
                              </div>
                              {schedules.length === 0 && (
                                <p className={styles.helperText}>
                                  Najpierw utwórz rozkład w zakładce „Rozkłady
                                  jazdy”.
                                </p>
                              )}
                            </td>
                            <td className={styles.tableCell}>
                              {currentScheduleId ? (
                                <span className={styles.statusAssigned}>
                                  <CircleCheck size={14} />
                                  Przypisany
                                </span>
                              ) : (
                                <span className={styles.statusUnassigned}>
                                  <CircleSlash size={14} />
                                  Brak
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

export default Schedule;