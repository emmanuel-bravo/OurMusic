import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOurMusicApp } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function launchWindowsAppWindow(url) {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      const child = spawn(exe, [`--app=${url}`, '--window-size=1320,860'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }
  }
  const fallback = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
  fallback.unref();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const webOnly = args.has('--web-only');
  const winApp = args.has('--windows-app');
  const preferredPort = parseInt(process.env.OURMUSIC_PORT || '4380', 10);

  let app;
  try {
    app = await createOurMusicApp({ port: preferredPort });
  } catch {
    app = await createOurMusicApp({ port: 0 });
  }

  console.log(`\n=============================================================`);
  console.log(`  OurMusic — Reproductor Local HiFi Clean-Room`);
  console.log(`  Motor C11 (${process.platform === 'win32' ? 'WASAPI' : 'ALSA'}) + Interfaz Asíncrona`);
  console.log(`  URL local: ${app.baseUrl}`);
  console.log(`=============================================================\n`);

  let shuttingDown = false;
  const gracefulExit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);

  if (!webOnly && process.platform === 'linux') {
    const guiBin = path.join(ROOT_DIR, 'bin', 'ourmusic-gui');
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (hasDisplay && fs.existsSync(guiBin)) {
      const gui = spawn(guiBin, [app.baseUrl], { stdio: 'inherit' });
      gui.on('close', gracefulExit);
    } else {
      console.log(`  Abre ${app.baseUrl} en tu navegador para usar la interfaz.`);
    }
  } else if (!webOnly && (process.platform === 'win32' || winApp)) {
    launchWindowsAppWindow(app.baseUrl);
  }
}

main().catch((err) => {
  console.error('[OurMusic] Error fatal al iniciar:', err.message);
  process.exit(1);
});
