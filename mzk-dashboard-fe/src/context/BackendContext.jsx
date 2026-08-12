import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
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

    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    );
  }

  return parts.length ? `?${parts.join('&')}` : '';
}

async function parseResponse(response) {
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {
        ok: false,
        error: text,
      };
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
      headers: {
        'Content-Type': 'application/json',
      },
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

    // --- Informacje / IP ---
    getRoot: () => get('/'),
    getApiIp: () => get('/api/ip'),
    getIsarsoftLatest: () => get('/api/isarsoft/latest'),

    // --- Przystanki ---
    getStops: (query) => get('/stops', query),

    getStop: (id) =>
      get(`/stops/${encodeURIComponent(id)}`),

    createStop: (payload) =>
      post('/stops', payload),

    updateStop: (id, payload) =>
      put(`/stops/${encodeURIComponent(id)}`, payload),

    deleteStop: (id) =>
      del(`/stops/${encodeURIComponent(id)}`),

    // --- Trasy ---
    getRoutes: (query) => get('/api/routes', query),

    getRoute: (id) =>
      get(`/api/routes/${encodeURIComponent(id)}`),

    createRoute: (payload) =>
      post('/api/routes', payload),

    updateRoute: (id, payload) =>
      put(`/api/routes/${encodeURIComponent(id)}`, payload),

    deleteRoute: (id) =>
      del(`/api/routes/${encodeURIComponent(id)}`),

    replaceRouteStops: (id, stops) =>
      put(`/api/routes/${encodeURIComponent(id)}/stops`, {
        stops,
      }),

    // --- Typy dni ---
    getServiceDays: () => get('/service-days'),

    // --- Święta ---
    getHolidays: () => get('/holidays'),

    createHoliday: (payload) =>
      post('/holidays', payload),

    deleteHoliday: (date) =>
      del(`/holidays/${encodeURIComponent(date)}`),

    // --- Pojazdy ---
    getVehicles: () => get('/api/vehicles'),

    // --- Kursy / przypisania pojazdów ---
    assignVehicleTrips: (pcName, payload) =>
      post('/api/vehicles/assign-trips', {
        pcName,
        ...payload,
      }),

    getVehicleAssignments: (pcName, query) =>
      get(
        `/api/vehicles/${encodeURIComponent(pcName)}/assignments`,
        query
      ),

    getVehicleSchedule: (pcName, query) => {
      if (!pcName) {
        throw new Error(
          'Brak pcName. Aby pobrać harmonogram, podaj nazwę pojazdu.'
        );
      }

      return get(
        `/api/vehicles/${encodeURIComponent(pcName)}/schedule`,
        query
      );
    },

    /*
      Alias dla starszych komponentów.

      Poprawne użycie:
      api.getSchedules(pcName, { date: '2026-08-11', day_type: 'weekday' })
    */
    getSchedules: (pcName, query) => {
      if (!pcName) {
        throw new Error(
          'Brak pcName. Użyj api.getSchedules(pcName, query) albo api.getVehicleSchedule(pcName, query).'
        );
      }

      return get(
        `/api/vehicles/${encodeURIComponent(pcName)}/schedule`,
        query
      );
    },

    deleteTrip: (assignmentId) =>
      del(`/api/trips/${encodeURIComponent(assignmentId)}`),

    // --- Zdarzenia trackingowe / raporty ---
    getTrips: (query) => get('/trips', query),

    deleteTrips: (query) => del('/trips', query),

    getReportCurrent: (query) =>
      get('/reports/trip/current', query),

    getCurrentStatus: (query) =>
      get('/reports/trip/current', query),

    getReportStopUsage: (query) =>
      get('/reports/stop-usage', query),

    getReportOnDemandStops: (query) =>
      get('/reports/on-demand-stops', query),

    getReportLinePerformance: (query) =>
      get('/reports/line-performance', query),

    getReportAdminZone: (query) =>
      get('/reports/admin-zone', query),

    // Aliasy zgodności dla starszych komponentów
    getStopUsage: (query) =>
      get('/reports/stop-usage', query),

    getOnDemandStops: (query) =>
      get('/reports/on-demand-stops', query),

    getLinePerformance: (query) =>
      get('/reports/line-performance', query),

    getAdminZone: (query) =>
      get('/reports/admin-zone', query),

    // --- Ustawienia ---
    getSettings: () => get('/settings'),
  };
}

export const BackendProvider = ({ children, baseUrl }) => {
  const [serverUrl, setServerUrl] = useState(
    baseUrl || DEFAULT_BASE_URL
  );

  const api = useMemo(
    () => createApi(serverUrl),
    [serverUrl]
  );

  const updateServerUrl = useCallback((url) => {
    setServerUrl(url || DEFAULT_BASE_URL);
  }, []);

  // ---------- TRASY ----------
  const [routes, setRoutes] = useState([]);
  const [routesLoading, setRoutesLoading] = useState(false);

  const fetchRoutes = useCallback(
    async (query) => {
      setRoutesLoading(true);

      try {
        const data = await api.getRoutes(query);
        const next = data.routes || [];

        setRoutes(next);

        return next;
      } finally {
        setRoutesLoading(false);
      }
    },
    [api]
  );

  const createRoute = useCallback(
    async (data) => {
      const result = await api.createRoute(data);

      await fetchRoutes();

      return result.route;
    },
    [api, fetchRoutes]
  );

  const updateRoute = useCallback(
    async (id, payload) => {
      const result = await api.updateRoute(id, payload);

      await fetchRoutes();

      return result.route;
    },
    [api, fetchRoutes]
  );

  const deleteRoute = useCallback(
    async (id) => {
      const result = await api.deleteRoute(id);

      setRoutes((prev) =>
        prev.filter((route) => route.id !== id)
      );

      return result;
    },
    [api]
  );

  const replaceRouteStops = useCallback(
    async (id, stops) => {
      const result = await api.replaceRouteStops(id, stops);

      await fetchRoutes();

      return result.route;
    },
    [api, fetchRoutes]
  );

  // ---------- POJAZDY ----------
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

  // ---------- KURSY / PRZYPISANIA ----------
  const [vehicleSchedules, setVehicleSchedules] = useState({});

  const assignVehicleTrips = useCallback(
    async (pcName, payload) => {
      return api.assignVehicleTrips(pcName, payload);
    },
    [api]
  );

  const fetchVehicleAssignments = useCallback(
    async (pcName, query) => {
      const result = await api.getVehicleAssignments(
        pcName,
        query
      );

      return result.assignments || [];
    },
    [api]
  );

  const deleteTrip = useCallback(
    async (assignmentId) => {
      return api.deleteTrip(assignmentId);
    },
    [api]
  );

  const fetchVehicleSchedule = useCallback(
    async (pcName, query) => {
      const result = await api.getVehicleSchedule(pcName, query);

      setVehicleSchedules((prev) => ({
        ...prev,
        [pcName]: result,
      }));

      return result;
    },
    [api]
  );

  /*
    Alias na poziomie contextu.

    Możesz użyć:
    const { fetchSchedules } = useBackend();
    const schedule = await fetchSchedules(pcName, query);
  */
  const fetchSchedules = useCallback(
    async (pcName, query) => {
      const result = await api.getSchedules(pcName, query);

      setVehicleSchedules((prev) => ({
        ...prev,
        [pcName]: result,
      }));

      return result;
    },
    [api]
  );

  const value = useMemo(
    () => ({
      api,
      serverUrl,
      setServerUrl: updateServerUrl,

      // Stan
      routes,
      routesLoading,
      vehicles,
      vehiclesLoading,
      vehicleSchedules,

      // Trasy
      fetchRoutes,
      createRoute,
      updateRoute,
      deleteRoute,
      replaceRouteStops,

      // Pojazdy / kursy
      fetchVehicles,
      assignVehicleTrips,
      fetchVehicleAssignments,
      deleteTrip,
      fetchVehicleSchedule,
      fetchSchedules,
    }),
    [
      api,
      serverUrl,
      updateServerUrl,
      routes,
      routesLoading,
      vehicles,
      vehiclesLoading,
      vehicleSchedules,
      fetchRoutes,
      createRoute,
      updateRoute,
      deleteRoute,
      replaceRouteStops,
      fetchVehicles,
      assignVehicleTrips,
      fetchVehicleAssignments,
      deleteTrip,
      fetchVehicleSchedule,
      fetchSchedules,
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
    throw new Error(
      'useBackend musi być użyty wewnątrz <BackendProvider>.'
    );
  }

  return ctx;
};

export default BackendContext;