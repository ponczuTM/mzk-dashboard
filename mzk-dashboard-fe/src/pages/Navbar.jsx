import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Bus,
  LayoutDashboard,
  Camera,
  CalendarClock,
  BusFront,
  BarChart3,
} from 'lucide-react';
import styles from './Navbar.module.css';

const navItems = [
  {
    to: '/',
    label: 'Dashboard',
    icon: LayoutDashboard,
    end: true,
  },
  {
    to: '/cameras',
    label: 'Kamery',
    icon: Camera,
  },
  {
    to: '/schedule',
    label: 'Rozkłady',
    icon: CalendarClock,
  },
  {
    to: '/vehicles',
    label: 'Pojazdy',
    icon: BusFront,
  },
  {
    to: '/statistics',
    label: 'Statystyki',
    icon: BarChart3,
  },
];

const Navbar = () => {
  return (
    <header className={styles.header}>
      <nav className={styles.navbar} aria-label="Główna nawigacja">
        <NavLink to="/" end className={styles.brandWrap}>
          <span className={styles.brandBadge} aria-hidden="true">
            <Bus className={styles.brandIcon} />
          </span>

          <div className={styles.brandText}>
            <span className={styles.brandTitle}>MZK Monitor</span>
            <span className={styles.brandSubtitle}>System nadzoru floty</span>
          </div>
        </NavLink>

        <div className={styles.navbarLinks}>
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                isActive
                  ? `${styles.navLink} ${styles.navLinkActive}`
                  : styles.navLink
              }
            >
              <Icon className={styles.navIcon} aria-hidden="true" />
              <span className={styles.navLabel}>{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </header>
  );
};

export default Navbar;