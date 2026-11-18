'use strict';

// ÁRBOL DERIVADO — una cartografía ramificada construida con las calles de los mosaicos vectoriales del mapa.
// El modelo es INSPIRADO en ramificaciones estocásticas, NO es la DLA física de Witten y Sander.
// Tampoco es un motor de navegación: no evalúa cortes, obras, seguridad ni accesibilidad real.

const ZONES = {
  recoleta: {label: 'RECOLETA, BUENOS AIRES', point: [-34.58823, -58.39310], zoom: 15},
  palermo: {label: 'PALERMO, BUENOS AIRES', point: [-34.58065, -58.41965], zoom: 15},
  'san-telmo': {label: 'SAN TELMO, BUENOS AIRES', point: [-34.62136, -58.37189], zoom: 15}
};
const el = id => document.getElementById(id);
const ui = {
  zone: el('zone'), radius: el('radius'), radiusValue: el('radiusValue'),
  branching: el('branching'), branchValue: el('branchValue'), generate: el('generate'),
  generateLabel: el('generateLabel'), pause: el('pause'), clear: el('clear'),
  statusLight: el('statusLight'), statusTitle: el('statusTitle'), statusDetail: el('statusDetail'),
  placeName: el('placeName'), centerMap: el('centerMap'),
  edgesCount: el('edgesCount'), forksCount: el('forksCount'), lengthCount: el('lengthCount'),
  export: el('export')
};
el('year').textContent = String(new Date().getFullYear());

const state = {
  origin: ZONES.recoleta.point.slice(),
  network: null, loadedKey: '',
  edges: [], usedNodes: new Set(), usedEdges: new Set(), tips: [],
  lineLayers: [], layerGroup: null, originMarker: null, radiusCircle: null,
  totalMeters: 0, forks: 0, timer: null, requestId: 0,
  paused: false, running: false, working: false, targetCount: 0,
  graphStartId: null, seed: 0
};

function setStatus(title, detail, kind = 'ready') {
  ui.statusTitle.textContent = title;
  ui.statusDetail.textContent = detail;
  ui.statusLight.className = 'status-light' + (kind === 'busy' ? ' busy' : kind === 'error' ? ' error' : '');
}
function updateStats() {
  ui.edgesCount.textContent = String(state.edges.length).padStart(2, '0');
  ui.forksCount.textContent = String(state.forks).padStart(2, '0');
  ui.lengthCount.textContent = state.totalMeters >= 1000 ? (state.totalMeters / 1000).toFixed(2).replace('.', ',') + ' km' : Math.round(state.totalMeters) + ' m';
}
const degrees = rad => rad * 180 / Math.PI;
const radians = deg => deg * Math.PI / 180;
function distance(a, b) {
  const p1 = radians(a[0]), p2 = radians(b[0]);
  const dp = p2 - p1, dl = radians(b[1] - a[1]);
  const s = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
}
function bearing(a, b) {
  const x = (b[1] - a[1]) * Math.cos(radians((a[0] + b[0]) / 2));
  const y = b[0] - a[0];
  return Math.atan2(y, x);
}
function angularSimilarity(a, b) { return Math.cos(a-b); }
const edgeKey = (a, b) => a < b ? a + '/' + b : b + '/' + a;

let map;
let vectorMap = null;
if (typeof L === 'undefined' || typeof L.maplibreGL !== 'function') {
  setStatus('No se pudo cargar el mapa', 'Comprobá la conexión a internet, recargá y verificá que el navegador permita WebGL.', 'error');
  ui.generate.disabled = true;
} else {
  map = L.map('map', {zoomControl: true, preferCanvas: true, scrollWheelZoom: true}).setView(state.origin, 15);
  // Fondo vectorial: OpenFreeMap no requiere claves ni registro.
  // A diferencia de los teselas del servidor comunitario de OSM, se puede usar
  // en este prototipo local sin depender de una cabecera Referer específica.
  // El algoritmo obtiene las calles de esas mismas teselas de OpenFreeMap: sin Overpass.
  if (typeof L.maplibreGL === 'function') {
    const basemap = L.maplibreGL({
      style: 'https://tiles.openfreemap.org/styles/positron',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors · <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a>'
    }).addTo(map);
    // Informar si los datos externos no están disponibles (por ejemplo, sin internet).
    const gl = basemap.getMaplibreMap();
    vectorMap = gl;
    let mapLoaded = false;
    gl.on('load', () => { mapLoaded = true; });
    gl.on('error', (event) => {
      if (!mapLoaded) {
        console.warn('Árbol Derivado: no se pudo cargar el fondo cartográfico', event?.error || event);
        setStatus('Error al cargar el mapa', 'Verificá tu conexión a internet y volvé a abrir la página.', 'error');
      }
    });
  } else {
    setStatus('No se pudo cargar el mapa', 'No se cargó el visor vectorial. Revisá internet y recargá la página.', 'error');
    ui.generate.disabled = true;
  }
  state.layerGroup = L.featureGroup().addTo(map);
  state.originMarker = L.marker(state.origin, {
    icon: L.divIcon({className: '', html: '<div class="origin-marker" aria-label="Semilla"><span class="seed-sprout">✦</span></div>', iconSize: [28,28], iconAnchor: [14,14]}),
    title: 'Semilla: punto donde comienza el crecimiento'
  }).addTo(map);
  state.radiusCircle = L.circle(state.origin, {radius: Number(ui.radius.value), color: '#728f60', weight: 1, opacity: .55, dashArray: '5 8', fillColor: '#a4b47a', fillOpacity: .075, interactive: false}).addTo(map);
  map.on('click', event => {
    if (state.working || state.running) {
      setStatus('El árbol está creciendo', 'Pausá el crecimiento antes de mover la semilla.', 'busy');
      return;
    }
    ui.zone.value = 'custom';
    setOrigin([event.latlng.lat, event.latlng.lng], 'SEMILLA PLANTADA EN EL MAPA', false);
  });
  restoreSaved();
}

function setOrigin(point, title, move = true) {
  stopAnimation();
  state.requestId++;
  state.origin = point.slice();
  state.network = null; state.loadedKey = '';
  clearDrawing(false);
  if (map) {
    state.originMarker.setLatLng(point);
    state.radiusCircle.setLatLng(point);
    if (move) map.setView(point, 15);
  }
  ui.placeName.textContent = title;
  setStatus('Semilla plantada', 'Presioná «Hacer crecer las ramas» para empezar.');
}

ui.zone.addEventListener('change', () => {
  const zone = ZONES[ui.zone.value];
  if (!zone) {
    setStatus('Elegí dónde plantar', 'Tocá el mapa para ubicar la semilla.');
    return;
  }
  setOrigin(zone.point, zone.label);
});
ui.radius.addEventListener('input', () => {
  const r = Number(ui.radius.value);
  ui.radiusValue.textContent = r >= 1000 ? (r/1000).toFixed(2).replace('.', ',') + ' km' : r + ' m';
  if (state.radiusCircle) state.radiusCircle.setRadius(r);
});
ui.branching.addEventListener('input', () => {
  ui.branchValue.textContent = ['','Muy baja','Baja','Media','Alta','Muy alta'][Number(ui.branching.value)];
});
ui.centerMap.addEventListener('click', () => {
  if (map) map.flyTo(state.origin, Math.max(map.getZoom(), 15), {duration: .5});
});
ui.generate.addEventListener('click', generate);
ui.pause.addEventListener('click', () => {
  if (!state.running) return;
  state.paused = !state.paused;
  ui.pause.querySelector('span').textContent = state.paused ? 'Seguir creciendo' : 'Pausar crecimiento';
  ui.pause.firstChild.textContent = state.paused ? '▷ ' : 'Ⅱ ';
  setStatus(state.paused ? 'Crecimiento en pausa' : 'Las ramas están creciendo', state.paused ? 'Podés reanudar cuando quieras.' : 'El árbol se expande siguiendo las calles.', state.paused ? 'ready' : 'busy');
});
ui.clear.addEventListener('click', () => {
  state.requestId++;
  clearDrawing(true);
  setStatus('La semilla sigue en su lugar', 'Las ramas se retiraron. Podés hacerlas crecer de nuevo.');
});
ui.export.addEventListener('click', exportGeoJSON);

function stopAnimation() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.paused = false;
  state.running = false;
  state.working = false;
  ui.pause.disabled = true;
  ui.pause.querySelector('span').textContent = 'Pausar crecimiento';
  ui.pause.firstChild.textContent = 'Ⅱ ';
  ui.generate.disabled = !map;
  ui.generateLabel.textContent = 'Hacer crecer las ramas';
}
function clearDrawing(removeSaved = false) {
  stopAnimation();
  if (state.layerGroup) state.layerGroup.clearLayers();
  state.edges = []; state.lineLayers = [];
  state.usedEdges = new Set(); state.usedNodes = new Set(); state.tips = [];
  state.totalMeters = 0; state.forks = 0;
  state.graphStartId = null;
  ui.clear.disabled = true; ui.export.disabled = true;
  updateStats();
  if (removeSaved) try { localStorage.removeItem('arbol-derivado-v1'); localStorage.removeItem('deriva-v1'); } catch (_e) {}
}

function networkKey(origin, radius) { return `${origin[0].toFixed(4)},${origin[1].toFixed(4)},${radius}`; }
// Convertir un radio en metros a límites geográficos sin crear un círculo Leaflet
// desconectado del mapa. getBounds() en un círculo sin .addTo(map) puede fallar
// porque no existe su referencia al mapa (layerPointToLatLng undefined).
function boundsAround(origin, radius) {
  return L.latLng(origin[0], origin[1]).toBounds(2 * radius);
}
// V3: sacar las calles del MISMO mapa vectorial de OpenFreeMap que se está mostrando.
// Ya no hay POST a Overpass, esperas de 18 segundos ni otra API para el recorrido.
// MapLibre solo permite consultar las calles de los mosaicos cargados en pantalla.
// Por eso primero ajustamos el encuadre al área elegida y esperamos a que termine.
function roadsInVisibleMap() {
  if (!vectorMap || !vectorMap.getStyle()) throw Error('El mapa todavía se está cargando.');
  const style = vectorMap.getStyle();
  const sources = new Map();
  for (const layer of (style.layers || [])) {
    const sourceLayer = layer['source-layer'];
    if (!sourceLayer || !layer.source) continue;
    if (!/(transportation|road|street)/i.test(sourceLayer)) continue;
    if ((style.sources || {})[layer.source]?.type !== 'vector') continue;
    sources.set(`${layer.source}/${sourceLayer}`, {source:layer.source, sourceLayer});
  }
  if (sources.size === 0) throw Error('El mapa no tiene una capa de calles disponible.');
  const features = [];
  for (const {source, sourceLayer} of sources.values()) {
    try {
      const result = vectorMap.querySourceFeatures(source, {sourceLayer});
      if (result?.length) features.push(...result);
    } catch (err) { console.warn('Árbol Derivado: capa de calles no disponible', sourceLayer, err); }
  }
  return features;
}
function waitForMapTiles(requestId) {
  return new Promise((resolve, reject) => {
    if (!vectorMap) return reject(Error('El visor vectorial no está disponible.'));
    let done = false;
    const timeout = setTimeout(() => finish(), 12000);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      vectorMap.off('idle', finish);
      if (requestId !== state.requestId) return resolve(false);
      resolve(true);
    };
    if (vectorMap.loaded() && vectorMap.areTilesLoaded()) finish();
    else vectorMap.on('idle', finish);
  });
}
const pointCross = (a,b) => a[0]*b[1]-a[1]*b[0];
function makeRoadGraph(features, origin, radius) {
  // Línea del vector tile -> segmentos reales en lat/lon.
  // El estilo puede fragmentar calles en los límites de mosaicos; por eso conectamos
  // extremos repetidos y calculamos intersecciones antes de armar la red.
  const latitudeToM = 111194.93;
  const longitudeToM = latitudeToM * Math.cos(radians(origin[0]));
  const xy = p => [(p[1]-origin[1])*longitudeToM,(p[0]-origin[0])*latitudeToM];
  const latlng = v => [origin[0]+v[1]/latitudeToM,origin[1]+v[0]/longitudeToM];
  const segments = [];
  const dedupe = new Set();
  for (const feature of features) {
    const geom = feature.geometry;
    if (!geom || (geom.type !== 'LineString' && geom.type !== 'MultiLineString')) continue;
    const prop = feature.properties || {};
    const roadClass = String(prop.class || prop.type || prop.subclass || '').toLowerCase();
    if (/(rail|subway|tram|ferry|runway|taxiway|motorway|trunk|busway)/.test(roadClass)) continue;
    const name = prop.name || prop.name_es || 'Calle del mapa';
    const level = `${prop.brunnel || ''}/${prop.layer || ''}/${prop.bridge || ''}/${prop.tunnel || ''}`;
    const lines = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const c0 = line[i-1],c1 = line[i];
        if (!Array.isArray(c0) || !Array.isArray(c1)) continue;
        if (![c0[0],c0[1],c1[0],c1[1]].every(Number.isFinite)) continue;
        const a = xy([c0[1],c0[0]]), b = xy([c1[1],c1[0]]);
        const length = Math.hypot(b[0]-a[0],b[1]-a[1]);
        if (length < 1.2 || length > 500) continue;
        if (Math.min(a[0],b[0]) > radius+180 || Math.max(a[0],b[0]) < -radius-180 ||
            Math.min(a[1],b[1]) > radius+180 || Math.max(a[1],b[1]) < -radius-180) continue;
        // El proveedor puede devolver calles duplicadas por mosaicos y múltiples estilos.
        const ka = `${Math.round(a[0]*10)},${Math.round(a[1]*10)}`;
        const kb = `${Math.round(b[0]*10)},${Math.round(b[1]*10)}`;
        const key = ka < kb ? ka + ':' + kb : kb + ':' + ka;
        if (dedupe.has(key)) continue;
        dedupe.add(key);
        segments.push({a,b,name,level,splits:[0,1]});
      }
    }
  }
  if (segments.length < 30) throw Error('No hay suficientes calles cargadas en el mapa.');

  // Índice de grilla de 90 m: no comparamos cada segmento con todos los demás.
  const bins = new Map(), cell = 90;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const x1 = Math.floor(Math.min(s.a[0],s.b[0])/cell);
    const x2 = Math.floor(Math.max(s.a[0],s.b[0])/cell);
    const y1 = Math.floor(Math.min(s.a[1],s.b[1])/cell);
    const y2 = Math.floor(Math.max(s.a[1],s.b[1])/cell);
    for (let x=x1;x<=x2;x++) for(let y=y1;y<=y2;y++) {
      const key = x+','+y;
      if (!bins.has(key)) bins.set(key,[]);
      bins.get(key).push(i);
    }
  }
  const tested = new Set();
  for (const ids of bins.values()) {
    for (let i=0;i<ids.length;i++) for (let j=i+1;j<ids.length;j++) {
      const id1=ids[i],id2=ids[j];
      const pair = id1<id2 ? id1+','+id2 : id2+','+id1;
      if (tested.has(pair)) continue;
      tested.add(pair);
      const s=segments[id1],t=segments[id2];
      if (s.level !== t.level) continue;
      const r=[s.b[0]-s.a[0],s.b[1]-s.a[1]];
      const u=[t.b[0]-t.a[0],t.b[1]-t.a[1]];
      const denom=pointCross(r,u);
      if (Math.abs(denom)<.00001) continue;
      const q=[t.a[0]-s.a[0],t.a[1]-s.a[1]];
      const at=pointCross(q,u)/denom,bt=pointCross(q,r)/denom;
      if(at>=-.003&&at<=1.003&&bt>=-.003&&bt<=1.003) {
        s.splits.push(Math.min(1,Math.max(0,at)));
        t.splits.push(Math.min(1,Math.max(0,bt)));
      }
    }
  }
  const nodes = new Map(), links = new Set();
  // Redondeamos a metros para reunir extremos de diferentes mosaicos vectoriales.
  function nodeAt(v) {
    const key=Math.round(v[0]/1.2)+','+Math.round(v[1]/1.2);
    if (!nodes.has(key)) nodes.set(key,{id:key,point:latlng(v),neighbors:[]});
    return nodes.get(key);
  }
  for (const s of segments) {
    s.splits.sort((a,b)=>a-b);
    let last = null;
    for (const t of s.splits) {
      const point = [s.a[0]+(s.b[0]-s.a[0])*t,s.a[1]+(s.b[1]-s.a[1])*t];
      const node = nodeAt(point);
      if (last && last.id !== node.id) {
        const key = edgeKey(last.id,node.id);
        if (!links.has(key)) {
          const dist = distance(last.point,node.point);
          if (dist>=.9 && dist<=450) {
            links.add(key);
            last.neighbors.push({id:node.id,key,distance:dist,name:s.name});
            node.neighbors.push({id:last.id,key,distance:dist,name:s.name});
          }
        }
      }
      last = node;
    }
  }
  for (const [id,n] of nodes) if(!n.neighbors.length) nodes.delete(id);
  // Encontrar calle más cercana al origen y quedarnos con su componente conectada.
  let nearest=null, min=Infinity;
  for (const n of nodes.values()) {
    const d=distance(origin,n.point);
    if(d<min) {min=d;nearest=n;}
  }
  if (!nearest || min > 250) throw Error('No se encontró una calle cerca del origen seleccionado.');
  const reached=new Set([nearest.id]),queue=[nearest.id];
  for(let head=0;head<queue.length;head++) {
    const n=nodes.get(queue[head]);
    for(const edge of n.neighbors) {
      const other=nodes.get(edge.id);
      if(!other || reached.has(edge.id) || distance(origin,other.point)>radius+50) continue;
      reached.add(edge.id);queue.push(edge.id);
    }
  }
  const component=new Map();
  for (const id of reached) {
    const n=nodes.get(id);
    component.set(id,{...n,neighbors:n.neighbors.filter(e=>reached.has(e.id))});
  }
  if (component.size < 30) throw Error('La zona visible tiene pocas calles conectadas. Acercá el mapa o elegí otro origen.');
  return {nodes:component,startId:nearest.id};
}
async function getRoadGraphFromMap(origin, radius, requestId) {
  const key=networkKey(origin,radius);
  if(state.network && state.loadedKey===key) return state.network;
  if (!vectorMap) throw Error('El mapa todavía no se cargó.');
  map.fitBounds(boundsAround(origin, radius*1.08),{padding:[18,18],maxZoom:15,animate:false});
  const isCurrent=await waitForMapTiles(requestId);
  if (!isCurrent) return null;
  let features=roadsInVisibleMap();
  if (features.length < 30) {
    // Algunas teselas tardan un instante extra en pintar la geometría.
    await new Promise(resolve=>setTimeout(resolve,800));
    features=roadsInVisibleMap();
  }
  if(requestId!==state.requestId) return null;
  const graph=makeRoadGraph(features,origin,radius);
  state.network=graph;state.loadedKey=key;
  return graph;
}

function weightedChoice(options, weightFn) {
  const weights = options.map(item => Math.max(.001, weightFn(item)));
  let val = Math.random() * weights.reduce((x,y) => x+y,0);
  for (let i=0; i<options.length; i++) {
    val -= weights[i];
    if (val <= 0) return options[i];
  }
  return options[options.length-1];
}
function validEdges(tip) {
  const from = state.network.nodes.get(tip.id);
  if (!from) return [];
  return from.neighbors.filter(e => !state.usedEdges.has(e.key) && !state.usedNodes.has(e.id));
}
function chooseEdge(tip, options) {
  const from = state.network.nodes.get(tip.id);
  return weightedChoice(options, e => {
    const target = state.network.nodes.get(e.id);
    const direction = bearing(from.point, target.point);
    const straightness = tip.direction === null ? 0 : angularSimilarity(tip.direction, direction);
    const heading = tip.direction === null ? 1 : .35 + 1.65 * Math.pow((1 + straightness)/2, 1.6);
    return heading * (1 / Math.sqrt(Math.max(e.distance, 3))) * (.55 + Math.random() * 1.15);
  });
}
function updateButtons() {
  ui.clear.disabled = !state.edges.length && !state.working && !state.running;
  ui.export.disabled = !state.edges.length;
}
function drawEdge(a, b, name) {
  const line = L.polyline([a,b], {color:'#638950', weight:5, opacity:.95, lineCap:'round', lineJoin:'round'});
  const safeName = String(name).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  line.bindPopup(`<div class="segment-popup"><b>${safeName}</b><span>Una rama de este árbol urbano</span></div>`);
  line.addTo(state.layerGroup);
  state.lineLayers.push(line);
}
function extendFrom(tip) {
  const from = state.network.nodes.get(tip.id);
  const choices = validEdges(tip);
  if (!choices.length) return false;
  const chosen = chooseEdge(tip, choices);
  const next = state.network.nodes.get(chosen.id);
  const heading = bearing(from.point, next.point);
  const prevTipId = tip.id;
  state.usedEdges.add(chosen.key); state.usedNodes.add(chosen.id);
  const branchChance = .08 + (Number(ui.branching.value) - 1) * .15;
  if (choices.length >= 2 && state.tips.length < 18 && Math.random() < branchChance) {
    state.tips.push({id:prevTipId, direction:tip.direction, progress:tip.progress, age:0});
    state.forks++;
  }
  tip.id = chosen.id;
  tip.direction = heading;
  tip.progress += chosen.distance;
  tip.age++;
  state.edges.push({a: from.point, b: next.point, name: chosen.name, meters: chosen.distance});
  state.totalMeters += chosen.distance;
  drawEdge(from.point, next.point, chosen.name);
  return true;
}
function reactivateFrontier() {
  const options = [];
  for (const id of state.usedNodes) {
    const n = state.network.nodes.get(id);
    if (!n) continue;
    const open = n.neighbors.filter(e => !state.usedNodes.has(e.id));
    if (open.length) options.push(n);
  }
  if (!options.length) return false;
  const node = options[Math.floor(Math.random() * options.length)];
  state.tips.push({id: node.id, direction: null, progress: 0, age: 0});
  state.forks++;
  return true;
}
function growthTick() {
  if (state.paused) return;
  // More than one small street segment per frame, without blocking interaction.
  for (let k=0; k<2; k++) {
    if (state.edges.length >= state.targetCount) {finishGrowth();return;}
    if (state.tips.length === 0 && !reactivateFrontier()) {finishGrowth();return;}
    const withOptions = state.tips.filter(tip => validEdges(tip).length);
    if (!withOptions.length) {
      state.tips = [];
      if (!reactivateFrontier()) {finishGrowth();return;}
    }
    const choices = state.tips.filter(tip => validEdges(tip).length);
    if (!choices.length) {finishGrowth();return;}
    const tip = weightedChoice(choices, t => 1.1 / Math.pow(1 + t.age * .08, .45));
    const success = extendFrom(tip);
    if (!success || !validEdges(tip).length) state.tips = state.tips.filter(t => t !== tip);
  }
  updateStats(); updateButtons();
  if (state.edges.length % 14 === 0) saveLocal();
}
function finishGrowth() {
  stopAnimation();
  updateButtons(); updateStats();
  saveLocal();
  setStatus('El árbol terminó de crecer', `${state.edges.length} tramos nacieron de tu semilla. Podés crear otra variante.`, 'ready');
}
async function generate() {
  if (!map || state.working || state.running) return;
  state.requestId++;
  const requestId = state.requestId;
  const origin = state.origin.slice();
  const radius = Number(ui.radius.value);
  const networkCached = state.network && state.loadedKey === networkKey(origin, radius);
  clearDrawing(false);
  state.working = true;
  ui.generate.disabled = true;
  ui.generateLabel.textContent = 'Preparando el terreno…';
  ui.clear.disabled = false;
  setStatus('Preparando el terreno', networkCached ? 'Buscando nuevas direcciones para crecer…' : 'Identificando las calles por donde pueden crecer las ramas…', 'busy');
  try {
    const network = await getRoadGraphFromMap(origin, radius, requestId);
    if (requestId !== state.requestId || !network) return;
    if (!network.startId) throw Error('No hay un punto inicial en esta zona');
    state.network = network;
    state.usedNodes.add(network.startId);
    state.graphStartId = network.startId;
    state.tips = [{id:network.startId, direction:null, progress:0, age:0}];
    const snappedPoint = network.nodes.get(network.startId).point;
    state.originMarker.setLatLng(snappedPoint); // El inicio siempre coincide con un nodo real de calle.
    map.fitBounds(boundsAround(origin, radius*1.07), {padding: [18, 18], maxZoom: 15});
    state.targetCount = Math.min(280, Math.max(42, Math.round(radius * (.075 + Number(ui.branching.value) * .025))));
    state.working = false;
    state.running = true;
    ui.generate.disabled = true;
    ui.generateLabel.textContent = 'Las ramas están creciendo…';
    ui.pause.disabled = false;
    setStatus('Las ramas están creciendo', `La semilla dará origen a una red de hasta ${state.targetCount} tramos.`, 'busy');
    state.timer = setInterval(growthTick, 85);
  } catch (error) {
    if (requestId !== state.requestId) return;
    stopAnimation(); updateButtons();
    console.warn('Árbol Derivado: no fue posible construir la red', error);
    setStatus('Las ramas no pudieron crecer', (error?.message || 'No se encuentran datos de calles en el mapa.') + ' Comprobá que el mapa esté visible y recargá.', 'error');
  }
}
function saveLocal() {
  try {
    localStorage.setItem('arbol-derivado-v1', JSON.stringify({origin:state.origin, zone: ui.zone.value, radius:ui.radius.value, branching:ui.branching.value, edges: state.edges, forks:state.forks, savedAt:Date.now()}));
  } catch (_e) { /* Privacidad/almacenamiento restringido: no bloquea la experiencia. */ }
}
function restoreSaved() {
  try {
    const raw = localStorage.getItem('arbol-derivado-v1') || localStorage.getItem('deriva-v1');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved?.edges) || !Array.isArray(saved?.origin)) return;
    if (!saved.edges.length || saved.edges.length > 1200) return;
    ui.radius.value = saved.radius || 700; ui.radius.dispatchEvent(new Event('input'));
    ui.branching.value = saved.branching || 3; ui.branching.dispatchEvent(new Event('input'));
    ui.zone.value = saved.zone || 'custom';
    state.origin = saved.origin;
    ui.placeName.textContent = ZONES[saved.zone]?.label || 'SEMILLA PLANTADA EN EL MAPA';
    state.originMarker.setLatLng(saved.edges[0].a);
    state.radiusCircle.setLatLng(state.origin);
    map.setView(state.origin, 15);
    state.forks = Number(saved.forks) || 0;
    for (const segment of saved.edges) {
      if (!Array.isArray(segment.a) || !Array.isArray(segment.b)) continue;
      const meters = distance(segment.a, segment.b);
      state.edges.push({a:segment.a,b:segment.b,name:segment.name || 'Calle',meters});
      state.totalMeters += meters;
      drawEdge(segment.a,segment.b,segment.name || 'Calle');
    }
    updateButtons(); updateStats();
    setStatus('Tu árbol volvió a aparecer', `${state.edges.length} tramos recuperados de este navegador.`);
  } catch (_e) { /* El prototipo puede seguir sin los datos previos. */ }
}
function exportGeoJSON() {
  if (!state.edges.length) return;
  const features = state.edges.map((e, index) => ({
    type:'Feature', properties:{index:index + 1, calle:e.name, longitud_m:Math.round(e.meters*10)/10, origen:'Árbol Derivado - prototipo'},
    geometry:{type:'LineString',coordinates:[[e.a[1],e.a[0]],[e.b[1],e.b[0]]]}
  }));
  const content = JSON.stringify({type:'FeatureCollection',name:'Árbol Derivado - ramas urbanas',source:'© OpenStreetMap contributors',features}, null, 2);
  const url = URL.createObjectURL(new Blob([content],{type:'application/geo+json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'arbol-derivado-ramas.geojson';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url),1000);
  setStatus('Ramas guardadas', 'Descargaste un archivo GeoJSON con los caminos que crecieron.');
}
