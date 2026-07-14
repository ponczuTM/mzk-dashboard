import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ReactLenis } from 'lenis/react';
import * as THREE from 'three';
import {
  FiCpu, FiLayers, FiCode, FiTerminal, FiGitBranch,
  FiDatabase, FiMonitor, FiArrowRight, FiMail, FiPhone, FiGithub, FiGlobe,
  FiUser, FiBriefcase, FiBook, FiTool, FiStar, FiAward, FiServer, FiLayout,
  FiGrid, FiClock, FiMapPin, FiLink, FiExternalLink, FiCheck, FiPlus
} from 'react-icons/fi';
import { PointMaterial } from '@react-three/drei';
import styles from './Portfolio.module.css';

import mcdonalds from '../assets/images/mcdonalds.png';
import gorpol from '../assets/images/gorpol.png';
import fitrening from '../assets/images/fitrening.png';
import mechanic from '../assets/images/mechanic.png';
import topsupple from '../assets/images/topsupple.png';
import pracovo from '../assets/images/pracovo.png';
import eternalwellness from '../assets/images/eternalwellness.png';

gsap.registerPlugin(ScrollTrigger);

// ==
// 3D SCENE & QUANTUM PARTICLE COMPONENTS
// ==
function ParticleMorphSystem({ activeSection }) {
  const pointsRef = useRef();
  const count = 2000;

  const positions = useMemo(() => {
    const targets = {
      home: new Float32Array(count * 3),
      about: new Float32Array(count * 3),
      tech: new Float32Array(count * 3),
      experience: new Float32Array(count * 3),
      contact: new Float32Array(count * 3)
    };

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;

      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = Math.cbrt(Math.random()) * 8;

      targets.home[i3] = r * Math.sin(phi) * Math.cos(theta);
      targets.home[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      targets.home[i3 + 2] = r * Math.cos(phi);

      targets.about[i3] = ((i % 50) - 25) * 0.5;
      targets.about[i3 + 1] = (Math.floor(i / 50) - 30) * 0.4;
      targets.about[i3 + 2] = Math.sin(i * 0.1) * 2;

      const t = (i / count) * Math.PI * 2;
      targets.tech[i3] = Math.sin(t) * 6;
      targets.tech[i3 + 1] = Math.sin(t * 2) * 2.5;
      targets.tech[i3 + 2] = Math.cos(t) * 4;

      targets.experience[i3] = Math.cos(i) * (2 + Math.random() * 0.5);
      targets.experience[i3 + 1] = Math.sin(i) * (2 + Math.random() * 0.5);
      targets.experience[i3 + 2] = ((i % 100) - 50) * 0.6;

      const angle = (i / count) * 120;
      const radius = (i / count) * 8 + Math.random() * 0.4;
      targets.contact[i3] = Math.cos(angle) * radius;
      targets.contact[i3 + 1] = (i / count - 0.5) * 10;
      targets.contact[i3 + 2] = Math.sin(angle) * radius;
    }

    return targets;
  }, []);

  const currentArray = useMemo(() => {
    const arr = new Float32Array(count * 3);
    arr.set(positions.home);
    return arr;
  }, [positions]);

  useFrame((state, delta) => {
    if (!pointsRef.current) return;

    const target = positions[activeSection] || positions.home;
    const att = pointsRef.current.geometry.attributes.position.array;

    for (let i = 0; i < count * 3; i++) {
      att[i] += (target[i] - att[i]) * 4 * delta;
    }

    pointsRef.current.geometry.attributes.position.needsUpdate = true;
    pointsRef.current.rotation.y += delta * 0.05;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={count}
          array={currentArray}
          itemSize={3}
        />
      </bufferGeometry>

      <PointMaterial
        color="#0066ff"
        size={0.08}
        sizeAttenuation
        transparent
        opacity={0.85}
        depthWrite={false}
        depthTest={false}
        blending={THREE.CustomBlending}
        blendEquation={THREE.AddEquation}
        blendSrc={THREE.SrcAlphaFactor}
        blendDst={THREE.OneMinusSrcAlphaFactor}
      />
    </points>
  );
}

function StarfieldBackground() {
  const ref = useRef();

  const sphere = useMemo(() => {
    const arr = new Float32Array(1500 * 3);

    for (let i = 0; i < 1500; i++) {
      const i3 = i * 3;
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 20 + Math.random() * 30;

      arr[i3] = r * Math.sin(phi) * Math.cos(theta);
      arr[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i3 + 2] = r * Math.cos(phi);
    }

    return arr;
  }, []);

  useFrame((state, delta) => {
    if (ref.current) {
      ref.current.rotation.x -= delta * 0.01;
      ref.current.rotation.y -= delta * 0.015;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={1500}
          array={sphere}
          itemSize={3}
        />
      </bufferGeometry>

      <pointsMaterial
        color="#9d4edd"
        size={0.04}
        sizeAttenuation
        depthWrite={false}
        transparent
        opacity={0.4}
      />
    </points>
  );
}

function FloatingTechArtifacts() {
  const meshRef = useRef();

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.x = Math.sin(state.clock.getElapsedTime() * 0.4) * 0.2;
      meshRef.current.rotation.y = Math.cos(state.clock.getElapsedTime() * 0.3) * 0.2;
    }
  });

  return (
    <group ref={meshRef}>
      <mesh position={[4, 2, -3]}>
        <octahedronGeometry args={[0.7, 0]} />
        <meshBasicMaterial color="#00f3ff" wireframe transparent opacity={0.15} />
      </mesh>

      <mesh position={[-5, -2, -4]}>
        <dodecahedronGeometry args={[0.8, 0]} />
        <meshBasicMaterial color="#9d4edd" wireframe transparent opacity={0.15} />
      </mesh>
    </group>
  );
}

function Interactive3DScene({ activeSection }) {
  return (
    <div className={styles.canvasContainer}>
      <Canvas camera={{ position: [0, 0, 10], fov: 60 }}>
        <ambientLight intensity={0.2} />
        <pointLight position={[10, 10, 10]} intensity={1.5} color="#00f3ff" />
        <pointLight position={[-10, -10, -10]} intensity={1.0} color="#9d4edd" />

        <ParticleMorphSystem activeSection={activeSection} />
        <StarfieldBackground />
        <FloatingTechArtifacts />
      </Canvas>
    </div>
  );
}

// ==
// MAIN COMPONENT
// ==
const PAGE_COPIES = [0, 1, 2];

export default function Portfolio() {
  const [activeSection, setActiveSection] = useState('home');
  const [hackedText, setHackedText] = useState('RECRUITER DETECTED...');

  const containerRef = useRef(null);
  const middlePageRef = useRef(null);
  const lenisRef = useRef(null);
  const isTeleportingRef = useRef(false);
  const pageHeightRef = useRef(0);
  const initializedRef = useRef(false);

  const mouseX = useMotionValue(-100);
  const mouseY = useMotionValue(-100);
  const springConfig = { damping: 30, stiffness: 400, mass: 0.4 };
  const cursorX = useSpring(mouseX, springConfig);
  const cursorY = useSpring(mouseY, springConfig);

  useEffect(() => {
    const handleMouseMove = (e) => {
      mouseX.set(e.clientX - 10);
      mouseY.set(e.clientY - 10);
    };

    window.addEventListener('mousemove', handleMouseMove);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, [mouseX, mouseY]);

  useEffect(() => {
    const lines = [
      'INITIALIZING SCANNER...',
      'PORTFOLIO COMPILING...',
      'SYSTEM ONLINE.',
      'I KNOW YOU\'RE SCROLLING.',
      'KEEP GOING...',
      'LOOKING FOR A MASTER FULLSTACK ENGINEER?'
    ];

    let idx = 0;

    const interval = setInterval(() => {
      setHackedText(lines[idx]);
      idx = (idx + 1) % lines.length;
    }, 4500);

    return () => clearInterval(interval);
  }, []);

  const getScroller = useCallback(() => {
    const lenis = lenisRef.current?.lenis;

    if (lenis?.rootElement) return lenis.rootElement;

    return window;
  }, []);

  const getScrollY = useCallback(() => {
    const lenis = lenisRef.current?.lenis;

    if (lenis && typeof lenis.scroll === 'number') {
      return lenis.scroll;
    }

    return window.scrollY || window.pageYOffset || 0;
  }, []);

  const setScrollY = useCallback((value, immediate = true) => {
    const lenis = lenisRef.current?.lenis;

    if (lenis) {
      lenis.scrollTo(value, {
        immediate,
        force: true,
        lock: true
      });
    } else {
      window.scrollTo({
        top: value,
        behavior: 'auto'
      });
    }
  }, []);

  const updatePageMetrics = useCallback(() => {
    if (!middlePageRef.current) return;

    pageHeightRef.current = middlePageRef.current.offsetHeight;
  }, []);

  useEffect(() => {
    const init = () => {
      updatePageMetrics();

      if (!initializedRef.current && pageHeightRef.current > 0) {
        setScrollY(pageHeightRef.current, true);
        initializedRef.current = true;
      }
    };

    const raf = requestAnimationFrame(init);

    window.addEventListener('resize', updatePageMetrics);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', updatePageMetrics);
    };
  }, [setScrollY, updatePageMetrics]);

  useEffect(() => {
    const handleLoopScroll = () => {
      if (isTeleportingRef.current) return;

      const pageHeight = pageHeightRef.current;
      if (!pageHeight) return;

      const y = getScrollY();
      const threshold = pageHeight * 0.2;

      if (y < threshold) {
        isTeleportingRef.current = true;
        setScrollY(y + pageHeight, true);

        requestAnimationFrame(() => {
          isTeleportingRef.current = false;
        });
      } else if (y > pageHeight * 2 - threshold) {
        isTeleportingRef.current = true;
        setScrollY(y - pageHeight, true);

        requestAnimationFrame(() => {
          isTeleportingRef.current = false;
        });
      }
    };

    const lenis = lenisRef.current?.lenis;
    let cleanupLenis = null;

    if (lenis?.on) {
      const cb = () => handleLoopScroll();
      lenis.on('scroll', cb);
      cleanupLenis = () => lenis.off('scroll', cb);
    } else {
      window.addEventListener('scroll', handleLoopScroll, { passive: true });
    }

    return () => {
      if (cleanupLenis) {
        cleanupLenis();
      } else {
        window.removeEventListener('scroll', handleLoopScroll);
      }
    };
  }, [getScrollY, setScrollY]);

  useEffect(() => {
    if (!middlePageRef.current) return;

    const sections = middlePageRef.current.querySelectorAll('[data-section]');

    const observerOptions = {
      root: null,
      rootMargin: '-40% 0px -40% 0px',
      threshold: 0
    };

    const observer = new IntersectionObserver((entries) => {
      if (isTeleportingRef.current) return;

      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const sectionName = entry.target.getAttribute('data-section');

          if (sectionName) {
            setActiveSection(sectionName);
          }
        }
      });
    }, observerOptions);

    sections.forEach((section) => observer.observe(section));

    return () => {
      sections.forEach((section) => observer.unobserve(section));
      observer.disconnect();
    };
  }, []);

  const scrollToSection = useCallback((sectionId) => {
    const target = middlePageRef.current?.querySelector(
      `[data-section-id="${sectionId}"]`
    );

    if (!target) return;

    const rect = target.getBoundingClientRect();
    const absoluteTop = getScrollY() + rect.top;

    const lenis = lenisRef.current?.lenis;

    if (lenis) {
      lenis.scrollTo(absoluteTop, { duration: 3 });
    } else {
      window.scrollTo({
        top: absoluteTop,
        behavior: 'smooth'
      });
    }
  }, [getScrollY]);

  const renderPageContent = (copyIndex) => {
    const pageProps = copyIndex === 1 ? { ref: middlePageRef } : {};

    const projects = [
      {
        title: 'McDonald\'s Multimedia Table',
        type: 'Interactive Gaming Table with Unity & Hardware Integration',
        image: mcdonalds,
        desc: 'Multimedia gaming table for McDonald\'s restaurants. Interactive experience based on game engine/Unity, hardware integration, refined UI, animations, and flawless operation in kiosk mode. Project coordinator & frontend/Unity contributor. Responsible for planning, delivery, and production readiness.'
      },
      {
        title: 'TopSupple Online Store',
        type: 'E-commerce Platform',
        image: topsupple,
        desc: 'Complete e-commerce platform with CMS, basket, checkout, payments, and an admin panel for day-to-day operations. React.js, CMS, Payments, Admin panel.'
      },
      {
        title: 'Fitrening Sports Stats',
        type: 'Sports Statistics Platform',
        image: fitrening,
        desc: 'Statistics platform for sport users with three privilege levels, authentication, password change flow, and an admin panel. RBAC, Auth, Analytics, Admin.'
      },
      {
        title: 'Eternal Wellness Booking App',
        type: 'Calendar & Booking Application',
        image: eternalwellness,
        desc: 'Performance-driven booking and scheduling platform built with React.js and Node.js. Streamlined client journey: service selection, availability discovery, booking confirmation, and operational admin tooling.'
      },
      {
        title: 'Pracovo.pl',
        type: 'AI-Powered Remote Recruitment Platform',
        image: pracovo,
        desc: 'Innovative job board for remote specialists integrated with an automated AI recruitment pipeline. Features a custom job listing creator and multi-tiered hiring automation: traditional application flow, automated AI Screening of resumes to select top candidates, and an AI Agent mode conducting structured online interviews with automated voice/text analysis.'
      },
      {
        title: 'GÓRPOL Website',
        type: 'Heavy Machinery Rental Landing Page',
        image: gorpol,
        desc: 'A business card and service presentation website for a heavy construction equipment rental company. Designed for high performance and conversions, showcasing a comprehensive fleet of telehandlers and backhoe loaders with professional UDT certifications, dedicated operators, and a streamlined contact flow for B2B and individual clients.'
      },
      {
        title: 'Mechanik Lubicz',
        type: 'Local Business Showcase & Lead Generation Page',
        image: mechanic,
        desc: 'An optimized, highly responsive local business landing page designed for a professional car diagnostics and repair workshop. Built with an intuitive, mobile-first interface featuring quick-action call buttons, structured service offerings (ranging from computer diagnostics to suspension and gearbox repairs), and clear location metadata to boost local SEO.'
      }
    ];

    return (
      <div
        {...pageProps}
        className={styles.pageClone}
        data-page-copy={copyIndex}
        aria-hidden={copyIndex !== 1}
      >
        <section
          data-section="home"
          data-section-id="home"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <div className={styles.centerHero}>
              <div className={styles.heroLayout}>
                <motion.div
                  initial={{ opacity: 0, y: 100 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 1.2,
                    ease: [0.16, 1, 0.3, 1],
                    delay: 0.2
                  }}
                  className={styles.glitchContainer}
                >
                  <h1 className={styles.giantTitle}>
                    OLIWER <span className={styles.gradientText}>MROCZKOWSKI</span>
                  </h1>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 1.6, delay: 0.6 }}
                  className={styles.subContainer}
                >
                  <h2 className={styles.roleSubtext}>
                    FULLSTACK DEVELOPER & ENGINEER
                  </h2>

                  <div className={styles.glowingBar} />

                  <p className={styles.abstractDescription}>
                    I design and build interactive, modern web applications with React,
                    and Node.js. Passionate about creating engaging user experiences
                    with clean design and solid code.
                  </p>

                  <div className={styles.homeQuickInfo}>
                    <span><FiMapPin /> Poland / Remote</span>
                    <span><FiClock /> Available for new opportunities</span>
                  </div>

                  <div className={styles.homeCTArow}>
                    <button
                      className={styles.premiumCTA}
                      onClick={() => scrollToSection('about')}
                    >
                      INITIALIZE JOURNEY <FiArrowRight className={styles.ctaIcon} />
                    </button>

                    <a
                      href="https://github.com/ponczuTM"
                      target="_blank"
                      rel="noreferrer"
                      className={styles.githubHomeLink}
                    >
                      <FiGithub /> GitHub
                    </a>
                  </div>
                </motion.div>
              </div>
            </div>
          </div>
        </section>

        <section
          id={copyIndex === 1 ? 'about' : undefined}
          data-section="about"
          data-section-id="about"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// SYSTEM CORE MANIFESTO</span>
            <h3 className={styles.sectionHeader}>BIO ARCHITECTURE</h3>

            <div className={styles.aboutFullGrid}>
              <div className={styles.aboutMainBio}>
                <p className={styles.aboutIntro}>
                  Frontend Developer and master engineer with several years of
                  experience in designing and implementing web applications using
                  React.js, Angular and modern JavaScript.
                </p>

                <p>
                  Skilled in building interactive user interfaces, integrating backend
                  services and managing commercial projects. Strong analytical mindset
                  with additional expertise in data processing (Python) and proven
                  teamwork and presentation skills. Advanced English (B2) and a strong
                  commitment to delivering high-quality results.
                </p>

                <div className={styles.aboutCorePillars}>
                  <div className={styles.pillarItem}>
                    <FiStar className={styles.pillarIcon} />
                    <div>
                      <strong>Product-minded UX</strong>
                      <span>Clean flows, crisp motion, and zero-friction UI decisions.</span>
                    </div>
                  </div>

                  <div className={styles.pillarItem}>
                    <FiTool className={styles.pillarIcon} />
                    <div>
                      <strong>Engineering rigor</strong>
                      <span>Maintainable architecture, solid code, predictable delivery.</span>
                    </div>
                  </div>

                  <div className={styles.pillarItem}>
                    <FiServer className={styles.pillarIcon} />
                    <div>
                      <strong>Real-world reliability</strong>
                      <span>Kiosk mode, fleet updates, telemetry, and hard constraints.</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.aboutSnapshot}>
                <h4>Quick Snapshot</h4>

                <div className={styles.snapshotGrid}>
                  <div><strong>Focus</strong><span>React, Node.js, UX engineering</span></div>
                  <div><strong>Strength</strong><span>Interactive apps & device integrations</span></div>
                  <div><strong>Style</strong><span>Modern UI, motion, performance</span></div>
                  <div><strong>Location</strong><span>Poland / Remote</span></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          data-section="tech"
          data-section-id="tech"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// CAPABILITY ARCHITECTURE</span>
            <h3 className={styles.sectionHeader}>TECHNOLOGY INFRASTRUCTURE</h3>

            <div className={styles.techCategories}>
              <div className={styles.techCategory}>
                <h4><FiLayout /> Frontend Development</h4>
                <div className={styles.techChipGroup}>
                  <span className={styles.techChip}>React.js</span>
                  <span className={styles.techChip}>Angular</span>
                  <span className={styles.techChip}>TypeScript</span>
                  <span className={styles.techChip}>HTML/CSS</span>
                </div>
              </div>

              <div className={styles.techCategory}>
                <h4><FiServer /> Backend Development</h4>
                <div className={styles.techChipGroup}>
                  <span className={styles.techChip}>Node.js</span>
                  <span className={styles.techChip}>Nest.js</span>
                  <span className={styles.techChip}>Firebase</span>
                  <span className={styles.techChip}>MongoDB</span>
                </div>
              </div>

              <div className={styles.techCategory}>
                <h4><FiLayout /> UI & UX</h4>
                <div className={styles.techChipGroup}>
                  <span className={styles.techChip}>Web App Design</span>
                  <span className={styles.techChip}>Responsive Layouts</span>
                  <span className={styles.techChip}>Interactive Interfaces</span>
                </div>
              </div>

              <div className={styles.techCategory}>
                <h4><FiTool /> Additional</h4>
                <div className={styles.techChipGroup}>
                  <span className={styles.techChip}>Python</span>
                  <span className={styles.techChip}>Unity (C#)</span>
                </div>
              </div>

              <div className={styles.techCategory}>
                <h4><FiGitBranch /> Tools</h4>
                <div className={styles.techChipGroup}>
                  <span className={styles.techChip}>Git</span>
                  <span className={styles.techChip}>Firebase</span>
                  <span className={styles.techChip}>MongoDB</span>
                  <span className={styles.techChip}>REST APIs</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          data-section="experience"
          data-section-id="experience"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>
              // CHRONOLOGICAL RUNTIME OPERATION
            </span>

            <h3 className={styles.sectionHeader}>EXPERIENCE REGISTER</h3>

            <div className={styles.hyperTunnelTimeline}>
              {[
                {
                  company: 'EXON Computer Systems',
                  role: 'IT Department Coordinator / FullStack Developer',
                  date: 'Oct 2024 – Present',
                  bullets: [
                    'Developing and maintaining web applications with React.js and Node.js',
                    'Building integrations with external devices (sensors, printers) using Node.js and Python',
                    'Designing interactive Unity (C#) applications and multimedia systems',
                    'Coordinating and delivering commercial projects, including interactive screen management systems and multimedia table platform'
                  ]
                },
                {
                  company: 'TopSupple',
                  role: 'Freelance System Architect',
                  date: 'Dec 2024 – Feb 2025',
                  bullets: [
                    'Developed e-commerce website top-supple.co.uk – shopping cart, online payments, full store functionality',
                    'Engineered comprehensive e-commerce engine infrastructure',
                    'Designed secure custom payment systems',
                    'Architected transactional data persistence matrices'
                  ]
                },
                {
                  company: 'MGA Sp. z o.o.',
                  role: 'Frontend System Engineer (Angular)',
                  date: 'Jan 2024 – Apr 2024',
                  bullets: [
                    'Designed and implemented new web application features in Angular',
                    'Participated in code reviews and testing',
                    'Supported recruitment processes'
                  ]
                },
                {
                  company: 'ECWM Toruń',
                  role: 'FullStack Core Developer',
                  date: 'Oct 2020 – Dec 2023',
                  bullets: [
                    'Developed web applications with React.js and Nest.js',
                    'Supported data analysis and visualization',
                    'Built dashboards and statistics tools for internal projects'
                  ]
                }
              ].map((exp, idx) => (
                <div key={idx} className={styles.timelineCheckpointNode}>
                  <div className={styles.checkpointGlowNode} />

                  <div className={styles.checkpointBlock}>
                    <div className={styles.checkpointHeaderRow}>
                      <h4 className={styles.checkpointCompany}>{exp.company}</h4>
                      <span className={styles.checkpointTimestamp}>{exp.date}</span>
                    </div>

                    <h5 className={styles.checkpointRole}>{exp.role}</h5>

                    <ul className={styles.checkpointDetailsList}>
                      {exp.bullets.map((bullet, bulletIndex) => (
                        <li key={bulletIndex}>
                          <FiCheck /> {bullet}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          data-section="experience"
          data-section-id="education"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// ACADEMIC RUNTIME</span>
            <h3 className={styles.sectionHeader}>EDUCATION REGISTER</h3>

            <div className={styles.educationGrid}>
              <div className={styles.educationCard}>
                <div className={styles.eduIconWrapper}><FiAward /></div>
                <h4>Master of Computer Science</h4>
                <p className={styles.eduInstitution}>Nicolaus Copernicus University</p>
                <span className={styles.eduDate}>2023 – 2024</span>
                <p className={styles.eduDesc}>
                  Advanced computer science engineering with focus on system
                  architecture and software development.
                </p>
              </div>

              <div className={styles.educationCard}>
                <div className={styles.eduIconWrapper}><FiBook /></div>
                <h4>Bachelor of Computer Science Engineering</h4>
                <p className={styles.eduInstitution}>Nicolaus Copernicus University</p>
                <span className={styles.eduDate}>2019 – 2023</span>
                <p className={styles.eduDesc}>
                  Foundation in computer science engineering, software development
                  principles and system design.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          data-section="experience"
          data-section-id="skills"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>
              // TELEMETRY REALTIME SYSTEM METRICS
            </span>

            <h3 className={styles.sectionHeader}>ENGINE POWER OUTPUT</h3>

            <div className={styles.reactorGridSystem}>
              {[
                { name: 'JavaScript', pct: '95%' },
                { name: 'React.js', pct: '90%' },
                { name: 'Angular', pct: '85%' },
                { name: 'HTML / CSS', pct: '85%' },
                { name: 'Node.js', pct: '80%' },
                { name: 'Frontend Development', pct: '100%' },
                { name: 'Web App Design', pct: '90%' },
                { name: 'UI Implementation', pct: '80%' },
                { name: 'Team Collaboration', pct: '100%' },
                { name: 'API/Integrations', pct: '90%' }
              ].map((skill, idx) => (
                <div key={idx} className={styles.reactorTelemetryMetric}>
                  <div className={styles.reactorMetricLabelRow}>
                    <span>{skill.name}</span>
                    <span className={styles.reactorMetricPct}>{skill.pct}</span>
                  </div>

                  <div className={styles.reactorEnergyMeterTrack}>
                    <motion.div
                      className={styles.reactorEnergyMeterFill}
                      initial={{ width: 0 }}
                      whileInView={{ width: skill.pct }}
                      viewport={{ once: true }}
                      transition={{ duration: 1.4, ease: 'easeOut' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          data-section="tech"
          data-section-id="projects"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// PRODUCTION RELEASES</span>
            <h3 className={styles.sectionHeader}>SYSTEM WORKCASE DEPLOYMENTS</h3>

            <div className={styles.showcaseGrid}>
              {projects.map((proj, idx) => (
                <div key={idx} className={styles.premiumTiltCard}>
                  <div className={styles.cardImageTrack}>
                    <img
                      src={proj.image}
                      alt={`${proj.title} project thumbnail`}
                      className={styles.projectImagePayload}
                      loading="lazy"
                    />
                  </div>

                  <div className={styles.cardDetailsTray}>
                    <h4 className={styles.projectCardTitle}>{proj.title}</h4>
                    <p className={styles.projectCardType}>{proj.type}</p>
                    <p className={styles.projectCardDesc}>{proj.desc}</p>

                    <div className={styles.projectCardLink}>
                      <FiLink /> <span>View Project →</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          data-section="contact"
          data-section-id="contact"
          className={styles.sectionWindow}
        >
          <div className={styles.glassContainer}>
            <div className={styles.contactQuantumLayout}>
              <div className={styles.contactCenterFrame}>
                <span className={styles.sectionTag}>// SECURE TRANSCEIVER NODE</span>

                <h3 className={styles.hugeContactHeader}>
                  LET&apos;S CONSTRUCT QUANTUM ARCHITECTURE
                </h3>

                <p className={styles.contactIntro}>
                  I&apos;m always open to new opportunities, collaborations, and
                  exciting projects. Feel free to reach out!
                </p>

                <div className={styles.contactChannelsGrid}>
                  <a
                    href="mailto:mroczkowskioliwer10@gmail.com"
                    className={styles.channelLinkAnchor}
                  >
                    <FiMail /> mroczkowskioliwer10@gmail.com
                  </a>

                  <a
                    href="tel:+48511535814"
                    className={styles.channelLinkAnchor}
                  >
                    <FiPhone /> +48 511 535 814
                  </a>

                  <a
                    href="https://github.com/ponczuTM"
                    target="_blank"
                    rel="noreferrer"
                    className={styles.channelLinkAnchor}
                  >
                    <FiGithub /> github.com/ponczuTM
                  </a>

                  <a
                    href="https://mroczkowski.netlify.app"
                    target="_blank"
                    rel="noreferrer"
                    className={styles.channelLinkAnchor}
                  >
                    <FiGlobe /> mroczkowski.netlify.app
                  </a>
                </div>

                <div className={styles.contactBusinessNote}>
                  <h4>Business-first approach</h4>
                  <p>
                    Clear scope, crisp UX, predictable delivery. If you want a
                    product that looks premium and behaves reliably, you&apos;re in
                    the right place.
                  </p>
                </div>

                <div className={styles.terminalSignatureCluster}>
                  <p className={styles.sigTitle}>Oliwer Mroczkowski</p>
                  <p className={styles.sigSub}>Master Engineer & FullStack Architect</p>

                  <div className={styles.sigContactRow}>
                    <span>mroczkowskioliwer10@gmail.com</span>
                    <span>•</span>
                    <span>mroczkowski.netlify.app</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <footer className={styles.minimalistFooter} data-section-id="footer">
          <div className={styles.footerGlowDivider} />

          <div className={styles.footerContentBlock}>
            <p>© 2026 Made with ♥ by Oliwer Mroczkowski.</p>
            <p className={styles.footerTechStackTelemetry}>
              REACT × THREE.JS × GSAP × SYSTEM KERNEL
            </p>
            <p className={styles.footerSmallNote}>React • Node • UX • Unity</p>
          </div>
        </footer>
      </div>
    );
  };

  return (
    <ReactLenis
      ref={lenisRef}
      root
      options={{
        lerp: 0.08,
        duration: 1.2,
        syncTouch: true
      }}
    >
      <div ref={containerRef} className={styles.appContainer}>
        <div className={styles.grainOverlay} />
        <div className={styles.vignetteOverlay} />

        <motion.div
          className={styles.customCursor}
          style={{ x: cursorX, y: cursorY }}
        />

        <Interactive3DScene activeSection={activeSection} />

        <div className={styles.hackerTicker}>
          <span className={styles.tickerPulse} />
          <p className={styles.tickerText}>{hackedText}</p>
        </div>

        <div className={styles.infinitePagesWrapper}>
          {PAGE_COPIES.map((copyIndex) => (
            <React.Fragment key={copyIndex}>
              {renderPageContent(copyIndex)}
            </React.Fragment>
          ))}
        </div>
      </div>
    </ReactLenis>
  );
}