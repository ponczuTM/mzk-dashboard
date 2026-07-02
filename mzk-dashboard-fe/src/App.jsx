import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './pages/Navbar';
import Dashboard from './pages/Dashboard';
import Cameras from './pages/Cameras';
import Schedule from './pages/Schedule';
import Vehicles from './pages/Vehicles';
import Statistics from './pages/Statistics';
import { BackendProvider } from './context/BackendContext';

function App() {
  return (
    <BackendProvider>
      <div className="app">
        <Navbar />
        <div className="container">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/cameras" element={<Cameras />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/vehicles" element={<Vehicles />} />
            <Route path="/statistics" element={<Statistics />} />
          </Routes>
        </div>
      </div>
    </BackendProvider>
  );
}

export default App;