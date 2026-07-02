import React, { createContext, useContext, useCallback } from 'react';

// Stała bazowego URL – można nadpisać przez zmienną środowiskową
const BASE_URL = import.meta.env.VITE_API_URL || 'http://192.168.77.152:3001';

// Funkcja pomocnicza do obsługi fetch
async function fetchApi(endpoint, options = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  const config = {
    ...options,
    headers
  };
  try {
    const response = await fetch(url, config);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Błąd HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    console.error(`API call failed: ${url}`, error);
    throw error;
  }
}

// Funkcje API
const api = {
  // Stops
  getStops: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/stops${qs ? '?' + qs : ''}`);
  },
  createStop: (data) => fetchApi('/stops', { method: 'POST', body: JSON.stringify(data) }),
  updateStop: (id, data) => fetchApi(`/stops/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteStop: (id) => fetchApi(`/stops/${id}`, { method: 'DELETE' }),

  // Schedules
  getSchedules: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/schedules${qs ? '?' + qs : ''}`);
  },
  createSchedule: (data) => fetchApi('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateSchedule: (id, data) => fetchApi(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSchedule: (id) => fetchApi(`/schedules/${id}`, { method: 'DELETE' }),

  // Vehicles
  getVehicles: () => fetchApi('/vehicles'),

  // Trips
  getTrips: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/trips${qs ? '?' + qs : ''}`);
  },
  deleteTrips: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/trips${qs ? '?' + qs : ''}`, { method: 'DELETE' });
  },

  // Reports
  getCurrentStatus: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/reports/trip/current${qs ? '?' + qs : ''}`);
  },
  getStopUsage: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/reports/stop-usage${qs ? '?' + qs : ''}`);
  },
  getOnDemandStops: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/reports/on-demand-stops${qs ? '?' + qs : ''}`);
  },
  getLinePerformance: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/reports/line-performance${qs ? '?' + qs : ''}`);
  },
  getAdminZone: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetchApi(`/reports/admin-zone${qs ? '?' + qs : ''}`);
  },

  // Settings
  getSettings: () => fetchApi('/settings'),

  // ---------- NOWA METODA: dane Isarsoft (cache) ----------
  getIsarsoftLatest: () => fetchApi('/api/isarsoft/latest'),
};

const BackendContext = createContext(null);

export const BackendProvider = ({ children }) => {
  const value = {
    api,
    BASE_URL
  };
  return (
    <BackendContext.Provider value={value}>
      {children}
    </BackendContext.Provider>
  );
};

export const useBackend = () => {
  const context = useContext(BackendContext);
  if (!context) {
    throw new Error('useBackend must be used within a BackendProvider');
  }
  return context;
};