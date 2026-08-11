import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  Upload,
} from 'lucide-react';
import styles from './Schedule.module.css';

const DAY_TYPES = [
  { key: 'WEEKDAY', label: 'Dzień powszedni' },
  { key: 'WEEKEND', label: 'Weekend' },
  { key: 'HOLIDAY', label: 'Święto' },
];

const generateStopId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const cryptoObj = typeof window !== 'undefined' ? window.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    cryptoObj.getRandomValues(bytes);
    for (let i = 0; i < 8; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
  } else {
    for (let i = 0; i < 8; i += 1) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  }
  return out;
};

const createEmptyStopForm = () => ({
  name: '',
  latitude: '',
  longitude: '',
});

const createEmptyRouteForm = () => ({
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

const parseCoord = (raw) => {
  if (raw === null || raw === undefined) return NaN;
  const cleaned = String(raw).trim().replace(',', '.');
  if (cleaned === '') return NaN;
  return parseFloat(cleaned);
};

const parseStopsCsv = (text) => {
  const errors = [];
  const rows = [];
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    return { rows, errors: ['Plik jest pusty.'] };
  }
  const firstCols = lines[0].split(';');
  const looksLikeHeader =
    firstCols.length >= 3 &&
    (Number.isNaN(parseCoord(firstCols[1])) || Number.isNaN(parseCoord(firstCols[2])));
  const startIdx = looksLikeHeader ? 1 : 0;
  for (let i = startIdx; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const cols = lines[i].split(';');
    if (cols.length < 3) {
      errors.push(`Wiersz ${lineNo}: oczekiwano 3 kolumn (nazwa;szerokość;wysokość).`);
      continue;
    }
    const name = cols[0].trim();
    const latitude = parseCoord(cols[1]);
    const longitude = parseCoord(cols[2]);
    if (!name) {
      errors.push(`Wiersz ${lineNo}: brak nazwy przystanku.`);
      continue;
    }
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      errors.push(`Wiersz ${lineNo} (${name}): współrzędne muszą być liczbami.`);
      continue;
    }
    rows.push({ name, latitude, longitude });
  }
  return { rows, errors };
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
    routes,
    routesLoading,
    fetchRoutes,
    createRoute,
    updateRoute,
    deleteRoute,
    deleteTrip,
    replaceRouteStops,
    vehicles,
    vehiclesLoading,
    fetchVehicles,
    fetchVehicleSchedule,
    fetchVehicleAssignments,
    assignVehicleTrips,
  } = useBackend();

  const [activeTab, setActiveTab] = useState('schedules');
  const [error, setError] = useState(null);

  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopForm, setStopForm] = useState(createEmptyStopForm());
  const [editingStop, setEditingStop] = useState(null);

  const fileInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ done: 0, total: 0 });
  const [importResult, setImportResult] = useState(null);

  const [routeForm, setRouteForm] = useState(createEmptyRouteForm());
  const [savingRoute, setSavingRoute] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [routeStops, setRouteStops] = useState([]);
  const [savingStops, setSavingStops] = useState(false);

  const [assignPcName, setAssignPcName] = useState('');
  const [assignDate, setAssignDate] = useState('');
  const [newTripRouteId, setNewTripRouteId] = useState('');
  const [newTripDayType, setNewTripDayType] = useState('WEEKDAY');
  const [newTripStartTime, setNewTripStartTime] = useState('');
  const [newTripBlockId, setNewTripBlockId] = useState('');
  const [savingTrip, setSavingTrip] = useState(false);
  const [vehicleAssignments, setVehicleAssignments] = useState([]);
  const [vehicleAssignmentsLoading, setVehicleAssignmentsLoading] = useState(false);

  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const loadRoutes = useCallback(async () => {
    try {
      await fetchRoutes();
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać tras.');
    }
  }, [fetchRoutes]);

  const loadVehicles = useCallback(async () => {
    try {
      await fetchVehicles();
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać pojazdów.');
    }
  }, [fetchVehicles]);

  const loadVehicleAssignments = useCallback(async (pcName) => {
    if (!pcName) {
      setVehicleAssignments([]);
      return;
    }
    setVehicleAssignmentsLoading(true);
    try {
      const assignments = await fetchVehicleAssignments(pcName, {
        day_type: newTripDayType,
        date: assignDate || undefined,
      });
      setVehicleAssignments(assignments);
    } catch (err) {
      setError(err.message || 'Nie udało się pobrać kursów pojazdu.');
    } finally {
      setVehicleAssignmentsLoading(false);
    }
  }, [fetchVehicleAssignments, newTripDayType, assignDate]);

  useEffect(() => {
    setError(null);
    loadStops();
    loadRoutes();
    loadVehicles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeTab === 'assignments' && assignPcName) {
      loadVehicleAssignments(assignPcName);
    }
  }, [activeTab, assignPcName, newTripDayType, assignDate, loadVehicleAssignments]);

  const selectedRoute = useMemo(
    () => routes.find((r) => r.id === selectedRouteId) || null,
    [routes, selectedRouteId]
  );

  useEffect(() => {
    if (selectedRoute) {
      const stopsWithMinutes = (selectedRoute.stops || []).map((s) => ({
        stop_id: s.stop_id,
        stop_name: s.name || s.stop_id,
        minutes_from_previous: s.minutes_from_previous ?? 0,
      }));
      setRouteStops(stopsWithMinutes);
    } else {
      setRouteStops([]);
    }
  }, [selectedRoute]);

  const resetStopForm = () => {
    setEditingStop(null);
    setStopForm(createEmptyStopForm());
  };

  const handleEditStop = (stop) => {
    setEditingStop(stop);
    setStopForm({
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
      const basePayload = {
        name: stopForm.name.trim(),
        latitude: parseFloat(stopForm.latitude),
        longitude: parseFloat(stopForm.longitude),
      };
      if (Number.isNaN(basePayload.latitude) || Number.isNaN(basePayload.longitude)) {
        throw new Error('Współrzędne muszą być liczbami.');
      }
      if (editingStop) {
        await api.updateStop(editingStop.id, { id: editingStop.id, ...basePayload });
      } else {
        await api.createStop({ id: generateStopId(), ...basePayload });
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

  const handleImportClick = () => {
    if (importing) return;
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    setError(null);
    let text;
    try {
      text = await file.text();
    } catch (err) {
      window.alert(`Nie udało się odczytać pliku: ${err.message}`);
      return;
    }
    const { rows, errors: parseErrors } = parseStopsCsv(text);
    if (rows.length === 0) {
      window.alert(
        `Nie znaleziono poprawnych wierszy w pliku CSV.` +
          (parseErrors.length ? `\n\nSzczegóły:\n${parseErrors.join('\n')}` : '')
      );
      return;
    }
    const dedupedMap = new Map();
    for (const row of rows) {
      dedupedMap.set(row.name.trim().toLowerCase(), row);
    }
    const deduped = [...dedupedMap.values()];
    if (
      !window.confirm(
        `Znaleziono ${deduped.length} unikalnych przystanków w pliku.\n\n` +
          `Istniejące (dopasowane po nazwie) zostaną zaktualizowane, ` +
          `nowe zostaną dodane, a przystanki spoza pliku pozostaną nietknięte.\n\n` +
          `Kontynuować import?`
      )
    ) {
      return;
    }
    let currentStops = stops;
    try {
      const fresh = await api.getStops();
      currentStops = fresh.stops || [];
      setStops(currentStops);
    } catch {
      // ignore
    }
    const existingByName = new Map();
    for (const s of currentStops) {
      if (s.name) existingByName.set(String(s.name).trim().toLowerCase(), s);
    }
    setImporting(true);
    setImportProgress({ done: 0, total: deduped.length });
    let created = 0;
    let updated = 0;
    let failed = 0;
    const opErrors = [];
    for (let i = 0; i < deduped.length; i += 1) {
      const row = deduped[i];
      const key = row.name.trim().toLowerCase();
      const existing = existingByName.get(key);
      const payload = {
        name: row.name,
        latitude: row.latitude,
        longitude: row.longitude,
      };
      try {
        if (existing) {
          await api.updateStop(existing.id, { id: existing.id, ...payload });
          updated += 1;
        } else {
          await api.createStop({ id: generateStopId(), ...payload });
          created += 1;
        }
      } catch (err) {
        failed += 1;
        opErrors.push(`${row.name}: ${err.message || 'nieznany błąd'}`);
      }
      setImportProgress({ done: i + 1, total: deduped.length });
    }
    setImporting(false);
    setImportResult({
      created,
      updated,
      failed,
      errors: [...parseErrors, ...opErrors],
    });
    await loadStops();
  };

  const handleSubmitRoute = async (e) => {
    e.preventDefault();
    if (!routeForm.name.trim()) {
      window.alert('Podaj nazwę trasy.');
      return;
    }
    setSavingRoute(true);
    try {
      const created = await createRoute({
        name: routeForm.name.trim(),
        code: routeForm.code.trim() || undefined,
        color: routeForm.color || undefined,
        // Nie wysyłamy stops – backend po zmianie przyjmie pustą tablicę
      });
      setRouteForm(createEmptyRouteForm());
      if (created?.id) setSelectedRouteId(created.id);
      await loadRoutes();
    } catch (err) {
      window.alert(`Nie udało się utworzyć trasy: ${err.message}`);
    } finally {
      setSavingRoute(false);
    }
  };

  const handleDeleteRoute = async (id) => {
    if (
      !window.confirm(
        'Usunąć tę trasę? Skasuje to również wszystkie jej przystanki (route_stops) oraz kursy i przypisania pojazdów.'
      )
    )
      return;
    try {
      await deleteRoute(id);
      if (selectedRouteId === id) setSelectedRouteId('');
      await loadRoutes();
    } catch (err) {
      window.alert(`Nie udało się usunąć trasy: ${err.message}`);
    }
  };

  const availableStopsForRoute = useMemo(() => {
    const used = new Set(routeStops.map((rs) => rs.stop_id));
    return stops.filter((s) => !used.has(s.id));
  }, [stops, routeStops]);

  const handleAddRouteStop = (stopId) => {
    if (!stopId) return;
    const stop = stops.find((s) => s.id === stopId);
    if (!stop) return;
    const minutes = routeStops.length === 0 ? 0 : 1;
    setRouteStops((prev) => [
      ...prev,
      {
        stop_id: stop.id,
        stop_name: stop.name,
        minutes_from_previous: minutes,
      },
    ]);
  };

  const handleRemoveRouteStop = (index) => {
    setRouteStops((prev) => prev.filter((_, i) => i !== index));
  };

  const handleRouteStopMinutes = (index, value) => {
    const num = parseInt(value, 10);
    if (Number.isNaN(num) || num < 0) return;
    setRouteStops((prev) =>
      prev.map((rs, i) => (i === index ? { ...rs, minutes_from_previous: num } : rs))
    );
  };

  const moveRouteStop = (index, delta) => {
    setRouteStops((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  };

  const handleSaveRouteStops = async () => {
    if (!selectedRoute) return;
    if (routeStops.length === 0) {
      window.alert('Trasa musi mieć co najmniej jeden przystanek.');
      return;
    }
    if (routeStops[0].minutes_from_previous !== 0) {
      window.alert('Pierwszy przystanek musi mieć czas 0 minut.');
      return;
    }
    for (let i = 1; i < routeStops.length; i++) {
      if (routeStops[i].minutes_from_previous < 0) {
        window.alert('Czasy przejazdu nie mogą być ujemne.');
        return;
      }
    }
    const stopsPayload = routeStops.map((rs) => ({
      stop_id: rs.stop_id,
      minutes_from_previous: rs.minutes_from_previous,
    }));
    setSavingStops(true);
    try {
      await replaceRouteStops(selectedRoute.id, stopsPayload);
      await loadRoutes();
      window.alert('Przystanki trasy zapisane.');
    } catch (err) {
      window.alert(`Nie udało się zapisać przystanków trasy: ${err.message}`);
    } finally {
      setSavingStops(false);
    }
  };

  const resetTripForm = () => {
    setNewTripRouteId('');
    setNewTripStartTime('');
    setNewTripBlockId('');
    setNewTripDayType('WEEKDAY');
  };

  const handleCreateTripForVehicle = async () => {
    const pcName = assignPcName.trim();
    if (!pcName) {
      window.alert('Wybierz pojazd z listy.');
      return;
    }
    if (!newTripRouteId) {
      window.alert('Wybierz trasę.');
      return;
    }
    const startTime = normalizeTimeHHMM(newTripStartTime);
    if (!startTime) {
      window.alert('Podaj poprawną godzinę startu (HH:MM).');
      return;
    }
    setSavingTrip(true);
    try {
      await assignVehicleTrips(pcName, {
        assignments: [
          {
            route_id: newTripRouteId,
            day_type: newTripDayType,
            start_time: startTime,
            block_id: newTripBlockId.trim() || undefined,
          },
        ],
        date: assignDate || undefined,
        replace: false,
      });
      resetTripForm();
      await loadVehicleAssignments(pcName);
      if (preview) {
        const data = await fetchVehicleSchedule(pcName, { date: assignDate || todayKey() });
        setPreview(data);
      }
      window.alert('Dodano kurs do pojazdu.');
    } catch (err) {
      window.alert(`Nie udało się dodać kursu: ${err.message}`);
    } finally {
      setSavingTrip(false);
    }
  };

  const handleDeleteAssignment = async (assignmentId) => {
    if (!window.confirm('Usunąć ten kurs z pojazdu?')) return;
    try {
      await deleteTrip(assignmentId);
      await loadVehicleAssignments(assignPcName);
      if (preview) {
        const data = await fetchVehicleSchedule(assignPcName, { date: assignDate || todayKey() });
        setPreview(data);
      }
    } catch (err) {
      window.alert(`Nie udało się usunąć kursu: ${err.message}`);
    }
  };

  const handleLoadPreview = async () => {
    const pcName = assignPcName.trim();
    if (!pcName) {
      window.alert('Wybierz pojazd z listy.');
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

  return (
    <section className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <p className={styles.headerLabel}>Zarządzanie infrastrukturą</p>
          <h1 className={styles.title}>Trasy, kursy i pojazdy</h1>
          <p className={styles.subtitle}>
            Trasa definiuje kolejność przystanków i czasy przejazdu między nimi (w minutach).
            Kurs to konkretne wykonanie trasy o danej godzinie startu, w określonym typie dnia,
            przypisane do pojazdu. W Dyspozyturze zarządzasz kursami dla każdego pojazdu.
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
            { key: 'schedules', label: 'Trasy', icon: RouteIcon },
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

        {/* ================= TRASY ================= */}
        {activeTab === 'schedules' && (
          <div className={styles.section}>
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Nowa trasa</h2>
                  <p className={styles.cardDescription}>
                    Nadaj nazwę, opcjonalny kod (np. numer linii) i kolor.
                    Po utworzeniu możesz dodać przystanki z czasami przejazdu.
                  </p>
                </div>
              </div>

              <form onSubmit={handleSubmitRoute} className={styles.formGrid}>
                <div>
                  <label className={styles.label}>Nazwa trasy</label>
                  <input
                    className={styles.input}
                    value={routeForm.name}
                    onChange={(e) => setRouteForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="np. Linia 100 – Pętla Zachód"
                    required
                  />
                </div>
                <div>
                  <label className={styles.label}>Kod / numer (opcjonalnie)</label>
                  <input
                    className={styles.input}
                    value={routeForm.code}
                    onChange={(e) => setRouteForm((p) => ({ ...p, code: e.target.value }))}
                    placeholder="np. 100"
                  />
                </div>
                <div>
                  <label className={styles.label}>Kolor</label>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={routeForm.color}
                    onChange={(e) => setRouteForm((p) => ({ ...p, color: e.target.value }))}
                  />
                </div>
                <div>
                  <button type="submit" className={styles.btnPrimary} disabled={savingRoute}>
                    {savingRoute ? <LoaderCircle size={16} className={styles.spinner} /> : <Save size={16} />}
                    Utwórz
                  </button>
                </div>
              </form>
            </div>

            <div className={styles.twoColumn}>
              <div className={styles.card}>
                <div className={styles.cardHeader}>
                  <div>
                    <h2 className={styles.cardTitle}>Trasy</h2>
                    <p className={styles.cardDescription}>Wybierz trasę, aby skonfigurować jej przystanki.</p>
                  </div>
                </div>

                {routesLoading ? (
                  <div className={styles.loading}>
                    <LoaderCircle size={16} className={styles.spinner} />
                    Ładowanie tras…
                  </div>
                ) : routes.length === 0 ? (
                  <div className={styles.emptyState}>Nie ma jeszcze żadnej trasy. Utwórz pierwszą powyżej.</div>
                ) : (
                  <div className={styles.scheduleList}>
                    {routes.map((r) => {
                      const active = r.id === selectedRouteId;
                      const stopCount = (r.stops || []).length;
                      return (
                        <div
                          key={r.id}
                          className={`${styles.scheduleItem} ${active ? styles.scheduleItemActive : styles.scheduleItemInactive}`}
                        >
                          <button className={styles.scheduleItemButton} onClick={() => setSelectedRouteId(r.id)}>
                            <span className={styles.colorDot} style={{ backgroundColor: r.color || '#3B82F6' }} />
                            <span className={styles.scheduleName}>{r.name}</span>
                            {r.code && <span className={styles.scheduleDirection}>{r.code}</span>}
                            <span className={styles.extendedBadge}>{stopCount} przyst.</span>
                          </button>
                          <button
                            className={styles.btnIconDanger}
                            onClick={() => handleDeleteRoute(r.id)}
                            title="Usuń trasę"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {selectedRoute && (
                <div className={styles.card}>
                  <div className={styles.cardHeader}>
                    <div>
                      <h2 className={styles.cardTitle}>
                        <RouteIcon size={18} className={styles.iconPrimary} />
                        Przystanki trasy
                      </h2>
                      <p className={styles.cardDescription}>
                        Kolejność przystanków oraz czasy dojazdu (w minutach od poprzedniego przystanku).
                        Pierwszy przystanek ma czas 0.
                      </p>
                    </div>
                  </div>

                  <div className={styles.addStopRow}>
                    <div className={styles.selectWrapper}>
                      <select
                        className={styles.select}
                        value=""
                        onChange={(e) => {
                          handleAddRouteStop(e.target.value);
                          e.target.value = '';
                        }}
                      >
                        <option value="">— dodaj przystanek —</option>
                        {availableStopsForRoute.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.id})
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} className={styles.selectIcon} />
                    </div>
                  </div>

                  {routeStops.length === 0 ? (
                    <div className={styles.emptyState}>
                      <MapPinned size={32} className={styles.emptyIcon} />
                      <p className={styles.emptyTitle}>Brak przystanków w tej trasie</p>
                      <p className={styles.emptyDescription}>Dodaj przystanki i ustaw czasy przejazdu.</p>
                    </div>
                  ) : (
                    <ul className={styles.stopList}>
                      {routeStops.map((rs, idx) => (
                        <li key={`${rs.stop_id}-${idx}`} className={styles.stopItem}>
                          <span className={styles.stopIndex}>{idx + 1}</span>
                          <div className={styles.stopInfo}>
                            <p className={styles.stopName}>{rs.stop_name || rs.stop_id}</p>
                            <p className={styles.stopId}>{rs.stop_id}</p>
                          </div>
                          <div className={styles.stopTime}>
                            <Clock3 size={14} className={styles.inputIcon} />
                            <input
                              type="number"
                              min="0"
                              step="1"
                              className={styles.stopTimeInput}
                              value={rs.minutes_from_previous}
                              onChange={(e) => handleRouteStopMinutes(idx, e.target.value)}
                              title="Czas od poprzedniego przystanku (minuty)"
                              disabled={idx === 0}
                            />
                            <span style={{ fontSize: '0.8rem', marginLeft: '4px' }}>min</span>
                          </div>
                          <div className={styles.stopMove}>
                            <button className={styles.btnIcon} onClick={() => moveRouteStop(idx, -1)} disabled={idx === 0}>
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
                          <button className={styles.btnIconDanger} onClick={() => handleRemoveRouteStop(idx)}>
                            <Trash2 size={16} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className={styles.buttonGroup}>
                    <button className={styles.btnPrimary} onClick={handleSaveRouteStops} disabled={savingStops}>
                      {savingStops ? <LoaderCircle size={16} className={styles.spinner} /> : <Save size={16} />}
                      Zapisz przystanki trasy
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= PRZYSTANKI ================= */}
        {activeTab === 'stops' && (
          <div className={styles.twoColumn}>
            <div className={styles.card}>
              <h2 className={styles.cardTitle}>{editingStop ? 'Edytuj przystanek' : 'Nowy przystanek'}</h2>
              <p className={styles.cardDescription}>
                {editingStop
                  ? 'Zmień nazwę lub współrzędne. Identyfikator przystanku jest nadany automatycznie i nie podlega edycji.'
                  : 'Podaj nazwę i współrzędne geograficzne. Identyfikator zostanie wygenerowany automatycznie.'}
              </p>
              <form onSubmit={handleSubmitStop} className={styles.stopForm}>
                <div className={styles.stopFormGrid}>
                  {editingStop && (
                    <div>
                      <label className={styles.label}>ID przystanku (nadane automatycznie)</label>
                      <input className={styles.input} value={editingStop.id} readOnly disabled />
                    </div>
                  )}
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

              <div className={styles.preview} style={{ marginTop: '1.5rem' }}>
                <div className={styles.previewHeader}>
                  <span className={styles.previewTitle}>
                    <Upload size={16} />
                    Import przystanków z CSV
                  </span>
                </div>
                <p className={styles.cardDescription}>
                  Format: <code>nazwa;szerokość;wysokość</code> (separator średnik, pierwszy
                  wiersz nagłówka jest pomijany). Istniejące przystanki o tej samej nazwie
                  zostaną zaktualizowane (współrzędne), nowe zostaną dodane, a przystanki
                  spoza pliku pozostaną nietknięte.
                </p>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={handleImportFile}
                />

                <div className={styles.buttonGroup}>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    onClick={handleImportClick}
                    disabled={importing}
                  >
                    {importing ? (
                      <>
                        <LoaderCircle size={16} className={styles.spinner} />
                        Importowanie… ({importProgress.done}/{importProgress.total})
                      </>
                    ) : (
                      <>
                        <Upload size={16} />
                        Zaimportuj CSV z przystankami
                      </>
                    )}
                  </button>
                </div>

                {importing && importProgress.total > 0 && (
                  <div
                    style={{
                      marginTop: '0.75rem',
                      height: 8,
                      borderRadius: 4,
                      background: 'rgba(0,0,0,0.08)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        height: '100%',
                        width: `${Math.round((importProgress.done / importProgress.total) * 100)}%`,
                        background: '#3B82F6',
                        transition: 'width 0.15s ease',
                      }}
                    />
                  </div>
                )}

                {importResult && !importing && (
                  <div className={styles.previewEmpty} style={{ marginTop: '0.75rem' }}>
                    <div>
                      Import zakończony: dodano <strong>{importResult.created}</strong>,
                      zaktualizowano <strong>{importResult.updated}</strong>
                      {importResult.failed > 0 && (
                        <>
                          , błędów <strong>{importResult.failed}</strong>
                        </>
                      )}
                      .
                    </div>
                    {importResult.errors.length > 0 && (
                      <ul style={{ marginTop: '0.5rem', paddingLeft: '1.25rem' }}>
                        {importResult.errors.slice(0, 15).map((msg, i) => (
                          <li key={i}>{msg}</li>
                        ))}
                        {importResult.errors.length > 15 && (
                          <li>…oraz {importResult.errors.length - 15} więcej.</li>
                        )}
                      </ul>
                    )}
                  </div>
                )}
              </div>
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
                    Zarządzanie kursami pojazdu
                  </h2>
                  <p className={styles.cardDescription}>
                    Wybierz pojazd, aby zobaczyć jego aktualne kursy. Możesz dodawać nowe kursy
                    (przypisania trasy o konkretnej godzinie) lub usuwać istniejące.
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
                      Brak zarejestrowanych pojazdów w systemie. Pojazdy pojawią się automatycznie po wysłaniu pierwszej
                      ramki danych (IsarsoftData).
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
                  <input
                    type="date"
                    className={styles.input}
                    value={assignDate}
                    onChange={(e) => setAssignDate(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.dayTypeTabs}>
                {DAY_TYPES.map((d) => {
                  const active = newTripDayType === d.key;
                  return (
                    <button
                      key={d.key}
                      onClick={() => setNewTripDayType(d.key)}
                      className={`${styles.dayTypeTab} ${active ? styles.dayTypeTabActive : styles.dayTypeTabInactive}`}
                    >
                      <CalendarClock size={16} />
                      {d.label}
                    </button>
                  );
                })}
              </div>

              <div className={styles.preview} style={{ marginTop: '1rem' }}>
                <div className={styles.previewHeader}>
                  <span className={styles.previewTitle}>
                    <ListChecks size={16} />
                    Kursy pojazdu {assignPcName ? `„${assignPcName}”` : ''}
                  </span>
                  <span className={styles.previewBadge}>{vehicleAssignments.length}</span>
                </div>
                {vehicleAssignmentsLoading ? (
                  <div className={styles.loading}>
                    <LoaderCircle size={16} className={styles.spinner} />
                    Ładowanie kursów…
                  </div>
                ) : vehicleAssignments.length === 0 ? (
                  <p className={styles.previewEmpty}>
                    {assignPcName
                      ? 'Brak kursów dla tego pojazdu w wybranym typie dnia i dacie.'
                      : 'Wybierz pojazd, aby zobaczyć jego kursy.'}
                  </p>
                ) : (
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr className={styles.tableHead}>
                          <th>Trasa</th>
                          <th>Start</th>
                          <th>Brygada</th>
                          <th>Akcje</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vehicleAssignments.map((ass) => {
                          const route = routes.find((r) => r.id === ass.route_id);
                          return (
                            <tr key={ass.id} className={styles.tableRow}>
                              <td className={styles.tableCell}>
                                {route ? route.name : ass.route_id}
                                {route?.code && ` (${route.code})`}
                              </td>
                              <td className={styles.tableCell}>{ass.start_time}</td>
                              <td className={styles.tableCell}>{ass.block_id || '—'}</td>
                              <td className={styles.tableCell}>
                                <button
                                  className={styles.btnIconDanger}
                                  onClick={() => handleDeleteAssignment(ass.id)}
                                >
                                  <Trash2 size={16} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className={styles.card} style={{ marginTop: '1.5rem' }}>
                <h3 className={styles.cardTitle}>Dodaj nowy kurs</h3>
                <div className={styles.stopFormGrid}>
                  <div>
                    <label className={styles.label}>Trasa</label>
                    <div className={styles.selectWrapper}>
                      <select
                        className={styles.select}
                        value={newTripRouteId}
                        onChange={(e) => setNewTripRouteId(e.target.value)}
                      >
                        <option value="">— wybierz trasę —</option>
                        {routes.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}{r.code ? ` (${r.code})` : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} className={styles.selectIcon} />
                    </div>
                  </div>
                  <div>
                    <label className={styles.label}>Godzina startu (HH:MM)</label>
                    <input
                      type="time"
                      className={styles.input}
                      value={newTripStartTime}
                      onChange={(e) => setNewTripStartTime(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className={styles.label}>Brygada / blok (opcjonalnie)</label>
                    <input
                      className={styles.input}
                      value={newTripBlockId}
                      onChange={(e) => setNewTripBlockId(e.target.value)}
                      placeholder="np. B1"
                    />
                  </div>
                </div>
                <div className={styles.buttonGroup}>
                  <button
                    className={styles.btnPrimary}
                    onClick={handleCreateTripForVehicle}
                    disabled={savingTrip || !assignPcName}
                  >
                    {savingTrip ? (
                      <>
                        <LoaderCircle size={16} className={styles.spinner} />
                        Dodawanie…
                      </>
                    ) : (
                      <>
                        <Plus size={16} />
                        Dodaj kurs
                      </>
                    )}
                  </button>
                  <button className={styles.btnSecondary} onClick={resetTripForm}>
                    <RotateCcw size={16} />
                    Wyczyść
                  </button>
                </div>
              </div>

              <div className={styles.buttonGroup} style={{ marginTop: '1rem' }}>
                <button
                  className={styles.btnPrimary}
                  onClick={handleLoadPreview}
                  disabled={previewLoading || !assignPcName}
                >
                  {previewLoading ? (
                    <LoaderCircle size={16} className={styles.spinner} />
                  ) : (
                    <ListChecks size={16} />
                  )}
                  Podgląd harmonogramu pojazdu
                </button>
              </div>
            </div>

            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div>
                  <h2 className={styles.cardTitle}>Harmonogram pojazdu</h2>
                  <p className={styles.cardDescription}>
                    Rozwinięty rozkład dnia dla pojazdu {preview?.pcName ? `„${preview.pcName}”` : ''}
                    {preview?.date ? ` (${preview.date})` : ''} – każdy przystanek z wyliczoną godziną.
                  </p>
                </div>
              </div>

              {previewLoading ? (
                <div className={styles.loading}>
                  <LoaderCircle size={16} className={styles.spinner} />
                  Ładowanie harmonogramu…
                </div>
              ) : !preview || (preview.trips || []).length === 0 ? (
                <div className={styles.timelineEmpty}>
                  {assignPcName
                    ? 'Brak przypisanych kursów dla tego pojazdu w wybranym dniu.'
                    : 'Wybierz pojazd i kliknij „Podgląd harmonogramu pojazdu”.'}
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
                                Kurs {idx + 1}: {firstStop?.planned_time || trip.start_time} –{' '}
                                {lastStop?.planned_time || '—'}
                              </span>
                              <span className={styles.tripRowBadge}>
                                {trip.line_number || trip.route_id}
                              </span>
                              {trip.block_id && <span className={styles.tripRowBadge}>{trip.block_id}</span>}
                            </div>
                            <div className={styles.timelineTripStops}>
                              {(trip.stops || [])
                                .map((s) => `${s.name || s.stop_id} (${s.planned_time})`)
                                .join(' → ')}
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
                  <p className={styles.cardDescription}>
                    Pojazdy widoczne w systemie (zgłoszone przez pokładowy komputer).
                  </p>
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