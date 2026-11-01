const pool = require('./db');

(async () => {
  try {
    const [rows] = await pool.query('SELECT 1 + 1 AS hasil');
    console.log('Koneksi berhasil!', rows);
  } catch (err) {
    console.error('Koneksi gagal:', err.message);
  }
  process.exit();
})();