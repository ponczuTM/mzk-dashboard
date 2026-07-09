import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Center, Text3D, Float, PerspectiveCamera } from '@react-three/drei';
import { motion, useMotionValue, useSpring } from 'framer-motion';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ReactLenis } from 'lenis/react';
import * as THREE from 'three';
import { 
  FiCpu, FiLayers, FiCode, FiTerminal, FiGitBranch, 
  FiDatabase, FiMonitor, FiArrowRight, FiMail, FiPhone, FiGithub, FiGlobe 
} from 'react-icons/fi';
import styles from './Portfolio.module.css';

gsap.registerPlugin(ScrollTrigger);

//==
// 3D SCENE & QUANTUM PARTICLE COMPONENTS
//==

function ParticleMorphSystem({ activeSection }) {
  const pointsRef = useRef();
  const count = 3000;

  // Generate distinct target point arrays for structural morphs
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
      
      // Home: Spherical cloud
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = Math.cbrt(Math.random()) * 8;
      targets.home[i3] = r * Math.sin(phi) * Math.cos(theta);
      targets.home[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      targets.home[i3 + 2] = r * Math.cos(phi);

      // About: Flat Interactive Cyber Grid Matrix
      targets.about[i3] = ((i % 50) - 25) * 0.5;
      targets.about[i3 + 1] = (Math.floor(i / 50) - 30) * 0.4;
      targets.about[i3 + 2] = Math.sin(i * 0.1) * 2;

      // Tech: Floating Infinity Ring
      const t = (i / count) * Math.PI * 2;
      targets.tech[i3] = Math.sin(t) * 6;
      targets.tech[i3 + 1] = Math.sin(t * 2) * 2.5;
      targets.tech[i3 + 2] = Math.cos(t) * 4;

      // Experience: Deep Hyper-tunnel configuration
      targets.experience[i3] = Math.cos(i) * (2 + Math.random() * 0.5);
      targets.experience[i3 + 1] = Math.sin(i) * (2 + Math.random() * 0.5);
      targets.experience[i3 + 2] = ((i % 100) - 50) * 0.6;

      // Contact: Highly volatile gravitational vortex
      const angle = (i / count) * 120;
      const radius = (i / count) * 8 + Math.random() * 0.4;
      targets.contact[i3] = Math.cos(angle) * radius;
      targets.contact[i3 + 1] = (i / count - 0.5) * 10;
      targets.contact[i3 + 2] = Math.sin(angle) * radius;
    }
    return targets;
  }, []);

  const currentArray = useMemo(() => new Float32Array(count * 3), []);
  
  useEffect(() => {
    currentArray.set(positions.home);
  }, [positions, currentArray]);

  useFrame((state, delta) => {
    if (!pointsRef.current) return;
    const target = positions[activeSection] || positions.home;
    const att = pointsRef.current.geometry.attributes.position.array;

    // Fluid interpolation interpolation over time
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
      <pointsMaterial
        color="#00f3ff"
        size={0.06}
        sizeAttenuation={true}
        depthWrite={false}
        transparent
        opacity={0.85}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function StarfieldBackground() {
  const ref = useRef();
  const sphere = useMemo(() => {
    const arr = new Float32Array(1500 * 3);
    for(let i=0; i<1500; i++) {
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
        <bufferAttribute attach="attributes-position" count={1500} array={sphere} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color="#9d4edd" size={0.04} sizeAttenuation={true} depthWrite={false} transparent opacity={0.4} />
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

//==
// MAIN COMPONENT & ENGINE ARCHITECTURE
//==

export default function Portfolio() {
  const [activeSection, setActiveSection] = useState('home');
  const [hackedText, setHackedText] = useState('RECRUITER DETECTED...');
  const containerRef = useRef(null);

  // Advanced Mouse Tracking Mechanics
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
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [mouseX, mouseY]);

  // Structural Intersection Observers
  useEffect(() => {
    const sections = document.querySelectorAll('[data-section]');
    const observerOptions = { root: null, rootMargin: '-40% 0px -40% 0px', threshold: 0 };
    
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActiveSection(entry.target.getAttribute('data-section'));
        }
      });
    }, observerOptions);

    sections.forEach((s) => observer.observe(s));
    return () => sections.forEach((s) => observer.unobserve(s));
  }, []);

  // System Text Simulation Ticker Loops
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

  return (
    <ReactLenis root options={{ lerp: 0.08, duration: 1.2, syncTouch: true }}>
      <div ref={containerRef} className={styles.appContainer}>
        
        {/* Cinematic VFX Layers */}
        <div className={styles.grainOverlay} />
        <div className={styles.vignetteOverlay} />
        
        {/* Interactive Custom Mouse Artifact */}
        <motion.div 
          className={styles.customCursor} 
          style={{ x: cursorX, y: cursorY }}
        />

        {/* Dynamic 3D Scene Layer */}
        <Interactive3DScene activeSection={activeSection} />

        {/* Live Interface Ticker HUD */}
        <div className={styles.hackerTicker}>
          <span className={styles.tickerPulse}></span>
          <p className={styles.tickerText}>{hackedText}</p>
        </div>

        {/* ==========================================
            1. HOME SECTOR
           ========================================== */}
        <section data-section="home" className={styles.sectionWindow}>
          <div className={styles.centerHero}>
            <div className={styles.heroLayout}>
              <motion.div 
                initial={{ opacity: 0, y: 100 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
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
                <h2 className={styles.roleSubtext}>FULLSTACK DEVELOPER & ENGINEER</h2>
                <div className={styles.glowingBar} />
                <p className={styles.abstractDescription}>
                  Architecting hyper-optimized web interfaces, complex IoT node ecosystems, and zero-latency immersive web pipelines.
                </p>
                
                <button 
                  className={styles.premiumCTA}
                  onClick={() => document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' })}
                >
                  INITIALIZE JOURNEY <FiArrowRight className={styles.ctaIcon} />
                </button>
              </motion.div>
            </div>
          </div>
        </section>

        {/* ==========================================
            2. ABOUT PORTAL SECTOR
           ========================================== */}
        <section id="about" data-section="about" className={styles.sectionWindow}>
          <div className={styles.glassContainer}>
            <div className={styles.gridSplit}>
              <div>
                <span className={styles.sectionTag}>// SYSTEM CORE MANIFESTO</span>
                <h3 className={styles.sectionHeader}>BIO ARCHITECTURE</h3>
                
                <div className={styles.terminalParagraph}>
                  <p>
                    Master Engineer specialized in orchestrating advanced system frameworks. Seamless engineering execution between reactive clients and highly scalable data distribution channels.
                  </p>
                  <p className={styles.secondaryBioText}>
                    Proven capability designing production-ready systems, microservices architectures, hardware layer protocols, and immersive graphical pipelines.
                  </p>
                </div>
              </div>

              <div className={styles.interactiveObjectDisplay}>
                <div className={styles.revealCoreFrame}>
                  <div className={styles.revealHoverObject}>
                    <FiCpu className={styles.revealHardwareIcon} />
                    <span className={styles.revealObjectOverlay}>HOVER TO OPEN CORE ARCHITECTURE</span>
                    <div className={styles.hiddenHardwarePayload}>
                      <h4>SYSTEM COMPILING</h4>
                      <ul>
                        <li>+ Node.js Architecture Threads</li>
                        <li>+ React Kernel Memory Optimizations</li>
                        <li>+ Low-Level Hardware System Routing</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ==========================================
            3. TECH STACK MATRIX SECTOR
           ========================================== */}
        <section data-section="tech" className={styles.sectionWindow}>
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// CAPABILITY ARCHITECTURE</span>
            <h3 className={styles.sectionHeader}>TECHNOLOGY INFRASTRUCTURE</h3>
            
            <div className={styles.matrixArtifactGrid}>
              {[
                { name: 'React', icon: <FiLayers />, desc: 'Virtual DOM engineering, customized Hooks optimization frameworks, advanced state mechanics.' },
                { name: 'Node.js', icon: <FiCode />, desc: 'Ultra-performant event-driven microservice orchestration and high-concurrency clusters.' },
                { name: 'JavaScript', icon: <FiTerminal />, desc: 'Advanced asynchronous engine execution, compilation pipelines, memory architecture optimization.' },
                { name: 'Git Workspace', icon: <FiGitBranch />, desc: 'Continuous integration mechanics, advanced tree-merging systems, production release pipelines.' },
                { name: 'MongoDB / Databases', icon: <FiDatabase />, desc: 'NoSQL spatial index scaling, performance shard strategies, and persistent storage arrays.' },
                { name: 'Hardware / IoT Node Nodes', icon: <FiMonitor />, desc: 'Low-latency system integration, electronic label gateways, sensor monitoring.' }
              ].map((tech, idx) => (
                <div key={idx} className={styles.hologramArtifactCard}>
                  <div className={styles.hologramIconWrapper}>
                    {tech.icon}
                  </div>
                  <h4 className={styles.artifactName}>{tech.name}</h4>
                  <p className={styles.artifactDesc}>{tech.desc}</p>
                  <div className={styles.artifactLaserScanner} />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ==========================================
            4. TIME-LINE HYPER-TUNNEL SECTOR
           ========================================== */}
        <section data-section="experience" className={styles.sectionWindow}>
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// CHRONOLOGICAL RUNTIME OPERATION</span>
            <h3 className={styles.sectionHeader}>EXPERIENCE REGISTER</h3>

            <div className={styles.hyperTunnelTimeline}>
              {[
                {
                  company: 'EXON Computer Systems',
                  role: 'IT Department Coordinator / FullStack Developer',
                  date: 'Oct 2024 – Present',
                  bullets: ['Engineering performant React UI interfaces', 'Building Node.js microservice architectures', 'Deploying complex system sensor/printer low-level arrays']
                },
                {
                  company: 'TopSupple',
                  role: 'Freelance System Architect',
                  date: 'Dec 2024 – Feb 2025',
                  bullets: ['Engineered comprehensive e-commerce engine infrastructure', 'Designed secure custom payment systems', 'Architected transactional data persistence matrices']
                },
                {
                  company: 'MGA Sp. z o.o.',
                  role: 'Frontend System Engineer',
                  date: 'Jan 2024 – Apr 2024',
                  bullets: ['Engineered core components using Angular enterprise architecture', 'Executed comprehensive structural code analytics', 'Implemented automated testing matrix protocols']
                },
                {
                  company: 'ECWM Toruń',
                  role: 'FullStack Core Developer',
                  date: 'Oct 2020 – Dec 2023',
                  bullets: ['Architected complex reactive dashboards using React & Nest.js', 'Engineered performant metrics statistical aggregation engines', 'Managed internal mission-critical enterprise apps']
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
                      {exp.bullets.map((b, bIdx) => <li key={bIdx}>{b}</li>)}
                    </ul>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ==========================================
            5. SKILLS ENERGY REACTING REACTOR
           ========================================== */}
        <section data-section="experience" className={styles.sectionWindow}>
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// TELEMETRY REALTIME SYSTEM METRICS</span>
            <h3 className={styles.sectionHeader}>ENGINE POWER OUTPUT</h3>

            <div className={styles.reactorGridSystem}>
              {[
                { name: 'JavaScript Engine Execution', pct: '95%' },
                { name: 'React Ecosystem Architecture', pct: '90%' },
                { name: 'Angular Framework Systems', pct: '85%' },
                { name: 'Node.js Backend Microservices', pct: '80%' },
                { name: 'System Integrations & Low-Level API', pct: '90%' },
                { name: 'Core Architecture UI Execution', pct: '100%' }
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

        {/* ==========================================
            6. PRODUCT / PROJECT SHOWCASE (TILT CARDS)
           ========================================== */}
        <section data-section="tech" className={styles.sectionWindow}>
          <div className={styles.glassContainer}>
            <span className={styles.sectionTag}>// PRODUCTION RELEASES</span>
            <h3 className={styles.sectionHeader}>SYSTEM WORKCASE DEPLOYMENTS</h3>

            <div className={styles.showcaseGrid}>
              {[
                { title: 'PRACOVO PLATFORM', type: 'AI Recruitment Architecture Engine', img: '../assets/images/project1.jpg' },
                { title: 'MZK TRANSIT MATRIX', type: 'Real-Time Spatial Data Processing Terminal', img: '../assets/images/project2.jpg' },
                { title: 'ESL NEXUS GATEWAY', type: 'Low-Level Electronic Shelf Hardware Node', img: '../assets/images/project3.jpg' }
              ].map((proj, idx) => (
                <div key={idx} className={styles.premiumTiltCard}>
                  <div className={styles.cardImageTrack}>
                    <div className={styles.fallbackVisualMatrix} />
                    <img 
                      src={proj.img} 
                      alt={proj.title} 
                      className={styles.projectImagePayload} 
                      onError={(e) => { e.currentTarget.style.display = 'none'; }} 
                    />
                  </div>
                  <div className={styles.cardDetailsTray}>
                    <h4 className={styles.projectCardTitle}>{proj.title}</h4>
                    <p className={styles.projectCardType}>{proj.type}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ==========================================
            7. CONTACT MATRIX TERMINAL (CINEMATIC END)
           ========================================== */}
        <section data-section="contact" className={styles.sectionWindow}>
          <div className={styles.glassContainer}>
            <div className={styles.contactQuantumLayout}>
              <div className={styles.contactCenterFrame}>
                <span className={styles.sectionTag}>// SECURE TRANSCEIVER NODE</span>
                <h3 className={styles.hugeContactHeader}>LET'S CONSTRUCT QUANTUM ARCHITECTURE</h3>
                
                <div className={styles.contactChannelsGrid}>
                  <a href="mailto:mroczkowskioliwer10@gmail.com" className={styles.channelLinkAnchor}>
                    <FiMail /> mroczkowskioliwer10@gmail.com
                  </a>
                  <a href="tel:+48511535814" className={styles.channelLinkAnchor}>
                    <FiPhone /> +48 511 535 814
                  </a>
                  <a href="https://github.com/ponczuTM" target="_blank" rel="noreferrer" className={styles.channelLinkAnchor}>
                    <FiGithub /> github.com/ponczuTM
                  </a>
                  <span className={styles.channelLinkAnchor}>
                    <FiGlobe /> mroczkowski.netlify.app
                  </span>
                </div>

                <div className={styles.terminalSignatureCluster}>
                  <p className={styles.sigTitle}>Oliwer Mroczkowski</p>
                  <p className={styles.sigSub}>Master Engineer & FullStack Architect</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ==========================================
            8. MINIMALISTIC FOOTER RUNTIME LAYER
           ========================================== */}
        <footer className={styles.minimalistFooter}>
          <div className={styles.footerGlowDivider} />
          <div className={styles.footerContentBlock}>
            <p>© 2026 OLIWER MROCZKOWSKI. ALL RIGHTS RUNTIME SECURED.</p>
            <p className={styles.footerTechStackTelemetry}>REACT × THREE.JS × GSAP × SYSTEM KERNEL</p>
          </div>
        </footer>

      </div>
    </ReactLenis>
  );
}