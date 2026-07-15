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
  Bus,
  TramFront,
} from 'lucide-react';

const DAY_TYPES = [
  { key: 'WEEKDAY', label: 'Dzień powszedni' },
  { key: 'WEEKEND', label: 'Weekend' },
  { key: 'HOLIDAY', label: 'Święto' },
];

const DIRECTION_LABELS = {
  FROM_START: 'Tam (od pętli)',
  TO_START: 'Powrót (do pętli)',
};

const LINE_TYPE_LABELS = {
  bus: 'Autobus',
  tram: 'Tramwaj',
  trolley: 'Trolejbus',
  train: 'Kolej',
  metro: 'Metro',
};

const createEmptyStopForm = () => ({
  id: '',
  name: '',
  latitude: '',
  longitude: '',
});

const createEmptyLineForm = () => ({
  number: '',
  type: 'bus',
});

const createEmptyRouteForm = () => ({
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

const LineTypeIcon = ({ type, className }) => {
  if (type === 'tram') return <TramFront className={className} />;
  return <Bus className={className} />;
};

const Schedule = () => {
  const { api } = useBackend();

  const [activeTab, setActiveTab] = useState('routes');
  const [error, setError] = useState(null);

  // ---------- PRZYSTANKI ----------
  const [stops, setStops] = useState([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopForm, setStopForm] = useState(createEmptyStopForm());
  const [editingStop, setEditingStop] = useState(null);

  // ---------- LINIE ----------
  const [lines, setLines] = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [lineForm, setLineForm] = useState(createEmptyLineForm());
  const [showLineForm, setShowLineForm] = useState(false);

  // ---------- TRASY ----------
  const [routes, setRoutes] = useState([]);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [selectedLineId, setSelectedLineId] = useState('');
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [routeForm, setRouteForm] = useState(createEmptyRouteForm());
  const [showRouteForm, setShowRouteForm] = useState(false);

  // ---------- PRZYSTANKI NA TRASIE ----------
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
      setError(err.message || 'Błąd ładowania przystanków.');
    } finally {
      setStopsLoading(false);
    }
  }, [api]);

  const loadLines = useCallback(async () => {
    setLinesLoading(true);
    try {
      const data = await api.getLines();
      setLines(data.lines || []);
    } catch (err) {
      setError(err.message || 'Błąd ładowania linii.');
    } finally {
      setLinesLoading(false);
    }
  }, [api]);

  const loadRoutes = useCallback(
    async (lineId) => {
      if (!lineId) {
        setRoutes([]);
        return;
      }
      setRoutesLoading(true);
      try {
        const data = await api.getRoutes({ line_id: lineId });
        setRoutes(data.routes || []);
      } catch (err) {
        setError(err.message || 'Błąd ładowania tras.');
      } finally {
        setRoutesLoading(false);
      }
    },
    [api]
  );

  const loadRouteStops = useCallback(
    async (routeId) => {
      if (!routeId) {
        setRouteStops([]);
        return;
      }
      setRouteStopsLoading(true);
      try {
        const data = await api.getRouteStops(routeId);
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
        setError(err.message || 'Błąd ładowania przystanków trasy.');
      } finally {
        setRouteStopsLoading(false);
      }
    },
    [api]
  );

  const loadScheduleTrips = useCallback(
    async (routeId, dayType) => {
      if (!routeId) {
        setScheduleTrips([]);
        return;
      }
      setTripsLoading(true);
      try {
        const data = await api.getScheduleTrips({
          route_id: routeId,
          day_type: dayType,
        });
        const sorted = (data.trips || [])
          .slice()
          .sort((a, b) =>
            String(a.departure_time).localeCompare(String(b.departure_time))
          );
        setScheduleTrips(sorted);
      } catch (err) {
        setError(err.message || 'Błąd ładowania kursów.');
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
      setError(err.message || 'Błąd ładowania pojazdów.');
    } finally {
      setVehiclesLoading(false);
    }
  }, [api]);

  useEffect(() => {
    setError(null);
    loadStops();
    loadLines();
    loadVehicles();
  }, [loadStops, loadLines, loadVehicles]);

  useEffect(() => {
    loadRoutes(selectedLineId);
    setSelectedRouteId('');
    setRouteStops([]);
    setScheduleTrips([]);
    setPreviewStop(null);
  }, [selectedLineId, loadRoutes]);

  useEffect(() => {
    if (selectedRouteId) {
      loadRouteStops(selectedRouteId);
      loadScheduleTrips(selectedRouteId, selectedDayType);
      setPreviewStop(null);
    } else {
      setRouteStops([]);
      setScheduleTrips([]);
    }
  }, [selectedRouteId, loadRouteStops, loadScheduleTrips, selectedDayType]);

  const selectedRoute = useMemo(
    () => routes.find((r) => r.id === selectedRouteId) || null,
    [routes, selectedRouteId]
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
      window.alert(`Błąd zapisu przystanku: ${err.message}`);
    }
  };

  const updateStopField = (field, value) => {
    setStopForm((prev) => ({ ...prev, [field]: value }));
  };

  // =================== LINIE ===================
  const handleSubmitLine = async (e) => {
    e.preventDefault();
    try {
      const created = await api.createLine({
        number: lineForm.number.trim(),
        type: lineForm.type,
      });
      setLineForm(createEmptyLineForm());
      setShowLineForm(false);
      await loadLines();
      if (created?.line?.id) setSelectedLineId(created.line.id);
    } catch (err) {
      window.alert(`Błąd zapisu linii: ${err.message}`);
    }
  };

  const handleDeleteLine = async (id) => {
    if (
      !window.confirm(
        `Usunąć linię ${id}? Skasuje to również jej trasy i kursy.`
      )
    )
      return;
    try {
      await api.deleteLine(id);
      if (selectedLineId === id) setSelectedLineId('');
      await loadLines();
    } catch (err) {
      window.alert(`Błąd usuwania linii: ${err.message}`);
    }
  };

  // =================== TRASY ===================
  const handleSubmitRoute = async (e) => {
    e.preventDefault();
    if (!selectedLineId) {
      window.alert('Najpierw wybierz linię.');
      return;
    }
    try {
      const created = await api.createRoute({
        line_id: selectedLineId,
        name: routeForm.name.trim(),
        direction: routeForm.direction,
        is_extended: routeForm.is_extended,
      });
      setRouteForm(createEmptyRouteForm());
      setShowRouteForm(false);
      await loadRoutes(selectedLineId);
      if (created?.route?.id) setSelectedRouteId(created.route.id);
    } catch (err) {
      window.alert(`Błąd zapisu trasy: ${err.message}`);
    }
  };

  const handleDeleteRoute = async (id) => {
    if (
      !window.confirm(`Usunąć trasę ${id}? Skasuje to jej przystanki i kursy.`)
    )
      return;
    try {
      await api.deleteRoute(id);
      if (selectedRouteId === id) setSelectedRouteId('');
      await loadRoutes(selectedLineId);
    } catch (err) {
      window.alert(`Błąd usuwania trasy: ${err.message}`);
    }
  };

  // =================== PRZYSTANKI NA TRASIE ===================
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
    if (!selectedRouteId) return;
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
      await api.setRouteStops(selectedRouteId, payload);
      await loadRouteStops(selectedRouteId);
      window.alert('Układ trasy zapisany.');
    } catch (err) {
      window.alert(`Błąd zapisu układu trasy: ${err.message}`);
    } finally {
      setSavingRouteStops(false);
    }
  };

  const handleCopyFromOtherRoute = async () => {
    if (!selectedRouteId) return;
    const others = routes.filter((r) => r.id !== selectedRouteId);
    if (others.length === 0) {
      window.alert('Brak innej trasy w tej linii do skopiowania.');
      return;
    }
    const list = others
      .map((r, i) => `${i + 1}. ${r.name} [${DIRECTION_LABELS[r.direction]}]`)
      .join('\n');
    const answer = window.prompt(
      `Z której trasy skopiować przystanki? Podaj numer:\n${list}`,
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
      'Odwrócić kolejność i czasy (trasa powrotna)? OK = tak, Anuluj = kopiuj 1:1.'
    );
    try {
      await api.copyDirection(source.id, {
        target_route_id: selectedRouteId,
        reverse,
      });
      await loadRouteStops(selectedRouteId);
      window.alert('Skopiowano przystanki.');
    } catch (err) {
      window.alert(`Błąd kopiowania: ${err.message}`);
    }
  };

  // =================== KURSY ===================
  const handleAddTrip = async (e) => {
    e.preventDefault();
    if (!selectedRouteId) {
      window.alert('Najpierw wybierz trasę.');
      return;
    }
    setAddingTrip(true);
    try {
      await api.createScheduleTrip({
        route_id: selectedRouteId,
        day_type: selectedDayType,
        departure_time: normalizeTimeHHMM(newDepartureTime),
      });
      await loadScheduleTrips(selectedRouteId, selectedDayType);
    } catch (err) {
      window.alert(`Błąd dodawania kursu: ${err.message}`);
    } finally {
      setAddingTrip(false);
    }
  };

  const handleDeleteTrip = async (tripId) => {
    try {
      await api.deleteScheduleTrip(tripId);
      await loadScheduleTrips(selectedRouteId, selectedDayType);
    } catch (err) {
      window.alert(`Błąd usuwania kursu: ${err.message}`);
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
  const handleUpdateVehicleRoute = async (pcName, routeId) => {
    try {
      await api.updateVehicle(pcName, { route_id: routeId || '' });
      await loadVehicles();
    } catch (err) {
      window.alert(`Błąd aktualizacji pojazdu: ${err.message}`);
    }
  };

  const allRoutesFlat = useMemo(() => routes, [routes]);

  // =================== RENDER ===================
  const btnPrimary =
    'inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50';
  const btnSecondary =
    'inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50';
  const btnIcon =
    'inline-flex items-center justify-center rounded-md p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30';
  const btnIconDanger =
    'inline-flex items-center justify-center rounded-md p-2 text-red-500 transition hover:bg-red-50 hover:text-red-700';
  const inputCls =
    'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100';
  const labelCls = 'mb-1 block text-xs font-medium text-slate-600';
  const cardCls = 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm';

  return (
    <section className="min-h-screen bg-slate-50 p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
            Zarządzanie infrastrukturą
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-900">
            Konfiguracja rozkładów
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Linie, warianty tras (w tym powrotne i wydłużone), przystanki na
            trasie, kursy oraz przypisanie do pojazdów.
          </p>
        </header>

        {error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {[
            { key: 'routes', label: 'Trasy i rozkłady', icon: RouteIcon },
            { key: 'stops', label: 'Przystanki', icon: MapPin },
            { key: 'vehicles', label: 'Pojazdy', icon: Truck },
          ].map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                  active
                    ? 'bg-indigo-600 text-white shadow'
                    : 'bg-white text-slate-600 hover:bg-slate-100'
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* ================= TRASY I ROZKŁADY ================= */}
        {activeTab === 'routes' && (
          <div className="space-y-6">
            <div className={cardCls}>
              <div className="flex flex-col gap-4 md:flex-row md:items-end">
                <div className="flex-1">
                  <label className={labelCls}>Linia</label>
                  <div className="relative">
                    <select
                      className={`${inputCls} appearance-none pr-9`}
                      value={selectedLineId}
                      onChange={(e) => setSelectedLineId(e.target.value)}
                    >
                      <option value="">— wybierz linię —</option>
                      {lines.map((l) => (
                        <option key={l.id} value={l.id}>
                          {LINE_TYPE_LABELS[l.type] || l.type} {l.number}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    className={btnSecondary}
                    onClick={() => setShowLineForm((v) => !v)}
                  >
                    <Plus className="h-4 w-4" />
                    Nowa linia
                  </button>
                  {selectedLineId && (
                    <button
                      className={btnIconDanger}
                      onClick={() => handleDeleteLine(selectedLineId)}
                      title="Usuń linię"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {showLineForm && (
                <form
                  onSubmit={handleSubmitLine}
                  className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-4 md:grid-cols-3"
                >
                  <div>
                    <label className={labelCls}>Numer</label>
                    <input
                      className={inputCls}
                      value={lineForm.number}
                      onChange={(e) =>
                        setLineForm((p) => ({ ...p, number: e.target.value }))
                      }
                      required
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Typ</label>
                    <div className="relative">
                      <select
                        className={`${inputCls} appearance-none pr-9`}
                        value={lineForm.type}
                        onChange={(e) =>
                          setLineForm((p) => ({ ...p, type: e.target.value }))
                        }
                      >
                        {Object.entries(LINE_TYPE_LABELS).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    </div>
                  </div>
                  <div className="flex items-end">
                    <button type="submit" className={btnPrimary}>
                      <Save className="h-4 w-4" />
                      Zapisz linię
                    </button>
                  </div>
                </form>
              )}
            </div>

            {selectedLineId && (
              <div className={cardCls}>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-slate-900">
                      Warianty tras
                    </h2>
                    <p className="text-sm text-slate-500">
                      Wybierz wariant (kierunek / trasa wydłużona) do edycji.
                    </p>
                  </div>
                  <button
                    className={btnSecondary}
                    onClick={() => setShowRouteForm((v) => !v)}
                  >
                    <Plus className="h-4 w-4" />
                    Nowy wariant
                  </button>
                </div>

                {showRouteForm && (
                  <form
                    onSubmit={handleSubmitRoute}
                    className="mb-4 grid gap-3 rounded-xl bg-slate-50 p-4 md:grid-cols-4"
                  >
                    <div className="md:col-span-2">
                      <label className={labelCls}>Nazwa trasy</label>
                      <input
                        className={inputCls}
                        value={routeForm.name}
                        onChange={(e) =>
                          setRouteForm((p) => ({ ...p, name: e.target.value }))
                        }
                        placeholder="np. Dworzec → Lotnisko"
                        required
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Kierunek</label>
                      <div className="relative">
                        <select
                          className={`${inputCls} appearance-none pr-9`}
                          value={routeForm.direction}
                          onChange={(e) =>
                            setRouteForm((p) => ({
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
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      </div>
                    </div>
                    <div className="flex items-end justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-300"
                          checked={routeForm.is_extended}
                          onChange={(e) =>
                            setRouteForm((p) => ({
                              ...p,
                              is_extended: e.target.checked,
                            }))
                          }
                        />
                        Wydłużona
                      </label>
                      <button type="submit" className={btnPrimary}>
                        <Save className="h-4 w-4" />
                        Zapisz
                      </button>
                    </div>
                  </form>
                )}

                {routesLoading ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    Ładowanie tras…
                  </div>
                ) : routes.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                    Brak tras dla tej linii. Dodaj pierwszy wariant.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {routes.map((r) => {
                      const active = r.id === selectedRouteId;
                      return (
                        <div
                          key={r.id}
                          className={`group flex items-center gap-2 rounded-xl border px-3 py-2 transition ${
                            active
                              ? 'border-indigo-500 bg-indigo-50'
                              : 'border-slate-200 bg-white hover:border-slate-300'
                          }`}
                        >
                          <button
                            className="flex items-center gap-2 text-left"
                            onClick={() => setSelectedRouteId(r.id)}
                          >
                            <RouteIcon
                              className={`h-4 w-4 ${
                                active ? 'text-indigo-600' : 'text-slate-400'
                              }`}
                            />
                            <span className="text-sm font-medium text-slate-800">
                              {r.name}
                            </span>
                            <span className="text-xs text-slate-500">
                              {DIRECTION_LABELS[r.direction]}
                            </span>
                            {r.is_extended && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                                <Sparkles className="h-3 w-3" />
                                Trasa wydłużona
                              </span>
                            )}
                          </button>
                          <button
                            className={btnIconDanger}
                            onClick={() => handleDeleteRoute(r.id)}
                            title="Usuń trasę"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {selectedRoute && (
              <div className="grid gap-6 lg:grid-cols-2">
                {/* EDYTOR PRZYSTANKÓW TRASY */}
                <div className={cardCls}>
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                        <ListOrdered className="h-5 w-5 text-indigo-600" />
                        Przystanki trasy
                      </h2>
                      <p className="text-sm text-slate-500">
                        {selectedRoute.name} · {DIRECTION_LABELS[selectedRoute.direction]}
                        {selectedRoute.is_extended ? ' · wydłużona' : ''}
                      </p>
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap gap-2">
                    <button
                      className={btnSecondary}
                      onClick={handleCopyFromOtherRoute}
                    >
                      <Copy className="h-4 w-4" />
                      Kopiuj z innej trasy (z odwróceniem)
                    </button>
                  </div>

                  <div className="mb-4 flex gap-2">
                    <div className="relative flex-1">
                      <select
                        className={`${inputCls} appearance-none pr-9`}
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
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    </div>
                    <button
                      className={btnSecondary}
                      onClick={handleAddStopToRoute}
                      disabled={!addStopId}
                    >
                      <Plus className="h-4 w-4" />
                      Dodaj
                    </button>
                  </div>

                  {routeStopsLoading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Ładowanie…
                    </div>
                  ) : routeStops.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-300 p-8 text-center">
                      <MapPinned className="h-8 w-8 text-slate-300" />
                      <p className="text-sm font-medium text-slate-600">
                        Brak przystanków na trasie
                      </p>
                      <p className="text-xs text-slate-400">
                        Dodaj przystanki i zapisz układ.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {routeStops.map((rs, idx) => (
                        <li
                          key={`${rs.stop_id}-${idx}`}
                          className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-2"
                        >
                          <button
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-600"
                            onClick={() => setPreviewStop(rs.stop_id)}
                            title="Podgląd odjazdów pasażera"
                          >
                            {idx + 1}
                          </button>
                          <button
                            className="min-w-0 flex-1 text-left"
                            onClick={() => setPreviewStop(rs.stop_id)}
                          >
                            <p className="truncate text-sm font-medium text-slate-800">
                              {rs.stop_name || rs.stop_id}
                            </p>
                            <p className="truncate text-xs text-slate-400">
                              {rs.stop_id}
                            </p>
                          </button>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0"
                              className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus:border-indigo-500"
                              value={rs.travel_time_from_start}
                              onChange={(e) =>
                                handleRouteStopTravelTime(idx, e.target.value)
                              }
                              title="Czas dojazdu od pętli (min)"
                            />
                            <span className="text-xs text-slate-400">min</span>
                          </div>
                          <div className="flex flex-col">
                            <button
                              className={btnIcon}
                              onClick={() => moveRouteStop(idx, -1)}
                              disabled={idx === 0}
                            >
                              <ArrowUpDown className="h-3.5 w-3.5" />
                            </button>
                            <button
                              className={btnIcon}
                              onClick={() => moveRouteStop(idx, 1)}
                              disabled={idx === routeStops.length - 1}
                            >
                              <ArrowUpDown
                                className="h-3.5 w-3.5"
                                style={{ transform: 'rotate(180deg)' }}
                              />
                            </button>
                          </div>
                          <button
                            className={btnIconDanger}
                            onClick={() => handleRemoveRouteStop(idx)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-4 flex gap-2">
                    <button
                      className={btnPrimary}
                      onClick={handleSaveRouteStops}
                      disabled={savingRouteStops}
                    >
                      {savingRouteStops ? (
                        <>
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                          Zapisywanie…
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4" />
                          Zapisz układ trasy
                        </>
                      )}
                    </button>
                    <button
                      className={btnSecondary}
                      onClick={() => loadRouteStops(selectedRouteId)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      Przywróć
                    </button>
                  </div>

                  {previewStop && (
                    <div className="mt-5 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-indigo-900">
                          <Clock3 className="h-4 w-4" />
                          Odjazdy z: {previewStopName}
                        </h3>
                        <button
                          className="text-xs text-indigo-600 hover:underline"
                          onClick={() => setPreviewStop(null)}
                        >
                          Zamknij
                        </button>
                      </div>
                      <p className="mb-2 text-xs text-indigo-700">
                        {DAY_TYPES.find((d) => d.key === selectedDayType)?.label}{' '}
                        · wyliczone: odjazd z pętli + czas dojazdu
                      </p>
                      {previewDepartures.length === 0 ? (
                        <p className="text-sm text-indigo-700">
                          Brak kursów dla tego typu dnia.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {previewDepartures.map((t, i) => (
                            <span
                              key={`${t}-${i}`}
                              className="rounded-lg bg-white px-2.5 py-1 text-sm font-medium text-indigo-800 shadow-sm"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* KURSY */}
                <div className={cardCls}>
                  <div className="mb-4">
                    <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-900">
                      <CalendarClock className="h-5 w-5 text-indigo-600" />
                      Kursy (odjazdy z pętli)
                    </h2>
                    <p className="text-sm text-slate-500">
                      Godziny odjazdu pierwszego przystanku dla wybranego typu
                      dnia.
                    </p>
                  </div>

                  <div className="mb-4 flex flex-wrap gap-2">
                    {DAY_TYPES.map((d) => {
                      const active = selectedDayType === d.key;
                      return (
                        <button
                          key={d.key}
                          onClick={() => setSelectedDayType(d.key)}
                          className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${
                            active
                              ? 'bg-indigo-600 text-white'
                              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                          }`}
                        >
                          <CalendarClock className="h-4 w-4" />
                          {d.label}
                        </button>
                      );
                    })}
                  </div>

                  <form onSubmit={handleAddTrip} className="mb-4 flex gap-2">
                    <div className="relative flex-1">
                      <Clock3 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        type="time"
                        className={`${inputCls} pl-9`}
                        value={newDepartureTime}
                        onChange={(e) => setNewDepartureTime(e.target.value)}
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      className={btnPrimary}
                      disabled={addingTrip}
                    >
                      {addingTrip ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )}
                      Dodaj kurs
                    </button>
                  </form>

                  {tripsLoading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                      Ładowanie kursów…
                    </div>
                  ) : scheduleTrips.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
                      Brak kursów dla tego typu dnia.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {scheduleTrips.map((trip) => (
                        <div
                          key={trip.id}
                          className="group inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white py-1.5 pl-3 pr-1.5 text-sm"
                        >
                          <span className="font-medium text-slate-800">
                            {normalizeTimeHHMM(trip.departure_time)}
                          </span>
                          <button
                            className="rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                            onClick={() => handleDeleteTrip(trip.id)}
                            title="Usuń kurs"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
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
          <div className="grid gap-6 lg:grid-cols-2">
            <div className={cardCls}>
              <h2 className="text-lg font-semibold text-slate-900">
                {editingStop ? 'Edytuj przystanek' : 'Dodaj nowy przystanek'}
              </h2>
              <p className="mb-4 text-sm text-slate-500">
                Unikalne ID, nazwa i współrzędne geograficzne.
              </p>
              <form onSubmit={handleSubmitStop} className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>ID przystanku</label>
                    <input
                      className={inputCls}
                      value={stopForm.id}
                      onChange={(e) => updateStopField('id', e.target.value)}
                      required
                      disabled={!!editingStop}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Nazwa</label>
                    <input
                      className={inputCls}
                      value={stopForm.name}
                      onChange={(e) => updateStopField('name', e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Szerokość</label>
                    <input
                      type="number"
                      step="any"
                      className={inputCls}
                      value={stopForm.latitude}
                      onChange={(e) =>
                        updateStopField('latitude', e.target.value)
                      }
                      required
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Długość</label>
                    <input
                      type="number"
                      step="any"
                      className={inputCls}
                      value={stopForm.longitude}
                      onChange={(e) =>
                        updateStopField('longitude', e.target.value)
                      }
                      required
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="submit" className={btnPrimary}>
                    <Save className="h-4 w-4" />
                    {editingStop ? 'Zapisz zmiany' : 'Dodaj przystanek'}
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    onClick={resetStopForm}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Anuluj
                  </button>
                </div>
              </form>
            </div>

            <div className={cardCls}>
              <h2 className="text-lg font-semibold text-slate-900">
                Lista przystanków
              </h2>
              <p className="mb-4 text-sm text-slate-500">
                {stops.length} przystanków w bazie.
              </p>
              {stopsLoading ? (
                <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Ładowanie…
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                        <th className="py-2 pr-3">ID</th>
                        <th className="py-2 pr-3">Nazwa</th>
                        <th className="py-2 pr-3">Szer.</th>
                        <th className="py-2 pr-3">Dł.</th>
                        <th className="py-2">Akcje</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stops.length === 0 ? (
                        <tr>
                          <td colSpan="5" className="py-6 text-center text-slate-400">
                            Brak przystanków.
                          </td>
                        </tr>
                      ) : (
                        stops.map((stop) => (
                          <tr
                            key={stop.id}
                            className="border-b border-slate-100"
                          >
                            <td className="py-2 pr-3 font-mono text-xs text-slate-500">
                              {stop.id}
                            </td>
                            <td className="py-2 pr-3 text-slate-800">
                              {stop.name}
                            </td>
                            <td className="py-2 pr-3 text-slate-500">
                              {stop.latitude}
                            </td>
                            <td className="py-2 pr-3 text-slate-500">
                              {stop.longitude}
                            </td>
                            <td className="py-2">
                              <div className="flex gap-1">
                                <button
                                  className={btnIcon}
                                  onClick={() => handleEditStop(stop)}
                                >
                                  <Pencil className="h-4 w-4" />
                                </button>
                                <button
                                  className={btnIconDanger}
                                  onClick={() => handleDeleteStop(stop.id)}
                                >
                                  <Trash2 className="h-4 w-4" />
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
          <div className={cardCls}>
            <h2 className="text-lg font-semibold text-slate-900">Pojazdy</h2>
            <p className="mb-4 text-sm text-slate-500">
              Przypisz wariant trasy do każdego pojazdu (pcName).
            </p>
            {vehiclesLoading ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Ładowanie pojazdów…
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase text-slate-400">
                      <th className="py-2 pr-3">Pojazd (pcName)</th>
                      <th className="py-2 pr-3">Przypisana trasa</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vehicles.length === 0 ? (
                      <tr>
                        <td colSpan="3" className="py-6 text-center text-slate-400">
                          Brak pojazdów.
                        </td>
                      </tr>
                    ) : (
                      vehicles.map((vehicle) => {
                        const currentRouteId =
                          vehicle.route_id || vehicle.schedule_id || '';
                        return (
                          <tr
                            key={vehicle.pcName}
                            className="border-b border-slate-100"
                          >
                            <td className="py-2 pr-3 font-medium text-slate-800">
                              {vehicle.pcName}
                            </td>
                            <td className="py-2 pr-3">
                              <div className="relative max-w-xs">
                                <select
                                  className={`${inputCls} appearance-none pr-9`}
                                  value={currentRouteId}
                                  onChange={(e) =>
                                    handleUpdateVehicleRoute(
                                      vehicle.pcName,
                                      e.target.value
                                    )
                                  }
                                >
                                  <option value="">Brak</option>
                                  {allRoutesFlat.map((r) => (
                                    <option key={r.id} value={r.id}>
                                      {r.name} ({DIRECTION_LABELS[r.direction]})
                                      {r.is_extended ? ' · wydł.' : ''}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                              </div>
                              {allRoutesFlat.length === 0 && (
                                <p className="mt-1 text-xs text-slate-400">
                                  Wybierz linię w zakładce „Trasy”, aby zobaczyć
                                  jej warianty.
                                </p>
                              )}
                            </td>
                            <td className="py-2">
                              {currentRouteId ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
                                  Przypisany
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
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