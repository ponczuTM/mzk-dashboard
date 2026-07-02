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
} from 'lucide-react';
import styles from './Schedule.module.css';

const EMPTY_DAY_TYPES = {
  weekday: [],
  weekend: [],
  holiday: [],
};

const DAY_TYPE_LABELS = {
  weekday: 'Dzień powszedni',
  weekend: 'Weekend',
  holiday: 'Święto',
};

const createEmptyFormData = () => ({
  pcName: '',
  line_id: '',
  day_types: {
    weekday: [],
    weekend: [],
    holiday: [],
  },
  active: true,
});

const Schedule = () => {
  const { api } = useBackend();

  const [schedules, setSchedules] = useState([]);
  const [stops, setStops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [formData, setFormData] = useState(createEmptyFormData());
  const [selectedDayType, setSelectedDayType] = useState('weekday');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [schData, stopsData] = await Promise.all([
        api.getSchedules(),
        api.getStops(),
      ]);

      setSchedules(schData.schedules || []);
      setStops(stopsData.stops || []);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać danych rozkładów.');
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const resetForm = () => {
    setEditingSchedule(null);
    setFormData(createEmptyFormData());
    setSelectedDayType('weekday');
  };

  const handleEdit = (schedule) => {
    setEditingSchedule(schedule);
    setFormData({
      pcName: schedule.pcName || '',
      line_id: schedule.line_id || '',
      day_types: {
        weekday: schedule.day_types?.weekday || [],
        weekend: schedule.day_types?.weekend || [],
        holiday: schedule.day_types?.holiday || [],
      },
      active: schedule.active !== false,
    });
    setSelectedDayType('weekday');
  };

  const handleDelete = async (id) => {
    const confirmed = window.confirm('Czy na pewno usunąć ten rozkład?');
    if (!confirmed) return;

    try {
      await api.deleteSchedule(id);
      await loadData();

      if (editingSchedule?.schedule_id === id) {
        resetForm();
      }
    } catch (err) {
      window.alert(`Błąd usuwania: ${err.message}`);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);

    try {
      const payload = {
        pcName: formData.pcName.trim(),
        line_id: formData.line_id.trim(),
        day_types: formData.day_types,
        active: formData.active,
      };

      if (editingSchedule) {
        await api.updateSchedule(editingSchedule.schedule_id, payload);
      } else {
        await api.createSchedule(payload);
      }

      resetForm();
      await loadData();
    } catch (err) {
      window.alert(`Błąd zapisu: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const updateField = (field, value) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const addStopToSequence = () => {
    setFormData((prev) => ({
      ...prev,
      day_types: {
        ...prev.day_types,
        [selectedDayType]: [
          ...(prev.day_types[selectedDayType] || []),
          { stop_id: '', planned_time: '00:00:00' },
        ],
      },
    }));
  };

  const removeStopFromSequence = (index) => {
    setFormData((prev) => ({
      ...prev,
      day_types: {
        ...prev.day_types,
        [selectedDayType]: (prev.day_types[selectedDayType] || []).filter(
          (_, idx) => idx !== index
        ),
      },
    }));
  };

  const updateStopInSequence = (index, field, value) => {
    setFormData((prev) => ({
      ...prev,
      day_types: {
        ...prev.day_types,
        [selectedDayType]: (prev.day_types[selectedDayType] || []).map((item, idx) =>
          idx === index ? { ...item, [field]: value } : item
        ),
      },
    }));
  };

  const currentSequence = formData.day_types[selectedDayType] || [];
  const activeSchedulesCount = schedules.filter((schedule) => schedule.active).length;

  if (loading) {
    return (
      <section className={styles.pageShell}>
        <div className={styles.stateCard}>
          <LoaderCircle className={`${styles.stateIcon} ${styles.spin}`} />
          <div>
            <h2 className={styles.stateTitle}>Ładowanie rozkładów</h2>
            <p className={styles.stateText}>
              Trwa pobieranie listy rozkładów oraz przystanków.
            </p>
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className={styles.pageShell}>
        <div className={styles.stateCard}>
          <AlertCircle className={styles.stateIconError} />
          <div>
            <h2 className={styles.stateTitle}>Nie udało się pobrać danych</h2>
            <p className={styles.stateText}>Błąd: {error}</p>
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
            <p className={styles.eyebrow}>Operacje rozkładów</p>
            <h1 className={styles.title}>Zarządzanie rozkładami</h1>
            <p className={styles.subtitle}>
              Dodawaj, edytuj i porządkuj sekwencje przystanków dla różnych typów dni.
            </p>
          </div>

          <div className={styles.heroStats}>
            <div className={styles.heroStat}>
              <Layers3 className={styles.heroStatIcon} />
              <div>
                <span className={styles.heroStatLabel}>Łącznie rozkładów</span>
                <strong className={styles.heroStatValue}>{schedules.length}</strong>
              </div>
            </div>

            <div className={styles.heroStat}>
              <CircleCheck className={styles.heroStatIcon} />
              <div>
                <span className={styles.heroStatLabel}>Aktywne</span>
                <strong className={styles.heroStatValue}>{activeSchedulesCount}</strong>
              </div>
            </div>
          </div>
        </header>

        <div className={styles.contentGrid}>
          <section className={styles.formCard}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>
                  {editingSchedule ? 'Edytuj rozkład' : 'Dodaj nowy rozkład'}
                </h2>
                <p className={styles.sectionText}>
                  Uzupełnij dane pojazdu, wybierz typ dnia i zbuduj sekwencję przystanków.
                </p>
              </div>
            </div>

            <form className={styles.form} onSubmit={handleSubmit}>
              <div className={styles.formGrid}>
                <div className={styles.field}>
                  <label htmlFor="pcName" className={styles.label}>
                    <span className={styles.labelInner}>
                      <BusFront className={styles.labelIcon} />
                      Pojazd (pcName)
                    </span>
                  </label>
                  <input
                    id="pcName"
                    type="text"
                    className={styles.input}
                    value={formData.pcName}
                    onChange={(e) => updateField('pcName', e.target.value)}
                    required
                  />
                </div>

                <div className={styles.field}>
                  <label htmlFor="line_id" className={styles.label}>
                    <span className={styles.labelInner}>
                      <Route className={styles.labelIcon} />
                      Linia
                    </span>
                  </label>
                  <input
                    id="line_id"
                    type="text"
                    className={styles.input}
                    value={formData.line_id}
                    onChange={(e) => updateField('line_id', e.target.value)}
                    required
                  />
                </div>
              </div>

              <div className={styles.toggleRow}>
                <div className={styles.toggleCopy}>
                  <span className={styles.label}>Status rozkładu</span>
                  <span className={styles.toggleHint}>
                    Określa, czy rozkład ma być aktywny po zapisaniu.
                  </span>
                </div>

                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    checked={formData.active}
                    onChange={(e) => updateField('active', e.target.checked)}
                  />
                  <span className={styles.switchTrack}>
                    <span className={styles.switchThumb} />
                  </span>
                  <span className={styles.switchLabel}>
                    {formData.active ? 'Aktywny' : 'Nieaktywny'}
                  </span>
                </label>
              </div>

              <div className={styles.dayTabs}>
                {Object.keys(EMPTY_DAY_TYPES).map((dayType) => (
                  <button
                    key={dayType}
                    type="button"
                    onClick={() => setSelectedDayType(dayType)}
                    className={
                      selectedDayType === dayType
                        ? `${styles.dayTab} ${styles.dayTabActive}`
                        : styles.dayTab
                    }
                  >
                    <CalendarClock className={styles.dayTabIcon} />
                    {DAY_TYPE_LABELS[dayType]}
                  </button>
                ))}
              </div>

              <div className={styles.sequenceCard}>
                <div className={styles.sequenceHeader}>
                  <div>
                    <h3 className={styles.sequenceTitle}>
                      Sekwencja przystanków: {DAY_TYPE_LABELS[selectedDayType]}
                    </h3>
                    <p className={styles.sequenceText}>
                      Dodaj kolejne punkty trasy i określ planowany czas przejazdu.
                    </p>
                  </div>

                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={addStopToSequence}
                  >
                    <Plus className={styles.buttonIcon} />
                    Dodaj przystanek
                  </button>
                </div>

                <div className={styles.sequenceList}>
                  {currentSequence.length > 0 ? (
                    currentSequence.map((item, index) => (
                      <div key={`${selectedDayType}-${index}`} className={styles.sequenceRow}>
                        <div className={styles.sequenceIndex}>
                          <ListOrdered className={styles.sequenceIndexIcon} />
                          <span>{index + 1}</span>
                        </div>

                        <div className={styles.sequenceFieldWide}>
                          <label
                            htmlFor={`stop-${selectedDayType}-${index}`}
                            className={styles.srOnly}
                          >
                            Przystanek
                          </label>

                          <div className={styles.selectWrap}>
                            <select
                              id={`stop-${selectedDayType}-${index}`}
                              className={styles.select}
                              value={item.stop_id}
                              onChange={(e) =>
                                updateStopInSequence(index, 'stop_id', e.target.value)
                              }
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
                          <label
                            htmlFor={`time-${selectedDayType}-${index}`}
                            className={styles.srOnly}
                          >
                            Planowany czas
                          </label>
                          <div className={styles.timeWrap}>
                            <Clock3 className={styles.timeIcon} />
                            <input
                              id={`time-${selectedDayType}-${index}`}
                              type="time"
                              step="1"
                              className={styles.input}
                              value={
                                item.planned_time
                                  ? item.planned_time.substring(0, 5)
                                  : ''
                              }
                              onChange={(e) =>
                                updateStopInSequence(
                                  index,
                                  'planned_time',
                                  `${e.target.value}:00`
                                )
                              }
                              required
                            />
                          </div>
                        </div>

                        <button
                          type="button"
                          className={styles.iconButtonDanger}
                          onClick={() => removeStopFromSequence(index)}
                          aria-label={`Usuń przystanek ${index + 1}`}
                        >
                          <Trash2 className={styles.buttonIcon} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <div className={styles.emptySequence}>
                      <MapPinned className={styles.emptySequenceIcon} />
                      <p className={styles.emptySequenceTitle}>
                        Brak przystanków dla tego typu dnia
                      </p>
                      <p className={styles.emptySequenceText}>
                        Dodaj pierwszy przystanek, aby utworzyć sekwencję.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className={styles.formActions}>
                <button type="submit" className={styles.primaryButton} disabled={saving}>
                  {saving ? (
                    <>
                      <LoaderCircle className={`${styles.buttonIcon} ${styles.spin}`} />
                      Zapisywanie...
                    </>
                  ) : (
                    <>
                      <Save className={styles.buttonIcon} />
                      {editingSchedule ? 'Zapisz zmiany' : 'Dodaj rozkład'}
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={resetForm}
                >
                  <RotateCcw className={styles.buttonIcon} />
                  Anuluj
                </button>
              </div>
            </form>
          </section>

          <section className={styles.listCard}>
            <div className={styles.sectionHeader}>
              <div>
                <h2 className={styles.sectionTitle}>Lista rozkładów</h2>
                <p className={styles.sectionText}>
                  Podgląd wszystkich konfiguracji z szybkim dostępem do edycji i usuwania.
                </p>
              </div>
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Pojazd</th>
                    <th>Linia</th>
                    <th>Status</th>
                    <th>Akcje</th>
                  </tr>
                </thead>

                <tbody>
                  {schedules.length > 0 ? (
                    schedules.map((schedule) => (
                      <tr key={schedule.schedule_id}>
                        <td>{schedule.schedule_id}</td>
                        <td>{schedule.pcName || '—'}</td>
                        <td>{schedule.line_id || '—'}</td>
                        <td>
                          {schedule.active ? (
                            <span className={styles.statusSuccess}>
                              <CircleCheck className={styles.statusIcon} />
                              Aktywny
                            </span>
                          ) : (
                            <span className={styles.statusDanger}>
                              <CircleX className={styles.statusIcon} />
                              Nieaktywny
                            </span>
                          )}
                        </td>
                        <td>
                          <div className={styles.tableActions}>
                            <button
                              type="button"
                              className={styles.iconButton}
                              onClick={() => handleEdit(schedule)}
                              aria-label={`Edytuj rozkład ${schedule.schedule_id}`}
                            >
                              <Pencil className={styles.buttonIcon} />
                            </button>

                            <button
                              type="button"
                              className={styles.iconButtonDanger}
                              onClick={() => handleDelete(schedule.schedule_id)}
                              aria-label={`Usuń rozkład ${schedule.schedule_id}`}
                            >
                              <Trash2 className={styles.buttonIcon} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="5">
                        <div className={styles.emptyTable}>
                          <AlertCircle className={styles.emptyTableIcon} />
                          <span>Brak zapisanych rozkładów.</span>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
};

export default Schedule;