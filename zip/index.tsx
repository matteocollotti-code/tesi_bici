import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import { 
  Bike, 
  Info, 
  AlertTriangle, 
  X, 
  Database,
  Map as MapIcon,
  CloudRain,
  Sun,
  Cloud,
  CloudFog,
  Snowflake,
  Droplets,
  Wind,
  Target,
  Gauge,
  Footprints,
  Calendar
} from 'lucide-react';

// Proj4 definitions for Italy UTM 32N
// @ts-ignore - proj4 is loaded via CDN in index.html
const utm32 = "+proj=utm +zone=32 +ellps=WGS84 +datum=WGS84 +units=m +no_defs";
const wgs84 = "+proj=longlat +datum=WGS84 +no_defs";

// ISTAT Codes Mapping (Based on PDF 2019 Edition)
const ISTAT_CODES = {
  NATURA_INC: {
    1: "Scontro frontale",
    2: "Scontro frontale-laterale",
    3: "Scontro laterale",
    4: "Tamponamento",
    5: "Investimento di pedone",
    6: "Urto con veicolo in fermata o in arresto",
    7: "Urto con veicolo in sosta",
    8: "Urto con ostacolo accidentale",
    9: "Urto con treno",
    10: "Fuoriuscita",
    11: "Infortunio per frenata improvvisa",
    12: "Infortunio per caduta da veicolo"
  } as Record<number, string>,
  INTERSEZIO: {
    1: "Incrocio",
    2: "Rotatoria",
    3: "Intersezione segnalata",
    4: "Intersezione con semaforo o vigile",
    5: "Intersezione non segnalata",
    6: "Passaggio a livello",
    7: "Rettilineo",
    8: "Curva",
    9: "Dosso, strettoia",
    10: "Pendenza",
    11: "Galleria illuminata",
    12: "Galleria non illuminata"
  } as Record<number, string>,
  TIPO_STRAD: {
    1: "Una carr. senso unico",
    2: "Una carr. doppio senso",
    3: "Due carreggiate",
    4: "Più di 2 carreggiate"
  } as Record<number, string>,
  PAVIMENTAZ: {
    1: "Strada pavimentata",
    2: "Strada pavimentata dissestata",
    3: "Strada non pavimentata"
  } as Record<number, string>,
  FONDO_STRA: {
    1: "Asciutto",
    2: "Bagnato",
    3: "Sdrucciolevole",
    4: "Ghiacciato",
    5: "Innevato"
  } as Record<number, string>,
  SEGNALETIC: {
    1: "Assente",
    2: "Verticale",
    3: "Orizzontale",
    4: "Verticale e orizzontale",
    5: "Temporanea di cantiere"
  } as Record<number, string>,
  CONDIZIONI: {
    1: "Sereno",
    2: "Nebbia",
    3: "Pioggia",
    4: "Grandine",
    5: "Neve",
    6: "Vento forte",
    7: "Altro"
  } as Record<number, string>
};

// 6 Main Macro-Categories + Other
const INCIDENT_CATEGORIES = {
  SIDE: "Scontro Laterale",      // Groups: Laterale (3), Frontale-Laterale (2)
  FRONTAL: "Scontro Frontale",   // Groups: Frontale (1)
  REAR: "Tamponamento",          // Groups: Tamponamento (4)
  PEDESTRIAN: "Investimento Pedone", // Groups: Pedone (5)
  STATIONARY: "Urto in Sosta",   // Groups: Sosta (7), Fermata/Arresto (6)
  RUNOFF: "Fuoriuscita",         // Groups: Fuoriuscita (10)
  OTHER: "Altro"                 // Groups: Ostacolo (8), Treno (9), Caduta (12), etc.
};

// Color Mapping based on provided Legend Image
const CATEGORY_COLORS: Record<string, string> = {
  [INCIDENT_CATEGORIES.SIDE]: "#FB929E",       // Pink/Salmon (from Legend 'Scontro laterale')
  [INCIDENT_CATEGORIES.FRONTAL]: "#A5A5A5",    // Grey (from Legend 'Scontro frontale')
  [INCIDENT_CATEGORIES.REAR]: "#70AD47",       // Green (from Legend 'Tamponamento')
  [INCIDENT_CATEGORIES.PEDESTRIAN]: "#ED7D31", // Orange (from Legend 'Investimento di pedone')
  [INCIDENT_CATEGORIES.STATIONARY]: "#9E480E", // Brown (from Legend 'Urto con veicolo in sosta')
  [INCIDENT_CATEGORIES.RUNOFF]: "#4472C4",     // Blue (from Legend 'Fuoriuscita')
  [INCIDENT_CATEGORIES.OTHER]: "#CBD5E1"       // Slate 300 (Neutral for 'Other')
};

const MILAN_CENTER: [number, number] = [45.4642, 9.1900];

// Helper to decode values
const decodeIstat = (category: keyof typeof ISTAT_CODES, value: any) => {
  if (value === null || value === undefined) return null;
  if (!isNaN(parseInt(value))) {
    const code = parseInt(value);
    return ISTAT_CODES[category][code] || value;
  }
  return value;
};

// Logic to map specific NATURA_INC description to a Macro Category
const mapToCategory = (description: string): string => {
  if (!description) return INCIDENT_CATEGORIES.OTHER;
  const d = description.toLowerCase();

  // 1. Scontro Laterale + Frontale-Laterale (Red/Pink Group)
  if (d.includes('laterale')) return INCIDENT_CATEGORIES.SIDE;
  
  // 2. Scontro Frontale (Grey)
  if (d.includes('frontale')) return INCIDENT_CATEGORIES.FRONTAL;
  
  // 3. Tamponamento (Green)
  if (d.includes('tamponamento')) return INCIDENT_CATEGORIES.REAR;
  
  // 4. Pedone (Orange)
  if (d.includes('pedone')) return INCIDENT_CATEGORIES.PEDESTRIAN;
  
  // 5. Veicolo in Sosta + Fermata/Arresto (Brown Group)
  if (d.includes('sosta') || d.includes('fermata') || d.includes('arresto')) {
    return INCIDENT_CATEGORIES.STATIONARY;
  }
  
  // 6. Fuoriuscita (Blue)
  if (d.includes('fuoriuscita')) return INCIDENT_CATEGORIES.RUNOFF;

  // 7. All others (Ostacolo, Treno, Caduta, Frenata) -> Other
  return INCIDENT_CATEGORIES.OTHER;
};

const App = () => {
  const mapRef = useRef<L.Map | null>(null);
  const geoJsonLayerRef = useRef<L.GeoJSON | null>(null);
  const polygonsLayerRef = useRef<L.LayerGroup | null>(null);
  
  const [geoData, setGeoData] = useState<any>(null);
  const [zona30Data, setZona30Data] = useState<any>(null);
  const [areePedonaliData, setAreePedonaliData] = useState<any>(null);
  
  const [selectedFeature, setSelectedFeature] = useState<any>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  
  // View State
  const [zoomLevel, setZoomLevel] = useState(13);
  const [selectedYear, setSelectedYear] = useState<string>('Tutti');
  const [visibleLayers, setVisibleLayers] = useState({
    zona30: true,
    pedonali: true
  });

  // Extract unique years from data
  const availableYears = useMemo(() => {
    if (!geoData?.features) return [];
    const years = new Set(geoData.features.map((f: any) => f.properties.ANNO));
    return Array.from(years).sort().reverse() as string[];
  }, [geoData]);

  // Initialize Map
  useEffect(() => {
    if (!mapRef.current) {
      mapRef.current = L.map('map', {
        center: MILAN_CENTER,
        zoom: 13,
        zoomControl: false,
        minZoom: 11
      });

      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 20
      }).addTo(mapRef.current);

      L.control.zoom({ position: 'bottomright' }).addTo(mapRef.current);

      mapRef.current.on('zoomend', () => {
        setZoomLevel(mapRef.current!.getZoom());
      });
    }

    const loadAllData = async () => {
      try {
        setLoading(true);
        const [incidentsRes, zona30Res, pedonaliRes] = await Promise.all([
          fetch('./incidents.geojson'),
          fetch('./zona30.geojson'),
          fetch('./areepedonali.geojson')
        ]);

        if (incidentsRes.ok) {
          try {
            const data = await incidentsRes.json();
            const transformedFeatures = data.features.map((f: any) => {
              // Coordinate Transformation
              let coords = f.geometry.coordinates;
              let geometry = f.geometry;
              if (Math.abs(coords[0]) > 1000) {
                // @ts-ignore
                const converted = proj4(utm32, wgs84, coords);
                geometry = { ...f.geometry, coordinates: converted };
              }
              
              // ISTAT Code Decoding
              const p = f.properties;
              const decodedProperties = {
                ...p,
                NATURA_INC: decodeIstat('NATURA_INC', p.NATURA_INC),
                INTERSEZIO: decodeIstat('INTERSEZIO', p.INTERSEZIO),
                TIPO_STRAD: decodeIstat('TIPO_STRAD', p.TIPO_STRAD),
                PAVIMENTAZ: decodeIstat('PAVIMENTAZ', p.PAVIMENTAZ),
                FONDO_STRA: decodeIstat('FONDO_STRA', p.FONDO_STRA),
                SEGNALETIC: decodeIstat('SEGNALETIC', p.SEGNALETIC),
                CONDIZIONI: decodeIstat('CONDIZIONI', p.CONDIZIONI),
              };

              // Determine Category
              decodedProperties.CATEGORY = mapToCategory(decodedProperties.NATURA_INC);

              return { ...f, geometry, properties: decodedProperties };
            });
            setGeoData({ ...data, features: transformedFeatures });
          } catch (e) {
            console.error("Failed to parse incidents.geojson", e);
          }
        }

        if (zona30Res.ok) {
          try { setZona30Data(await zona30Res.json()); } catch (e) {}
        }
        
        if (pedonaliRes.ok) {
          try { setAreePedonaliData(await pedonaliRes.json()); } catch (e) {}
        }

      } catch (err) {
        console.error("Error loading data:", err);
      } finally {
        setLoading(false);
      }
    };

    loadAllData();
  }, []);

  // Handle Polygon Layers
  useEffect(() => {
    if (!mapRef.current) return;

    if (polygonsLayerRef.current) {
      polygonsLayerRef.current.clearLayers();
    } else {
      polygonsLayerRef.current = L.layerGroup().addTo(mapRef.current);
    }

    if (zona30Data && visibleLayers.zona30) {
      L.geoJSON(zona30Data, {
        style: {
          color: '#F59E0B',
          weight: 2,
          opacity: 0.8,
          fillColor: '#FBBF24',
          fillOpacity: 0.15,
          dashArray: '5, 5'
        },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip("Zona 30: " + (feature.properties.name || "Area Limitata"), {
            sticky: true,
            className: 'custom-tooltip'
          });
        }
      }).addTo(polygonsLayerRef.current);
    }

    if (areePedonaliData && visibleLayers.pedonali) {
      L.geoJSON(areePedonaliData, {
        style: {
          color: '#10B981',
          weight: 2,
          opacity: 0.8,
          fillColor: '#34D399',
          fillOpacity: 0.15
        },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip("Area Pedonale: " + (feature.properties.name || "ZTL"), {
            sticky: true,
            className: 'custom-tooltip'
          });
        }
      }).addTo(polygonsLayerRef.current);
    }

  }, [zona30Data, areePedonaliData, visibleLayers]);

  // Handle Incidents Layer
  useEffect(() => {
    if (!mapRef.current || !geoData) return;

    if (geoJsonLayerRef.current) {
      mapRef.current.removeLayer(geoJsonLayerRef.current);
    }

    const filteredFeatures = selectedYear === 'Tutti' 
      ? geoData.features 
      : geoData.features.filter((f: any) => String(f.properties.ANNO) === String(selectedYear));

    const filteredGeoData = { ...geoData, features: filteredFeatures };

    const createIcon = (category: string) => {
      const color = CATEGORY_COLORS[category] || CATEGORY_COLORS[INCIDENT_CATEGORIES.OTHER];
      
      if (zoomLevel < 14) {
        return L.divIcon({
          className: 'custom-dot',
          html: `<div style="background-color: ${color}; width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 4px ${color};"></div>`,
          iconSize: [8, 8],
          iconAnchor: [4, 4]
        });
      }
      
      if (zoomLevel < 16) {
        return L.divIcon({
          className: 'custom-dot-medium',
          html: `<div style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.2);"></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        });
      }

      return L.divIcon({
        className: 'custom-marker',
        html: `
          <div style="
            background: white; padding: 7px; border-radius: 50%; 
            box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); 
            border: 2px solid ${color};
            display: flex; align-items: center; justify-content: center;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          " class="marker-inner hover:scale-125 hover:z-[1001]">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>
            </svg>
          </div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });
    };

    geoJsonLayerRef.current = L.geoJSON(filteredGeoData, {
      pointToLayer: (feature, latlng) => {
        return L.marker(latlng, { 
          icon: createIcon(feature.properties.CATEGORY) 
        });
      },
      onEachFeature: (feature, layer) => {
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          setSelectedFeature(feature);
          setIsPanelOpen(true);
          mapRef.current?.flyTo(e.latlng, 17, { duration: 1 });
        });
      }
    }).addTo(mapRef.current);

  }, [geoData, zoomLevel, selectedYear]);

  const getWeatherIcon = (cond: string) => {
    const c = cond?.toLowerCase() || '';
    if (c.includes('sereno')) return <Sun className="text-amber-500" size={20} />;
    if (c.includes('pioggia')) return <CloudRain className="text-blue-500" size={20} />;
    if (c.includes('nuvoloso') || c.includes('coperto')) return <Cloud className="text-slate-400" size={20} />;
    if (c.includes('nebbia')) return <CloudFog className="text-slate-300" size={20} />;
    if (c.includes('neve')) return <Snowflake className="text-cyan-400" size={20} />;
    return <Wind size={20} className="text-slate-400" />;
  };

  const getSurfaceIcon = (surf: string) => {
    const s = surf?.toLowerCase() || '';
    if (s.includes('asciutto')) return <Sun size={18} />;
    if (s.includes('bagnato')) return <Droplets className="text-blue-400" size={18} />;
    if (s.includes('ghiaccio')) return <Snowflake className="text-cyan-300" size={18} />;
    return <MapIcon size={18} />;
  };

  const activeCategory = selectedFeature?.properties?.CATEGORY || INCIDENT_CATEGORIES.OTHER;
  const activeColor = CATEGORY_COLORS[activeCategory];

  return (
    <div className="relative w-full h-screen font-sans text-slate-900 bg-slate-100 overflow-hidden">
      {/* Loading Overlay */}
      {loading && (
        <div className="absolute inset-0 z-[3000] bg-white flex flex-col items-center justify-center">
          <div className="animate-spin h-12 w-12 border-4 border-indigo-600 border-t-transparent rounded-full mb-4"></div>
          <p className="font-bold text-slate-500 uppercase tracking-widest text-xs animate-pulse">Caricamento Mappa...</p>
        </div>
      )}

      {/* Header UI */}
      <header className="absolute top-6 left-6 right-6 z-[1000] flex justify-between items-start pointer-events-none">
        <div className="glass px-6 py-4 rounded-3xl shadow-2xl border border-white/50 pointer-events-auto flex items-center gap-5 transition-all hover:scale-[1.01]">
          <div className="bg-indigo-600 p-3 rounded-2xl text-white shadow-xl shadow-indigo-200">
            <Bike size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight text-slate-800">Milano <span className="text-indigo-600">BikeSafe</span></h1>
            <p className="text-[11px] font-bold text-slate-500 flex items-center gap-1.5 uppercase tracking-wider">
              <Database size={14} className="text-indigo-400" />
              {geoData?.features?.length || 0} Incidenti
            </p>
          </div>
        </div>

        {/* Layer Toggles */}
        <div className="glass p-2 rounded-2xl shadow-xl border border-white/50 pointer-events-auto flex gap-2">
           <button 
             onClick={() => setVisibleLayers(p => ({...p, zona30: !p.zona30}))}
             className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${visibleLayers.zona30 ? 'bg-amber-100 text-amber-700' : 'bg-transparent text-slate-400 hover:bg-slate-50'}`}
           >
             <Gauge size={16} /> Zona 30
           </button>
           <button 
             onClick={() => setVisibleLayers(p => ({...p, pedonali: !p.pedonali}))}
             className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${visibleLayers.pedonali ? 'bg-emerald-100 text-emerald-700' : 'bg-transparent text-slate-400 hover:bg-slate-50'}`}
           >
             <Footprints size={16} /> Aree Pedonali
           </button>
        </div>
      </header>

      {/* Map */}
      <div id="map" className="w-full h-full"></div>

      {/* Sidebar Panel */}
      <div 
        className={`fixed top-0 right-0 h-full w-full md:w-[480px] glass z-[2000] shadow-[-20px_0_50px_rgba(0,0,0,0.1)] transition-transform duration-700 cubic-bezier(0.4, 0, 0.2, 1) flex flex-col ${
          isPanelOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Detail Header */}
        <div className="p-10 flex justify-between items-start border-b border-slate-200 bg-white/40">
          <div className="flex-1 pr-6">
            <div className="flex items-center gap-2 mb-3">
               <span 
                 className="inline-flex items-center px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest text-white shadow-sm"
                 style={{ backgroundColor: activeColor }}
               >
                 {activeCategory}
               </span>
               <span className="text-[10px] font-bold text-slate-400 tracking-tighter">ANNO {selectedFeature?.properties?.ANNO}</span>
            </div>
            <h2 className="text-3xl font-black text-slate-800 leading-[1.1] tracking-tight">
              {selectedFeature?.properties?.LOCALIZZAZ || selectedFeature?.properties?.NIL || "Località non definita"}
            </h2>
          </div>
          <button 
            onClick={() => setIsPanelOpen(false)}
            className="p-3 bg-white/50 hover:bg-white hover:shadow-lg rounded-2xl transition-all text-slate-400 hover:text-rose-500"
          >
            <X size={28} />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-10 space-y-10 custom-scrollbar">
          
          {/* Hero Section: NATURA_INC */}
          <section>
            <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.25em] mb-5 flex items-center gap-2">
              <AlertTriangle size={16} style={{ color: activeColor }} /> Dettaglio Incidente
            </h3>
            <div 
              className="relative p-8 rounded-[2rem] text-white shadow-2xl transition-colors duration-500 overflow-hidden group"
              style={{ background: `linear-gradient(135deg, ${activeColor}, ${activeColor}cc)` }}
            >
              <div className="absolute -right-8 -bottom-8 opacity-10 group-hover:scale-125 transition-transform duration-1000">
                <Bike size={180} />
              </div>
              <p className="text-2xl font-black relative z-10 leading-tight">
                {selectedFeature?.properties?.NATURA_INC || "In fase di accertamento"}
              </p>
              <div className="mt-4 flex gap-2 relative z-10">
                 <div className="px-3 py-1 bg-white/20 rounded-full text-[10px] font-bold backdrop-blur-sm">
                    {selectedFeature?.properties?.TIPO_STRAD || "Urbana"}
                 </div>
              </div>
            </div>
          </section>

          {/* Dynamic Environment Grid */}
          <div className="grid grid-cols-2 gap-6">
            <div className="p-6 rounded-3xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
              <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                Meteo
              </h4>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-2xl bg-slate-50 border border-slate-100">
                  {getWeatherIcon(selectedFeature?.properties?.CONDIZIONI)}
                </div>
                <p className="font-black text-slate-800 text-lg uppercase tracking-tight leading-none">
                  {selectedFeature?.properties?.CONDIZIONI || "N/D"}
                </p>
              </div>
            </div>
            <div className="p-6 rounded-3xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-shadow">
              <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                Fondo
              </h4>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-2xl bg-slate-50 border border-slate-100">
                  {getSurfaceIcon(selectedFeature?.properties?.FONDO_STRA)}
                </div>
                <p className="font-black text-slate-800 text-lg uppercase tracking-tight leading-none">
                  {selectedFeature?.properties?.FONDO_STRA || "N/D"}
                </p>
              </div>
            </div>
          </div>

          {/* Detailed Info */}
          <section className="bg-slate-50/50 p-8 rounded-[2rem] border border-slate-100 space-y-5">
             <h3 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.25em] flex items-center gap-2">
               <Info size={16} /> Caratteristiche
             </h3>
             <div className="space-y-4">
                {[
                  { label: "Quartiere (NIL)", value: selectedFeature?.properties?.NIL, highlight: true },
                  { label: "Segnaletica", value: selectedFeature?.properties?.SEGNALETIC },
                  { label: "Intersezione", value: selectedFeature?.properties?.INTERSEZIO },
                  { label: "Pavimentazione", value: selectedFeature?.properties?.PAVIMENTAZ }
                ].map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between py-3 border-b border-slate-200/50 last:border-0">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wide">{item.label}</span>
                    <span className={`text-sm font-black text-right ${item.highlight ? 'text-indigo-600' : 'text-slate-700'}`}>
                      {item.value || "Informazione non rilevata"}
                    </span>
                  </div>
                ))}
             </div>
          </section>
        </div>

        {/* GPS Coordinate Footer */}
        <div className="p-10 bg-white border-t border-slate-200">
          <div className="flex flex-col gap-4">
            <h4 className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
              <Target size={16} className="text-indigo-600" /> Coordinate Geografiche (GPS)
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 shadow-inner group">
                <span className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Latitudine</span>
                <code className="text-lg font-mono font-bold text-slate-800 transition-colors group-hover:text-indigo-600">
                  {selectedFeature?.geometry?.coordinates[1]?.toFixed(7) || '---.-------'}°
                </code>
              </div>
              <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 shadow-inner group">
                <span className="text-[9px] font-bold text-slate-400 uppercase block mb-1">Longitudine</span>
                <code className="text-lg font-mono font-bold text-slate-800 transition-colors group-hover:text-indigo-600">
                  {selectedFeature?.geometry?.coordinates[0]?.toFixed(7) || '---.-------'}°
                </code>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer Controls: Timeline & Legend */}
      <div className="absolute bottom-6 left-6 right-6 z-[1000] pointer-events-none flex flex-col md:flex-row items-end justify-between gap-6">
        
        {/* Dynamic Legend */}
        <div className="glass p-6 rounded-[2.5rem] shadow-2xl border border-white/50 pointer-events-auto min-w-[280px]">
          <h3 className="text-[12px] font-black text-slate-800 uppercase tracking-[0.15em] mb-5 pb-3 border-b border-slate-200">
            Categorie Incidenti
          </h3>
          <div className="space-y-3.5 max-h-[300px] overflow-y-auto custom-scrollbar pr-2">
            {Object.entries(CATEGORY_COLORS).map(([type, color]) => (
              <div key={type} className="flex items-center gap-3.5 group cursor-default">
                <div 
                  className="w-4 h-4 rounded-full shadow-sm transition-transform group-hover:scale-125" 
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs font-bold text-slate-600 tracking-tight group-hover:text-slate-900 transition-colors">
                  {type}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Timeline Filter */}
        <div className="glass p-3 rounded-full shadow-2xl border border-white/50 pointer-events-auto flex items-center gap-1 overflow-x-auto max-w-full">
          <div className="px-3 text-slate-400">
            <Calendar size={20} />
          </div>
          <button 
            onClick={() => setSelectedYear('Tutti')}
            className={`px-5 py-2.5 rounded-full text-xs font-black uppercase tracking-wider transition-all ${selectedYear === 'Tutti' ? 'bg-indigo-600 text-white shadow-lg' : 'bg-transparent text-slate-500 hover:bg-slate-100'}`}
          >
            Tutti
          </button>
          <div className="w-px h-6 bg-slate-200 mx-1"></div>
          {availableYears.map(year => (
             <button 
               key={year}
               onClick={() => setSelectedYear(year)}
               className={`px-5 py-2.5 rounded-full text-xs font-black transition-all ${selectedYear === year ? 'bg-slate-800 text-white shadow-lg' : 'bg-transparent text-slate-500 hover:bg-slate-100'}`}
             >
               {year}
             </button>
          ))}
        </div>

      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);