import React from 'react';
import { NavLink } from 'react-router-dom';
import './Navbar.css';

const Navbar = () => {
  return (
    <nav className="navbar">
      <div className="navbar-brand">
        <span className="brand">🚌 MZK Monitor</span>
      </div>
      <div className="navbar-links">
        <NavLink to="/" className={({ isActive }) => isActive ? 'active' : ''} end>Dashboard</NavLink>
        <NavLink to="/cameras" className={({ isActive }) => isActive ? 'active' : ''}>Kamery</NavLink>
        <NavLink to="/schedule" className={({ isActive }) => isActive ? 'active' : ''}>Rozkłady</NavLink>
        <NavLink to="/vehicles" className={({ isActive }) => isActive ? 'active' : ''}>Pojazdy</NavLink>
        <NavLink to="/statistics" className={({ isActive }) => isActive ? 'active' : ''}>Statystyki</NavLink>
      </div>
    </nav>
  );
};

export default Navbar;