# Peta Indeks Kualitas Lingkungan Permukiman (IKLP)

WebGIS Project SIG untuk mengeksplorasi kondisi lingkungan kawasan permukiman di Pekanbaru, Riau. Aplikasi menggunakan OpenLayers untuk peta dan Turf.js untuk analisis geometri di browser.

## Jalankan lokal

```bash
npm install
npm run start
```

Untuk memeriksa paket produksi:

```bash
npm run build
npm run serve
```

Konfigurasi Vite memakai `base: '/Project-SIG-Kualitas-Lingkungan/'` agar aset hasil build sesuai saat dipublikasikan di GitHub Pages. Sumber data tetap GeoJSON lokal dan masuk ke bundle, sehingga tidak memerlukan endpoint data saat deployment.

## Fitur aplikasi

- Rute `#home`, `#peta`, `#analisis`, dan `#tentang`; halaman Home ditampilkan pertama.
- Basemap OpenStreetMap dan Esri World Imagery.
- Layer vektor terpisah untuk Blok, Jalan, Drainase, Tong sampah, Pohon, dan Tempat masuk, beserta layer IKLP, cakupan, rekomendasi, dan hotspot.
- Filter kondisi dan blok, legenda dinamis, popup atribut, query blok / gambar poligon, dan penghitung fitur.
- Weighted overlay empat bobot (sampah 0,30; drainase 0,30; jalan 0,25; pohon 0,15). Bobot dinormalisasi otomatis. Indikator sampah yang diberi bobot 0,30 merupakan rata-rata % tong sampah baik dan cakupan layanan blok; tabel menampilkan kedua nilai mentahnya. Kerapatan pohon diskalakan terhadap blok berkepadatan tertinggi.
- Buffer layanan memakai tong sampah berkondisi Baik. Luas dihitung Turf.js dalam satuan meter geodesik; cakupan berpotongan dengan geometri blok, bukan hanya hubungan titik-di-dalam-poligon. Titik fasilitas dikelompokkan menurut atribut blok survei yang tersedia karena sebagian besar berada di luar blok.
- Hotspot memakai titik drainase dan tong sampah buruk. Drainase buruk di elevasi di bawah rata-rata drainase diberi penanda prioritas tinggi.

Jika seluruh jalan tidak memiliki atribut blok atau seluruhnya berstatus Baik, skor jalan yang sama diterapkan ke setiap blok; indikator tersebut memang tidak membedakan blok.

## Sumber data dan penggantian ke API

`src/data.js` mengisolasi pembacaan data. Saat ini `loadData()` mengembalikan import `data/data_kualitas_lingkungan.json`. Untuk API, ganti isi fungsi itu dengan pengambilan GeoJSON dari endpoint yang dikelola sendiri dan tetap kembalikan struktur `FeatureCollection` EPSG:4326. Koordinat serta skema properti perlu tetap mengikuti data saat ini (`jenis`, `nama`, `blok`, `kondisi`, `skor`, `lokasi_blok`, `elevasi_m`).

## Skema tabel PostGIS

Contoh skema sederhana: satu tabel untuk semua geometri survei dan CRS tersimpan EPSG:4326.

```sql
CREATE TABLE survey_feature (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jenis        text NOT NULL CHECK (jenis IN
                 ('Blok', 'Jalan', 'Drainase', 'Tong sampah', 'Pohon', 'Tempat masuk')),
  nama         text NOT NULL,
  blok         text,
  lokasi_blok  text,
  kondisi      text CHECK (kondisi IN ('Baik', 'Buruk') OR kondisi IS NULL),
  skor         smallint CHECK (skor IN (0, 1) OR skor IS NULL),
  elevasi_m    double precision,
  geom         geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX survey_feature_geom_gix ON survey_feature USING GIST (geom);
CREATE INDEX survey_feature_kind_block_idx ON survey_feature (jenis, blok);
```

Contoh geometri blok dan query ekuivalen analisis (transformasi ke UTM 48S / EPSG:32748 agar jarak, buffer, dan luas dalam meter):

```sql
-- Buffer 50 meter di sekitar tong sampah baik.
WITH bin_buffer AS (
  SELECT ST_UnaryUnion(ST_Collect(
           ST_Buffer(ST_Transform(geom, 32748), 50)
         )) AS geom
  FROM survey_feature
  WHERE jenis = 'Tong sampah' AND kondisi = 'Baik'
),
block_metric AS (
  SELECT b.nama,
         ST_Area(ST_Transform(b.geom, 32748)) AS luas_m2,
         ST_Area(ST_Intersection(
           ST_Transform(b.geom, 32748), bb.geom
         )) AS terlayani_m2,
         ST_Difference(ST_Transform(b.geom, 32748), bb.geom) AS belum_terlayani
  FROM survey_feature b
  CROSS JOIN bin_buffer bb
  WHERE b.jenis = 'Blok'
)
SELECT nama,
       100.0 * terlayani_m2 / NULLIF(luas_m2, 0) AS persen_terlayani,
       100.0 * (luas_m2 - terlayani_m2) / NULLIF(luas_m2, 0) AS persen_belum_terlayani,
       ST_Transform(belum_terlayani, 4326) AS geom_rekomendasi
FROM block_metric;
```

`ST_Intersects` untuk memilih fitur yang bersinggungan dengan area query; `ST_Within` untuk memilih titik di dalam area. Gunakan `ST_Transform` sebelum operasi jarak dan luas:

```sql
-- Fitur yang bersinggungan dengan poligon area pilihan (input GeoJSON EPSG:4326).
WITH query_area AS (
  SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(:polygon_geojson), 4326), 32748) AS geom
)
SELECT f.jenis, f.nama, f.kondisi, f.blok
FROM survey_feature f CROSS JOIN query_area q
WHERE ST_Intersects(ST_Transform(f.geom, 32748), q.geom);

-- Titik fasilitas di dalam sebuah blok.
SELECT p.jenis, p.nama, p.kondisi, b.nama AS nama_blok
FROM survey_feature p
JOIN survey_feature b ON b.jenis = 'Blok'
WHERE p.geom && b.geom
  AND ST_Within(p.geom, b.geom)
  AND p.jenis IN ('Drainase', 'Tong sampah', 'Pohon');

-- Contoh jumlah kondisi baik per blok berdasarkan atribut blok hasil survei.
SELECT blok,
       jenis,
       COUNT(*) AS jumlah,
       COUNT(*) FILTER (WHERE kondisi = 'Baik') AS jumlah_baik
FROM survey_feature
WHERE jenis IN ('Drainase', 'Tong sampah')
GROUP BY blok, jenis;
```

## Lisensi dan atribusi peta

Basemap memerlukan koneksi internet. OpenStreetMap dan Esri World Imagery tetap mengikuti atribusi dan ketentuan penggunaan masing-masing penyedia. Indeks dan rekomendasi bersifat indikatif, bukan pengganti verifikasi lapangan.
