import {
  area,
  buffer,
  difference,
  featureCollection,
  intersect,
  union,
} from '@turf/turf';

const TYPES = ['Blok', 'Jalan', 'Drainase', 'Tong sampah', 'Pohon', 'Tempat masuk'];
const DEFAULT_WEIGHTS = { trash: 0.3, drain: 0.3, road: 0.25, tree: 0.15 };

function assignedFeatures(features, type, blockName) {
  return features.filter((feature) => feature.properties.jenis === type && feature.properties.blok === blockName);
}

function normalizedRatio(good, total) {
  return total ? good / total : 0;
}

function classify(score) {
  if (score < 0.4) return 'Rendah';
  if (score <= 0.7) return 'Sedang';
  return 'Tinggi';
}

export function calculateIKLP(data, weights = DEFAULT_WEIGHTS, bufferMeters = 50) {
  const features = data.features;
  const blocks = features.filter((feature) => feature.properties.jenis === 'Blok');
  const allRoads = features.filter((feature) => feature.properties.jenis === 'Jalan');
  const overallRoadScore = normalizedRatio(
    allRoads.filter((feature) => feature.properties.kondisi === 'Baik').length,
    allRoads.length,
  );
  const rawRows = blocks.map((block) => {
    const name = block.properties.nama;
    const trash = assignedFeatures(features, 'Tong sampah', name);
    const drains = assignedFeatures(features, 'Drainase', name);
    const trees = assignedFeatures(features, 'Pohon', name);
    const roads = assignedFeatures(features, 'Jalan', name);
    const goodBins = trash.filter((feature) => feature.properties.kondisi === 'Baik');
    let servedArea = 0;

    if (goodBins.length) {
      const binBuffers = goodBins
        .map((feature) => buffer(feature, bufferMeters, { units: 'meters', steps: 16 }))
        .filter(Boolean);
      if (binBuffers.length) {
        const mergedBuffers = binBuffers.reduce((merged, current) => (
          merged ? union(featureCollection([merged, current])) : current
        ), null);
        const covered = intersect(featureCollection([block, mergedBuffers]));
        if (covered) servedArea = area(covered);
      }
    }

    const blockArea = area(block);
    return {
      name,
      block,
      areaHa: blockArea / 10000,
      trash: normalizedRatio(goodBins.length, trash.length),
      coverage: blockArea ? Math.min(1, servedArea / blockArea) : 0,
      drain: normalizedRatio(drains.filter((feature) => feature.properties.kondisi === 'Baik').length, drains.length),
      treeDensity: blockArea ? trees.length / (blockArea / 10000) : 0,
      road: roads.length
        ? normalizedRatio(roads.filter((feature) => feature.properties.kondisi === 'Baik').length, roads.length)
        : overallRoadScore,
    };
  });

  const maxDensity = Math.max(0, ...rawRows.map((row) => row.treeDensity));
  const normalizedWeights = { ...DEFAULT_WEIGHTS, ...weights };
  const weightTotal = Object.values(normalizedWeights).reduce((total, value) => total + Math.max(0, Number(value) || 0), 0);
  if (!weightTotal) throw new Error('Minimal satu bobot indikator harus lebih besar dari nol.');

  const rows = rawRows.map((row) => {
    const indicators = {
      trash: (row.trash + row.coverage) / 2,
      trashGood: row.trash,
      coverage: row.coverage,
      drain: row.drain,
      road: row.road,
      tree: maxDensity ? row.treeDensity / maxDensity : 0,
    };
    const score = Object.entries(indicators).reduce((sum, [key, value]) => (
      sum + value * (Math.max(0, Number(normalizedWeights[key]) || 0) / weightTotal)
    ), 0);
    return {
      ...row,
      indicators,
      score,
      className: classify(score),
      unservedArea: Math.max(0, row.areaHa * 10000 - row.areaHa * 10000 * row.coverage),
    };
  }).sort((a, b) => b.score - a.score);

  return { rows, blocks, weights: Object.fromEntries(Object.entries(normalizedWeights).map(([key, value]) => [key, Math.max(0, Number(value) || 0) / weightTotal])) };
}

export function calculateServiceAreas(data, bufferMeters) {
  const bins = data.features.filter((feature) => (
    feature.properties.jenis === 'Tong sampah' && feature.properties.kondisi === 'Baik'
  ));
  const buffers = bins.map((feature) => buffer(feature, bufferMeters, { units: 'meters', steps: 16 })).filter(Boolean);
  const merged = buffers.reduce((result, current) => (
    result ? union(featureCollection([result, current])) : current
  ), null);
  const servedFeatures = merged ? [merged] : [];
  const unservedFeatures = [];
  const summaries = [];

  for (const block of data.features.filter((feature) => feature.properties.jenis === 'Blok')) {
    const covered = merged ? intersect(featureCollection([block, merged])) : null;
    const unserved = covered ? difference(featureCollection([block, covered])) : block;
    const blockArea = area(block);
    const coveredArea = covered ? area(covered) : 0;
    if (unserved) unservedFeatures.push(unserved);
    summaries.push({
      name: block.properties.nama,
      areaHa: blockArea / 10000,
      unservedHa: (unserved ? area(unserved) : blockArea) / 10000,
      unservedPercent: blockArea ? 100 * (blockArea - coveredArea) / blockArea : 0,
    });
  }
  return { merged, servedFeatures, unservedFeatures, summaries };
}

export function getHotspotFeatures(data) {
  const candidates = data.features.filter((feature) => (
    ['Drainase', 'Tong sampah'].includes(feature.properties.jenis) && feature.properties.kondisi === 'Buruk'
  ));
  const drains = candidates.filter((feature) => feature.properties.jenis === 'Drainase');
  const meanElevation = drains.length
    ? drains.reduce((sum, feature) => sum + Number(feature.properties.elevasi_m || 0), 0) / drains.length
    : null;
  return candidates.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      prioritas_tinggi: feature.properties.jenis === 'Drainase' && meanElevation !== null
        && Number(feature.properties.elevasi_m) < meanElevation,
    },
  }));
}

export function countByType(features) {
  return TYPES.map((type) => ({
    type,
    count: features.filter((feature) => feature.properties.jenis === type).length,
  }));
}
