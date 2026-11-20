import dataGeoJSON from '../data/data_kualitas_lingkungan.json';

export async function loadData() {
  // Keep this boundary small so the static source can later be replaced by an API.
  return dataGeoJSON;
}
