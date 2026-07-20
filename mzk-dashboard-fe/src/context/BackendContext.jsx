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

    // --- ROZKŁADY (schedules) ---
    // Jeden rozkład = jedna nazwa + dwie strony jazdy (FROM_START / TO_START),
    // tworzone automatycznie przy POST /schedules. Dla każdej strony i typu dnia
    // (WEEKDAY/WEEKEND/HOLIDAY) zapisana jest uporządkowana lista przystanków
    // z bezwzględną godziną HH:MM.
    getSchedules: (query) => get('/schedules', query),
    getSchedule: (id) => get(`/schedules/${encodeURIComponent(id)}`),
    createSchedule: (payload) => post('/schedules', payload),
    updateSchedule: (id, payload) =>
      put(`/schedules/${encodeURIComponent(id)}`, payload),
    deleteSchedule: (id) => del(`/schedules/${encodeURIComponent(id)}`),

    getScheduleSideStops: (scheduleId, sideId, dayType) =>
      get(
        `/schedules/${encodeURIComponent(scheduleId)}/sides/${encodeURIComponent(sideId)}/stops`,
        { day_type: dayType }
      ),
    setScheduleSideStops: (scheduleId, sideId, dayType, stops) =>
      put(
        `/schedules/${encodeURIComponent(scheduleId)}/sides/${encodeURIComponent(sideId)}/stops`,
        { day_type: dayType, stops }
      ),
    copyScheduleSideStops: (scheduleId, sideId, payload) =>
      post(
        `/schedules/${encodeURIComponent(scheduleId)}/sides/${encodeURIComponent(sideId)}/copy`,
        payload
      ),

    // --- Typy dni ---
    getServiceDays: () => get('/service-days'),

    // --- Święta ---
    getHolidays: () => get('/holidays'),
    createHoliday: (payload) => post('/holidays', payload),
    deleteHoliday: (date) =>
      del(`/holidays/${encodeURIComponent(date)}`),

    // --- Pojazdy ---
    getVehicles: () => get('/vehicles'),
    updateVehicle: (pcName, payload) =>
      put(`/vehicles/${encodeURIComponent(pcName)}`, payload),

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

  const value = useMemo(
    () => ({
      api,
      serverUrl,
      setServerUrl: updateServerUrl,
    }),
    [api, serverUrl, updateServerUrl]
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