// Puntúa clips por movimiento usando ffmpeg (sin dependencias externas).
// Uso: node motion.mjs <dir> [n_clips] [--top]
//   Por defecto analiza una muestra distribuida a lo largo del día.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);
const DIR = process.argv[2] || '.';
const N = Number(process.argv[3] || 20);

// El filtro: desenfocar -> diferencia con el frame anterior -> leer la media de luminancia.
//
// El desenfoque NO es cosmético. Sin él, la diferencia frame-a-frame captura sobre todo ruido
// de códec en superficies texturadas (la malla del portón, la pared): medido en un clip real,
// el mapa de diferencias mostraba solo los bordes del tejido, sin ninguna silueta. Con
// sigma=8 el ruido desaparece y la señal de movimiento real queda dominante - en un clip con
// actividad la media es 3x la de un clip quieto de noche, y el pico 8x.
const FILTER = 'gblur=sigma=8,tblend=all_mode=difference,signalstats,metadata=mode=print:file=-';

async function score(file) {
  try {
    const { stdout } = await exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', file,
      '-vf', FILTER, '-f', 'null', '/dev/null',
    ], { maxBuffer: 32 * 1024 * 1024 });

    const rows = [];
    let t = null;
    for (const line of stdout.split('\n')) {
      const pt = line.match(/pts_time:([0-9.]+)/);
      if (pt) { t = parseFloat(pt[1]); continue; }
      const y = line.match(/YAVG=([0-9.]+)/);
      if (y && t !== null) rows.push({ t, v: parseFloat(y[1]) });
    }
    if (!rows.length) return null;

    // El primer keyframe tras el remux produce un pico artificial; se descarta el 1er segundo.
    const body = rows.filter(r => r.t > 1.0);
    if (!body.length) return null;

    const sum = body.reduce((a, r) => a + r.v, 0);
    const peak = body.reduce((a, r) => (r.v > a.v ? r : a), body[0]);
    // Cuántos frames superan un umbral: mide persistencia, no un pico aislado.
    const busy = body.filter(r => r.v > 1.0).length;

    return {
      file: path.basename(file),
      frames: rows.length,
      mean: sum / body.length,
      peak: peak.v,
      peakAt: peak.t,
      busyPct: (100 * busy) / body.length,
    };
  } catch {
    return null;
  }
}

const all = fs.readdirSync(DIR).filter(f => /\.(mkv|mp4)$/.test(f)).sort();
if (!all.length) { console.error('sin clips en ' + DIR); process.exit(1); }

// muestra distribuida: uno de cada tramo, para cubrir el día entero
const step = Math.max(1, Math.floor(all.length / N));
const pick = all.filter((_, i) => i % step === 0).slice(0, N);

console.log(`analizando ${pick.length} de ${all.length} clips\n`);

const out = [];
for (const f of pick) {
  const s = await score(path.join(DIR, f));
  if (s) { out.push(s); console.log(`  ${s.file}  media=${s.mean.toFixed(3)} pico=${s.peak.toFixed(2)}@${s.peakAt.toFixed(0)}s activo=${s.busyPct.toFixed(0)}%`); }
}

out.sort((a, b) => b.busyPct - a.busyPct);
console.log('\n=== TOP 5 con más movimiento ===');
for (const s of out.slice(0, 5)) {
  console.log(`  ${s.file}  activo=${s.busyPct.toFixed(1)}%  pico=${s.peak.toFixed(2)}  media=${s.mean.toFixed(3)}`);
}
const avg = out.reduce((a, s) => a + s.busyPct, 0) / out.length;
console.log(`\npromedio de la muestra: ${avg.toFixed(1)}% de frames con movimiento`);
