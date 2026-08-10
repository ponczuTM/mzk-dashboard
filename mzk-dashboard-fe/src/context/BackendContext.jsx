import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
} from 'react';

const DEFAULT_BASE_URL =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_ROOM_SERVER_URL) ||
  'http://localhost:3001';

const BackendContext = createContext(null);

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

function buildQuery(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = { ok: false, error: text };
    }
  }

  if (!response.ok || (data && data.ok === false)) {
    const message =
      (data && (data.error || data.message)) ||
      `Błąd HTTP ${response.status} ${response.statusText}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = data;
    throw error;
  }

  return data === null ? {} : data;
}

function createApi(baseUrl) {
  const request = async (method, path, { query, body } = {}) => {
    const url = joinUrl(baseUrl, path) + buildQuery(query);
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (body !== undefined && body !== null) {
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (networkErr) {
      const error = new Error(
        `Nie można połączyć się z serwerem (${url}): ${networkErr.message}`
      );
      error.cause = networkErr;
      throw error;
    }

    return parseResponse(response);
  };

  const get = (path, query) => request('GET', path, { query });
  const post = (path, body) => request('POST', path, { body });
  const put = (path, body) => request('PUT', path, { body });
  const patch = (path, body) => request('PATCH', path, { body });
  const del = (path, query) => request('DELETE', path, { query });

  return {
    baseUrl,
    request,

    // --- Info / IP ---
    getRoot: () => get('/'),
    getApiIp: () => get('/api/ip'),
    getIsarsoftLatest: () => get('/api/isarsoft/latest'),

    // --- Przystanki (stops) ---
    getStops: (query) => get('/stops', query),
    getStop: (id) => get(`/stops/${encodeURIComponent(id)}`),
    createStop: (payload) => post('/stops', payload),
    updateStop: (id, payload) =>
      put(`/stops/${encodeURIComponent(id)}`, payload),
    deleteStop: (id) => del(`/stops/${encodeURIComponent(id)}`),

    // --- LINIE (schedules) ---
    // Linia (Schedule) -> Wariant Kierunku (ScheduleSide, FROM_START/TO_START,
    // tworzone automatycznie przy POST) -> Kurs o konkretnej godzinie
    // (ScheduleTrip) -> Sekwencja przystanków z godzinami (ScheduleStop).
    getSchedules: (query) => get('/api/schedules', query),
    getSchedule: (id) => get(`/api/schedules/${encodeURIComponent(id)}`),
    createSchedule: (payload) => post('/api/schedules', payload),
    updateSchedule: (id, payload) =>
      put(`/api/schedules/${encodeURIComponent(id)}`, payload),
    deleteSchedule: (id) => del(`/api/schedules/${encodeURIComponent(id)}`),

    // Nazwa docelowa/opis wariantu kierunku (np. "Do: Pętla Zachód")
    updateScheduleSide: (scheduleId, sideId, payload) =>
      patch(
        `/api/schedules/${encodeURIComponent(scheduleId)}/sides/${encodeURIComponent(sideId)}`,
        payload
      ),

    // --- KURSY (schedule_trips) ---
    createTrip: (scheduleId, tripData) =>
      post(`/api/schedules/${encodeURIComponent(scheduleId)}/trips`, tripData),
    deleteTrip: (tripId) => del(`/api/trips/${encodeURIComponent(tripId)}`),

    // --- Typy dni ---
    getServiceDays: () => get('/service-days'),

    // --- Święta ---
    getHolidays: () => get('/holidays'),
    createHoliday: (payload) => post('/holidays', payload),
    deleteHoliday: (date) =>
      del(`/holidays/${encodeURIComponent(date)}`),

    // --- Pojazdy ---
    getVehicles: () => get('/vehicles'),

    // --- Dyspozytura / przypisania pojazdów do kursów ---
    assignVehicleTrips: (pcName, tripIds, date) =>
      post('/api/vehicles/assign-trips', {
        pcName,
        trip_ids: tripIds,
        date: date || null,
      }),
    getVehicleSchedule: (pcName, query) =>
      get(`/api/vehicles/${encodeURIComponent(pcName)}/schedule`, query),

    // --- Zdarzenia trackingowe / raporty ---
    getTrips: (query) => get('/trips', query),
    deleteTrips: (query) => del('/trips', query),
    getReportCurrent: (query) => get('/reports/trip/current', query),
    getCurrentStatus: (query) => get('/reports/trip/current', query),
    getReportStopUsage: (query) => get('/reports/stop-usage', query),
    getReportOnDemandStops: (query) => get('/reports/on-demand-stops', query),
    getReportLinePerformance: (query) =>
      get('/reports/line-performance', query),
    getReportAdminZone: (query) => get('/reports/admin-zone', query),

    // Aliasy zgodności wstecznej (krótsze nazwy używane przez starsze komponenty)
    getStopUsage: (query) => get('/reports/stop-usage', query),
    getOnDemandStops: (query) => get('/reports/on-demand-stops', query),
    getLinePerformance: (query) => get('/reports/line-performance', query),
    getAdminZone: (query) => get('/reports/admin-zone', query),

    // --- Ustawienia ---
    getSettings: () => get('/settings'),
  };
}

export const BackendProvider = ({ children, baseUrl }) => {
  const [serverUrl, setServerUrl] = useState(baseUrl || DEFAULT_BASE_URL);
  const api = useMemo(() => createApi(serverUrl), [serverUrl]);

  const updateServerUrl = useCallback((url) => {
    setServerUrl(url || DEFAULT_BASE_URL);
  }, []);

  // ---------- LINIE / KURSY / PRZYPISANIA POJAZDÓW ----------
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [trips, setTrips] = useState([]);
  const [vehicleAssignments, setVehicleAssignments] = useState({});

  // ---------- POJAZDY ----------
  // Pojazdy (pcName) rejestrują się automatycznie w bazie po odebraniu ramki
  // IsarsoftData — nigdy nie są tworzone ręcznie przez użytkownika.
  const [vehicles, setVehicles] = useState([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(false);

  const fetchVehicles = useCallback(async () => {
    setVehiclesLoading(true);
    try {
      const data = await api.getVehicles();
      const next = data.vehicles || [];
      setVehicles(next);
      return next;
    } finally {
      setVehiclesLoading(false);
    }
  }, [api]);

  const fetchSchedules = useCallback(
    async (query) => {
      setSchedulesLoading(true);
      try {
        const data = await api.getSchedules(query);
        const next = data.schedules || [];
        setSchedules(next);
        return next;
      } finally {
        setSchedulesLoading(false);
      }
    },
    [api]
  );

  const createSchedule = useCallback(
    async (data) => {
      const result = await api.createSchedule(data);
      await fetchSchedules();
      return result.schedule;
    },
    [api, fetchSchedules]
  );

  const deleteSchedule = useCallback(
    async (id) => {
      const result = await api.deleteSchedule(id);
      setSchedules((prev) => prev.filter((s) => s.id !== id));
      return result;
    },
    [api]
  );

  // ---------- NOWA METODA: aktualizacja nazwy wariantu kierunku ----------
  const updateScheduleSide = useCallback(
    async (scheduleId, sideId, payload) => {
      const result = await api.updateScheduleSide(scheduleId, sideId, payload);
      // Po pomyślnej aktualizacji odświeżamy całą listę linii,
      // aby zobaczyć zmiany w interfejsie.
      await fetchSchedules();
      return result;
    },
    [api, fetchSchedules]
  );

  const createTrip = useCallback(
    async (scheduleId, tripData) => {
      const result = await api.createTrip(scheduleId, tripData);
      setTrips((prev) => [...prev, result.trip]);
      await fetchSchedules();
      return result.trip;
    },
    [api, fetchSchedules]
  );

  const deleteTrip = useCallback(
    async (tripId) => {
      const result = await api.deleteTrip(tripId);
      setTrips((prev) => prev.filter((t) => t.id !== tripId));
      await fetchSchedules();
      return result;
    },
    [api, fetchSchedules]
  );

  const assignVehicleToTrips = useCallback(
    async (pcName, tripIds, date) => {
      const result = await api.assignVehicleTrips(pcName, tripIds, date);
      return result;
    },
    [api]
  );

  const fetchVehicleSchedule = useCallback(
    async (pcName, query) => {
      const result = await api.getVehicleSchedule(pcName, query);
      setVehicleAssignments((prev) => ({ ...prev, [pcName]: result }));
      return result;
    },
    [api]
  );

  const value = useMemo(
    () => ({
      api,
      serverUrl,
      setServerUrl: updateServerUrl,

      schedules,
      schedulesLoading,
      trips,
      vehicleAssignments,
      vehicles,
      vehiclesLoading,

      fetchSchedules,
      createSchedule,
      deleteSchedule,
      updateScheduleSide,   // ← nowa metoda kontekstowa
      createTrip,
      deleteTrip,
      assignVehicleToTrips,
      fetchVehicleSchedule,
      fetchVehicles,
    }),
    [
      api,
      serverUrl,
      updateServerUrl,
      schedules,
      schedulesLoading,
      trips,
      vehicleAssignments,
      vehicles,
      vehiclesLoading,
      fetchSchedules,
      createSchedule,
      deleteSchedule,
      updateScheduleSide,
      createTrip,
      deleteTrip,
      assignVehicleToTrips,
      fetchVehicleSchedule,
      fetchVehicles,
    ]
  );

  return (
    <BackendContext.Provider value={value}>
      {children}
    </BackendContext.Provider>
  );
};

export const useBackend = () => {
  const ctx = useContext(BackendContext);
  if (!ctx) {
    throw new Error('useBackend musi być użyty wewnątrz <BackendProvider>.');
  }
  return ctx;
};

export default BackendContext;