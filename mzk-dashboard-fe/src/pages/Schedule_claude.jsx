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
  ArrowUpDown,
  MapPin,
  Truck,
  Radio,
  CircleCheck,
  CircleSlash,
  Coffee,
  ListChecks,
} from 'lucide-react';
import styles from './Schedule.module.css';

const DAY_TYPES = [
  { key: 'WEEKDAY', label: 'Dzień powszedni' },
  { key: 'WEEKEND', label: 'Weekend' },
  { key: 'HOLIDAY', label: 'Święto' },
];

const SIDE_DIRECTIONS = ['FROM_START', 'TO_START'];

const DIRECTION_LABELS = {
  FROM_START: 'Tam (od pętli początkowej)',
  TO_START: 'Powrót (do pętli początkowej)',
};

const createEmptyStopForm = () => ({
  id: '',
  name: '',
  latitude: '',
  longitude: '',
});

const createEmptyScheduleForm = () => ({
  name: '',
  code: '',
  color: '#3B82F6',
});

const normalizeTimeHHMM = (time) => {
  if (time === null || time === undefined || time === '') return '';
  const parts = String(time).trim().split(':');
  if (parts.length < 2) return '';
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
    return '';
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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

const todayKey = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const Schedule = () => {
  const {
    api,
    schedules,
    schedulesLoading,
    fetchSchedules,
    createSchedule,
    deleteSchedule,
    createTrip,
    deleteTrip,
    vehicles,
    vehiclesLoading,
    fetchVehicles,
    assignVehicleToTrips,
    fetchVehicleSchedule,
  } = useBackend();

  const [activeTab, setActiveTab] = useState('schedules');
  const [error, setError] = useState(null);

  // ---------- PRZYSTANKI ----------
  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopForm, setStopForm] = useState(createEmptyStopForm());
  const [editingStop, setEditingStop] = useState(null);

  // ---------- LINIE (schedules) ----------
  const [scheduleForm, setScheduleForm] = useState(createEmptyScheduleForm());
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [selectedSideId, setSelectedSideId] = useState('');
  const [editingSideName, setEditingSideName] = useState(false);
  const [sideNameDraft, setSideNameDraft] = useState('');
  const [savingSideName, setSavingSideName] = useState(false);

  // ---------- NOWY KURS ----------
  const [tripDayType, setTripDayType] = useState('WEEKDAY');
  const [tripDepartureTime, setTripDepartureTime] = useState('');
  const [tripBlockId, setTripBlockId] = useState('');
  const [tripStops, setTripStops] = useState([]);
  const [addStopId, setAddStopId] = useState('');
  const [savingTrip, setSavingTrip] = useState(false);

  // ---------- POJAZDY / DYSPOZYTURA ----------
  // Lista `vehicles` pochodzi wyłącznie z BackendContext (rejestracja automatyczna
  // po odebraniu ramki IsarsoftData) — nigdy nie jest tworzona ręcznie tutaj.
  const [assignPcName, setAssignPcName] = useState('');
  const [assignDate, setAssignDate] = useState('');
  const [assignDayTypeFilter, setAssignDayTypeFilter] = useState('WEEKDAY');
  const [selectedTripIds, setSelectedTripIds] = useState(() => new Set());
  const [assigning, setAssigning] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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
    try {
      await fetchSchedules();
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać linii.');
    }
  }, [fetchSchedules]);

  const loadVehicles = useCallback(async () => {
    try {
      await fetchVehicles();
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać pojazdów.');
    }
  }, [fetchVehicles]);

  useEffect(() => {
    setError(null);
    loadStops();
    loadSchedules();
    loadVehicles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedSchedule = useMemo(
    () => schedules.find((s) => s.id === selectedScheduleId) || null,
    [schedules, selectedScheduleId]
  );

  const selectedSide = useMemo(() => {
    if (!selectedSchedule) return null;
    return (selectedSchedule.sides || []).find((s) => s.id === selectedSideId) || null;
  }, [selectedSchedule, selectedSideId]);

  // Po wybraniu/odświeżeniu linii, upewnij się że jest wybrana jakaś strona (kierunek).
  useEffect(() => {
    if (!selectedSchedule) {
      setSelectedSideId('');
      return;
    }
    const sides = selectedSchedule.sides || [];
    if (!sides.some((s) => s.id === selectedSideId)) {
      setSelectedSideId(sides[0]?.id || '');
    }
  }, [selectedSchedule, selectedSideId]);

  useEffect(() => {
    setSideNameDraft(selectedSide?.name || '');
    setEditingSideName(false);
  }, [selectedSide]);

  // Wszystkie kursy ze wszystkich linii, spłaszczone — używane w zakładce Dyspozytura.
  const allTrips = useMemo(() => {
    const result = [];
    for (const schedule of schedules) {
      for (const side of schedule.sides || []) {
        for (const trip of side.trips || []) {
          result.push({
            ...trip,
            schedule_id: schedule.id,
            schedule_name: schedule.name,
            schedule_code: schedule.code,
            schedule_color: schedule.color,
            side_direction: side.direction,
            side_name: side.name,
          });
        }
      }
    }
    return result;
  }, [schedules]);

  const tripsForAssignment = useMemo(
    () => allTrips.filter((t) => t.day_type === assignDayTypeFilter).sort((a, b) => a.departure_time.localeCompare(b.departure_time)),
    [allTrips, assignDayTypeFilter]
  );

  const tripsForSelectedSide = useMemo(() => {
    if (!selectedSide) return [];
    return (selectedSide.trips || [])
      .filter((t) => t.day_type === tripDayType)
      .slice()
      .sort((a, b) => a.departure_time.localeCompare(b.departure_time));
  }, [selectedSide, tripDayType]);

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

  // =================== LINIE ===================
  const handleSubmitSchedule = async (e) => {
    e.preventDefault();
    if (!scheduleForm.name.trim()) {
      window.alert('Podaj nazwę linii.');
      return;
    }
    setSavingSchedule(true);
    try {
      const created = await createSchedule({
        name: scheduleForm.name.trim(),
        code: scheduleForm.code.trim() || undefined,
        color: scheduleForm.color || undefined,
      });
      setScheduleForm(createEmptyScheduleForm());
      if (created?.id) setSelectedScheduleId(created.id);
    } catch (err) {
      window.alert(`Nie udało się utworzyć linii: ${err.message}`);
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleDeleteSchedule = async (id) => {
    if (
      !window.confirm(
        'Usunąć tę linię? Skasuje to oba warianty kierunku oraz wszystkie ich kursy, przystanki kursów i przypisania pojazdów.'
      )
    )
      return;
    try {
      await deleteSchedule(id);
      if (selectedScheduleId === id) setSelectedScheduleId('');
    } catch (err) {
      window.alert(`Nie udało się usunąć linii: ${err.message}`);
    }
  };

  const handleSaveSideName = async () => {
    if (!selectedSchedule || !selectedSide) return;
    setSavingSideName(true);
    try {
      await api.updateScheduleSide(selectedSchedule.id, selectedSide.id, {
        name: sideNameDraft.trim() || null,
      });
      await loadSchedules();
      setEditingSideName(false);
    } catch (err) {
      window.alert(`Nie udało się zapisać nazwy kierunku: ${err.message}`);
    } finally {
      setSavingSideName(false);
    }
  };

  // =================== NOWY KURS ===================
  const availableStopsToAdd = useMemo(() => {
    const used = new Set(tripStops.map((rs) => rs.stop_id));
    return stops.filter((s) => !used.has(s.id));
  }, [stops, tripStops]);

  const handleAddTripStop = () => {
    if (!addStopId) return;
    const stop = stops.find((s) => s.id === addStopId);
    if (!stop) return;
    setTripStops((prev) => [...prev, { stop_id: stop.id, stop_name: stop.name, time: '' }]);
    setAddStopId('');
  };

  const handleRemoveTripStop = (index) => {
    setTripStops((prev) => prev.filter((_, i) => i !== index));
  };

  const handleTripStopTime = (index, value) => {
    setTripStops((prev) => prev.map((rs, i) => (i === index ? { ...rs, time: value } : rs)));
  };

  const moveTripStop = (index, delta) => {
    setTripStops((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  };

  const resetTripForm = () => {
    setTripDepartureTime('');
    setTripBlockId('');
    setTripStops([]);
    setAddStopId('');
  };

  const handleCreateTrip = async () => {
    if (!selectedSchedule || !selectedSide) {
      window.alert('Wybierz najpierw linię i wariant kierunku.');
      return;
    }
    const departureTime = normalizeTimeHHMM(tripDepartureTime);
    if (!departureTime) {
      window.alert('Podaj poprawną godzinę startu (HH:MM).');
      return;
    }
    if (tripStops.length === 0) {
      window.alert('Dodaj przynajmniej jeden przystanek.');
      return;
    }
    for (const rs of tripStops) {
      if (!normalizeTimeHHMM(rs.time)) {
        window.alert(`Podaj poprawną godzinę (HH:MM) dla przystanku ${rs.stop_name || rs.stop_id}.`);
        return;
      }
    }

    setSavingTrip(true);
    try {
      await createTrip(selectedSchedule.id, {
        side_id: selectedSide.id,
        day_type: tripDayType,
        departure_time: departureTime,
        block_id: tripBlockId.trim() || undefined,
        stops: tripStops.map((rs, i) => ({
          stop_id: rs.stop_id,
          sequence_order: i + 1,
          time: normalizeTimeHHMM(rs.time),
        })),
      });
      resetTripForm();
    } catch (err) {
      window.alert(`Nie udało się utworzyć kursu: ${err.message}`);
    } finally {
      setSavingTrip(false);
    }
  };

  const handleDeleteTrip = async (tripId) => {
    if (!window.confirm('Usunąć ten kurs wraz z jego przystankami i przypisaniami pojazdów?')) return;
    try {
      await deleteTrip(tripId);
    } catch (err) {
      window.alert(`Nie udało się usunąć kursu: ${err.message}`);
    }
  };

  // =================== DYSPOZYTURA / PRZYPISANIA POJAZDÓW ===================
  const toggleTripSelected = (tripId) => {
    setSelectedTripIds((prev) => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  };

  const handleAssignTrips = async () => {
    const pcName = assignPcName.trim();
    if (!pcName) {
      window.alert('Wybierz pojazd z listy rozwijanej.');
      return;
    }
    if (selectedTripIds.size === 0) {
      window.alert('Wybierz przynajmniej jeden kurs do przypisania.');
      return;
    }
    setAssigning(true);
    try {
      await assignVehicleToTrips(pcName, [...selectedTripIds], assignDate || null);
      setSelectedTripIds(new Set());
      await loadVehicles();
      await handleLoadPreview(pcName);
      window.alert('Przypisano wybrane kursy do pojazdu.');
    } catch (err) {
      window.alert(`Nie udało się przypisać kursów: ${err.message}`);
    } finally {
      setAssigning(false);
    }
  };

  const handleLoadPreview = async (pcNameOverride) => {
    const pcName = (pcNameOverride || assignPcName).trim();
    if (!pcName) {
      window.alert('Wybierz pojazd z listy rozwijanej.');
      return;
    }
    setPreviewLoading(true);
    try {
      const data = await fetchVehicleSchedule(pcName, { date: assignDate || todayKey() });
      setPreview(data);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać rozpiski pojazdu.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const tripLabel = (trip) => {
    const dir = DIRECTION_LABELS[trip.side_direction] || trip.side_direction;
    const dest = trip.side_name ? ` — ${trip.side_name}` : '';
    return `${trip.schedule_name}${trip.schedule_code ? ` (${trip.schedule_code})` : ''} · ${dir}${dest}`;
  };

  return (
    <section className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <p className={styles.headerLabel}>Zarządzanie infrastrukturą</p>
          <h1 className={styles.title}>Rozkłady, kursy i pojazdy</h1>
          <p className={styles.subtitle}>
            Linia ma dwa warianty kierunku (tam / powrót). Dla każdego wariantu
            i typu dnia tworzysz Kursy o konkretnej godzinie startu, z ich
            własną sekwencją przystanków. W Dyspozyturze przypisujesz pojazd
            do wybranych Kursów — na stałe (szablon) albo na konkretny dzień.
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
            { key: 'schedules', label: 'Linie i kursy', icon: CalendarClock },
            { key: 'stops', label: 'Przystanki', icon: MapPin },
            { key: 'assignments', label: 'Dyspozytura', icon: Truck },
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

        {/* ================= LINIE I KURSY ================= */}
        {activeTab === 'schedules' && (
          <div className={styles.section}>
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Nowa linia</h2>
                  <p className={styles.cardDescription}>
                    Nadaj nazwę, opcjonalny kod (np. numer linii) i kolor.
                    Oba warianty kierunku (tam / powrót) tworzone są automatycznie.
                  </p>
                </div>
              </div>

              <form onSubmit={handleSubmitSchedule} className={styles.formGrid}>
                <div>
                  <label className={styles.label}>Nazwa linii</label>
                  <input
                    className={styles.input}
                    value={scheduleForm.name}
                    onChange={(e) => setScheduleForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="np. Linia 100"
                    required
                  />
                </div>
                <div>
                  <label className={styles.label}>Kod / numer (opcjonalnie)</label>
                  <input
                    className={styles.input}
                    value={scheduleForm.code}
                    onChange={(e) => setScheduleForm((p) => ({ ...p, code: e.target.value }))}
                    placeholder="np. 100"
                  />
                </div>
                <div>
                  <label className={styles.label}>Kolor</label>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={scheduleForm.color}
                    onChange={(e) => setScheduleForm((p) => ({ ...p, color: e.target.value }))}
                  />
                </div>
                <div>
                  <button type="submit" className={styles.btnPrimary} disabled={savingSchedule}>
                    {savingSchedule ? <LoaderCircle size={16} className={styles.spinner} /> : <Save size={16} />}
                    Utwórz
                  </button>
                </div>
              </form>
            </div>

            <div className={styles.twoColumn}>
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h2 className={styles.cardTitle}>Linie</h2>
                    <p className={styles.cardDescription}>Wybierz linię, aby skonfigurować jej kursy.</p>
                  </div>
                </div>

                {schedulesLoading ? (
                  <div className={styles.loading}>
                    <LoaderCircle size={16} className={styles.spinner} />
                    Ładowanie linii…
                  </div>
                ) : schedules.length === 0 ? (
                  <div className={styles.emptyState}>Nie ma jeszcze żadnej linii. Utwórz pierwszą powyżej.</div>
                ) : (
                  <div className={styles.scheduleList}>
                    {schedules.map((s) => {
                      const active = s.id === selectedScheduleId;
                      const tripCount = (s.sides || []).reduce((sum, side) => sum + (side.trips || []).length, 0);
                      return (
                        <div
                          key={s.id}
                          className={`${styles.scheduleItem} ${active ? styles.scheduleItemActive : styles.scheduleItemInactive}`}
                        >
                          <button className={styles.scheduleItemButton} onClick={() => setSelectedScheduleId(s.id)}>
                            <span className={styles.colorDot} style={{ backgroundColor: s.color || '#3B82F6' }} />
                            <span className={styles.scheduleName}>{s.name}</span>
                            {s.code && <span className={styles.scheduleDirection}>{s.code}</span>}
                            <span className={styles.extendedBadge}>{tripCount} kurs.</span>
                          </button>
                          <button
                            className={styles.btnIconDanger}
                            onClick={() => handleDeleteSchedule(s.id)}
                            title="Usuń linię"
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
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>
                        <RouteIcon size={18} className={styles.iconPrimary} />
                        Wariant kierunku
                      </h2>
                      <p className={styles.cardDescription}>Wybierz kierunek i nadaj mu nazwę docelową.</p>
                    </div>
                  </div>

                  <div className={styles.dayTypeTabs}>
                    {SIDE_DIRECTIONS.map((direction) => {
                      const side = (selectedSchedule.sides || []).find((s) => s.direction === direction);
                      if (!side) return null;
                      const active = selectedSideId === side.id;
                      return (
                        <button
                          key={direction}
                          onClick={() => setSelectedSideId(side.id)}
                          className={`${styles.dayTypeTab} ${active ? styles.dayTypeTabActive : styles.dayTypeTabInactive}`}
                        >
                          <RouteIcon size={16} />
                          {DIRECTION_LABELS[direction]}
                        </button>
                      );
                    })}
                  </div>

                  {selectedSide && (
                    <div className={styles.formScheduleDirection}>
                      <label className={styles.label}>Nazwa docelowa (np. „Do: Pętla Zachód”)</label>
                      <div className={styles.buttonGroup} style={{ marginTop: 0 }}>
                        <input
                          className={styles.input}
                          value={editingSideName ? sideNameDraft : selectedSide.name || ''}
                          onChange={(e) => {
                            setEditingSideName(true);
                            setSideNameDraft(e.target.value);
                          }}
                          placeholder="np. Pętla Zachód"
                        />
                        <button
                          className={styles.btnSecondary}
                          onClick={handleSaveSideName}
                          disabled={!editingSideName || savingSideName}
                        >
                          {savingSideName ? <LoaderCircle size={16} className={styles.spinner} /> : <Save size={16} />}
                          Zapisz
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {selectedSchedule && selectedSide && (
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h2 className={styles.cardTitle}>
                      <Clock3 size={18} className={styles.iconPrimary} />
                      Nowy kurs
                    </h2>
                    <p className={styles.cardDescription}>
                      Wybierz typ dnia, godzinę startu i sekwencję przystanków z godzinami przyjazdu.
                    </p>
                  </div>
                </div>

                <div className={styles.dayTypeTabs}>
                  {DAY_TYPES.map((d) => {
                    const active = tripDayType === d.key;
                    return (
                      <button
                        key={d.key}
                        onClick={() => setTripDayType(d.key)}
                        className={`${styles.dayTypeTab} ${active ? styles.dayTypeTabActive : styles.dayTypeTabInactive}`}
                      >
                        <CalendarClock size={16} />
                        {d.label}
                      </button>
                    );
                  })}
                </div>

                <div className={styles.stopFormGrid} style={{ marginBottom: '1rem' }}>
                  <div>
                    <label className={styles.label}>Godzina startu (HH:MM)</label>
                    <input
                      type="time"
                      className={styles.input}
                      value={tripDepartureTime}
                      onChange={(e) => setTripDepartureTime(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={styles.label}>Brygada / blok (opcjonalnie)</label>
                    <input
                      className={styles.input}
                      value={tripBlockId}
                      onChange={(e) => setTripBlockId(e.target.value)}
                      placeholder="np. B1"
                    />
                  </div>
                </div>

                <div className={styles.addStopRow}>
                  <div className={styles.selectWrapper}>
                    <select className={styles.select} value={addStopId} onChange={(e) => setAddStopId(e.target.value)}>
                      <option value="">— dodaj przystanek —</option>
                      {availableStopsToAdd.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.id})
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} className={styles.selectIcon} />
                  </div>
                  <button className={styles.btnSecondary} onClick={handleAddTripStop} disabled={!addStopId}>
                    <Plus size={16} />
                    Dodaj
                  </button>
                </div>

                {tripStops.length === 0 ? (
                  <div className={styles.emptyState}>
                    <MapPinned size={32} className={styles.emptyIcon} />
                    <p className={styles.emptyTitle}>Brak przystanków w tym kursie</p>
                    <p className={styles.emptyDescription}>Dodaj przystanki i ustaw godziny.</p>
                  </div>
                ) : (
                  <ul className={styles.stopList}>
                    {tripStops.map((rs, idx) => (
                      <li key={`${rs.stop_id}-${idx}`} className={styles.stopItem}>
                        <span className={styles.stopIndex}>{idx + 1}</span>
                        <div className={styles.stopInfo}>
                          <p className={styles.stopName}>{rs.stop_name || rs.stop_id}</p>
                          <p className={styles.stopId}>{rs.stop_id}</p>
                        </div>
                        <div className={styles.stopTime}>
                          <Clock3 size={14} className={styles.inputIcon} />
                          <input
                            type="time"
                            className={styles.stopTimeInput}
                            value={rs.time}
                            onChange={(e) => handleTripStopTime(idx, e.target.value)}
                            title="Godzina przyjazdu na przystanek (HH:MM)"
                          />
                        </div>
                        <div className={styles.stopMove}>
                          <button className={styles.btnIcon} onClick={() => moveTripStop(idx, -1)} disabled={idx === 0}>
                            <ArrowUpDown size={14} />
                          </button>
                          <button
                            className={styles.btnIcon}
                            onClick={() => moveTripStop(idx, 1)}
                            disabled={idx === tripStops.length - 1}
                          >
                            <ArrowUpDown size={14} style={{ transform: 'rotate(180deg)' }} />
                          </button>
                        </div>
                        <button className={styles.btnIconDanger} onClick={() => handleRemoveTripStop(idx)}>
                          <Trash2 size={16} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className={styles.buttonGroup}>
                  <button className={styles.btnPrimary} onClick={handleCreateTrip} disabled={savingTrip}>
                    {savingTrip ? (
                      <>
                        <LoaderCircle size={16} className={styles.spinner} />
                        Zapisywanie…
                      </>
                    ) : (
                      <>
                        <Save size={16} />
                        Utwórz kurs
                      </>
                    )}
                  </button>
                  <button className={styles.btnSecondary} onClick={resetTripForm}>
                    <RotateCcw size={16} />
                    Wyczyść
                  </button>
                </div>

                <div className={styles.preview}>
                  <div className={styles.previewHeader}>
                    <span className={styles.previewTitle}>
                      <ListChecks size={16} />
                      Kursy: {DIRECTION_LABELS[selectedSide.direction]} · {DAY_TYPES.find((d) => d.key === tripDayType)?.label}
                    </span>
                  </div>
                  {tripsForSelectedSide.length === 0 ? (
                    <p className={styles.previewEmpty}>Brak jeszcze utworzonych kursów dla tego wariantu i typu dnia.</p>
                  ) : (
                    <div className={styles.tableWrapper}>
                      <table className={styles.table}>
                        <thead>
                          <tr className={styles.tableHead}>
                            <th>Odjazd</th>
                            <th>Brygada</th>
                            <th>Przystanków</th>
                            <th>Trasa</th>
                            <th>Akcje</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tripsForSelectedSide.map((trip) => (
                            <tr key={trip.id} className={styles.tableRow}>
                              <td className={styles.tableCell}>{trip.departure_time}</td>
                              <td className={styles.tableCell}>{trip.block_id || '—'}</td>
                              <td className={styles.tableCell}>{(trip.stops || []).length}</td>
                              <td className={styles.tableCell}>
                                {(trip.stops || []).map((s) => s.stop_name).join(' → ')}
                              </td>
                              <td className={styles.tableCell}>
                                <button className={styles.btnIconDanger} onClick={() => handleDeleteTrip(trip.id)}>
                                  <Trash2 size={16} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
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
              <h2 className={styles.cardTitle}>{editingStop ? 'Edytuj przystanek' : 'Nowy przystanek'}</h2>
              <p className={styles.cardDescription}>Unikalne ID, nazwa i współrzędne geograficzne.</p>
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
                      onChange={(e) => updateStopField('latitude', e.target.value)}
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
                      onChange={(e) => updateStopField('longitude', e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className={styles.buttonGroup}>
                  <button type="submit" className={styles.btnPrimary}>
                    <Save size={16} />
                    {editingStop ? 'Zapisz zmiany' : 'Dodaj przystanek'}
                  </button>
                  <button type="button" className={styles.btnSecondary} onClick={resetStopForm}>
                    <RotateCcw size={16} />
                    Anuluj
                  </button>
                </div>
              </form>
            </div>

            <div className={styles.card}>
              <h2 className={styles.cardTitle}>Przystanki</h2>
              <p className={styles.cardDescription}>{stops.length} w bazie.</p>
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
                                <button className={styles.btnIcon} onClick={() => handleEditStop(stop)}>
                                  <Pencil size={16} />
                                </button>
                                <button className={styles.btnIconDanger} onClick={() => handleDeleteStop(stop.id)}>
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

        {/* ================= DYSPOZYTURA ================= */}
        {activeTab === 'assignments' && (
          <div className={styles.section}>
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>
                    <Truck size={18} className={styles.iconPrimary} />
                    Przypisanie pojazdu do kursów
                  </h2>
                  <p className={styles.cardDescription}>
                    Wybierz pojazd, opcjonalnie datę (puste = przypisanie stałe/szablonowe dla danego typu dnia),
                    a następnie zaznacz kursy, które ma wykonać.
                  </p>
                </div>
                <button className={styles.btnSecondary} onClick={loadVehicles}>
                  <RotateCcw size={16} />
                  Odśwież pojazdy
                </button>
              </div>

              <div className={styles.stopFormGrid} style={{ marginBottom: '1rem' }}>
                <div>
                  <label className={styles.label}>Pojazd (pcName)</label>
                  {vehicles.length === 0 ? (
                    <div className={styles.emptyState}>
                      Brak zarejestrowanych pojazdów w systemie. Pojazdy pojawią się automatycznie po wysłaniu pierwszej ramki danych (IsarsoftData).
                    </div>
                  ) : (
                    <div className={styles.selectWrapper}>
                      <select
                        className={styles.select}
                        value={assignPcName}
                        onChange={(e) => setAssignPcName(e.target.value)}
                      >
                        <option value="">— wybierz pojazd —</option>
                        {vehicles.map((v) => (
                          <option key={v.pcName} value={v.pcName}>
                            {v.pcName}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} className={styles.selectIcon} />
                    </div>
                  )}
                </div>
                <div>
                  <label className={styles.label}>Data (opcjonalnie)</label>
                  <input type="date" className={styles.input} value={assignDate} onChange={(e) => setAssignDate(e.target.value)} />
                </div>
              </div>

              <div className={styles.dayTypeTabs}>
                {DAY_TYPES.map((d) => {
                  const active = assignDayTypeFilter === d.key;
                  return (
                    <button
                      key={d.key}
                      onClick={() => setAssignDayTypeFilter(d.key)}
                      className={`${styles.dayTypeTab} ${active ? styles.dayTypeTabActive : styles.dayTypeTabInactive}`}
                    >
                      <CalendarClock size={16} />
                      {d.label}
                    </button>
                  );
                })}
              </div>

              {tripsForAssignment.length === 0 ? (
                <div className={styles.emptyState}>Brak kursów dla wybranego typu dnia. Utwórz je w zakładce „Linie i kursy”.</div>
              ) : (
                <div className={styles.stopList} style={{ maxHeight: '20rem', overflowY: 'auto' }}>
                  {tripsForAssignment.map((trip) => {
                    const checked = selectedTripIds.has(trip.id);
                    return (
                      <label
                        key={trip.id}
                        className={`${styles.tripRow} ${checked ? styles.tripRowSelected : ''}`}
                        style={{ cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          checked={checked}
                          onChange={() => toggleTripSelected(trip.id)}
                        />
                        <span className={styles.colorDot} style={{ backgroundColor: trip.schedule_color || '#3B82F6' }} />
                        <div className={styles.tripRowMain}>
                          <span className={styles.tripRowTitle}>{trip.departure_time} — {tripLabel(trip)}</span>
                          <span className={styles.tripRowSub}>
                            {(trip.stops || []).map((s) => s.stop_name).join(' → ')}
                          </span>
                        </div>
                        {trip.block_id && <span className={styles.tripRowBadge}>{trip.block_id}</span>}
                      </label>
                    );
                  })}
                </div>
              )}

              <div className={styles.buttonGroup}>
                <button className={styles.btnPrimary} onClick={handleAssignTrips} disabled={assigning}>
                  {assigning ? <LoaderCircle size={16} className={styles.spinner} /> : <Save size={16} />}
                  Przypisz zaznaczone kursy ({selectedTripIds.size})
                </button>
                <button className={styles.btnSecondary} onClick={() => handleLoadPreview()} disabled={previewLoading}>
                  {previewLoading ? <LoaderCircle size={16} className={styles.spinner} /> : <ListChecks size={16} />}
                  Podgląd trasy pojazdu
                </button>
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Podgląd ciągłości trasy</h2>
                  <p className={styles.cardDescription}>
                    Kursy przypisane pojazdowi {preview?.pcName ? `„${preview.pcName}”` : ''} w kolejności chronologicznej,
                    z automatycznie wyliczonymi pauzami między kursami.
                  </p>
                </div>
              </div>

              {previewLoading ? (
                <div className={styles.loading}>
                  <LoaderCircle size={16} className={styles.spinner} />
                  Ładowanie rozpiski…
                </div>
              ) : !preview || (preview.trips || []).length === 0 ? (
                <div className={styles.timelineEmpty}>
                  Brak przypisanych kursów dla tego pojazdu (dzień: {assignDate || todayKey()}). Przypisz kursy powyżej i kliknij „Podgląd trasy pojazdu”.
                </div>
              ) : (
                <div className={styles.timeline}>
                  {preview.trips.map((trip, idx) => {
                    const firstStop = trip.stops?.[0];
                    const lastStop = trip.stops?.[trip.stops.length - 1];
                    const leg = preview.legs?.find((l) => l.from_trip_id === trip.id);
                    return (
                      <React.Fragment key={trip.id}>
                        <div className={styles.timelineTrip}>
                          <RouteIcon size={18} className={styles.iconPrimary} />
                          <div style={{ flex: 1 }}>
                            <div className={styles.timelineTripHeader}>
                              <span>
                                Kurs {idx + 1}: {firstStop?.time || trip.departure_time} – {lastStop?.time || '—'}
                              </span>
                              <span className={styles.tripRowBadge}>
                                {trip.schedule_name}
                                {trip.schedule_code ? ` (${trip.schedule_code})` : ''}
                              </span>
                              <span className={styles.tripRowBadge}>{DIRECTION_LABELS[trip.side_direction] || trip.side_direction}</span>
                              {trip.block_id && <span className={styles.tripRowBadge}>{trip.block_id}</span>}
                            </div>
                            <div className={styles.timelineTripStops}>
                              {(trip.stops || []).map((s) => `${s.stop_name} (${s.time})`).join(' → ')}
                            </div>
                          </div>
                        </div>
                        {leg && (
                          <div className={styles.timelinePause}>
                            <Coffee size={14} />
                            <span>
                              PAUZA · {leg.pause_minutes} min ({leg.arrival_time} → {leg.departure_time})
                            </span>
                            <span className={styles.timelinePauseLine} />
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Pojazdy</h2>
                  <p className={styles.cardDescription}>Pojazdy widoczne w systemie (zgłoszone przez pokładowy komputer).</p>
                </div>
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
                        <th>Aktualna linia</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {vehicles.length === 0 ? (
                        <tr>
                          <td colSpan="4" className={styles.tableEmpty}>
                            Brak zarejestrowanych pojazdów w systemie. Pojazdy pojawią się automatycznie po wysłaniu
                            pierwszej ramki danych (IsarsoftData).
                          </td>
                        </tr>
                      ) : (
                        vehicles.map((vehicle) => (
                          <tr key={vehicle.pcName} className={styles.tableRow}>
                            <td className={styles.tableCell}>
                              <div className={styles.vehicleName}>
                                <Radio size={16} className={styles.vehicleIcon} />
                                <span className={styles.vehiclePcName}>{vehicle.pcName}</span>
                              </div>
                            </td>
                            <td className={styles.tableCell}>{formatSeen(vehicle.last_seen_at)}</td>
                            <td className={styles.tableCell}>{vehicle.line_id || '—'}</td>
                            <td className={styles.tableCell}>
                              {vehicle.has_schedule ? (
                                <span className={styles.statusAssigned}>
                                  <CircleCheck size={14} />
                                  Ma kursy dziś
                                </span>
                              ) : (
                                <span className={styles.statusUnassigned}>
                                  <CircleSlash size={14} />
                                  Brak
                                </span>
                              )}
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
      </div>
    </section>
  );
};

export default Schedule;
