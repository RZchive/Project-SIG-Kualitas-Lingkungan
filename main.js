import './style.css';
import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import HeatmapLayer from 'ol/layer/Heatmap';
import XYZ from 'ol/source/XYZ';
import OSM from 'ol/source/OSM';
import VectorSource from 'ol/source/Vector';
import Overlay from 'ol/Overlay';
import Draw from 'ol/interaction/Draw';
import { fromLonLat } from 'ol/proj';
import { Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import { booleanIntersects, booleanPointInPolygon } from '@turf/turf';
import { calculateIKLP, calculateServiceAreas, getHotspotFeatures } from './src/analysis.js';
import { loadData } from './src/data.js';

const TYPES = ['Blok', 'Jalan', 'Drainase', 'Tong sampah', 'Pohon', 'Tempat masuk'];
const TYPE_COLORS = {
  Blok: '#739087',
  Jalan: '#23a36d',
  Drainase: '#d94c43',
  'Tong sampah': '#d49b37',
  Pohon: '#6984a0',
  'Tempat masuk': '#5274c7',
};
const TYPE_SYMBOLS = {
  Blok: '▰',
  Jalan: '━',
  Drainase: '●',
  'Tong sampah': '■',
  Pohon: '▲',
  'Tempat masuk': '★',
};
const LAYER_DEFINITIONS = [
  { id: 'Blok', label: 'Blok permukiman', icon: '▱', color: TYPE_COLORS.Blok },
  { id: 'Jalan', label: 'Jalan', icon: TYPE_SYMBOLS.Jalan, color: TYPE_COLORS.Jalan },
  { id: 'Drainase', label: 'Drainase', icon: TYPE_SYMBOLS.Drainase, color: TYPE_COLORS.Drainase },
  { id: 'Tong sampah', label: 'Tong sampah', icon: TYPE_SYMBOLS['Tong sampah'], color: TYPE_COLORS['Tong sampah'] },
  { id: 'Pohon', label: 'Pohon', icon: TYPE_SYMBOLS.Pohon, color: TYPE_COLORS.Pohon },
  { id: 'Tempat masuk', label: 'Tempat masuk', icon: TYPE_SYMBOLS['Tempat masuk'], color: TYPE_COLORS['Tempat masuk'] },
  { id: 'IKLP', label: 'Kelas hasil IKLP', icon: '◉', color: '#237b5c' },
  { id: 'Cakupan', label: 'Buffer layanan sampah', icon: '◌', color: '#42a9aa' },
  { id: 'Rekomendasi', label: 'Area rekomendasi', icon: '▧', color: '#d6883d' },
  { id: 'Hotspot', label: 'Hotspot kondisi buruk', icon: '✳', color: '#c84242' },
];
const LAYER_DEFAULTS = {
  Blok: true, Jalan: true, Drainase: true, 'Tong sampah': true, Pohon: true,
  'Tempat masuk': true, IKLP: false, Cakupan: false, Rekomendasi: false, Hotspot: false,
};
const geojsonFormat = new GeoJSON();
const state = {
  raw: null,
  map: null,
  layers: {},
  sources: {},
  layerVisibility: { ...LAYER_DEFAULTS },
  ranking: [],
  service: null,
  hotspot: [],
  drawInteraction: null,
  activeBasemap: 'osm',
  route: 'home',
};

const byId = (id) => document.getElementById(id);

function safeText(value) {
  const element = document.createElement('span');
  element.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  return element.innerHTML;
}

function classForScore(score) {
  if (score < 0.4) return 'Rendah';
  if (score <= 0.7) return 'Sedang';
  return 'Tinggi';
}

function getLayerFeatureColor(feature) {
  const condition = feature.get('kondisi');
  if (condition === 'Baik') return '#20865c';
  if (condition === 'Buruk') return '#cf4d45';
  return '#6984a0';
}

function getPointStyle(feature, resolution) {
  const type = feature.get('jenis');
  const radius = Math.max(4, Math.min(10, 7.5 - Math.log2(Math.max(resolution, 1) / 2) * 0.65));
  const color = getLayerFeatureColor(feature);
  const outline = new Stroke({ color: '#ffffff', width: 1.8 });
  let image;
  if (type === 'Drainase') {
    image = new CircleStyle({ radius, fill: new Fill({ color }), stroke: outline });
  } else if (type === 'Tong sampah') {
    image = new RegularShape({ points: 4, radius: radius + 1, angle: Math.PI / 4, fill: new Fill({ color }), stroke: outline });
  } else if (type === 'Pohon') {
    image = new RegularShape({ points: 3, radius: radius + 1.5, angle: 0, fill: new Fill({ color }), stroke: outline });
  } else {
    image = new RegularShape({
      points: 5, radius: radius + 2, radius2: radius * 0.48, angle: 0,
      fill: new Fill({ color: '#5274c7' }), stroke: outline,
    });
  }
  const isHighPriority = feature.get('prioritas_tinggi') === true;
  return new Style({
    image,
    ...(isHighPriority ? { text: new Text({ text: '!', font: 'bold 12px sans-serif', offsetY: -13, fill: new Fill({ color: '#a82720' }) }) } : {}),
  });
}

function blockStyle(feature, analyzed = false) {
  const name = feature.get('nama') || '';
  const ranking = state.ranking.find((item) => item.name === name);
  let fill = 'rgba(255,255,255,0.12)';
  let stroke = '#46635e';
  if (analyzed && ranking) {
    fill = ranking.className === 'Tinggi' ? 'rgba(48,151,104,0.43)'
      : ranking.className === 'Sedang' ? 'rgba(226,177,67,0.48)' : 'rgba(205,77,69,0.46)';
    stroke = ranking.className === 'Tinggi' ? '#23865d'
      : ranking.className === 'Sedang' ? '#b8841d' : '#bd4943';
  }
  return new Style({
    fill: new Fill({ color: fill }),
    stroke: new Stroke({ color: stroke, width: analyzed ? 2 : 1.7 }),
    text: new Text({
      text: name, font: '600 12px Inter, sans-serif',
      fill: new Fill({ color: '#263c38' }),
      stroke: new Stroke({ color: 'rgba(255,255,255,0.92)', width: 3 }),
      overflow: true,
    }),
  });
}

function createLayers() {
  const makeVector = (key, features, style, zIndex) => {
    const source = new VectorSource({ features });
    const layer = new VectorLayer({ source, style, zIndex });
    state.sources[key] = source;
    state.layers[key] = layer;
    return layer;
  };
  const vectorFeatures = geojsonFormat.readFeatures(state.raw, {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  });
  const layers = [];
  for (const type of TYPES) {
    const features = vectorFeatures.filter((feature) => feature.get('jenis') === type);
    const layer = makeVector(type, features, (feature, resolution) => {
      if (type === 'Blok') return blockStyle(feature, false);
      if (type === 'Jalan') {
        const color = feature.get('kondisi') === 'Buruk' ? '#cf4d45' : '#23875e';
        return new Style({ stroke: new Stroke({ color, width: 4, lineCap: 'round', lineJoin: 'round' }) });
      }
      return getPointStyle(feature, resolution);
    }, type === 'Blok' ? 3 : type === 'Jalan' ? 5 : 6);
    layers.push(layer);
  }

  const analysisFeatures = geojsonFormat.readFeatures({
    type: 'FeatureCollection',
    features: state.raw.features.filter((feature) => feature.properties.jenis === 'Blok'),
  }, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
  const analysisLayer = makeVector('IKLP', analysisFeatures, (feature) => blockStyle(feature, true), 4);
  layers.push(analysisLayer);
  const serviceLayer = makeVector('Cakupan', [], new Style({
    fill: new Fill({ color: 'rgba(41,160,169,0.22)' }),
    stroke: new Stroke({ color: '#25999b', width: 1.5, lineDash: [5, 4] }),
  }), 2);
  layers.push(serviceLayer);
  const recommendationLayer = makeVector('Rekomendasi', [], new Style({
    fill: new Fill({ color: 'rgba(221,132,51,0.42)' }),
    stroke: new Stroke({ color: '#c77931', width: 2, lineDash: [7, 4] }),
  }), 7);
  layers.push(recommendationLayer);
  const hotspotFeatures = geojsonFormat.readFeatures({ type: 'FeatureCollection', features: [] }, {
    dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857',
  });
  const hotspotSource = new VectorSource({ features: hotspotFeatures });
  const hotspotLayer = new HeatmapLayer({
    source: hotspotSource, blur: 20, radius: 13,
    weight: (feature) => feature.get('prioritas_tinggi') ? 1 : 0.65,
    gradient: ['#4433a5', '#3288bd', '#65c16e', '#f8db55', '#ee743b', '#b9262e'],
    zIndex: 8,
  });
  state.sources.Hotspot = hotspotSource;
  state.layers.Hotspot = hotspotLayer;
  layers.push(hotspotLayer);
  state.sources.Query = new VectorSource();
  state.layers.Query = new VectorLayer({
    source: state.sources.Query,
    style: new Style({ fill: new Fill({ color: 'rgba(73,116,194,0.15)' }), stroke: new Stroke({ color: '#456fc1', width: 2, lineDash: [7, 4] }) }),
    zIndex: 10,
  });
  layers.push(state.layers.Query);
  return layers;
}

function addGeoJSON(source, features) {
  source.clear();
  if (!features.length) return;
  const transformed = geojsonFormat.readFeatures({ type: 'FeatureCollection', features }, {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:3857',
  });
  source.addFeatures(transformed);
}

function isFeatureFiltered(feature) {
  const type = feature.get('jenis');
  const condition = byId('condition-filter').value;
  const block = byId('block-filter').value;
  const featureCondition = feature.get('kondisi');
  if (condition !== 'Semua' && featureCondition !== condition) return true;
  if (block !== 'Semua' && feature.get('blok') !== block && feature.get('nama') !== block) return true;
  return !TYPES.includes(type);
}

function updateLayerVisibility() {
  for (const type of TYPES) {
    state.layers[type].setVisible(state.layerVisibility[type]);
    if (type !== 'Blok') {
      state.layers[type].setStyle((feature, resolution) => (
        isFeatureFiltered(feature) ? null : type === 'Jalan'
          ? new Style({ stroke: new Stroke({ color: feature.get('kondisi') === 'Buruk' ? '#cf4d45' : '#23875e', width: 4, lineCap: 'round' }) })
          : getPointStyle(feature, resolution)
      ));
    }
  }
  state.layers.IKLP.setVisible(state.layerVisibility.IKLP && state.layerVisibility.Blok && state.ranking.length > 0);
  state.layers.Cakupan.setVisible(state.layerVisibility.Cakupan);
  state.layers.Rekomendasi.setVisible(state.layerVisibility.Rekomendasi);
  state.layers.Hotspot.setVisible(state.layerVisibility.Hotspot);
  refreshCount();
  updateLegend();
}

function refreshCount() {
  let surveyCount = 0;
  for (const type of TYPES) {
    if (!state.layerVisibility[type]) continue;
    for (const feature of state.sources[type].getFeatures()) {
      if (type === 'Blok' && byId('block-filter').value !== 'Semua' && feature.get('nama') !== byId('block-filter').value) continue;
      if (type !== 'Blok' && isFeatureFiltered(feature)) continue;
      surveyCount += 1;
    }
  }
  let resultCount = 0;
  for (const key of ['IKLP', 'Cakupan', 'Rekomendasi', 'Hotspot']) {
    if (state.layerVisibility[key]) resultCount += state.sources[key].getFeatures().length;
  }
  byId('visible-count').textContent = `${surveyCount} survei${resultCount ? ` + ${resultCount} hasil` : ''} / ${state.raw.features.length}`;
}

function updateLegend() {
  const active = LAYER_DEFINITIONS.filter((item) => state.layerVisibility[item.id]);
  byId('legend-content').innerHTML = active.map((item) => {
    if (item.id === 'IKLP') {
      return '<div class="legend-row"><span class="legend-swatches"><i class="swatch-high"></i><i class="swatch-mid"></i><i class="swatch-low"></i></span><span>Kelas IKLP · Tinggi / Sedang / Rendah</span></div>';
    }
    if (item.id === 'Cakupan') return `<div class="legend-row"><i class="legend-area" style="--legend-color:${item.color}"></i><span>Buffer tong sampah baik</span></div>`;
    if (item.id === 'Rekomendasi') return `<div class="legend-row"><i class="legend-area" style="--legend-color:${item.color}"></i><span>Area belum terlayani</span></div>`;
    if (item.id === 'Hotspot') return '<div class="legend-row"><span class="hotspot-key"></span><span>Kepadatan kondisi buruk</span></div>';
    if (item.id === 'Blok') return `<div class="legend-row"><i class="legend-line" style="--legend-color:${item.color}"></i><span>Batas blok · ${LAYER_DEFAULTS.Blok ? 'nama blok' : ''}</span></div>`;
    if (item.id === 'Jalan') return '<div class="legend-row"><i class="legend-line" style="--legend-color:#23875e"></i><span>Jalan baik <i class="legend-line legend-road-bad"></i> buruk</span></div>';
    if (item.id === 'Pohon' || item.id === 'Tempat masuk') {
      return `<div class="legend-row"><i class="legend-point" style="--legend-color:${item.color}">${item.icon}</i><span>${item.label} · tanpa data kondisi</span></div>`;
    }
    return `<div class="legend-row"><i class="legend-point" style="--legend-color:${item.color}">${item.icon}</i><span>${item.label} · <i class="legend-condition-good"></i> Baik <i class="legend-condition-bad"></i> Buruk</span></div>`;
  }).join('') || '<p class="empty-legend">Aktifkan lapisan untuk melihat legenda.</p>';
}

function renderLayerControls() {
  byId('layer-controls').innerHTML = LAYER_DEFINITIONS.map((item) => `
    <label class="layer-option">
      <input type="checkbox" data-layer="${safeText(item.id)}" ${state.layerVisibility[item.id] ? 'checked' : ''}>
      <span class="layer-symbol" style="--layer-color:${item.color}">${item.icon}</span>
      <span class="layer-name">${item.label}</span>
      <span class="layer-check" aria-hidden="true">✓</span>
    </label>`).join('');
  byId('layer-controls').addEventListener('change', (event) => {
    const id = event.target.dataset.layer;
    if (!id) return;
    state.layerVisibility[id] = event.target.checked;
    updateLayerVisibility();
  });
}

function setupFilters() {
  const blockNames = state.raw.features.filter((feature) => feature.properties.jenis === 'Blok')
    .map((feature) => feature.properties.nama);
  byId('block-filter').innerHTML = '<option value="Semua">Semua blok</option>'
    + blockNames.map((name) => `<option value="${safeText(name)}">${safeText(name)}</option>`).join('');
  for (const id of ['condition-filter', 'block-filter']) {
    byId(id).addEventListener('change', () => {
      updateLayerVisibility();
      if (state.map && id === 'block-filter' && byId(id).value !== 'Semua') {
        const feature = state.sources.Blok.getFeatures().find((item) => item.get('nama') === byId(id).value);
        if (feature) state.map.getView().fit(feature.getGeometry().getExtent(), { padding: [70, 80, 70, 80], maxZoom: 19, duration: 500 });
      }
    });
  }
}

function renderHomeSummary() {
  const counts = TYPES.map((type) => ({
    type, count: state.raw.features.filter((feature) => feature.properties.jenis === type).length,
  }));
  byId('home-data-summary').innerHTML = counts.map((item) => (
    `<span>${item.type}<strong>${item.count}</strong></span>`
  )).join('');
  byId('total-features').textContent = state.raw.features.length;
  byId('total-blocks').textContent = counts.find((item) => item.type === 'Blok').count;
}

function createMap() {
  const osmLayer = new TileLayer({ source: new OSM(), visible: true, zIndex: 0 });
  const satelliteLayer = new TileLayer({
    source: new XYZ({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attributions: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxZoom: 19,
    }),
    visible: false, zIndex: 0,
  });
  const layers = createLayers();
  state.map = new Map({
    target: 'map',
    layers: [osmLayer, satelliteLayer, ...layers],
    view: new View({ center: fromLonLat([101.4705, 0.5365]), zoom: 17.5, minZoom: 14, maxZoom: 20 }),
    controls: undefined,
  });
  state.layers.BaseOSM = osmLayer;
  state.layers.BaseSatellite = satelliteLayer;
  const popup = new Overlay({
    element: byId('feature-popup'), autoPan: { animation: { duration: 220 } },
    offset: [0, -12], positioning: 'bottom-center',
  });
  state.map.addOverlay(popup);
  byId('popup-close').addEventListener('click', () => {
    popup.setPosition(undefined);
    byId('feature-popup').hidden = true;
  });

  state.map.on('singleclick', (event) => {
    let hitFeature;
    state.map.forEachFeatureAtPixel(event.pixel, (feature) => {
      hitFeature = feature;
      return true;
    }, { hitTolerance: 6 });
    if (!hitFeature) {
      popup.setPosition(undefined);
      byId('feature-popup').hidden = true;
      return;
    }
    const type = hitFeature.get('jenis');
    if (type === 'Blok') runSpatialQuery(hitFeature.getGeometry());
    if (!type) return;
    renderPopup(hitFeature);
    byId('feature-popup').hidden = false;
    popup.setPosition(event.coordinate);
  });
  updateLayerVisibility();
  return state.map;
}

function renderPopup(feature) {
  const props = feature.getProperties();
  const fields = Object.entries(props).filter(([key]) => key !== 'geometry');
  const name = feature.get('nama') || feature.get('jenis') || 'Fitur peta';
  byId('popup-content').innerHTML = `
    <div class="popup-eyebrow">${safeText(feature.get('jenis'))}</div>
    <h3>${safeText(name)}</h3>
    <dl>${fields.map(([key, value]) => `<div><dt>${safeText(key.replaceAll('_', ' '))}</dt><dd>${safeText(value)}</dd></div>`).join('')}</dl>`;
}

function geometryToTurf(geometry) {
  const feature = new Feature(geometry.clone());
  return geojsonFormat.writeFeatureObject(feature, {
    featureProjection: 'EPSG:3857',
    dataProjection: 'EPSG:4326',
  });
}

function runSpatialQuery(geometry) {
  const polygon = geometryToTurf(geometry);
  const matches = state.raw.features.filter((feature) => {
    try {
      if (feature.geometry.type === 'Point') return booleanPointInPolygon(feature, polygon);
      return booleanIntersects(feature, polygon);
    } catch (error) {
      console.error('Geometri tidak dapat diuji pada query spasial:', error);
      return false;
    }
  });
  const rows = TYPES.map((type) => {
    const group = matches.filter((feature) => feature.properties.jenis === type);
    const badCount = group.filter((feature) => feature.properties.kondisi === 'Buruk').length;
    return `<div><span>${safeText(type)}</span><strong>${group.length}</strong><small>${badCount} buruk</small></div>`;
  });
  byId('query-results').innerHTML = `<p class="query-summary"><strong>${matches.length} fitur</strong> beririsan dengan area terpilih</p>${rows.join('')}`;
}

function getWeights() {
  return {
    trash: Number(byId('weight-trash').value),
    drain: Number(byId('weight-drain').value),
    road: Number(byId('weight-road').value),
    tree: Number(byId('weight-tree').value),
  };
}

function updateRankingTable(result, showLayer) {
  state.ranking = result.rows;
  if (showLayer) state.layerVisibility.IKLP = true;
  syncLayerCheckboxes();
  byId('ranking-body').innerHTML = result.rows.map((row, index) => `
    <tr>
      <td><span class="rank-number">${String(index + 1).padStart(2, '0')}</span><strong>${safeText(row.name)}</strong></td>
      <td>${row.indicators.trashGood.toFixed(2)}</td><td>${row.indicators.coverage.toFixed(2)}</td>
      <td>${row.indicators.drain.toFixed(2)}</td>
      <td>${row.indicators.tree.toFixed(2)}</td><td>${row.indicators.road.toFixed(2)}</td>
      <td><span class="score-pill score-${row.className.toLowerCase()}">${row.score.toFixed(2)} <i>${row.className}</i></span></td>
    </tr>`).join('');
  const worst = result.rows[result.rows.length - 1];
  const priorityDrains = getHotspotFeatures(state.raw).filter((feature) => (
    feature.properties.jenis === 'Drainase' && feature.properties.prioritas_tinggi
  ));
  byId('conclusion-content').innerHTML = `
    <p>Blok dengan IKLP terendah adalah <strong>${safeText(worst.name)}</strong> dengan skor <strong>${worst.score.toFixed(2)} (${worst.className})</strong>. Prioritaskan peningkatan indikator sampah dan drainase di blok tersebut.</p>
    <p class="insight-stat"><strong>${priorityDrains.length}</strong> titik drainase buruk berelevasi di bawah rata-rata survei drainase (${(
      state.raw.features.filter((feature) => feature.properties.jenis === 'Drainase')
        .reduce((sum, feature) => sum + Number(feature.properties.elevasi_m || 0), 0)
      / state.raw.features.filter((feature) => feature.properties.jenis === 'Drainase').length
    ).toFixed(2)} m).</p>`;
  addGeoJSON(state.sources.IKLP, result.blocks.map((block) => block));
  state.layers.IKLP.setStyle((feature) => blockStyle(feature, true));
  state.layers.IKLP.changed();
  byId('map-status').textContent = 'Kelas IKLP per blok';
  updateLayerVisibility();
}

function runIKLP(showLayer = false) {
  try {
    const result = calculateIKLP(state.raw, getWeights(), Number(byId('buffer-distance').value));
    updateRankingTable(result, showLayer);
    if (state.layerVisibility.Cakupan || state.layerVisibility.Rekomendasi) runBufferAnalysis(false);
  } catch (error) {
    console.error('Perhitungan IKLP gagal:', error);
    byId('conclusion-content').innerHTML = `<p class="inline-error">Perhitungan IKLP gagal: ${safeText(error.message)}</p>`;
  }
}

function runBufferAnalysis(showMessage = true) {
  try {
    const distance = Number(byId('buffer-distance').value);
    state.service = calculateServiceAreas(state.raw, distance);
    addGeoJSON(state.sources.Cakupan, state.service.servedFeatures);
    addGeoJSON(state.sources.Rekomendasi, state.service.unservedFeatures);
    const ordered = [...state.service.summaries].sort((a, b) => b.unservedPercent - a.unservedPercent);
    const totalUnservedHa = state.service.summaries.reduce((sum, row) => sum + row.unservedHa, 0);
    byId('coverage-content').innerHTML = `
      <p>Dengan jangkauan <strong>${distance} m</strong>, sekitar <strong>${totalUnservedHa.toFixed(2)} ha</strong> area blok belum terlayani.</p>
      <div class="coverage-list">${ordered.map((row) => `<div><span>${safeText(row.name)}</span><strong>${row.unservedPercent.toFixed(0)}%</strong><small>${row.unservedHa.toFixed(2)} ha</small></div>`).join('')}</div>
      <p class="recommendation-note">Area jingga pada peta menunjukkan bagian blok di luar buffer tong sampah baik; gunakan sebagai indikasi lokasi survei lanjutan.</p>`;
    state.layerVisibility.Cakupan = true;
    state.layerVisibility.Rekomendasi = true;
    syncLayerCheckboxes();
    if (showMessage) byId('map-status').textContent = `Buffer layanan tong sampah · ${distance} m`;
    updateLayerVisibility();
  } catch (error) {
    console.error('Analisis buffer layanan gagal:', error);
    byId('coverage-content').innerHTML = `<p class="inline-error">Analisis buffer gagal: ${safeText(error.message)}</p>`;
  }
}

function runHotspotAnalysis() {
  try {
    state.hotspot = getHotspotFeatures(state.raw);
    addGeoJSON(state.sources.Hotspot, state.hotspot);
    state.layerVisibility.Hotspot = true;
    syncLayerCheckboxes();
    const priority = state.hotspot.filter((feature) => feature.properties.prioritas_tinggi).length;
    byId('conclusion-content').insertAdjacentHTML('beforeend', `<p class="recommendation-note">Hotspot memetakan ${state.hotspot.length} titik kondisi buruk. ${priority} drainase buruk bertanda prioritas elevasi rendah.</p>`);
    byId('map-status').textContent = `Hotspot kondisi buruk · ${state.hotspot.length} titik`;
    updateLayerVisibility();
  } catch (error) {
    console.error('Analisis hotspot gagal:', error);
    byId('conclusion-content').insertAdjacentHTML('beforeend', `<p class="inline-error">Analisis hotspot gagal: ${safeText(error.message)}</p>`);
  }
}

function syncLayerCheckboxes() {
  document.querySelectorAll('#layer-controls input[data-layer]').forEach((input) => {
    input.checked = state.layerVisibility[input.dataset.layer];
  });
}

function startDrawQuery() {
  if (!state.map) return;
  if (state.drawInteraction) {
    state.map.removeInteraction(state.drawInteraction);
    state.drawInteraction = null;
    byId('draw-query').innerHTML = 'Gambar area query <span aria-hidden="true">＋</span>';
    return;
  }
  const drawSource = state.sources.Query;
  state.drawInteraction = new Draw({ source: drawSource, type: 'Polygon' });
  state.map.addInteraction(state.drawInteraction);
  byId('draw-query').innerHTML = 'Selesaikan gambar di peta… <span aria-hidden="true">×</span>';
  state.drawInteraction.once('drawend', (event) => {
    runSpatialQuery(event.feature.getGeometry());
    state.map.removeInteraction(state.drawInteraction);
    state.drawInteraction = null;
    byId('draw-query').innerHTML = 'Gambar area query <span aria-hidden="true">＋</span>';
  });
}

function setBasemap(name) {
  state.activeBasemap = name;
  state.layers.BaseOSM.setVisible(name === 'osm');
  state.layers.BaseSatellite.setVisible(name === 'satellite');
  document.querySelectorAll('.basemap-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.basemap === name);
  });
}

function setupAnalysisControls() {
  byId('run-iklp').addEventListener('click', () => runIKLP(true));
  byId('run-buffer').addEventListener('click', () => runBufferAnalysis());
  byId('run-hotspot').addEventListener('click', runHotspotAnalysis);
  byId('draw-query').addEventListener('click', startDrawQuery);
  for (const [id, labelId] of [
    ['weight-trash', 'weight-trash-value'], ['weight-drain', 'weight-drain-value'],
    ['weight-road', 'weight-road-value'], ['weight-tree', 'weight-tree-value'],
  ]) {
    byId(id).addEventListener('input', () => {
      byId(labelId).textContent = `${byId(id).value}%`;
      runIKLP(false);
    });
  }
  byId('buffer-distance').addEventListener('input', () => {
    byId('buffer-distance-value').textContent = `${byId('buffer-distance').value} m`;
    if (state.ranking.length) runIKLP(false);
    if (state.service) runBufferAnalysis(false);
  });
  document.querySelectorAll('.basemap-button').forEach((button) => {
    button.addEventListener('click', () => setBasemap(button.dataset.basemap));
  });
}

function setRoute() {
  const requested = window.location.hash.replace('#', '') || 'home';
  const route = ['home', 'peta', 'analisis', 'tentang'].includes(requested) ? requested : 'home';
  state.route = route;
  byId('home-page').hidden = route !== 'home';
  byId('about-page').hidden = route !== 'tentang';
  byId('map-page').hidden = route !== 'peta' && route !== 'analisis';
  byId('analysis-page').hidden = route !== 'analisis';
  document.querySelectorAll('.main-nav [data-route]').forEach((link) => {
    link.classList.toggle('active', link.dataset.route === route);
  });
  document.body.classList.toggle('map-open', route === 'peta' || route === 'analisis');
  if (route === 'analisis' && state.map && state.ranking.length === 0) runIKLP(true);
  if (route === 'peta' || route === 'analisis') {
    requestAnimationFrame(() => state.map && state.map.updateSize());
  }
  if (route !== 'peta' && route !== 'analisis' && state.drawInteraction) {
    state.map.removeInteraction(state.drawInteraction);
    state.drawInteraction = null;
  }
}

async function initialize() {
  try {
    state.raw = await loadData();
    if (!state.raw || !Array.isArray(state.raw.features)) throw new Error('Berkas GeoJSON tidak memiliki daftar fitur yang valid.');
    renderHomeSummary();
    setupFilters();
    renderLayerControls();
    createMap();
    setupAnalysisControls();
    byId('mobile-sidebar-open').addEventListener('click', () => document.body.classList.add('sidebar-visible'));
    byId('sidebar-toggle').addEventListener('click', () => document.body.classList.remove('sidebar-visible'));
    window.addEventListener('hashchange', setRoute);
    setRoute();
  } catch (error) {
    console.error('Inisialisasi WebGIS gagal:', error);
    document.body.insertAdjacentHTML('beforeend', `<div class="fatal-error">Aplikasi gagal dimuat: ${safeText(error.message)}</div>`);
  }
}

initialize();
