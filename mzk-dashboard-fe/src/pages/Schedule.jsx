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
  Copy,
  MapPin,
  Truck,
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

const SIDE_DIRECTIONS = ['FROM_START', 'TO_START'];

const DIRECTION_LABELS = {
  FROM_START: 'Strona 1 (tam)',
  TO_START: 'Strona 2 (powrót)',
};

const createEmptyStopForm = () => ({
  id: '',
  name: '',
  latitude: '',
  longitude: '',
});

const createEmptyScheduleForm = () => ({
  name: '',
  line_id: '',
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

  // ---------- STRONY I GODZINY PRZYSTANKÓW ----------
  const [selectedSide, setSelectedSide] = useState('FROM_START');
  const [selectedDayType, setSelectedDayType] = useState('WEEKDAY');
  const [sideStops, setSideStops] = useState([]);
  const [sideStopsLoading, setSideStopsLoading] = useState(false);
  const [savingSideStops, setSavingSideStops] = useState(false);
  const [addStopId, setAddStopId] = useState('');

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
      const data = await api.getSchedules();
      setSchedules(data.schedules || []);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać rozkładów.');
    } finally {
      setSchedulesLoading(false);
    }
  }, [api]);

  const loadSideStops = useCallback(
    async (scheduleId, sideId, dayType) => {
      if (!scheduleId || !sideId) {
        setSideStops([]);
        return;
      }
      setSideStopsLoading(true);
      try {
        const data = await api.getScheduleSideStops(scheduleId, sideId, dayType);
        const sorted = (data.stops || [])
          .slice()
          .sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0))
          .map((s) => ({
            stop_id: s.stop_id,
            stop_name: s.stop_name || '',
            time: normalizeTimeHHMM(s.time),
          }));
        setSideStops(sorted);
      } catch (err) {
        setError(err.message || 'Nie udało się pobrać godzin przystanków.');
      } finally {
        setSideStopsLoading(false);
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

  const selectedSchedule = useMemo(
    () => schedules.find((s) => s.id === selectedScheduleId) || null,
    [schedules, selectedScheduleId]
  );

  const selectedSideObj = useMemo(() => {
    if (!selectedSchedule) return null;
    return (selectedSchedule.sides || []).find((s) => s.direction === selectedSide) || null;
  }, [selectedSchedule, selectedSide]);

  useEffect(() => {
    if (selectedSideObj) {
      loadSideStops(selectedScheduleId, selectedSideObj.id, selectedDayType);
    } else {
      setSideStops([]);
    }
  }, [selectedScheduleId, selectedSideObj, selectedDayType, loadSideStops]);

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
      line_id: schedule.line_id || '',
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
          line_id: scheduleForm.line_id.trim(),
        });
        await loadSchedules();
      } else {
        const created = await api.createSchedule({
          name: scheduleForm.name.trim(),
          line_id: scheduleForm.line_id.trim(),
        });
        await loadSchedules();
        if (created?.schedule?.id) setSelectedScheduleId(created.schedule.id);
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
        'Usunąć ten rozkład? Skasuje to obie jego strony i wszystkie zapisane godziny przystanków.'
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

  // =================== GODZINY PRZYSTANKÓW (STRONA + TYP DNIA) ===================
  const availableStopsToAdd = useMemo(() => {
    const used = new Set(sideStops.map((rs) => rs.stop_id));
    return stops.filter((s) => !used.has(s.id));
  }, [stops, sideStops]);

  const handleAddSideStop = () => {
    if (!addStopId) return;
    const stop = stops.find((s) => s.id === addStopId);
    if (!stop) return;
    setSideStops((prev) => [
      ...prev,
      {
        stop_id: stop.id,
        stop_name: stop.name,
        time: '',
      },
    ]);
    setAddStopId('');
  };

  const handleRemoveSideStop = (index) => {
    setSideStops((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSideStopTime = (index, value) => {
    setSideStops((prev) =>
      prev.map((rs, i) => (i === index ? { ...rs, time: value } : rs))
    );
  };

  const moveSideStop = (index, delta) => {
    setSideStops((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  };

  const handleSaveSideStops = async () => {
    if (!selectedScheduleId || !selectedSideObj) return;
    for (const rs of sideStops) {
      if (!rs.stop_id) {
        window.alert('Każdy wiersz musi mieć wybrany przystanek.');
        return;
      }
      if (!normalizeTimeHHMM(rs.time)) {
        window.alert(`Podaj poprawną godzinę (HH:MM) dla przystanku ${rs.stop_name || rs.stop_id}.`);
        return;
      }
    }
    setSavingSideStops(true);
    try {
      const payload = sideStops.map((rs) => ({
        stop_id: rs.stop_id,
        time: normalizeTimeHHMM(rs.time),
      }));
      await api.setScheduleSideStops(selectedScheduleId, selectedSideObj.id, selectedDayType, payload);
      await loadSideStops(selectedScheduleId, selectedSideObj.id, selectedDayType);
      await loadSchedules();
      window.alert('Godziny przystanków zapisane.');
    } catch (err) {
      window.alert(`Nie udało się zapisać: ${err.message}`);
    } finally {
      setSavingSideStops(false);
    }
  };

  const handleCopyFromOtherSide = async () => {
    if (!selectedSchedule || !selectedSideObj) return;
    const otherSide = (selectedSchedule.sides || []).find((s) => s.direction !== selectedSide);
    if (!otherSide) {
      window.alert('Brak drugiej strony rozkładu.');
      return;
    }
    const reverse = window.confirm(
      `Skopiować przystanki z „${DIRECTION_LABELS[otherSide.direction]}” (${DAY_TYPES.find((d) => d.key === selectedDayType)?.label})?\nOK = odwróć kolejność (kurs powrotny), Anuluj = kopiuj 1:1.\nGodziny trzeba będzie zweryfikować ręcznie po skopiowaniu.`
    );
    try {
      await api.copyScheduleSideStops(selectedScheduleId, selectedSideObj.id, {
        source_side_id: otherSide.id,
        source_day_type: selectedDayType,
        day_type: selectedDayType,
        reverse,
      });
      await loadSideStops(selectedScheduleId, selectedSideObj.id, selectedDayType);
      window.alert('Skopiowano przystanki. Zweryfikuj godziny.');
    } catch (err) {
      window.alert(`Nie udało się skopiować: ${err.message}`);
    }
  };

  const handleCopyFromOtherDayType = async () => {
    if (!selectedSchedule || !selectedSideObj) return;
    const others = DAY_TYPES.filter((d) => d.key !== selectedDayType);
    const list = others.map((d, i) => `${i + 1}. ${d.label}`).join('\n');
    const answer = window.prompt(
      `Z którego typu dnia skopiować przystanki (ta sama strona)? Podaj numer:\n${list}`,
      '1'
    );
    if (!answer) return;
    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= others.length) {
      window.alert('Nieprawidłowy numer.');
      return;
    }
    try {
      await api.copyScheduleSideStops(selectedScheduleId, selectedSideObj.id, {
        source_side_id: selectedSideObj.id,
        source_day_type: others[idx].key,
        day_type: selectedDayType,
        reverse: false,
      });
      await loadSideStops(selectedScheduleId, selectedSideObj.id, selectedDayType);
      window.alert('Skopiowano przystanki.');
    } catch (err) {
      window.alert(`Nie udało się skopiować: ${err.message}`);
    }
  };

  // =================== POJAZDY ===================
  const handleUpdateVehicleSchedule = async (pcName, scheduleId) => {
    try {
      await api.updateVehicle(pcName, { schedule_id: scheduleId || '' });
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
            Każdy rozkład ma dwie strony jazdy (tam i powrót). Dla każdej strony
            i typu dnia zapisujesz listę przystanków z dokładną godziną
            (HH:MM). W zakładce Pojazdy przypisujesz rozkład do konkretnego
            pojazdu.
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
                    Nadaj nazwę i (opcjonalnie) numer linii. Dwie strony jazdy
                    (tam / powrót) tworzone są automatycznie.
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
                    placeholder="np. Dworzec ↔ Lotnisko"
                    required
                  />
                </div>
                {/* <div className={styles.formScheduleDirection}>
                  <label className={styles.label}>Numer linii (opcjonalnie)</label>
                  <input
                    className={styles.input}
                    value={scheduleForm.line_id}
                    onChange={(e) =>
                      setScheduleForm((p) => ({ ...p, line_id: e.target.value }))
                    }
                    placeholder="np. 12"
                  />
                </div> */}
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
                    Wybierz rozkład, aby edytować godziny jego przystanków.
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
                          onClick={() => {
                            setSelectedScheduleId(s.id);
                            setSelectedSide('FROM_START');
                          }}
                        >
                          <RouteIcon
                            size={16}
                            className={active ? styles.iconActive : styles.iconInactive}
                          />
                          <span className={styles.scheduleName}>{s.name}</span>
                          {s.line_id && (
                            <span className={styles.scheduleDirection}>
                              linia {s.line_id}
                            </span>
                          )}
                        </button>
                        <button
                          className={styles.btnIcon}
                          onClick={() => handleEditScheduleMeta(s)}
                          title="Zmień nazwę / numer linii"
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
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h2 className={styles.cardTitle}>
                      <CalendarClock size={20} className={styles.iconPrimary} />
                      {selectedSchedule.name}
                    </h2>
                    <p className={styles.cardDescription}>
                      Wybierz stronę i typ dnia, następnie ustaw godzinę
                      (HH:MM) dla każdego przystanku.
                    </p>
                  </div>
                </div>

                <div className={styles.dayTypeTabs}>
                  {SIDE_DIRECTIONS.map((direction) => {
                    const active = selectedSide === direction;
                    return (
                      <button
                        key={direction}
                        onClick={() => setSelectedSide(direction)}
                        className={`${styles.dayTypeTab} ${active ? styles.dayTypeTabActive : styles.dayTypeTabInactive}`}
                      >
                        <RouteIcon size={16} />
                        {DIRECTION_LABELS[direction]}
                      </button>
                    );
                  })}
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
                        {selectedSideObj?.stop_counts?.[d.key] > 0 && (
                          <span className={styles.extendedBadge}>
                            {selectedSideObj.stop_counts[d.key]}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className={styles.buttonGroup}>
                  <button
                    className={styles.btnSecondary}
                    onClick={handleCopyFromOtherSide}
                  >
                    <Copy size={16} />
                    Kopiuj z drugiej strony
                  </button>
                  <button
                    className={styles.btnSecondary}
                    onClick={handleCopyFromOtherDayType}
                  >
                    <Copy size={16} />
                    Kopiuj z innego typu dnia
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
                    onClick={handleAddSideStop}
                    disabled={!addStopId}
                  >
                    <Plus size={16} />
                    Dodaj
                  </button>
                </div>

                {sideStopsLoading ? (
                  <div className={styles.loading}>
                    <LoaderCircle size={16} className={styles.spinner} />
                    Ładowanie…
                  </div>
                ) : sideStops.length === 0 ? (
                  <div className={styles.emptyState}>
                    <MapPinned size={32} className={styles.emptyIcon} />
                    <p className={styles.emptyTitle}>Brak przystanków dla tej strony i typu dnia</p>
                    <p className={styles.emptyDescription}>
                      Dodaj przystanki, ustaw godziny i zapisz.
                    </p>
                  </div>
                ) : (
                  <ul className={styles.stopList}>
                    {sideStops.map((rs, idx) => (
                      <li
                        key={`${rs.stop_id}-${idx}`}
                        className={styles.stopItem}
                      >
                        <span className={styles.stopIndex}>{idx + 1}</span>
                        <div className={styles.stopInfo}>
                          <p className={styles.stopName}>
                            {rs.stop_name || rs.stop_id}
                          </p>
                          <p className={styles.stopId}>{rs.stop_id}</p>
                        </div>
                        <div className={styles.stopTime}>
                          <Clock3 size={14} className={styles.inputIcon} />
                          <input
                            type="time"
                            className={styles.stopTimeInput}
                            value={rs.time}
                            onChange={(e) => handleSideStopTime(idx, e.target.value)}
                            title="Godzina bycia na przystanku (HH:MM)"
                          />
                        </div>
                        <div className={styles.stopMove}>
                          <button
                            className={styles.btnIcon}
                            onClick={() => moveSideStop(idx, -1)}
                            disabled={idx === 0}
                          >
                            <ArrowUpDown size={14} />
                          </button>
                          <button
                            className={styles.btnIcon}
                            onClick={() => moveSideStop(idx, 1)}
                            disabled={idx === sideStops.length - 1}
                          >
                            <ArrowUpDown size={14} style={{ transform: 'rotate(180deg)' }} />
                          </button>
                        </div>
                        <button
                          className={styles.btnIconDanger}
                          onClick={() => handleRemoveSideStop(idx)}
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
                    onClick={handleSaveSideStops}
                    disabled={savingSideStops}
                  >
                    {savingSideStops ? (
                      <>
                        <LoaderCircle size={16} className={styles.spinner} />
                        Zapisywanie…
                      </>
                    ) : (
                      <>
                        <Save size={16} />
                        Zapisz godziny
                      </>
                    )}
                  </button>
                  <button
                    className={styles.btnSecondary}
                    onClick={() =>
                      selectedSideObj &&
                      loadSideStops(selectedScheduleId, selectedSideObj.id, selectedDayType)
                    }
                  >
                    <RotateCcw size={16} />
                    Przywróć
                  </button>
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
                        const currentScheduleId = vehicle.schedule_id || '';
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
                                      {s.name}
                                      {s.line_id ? ` (linia ${s.line_id})` : ''}
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