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

function findLinuxBrowser() {
  const candidates = [
    '/usr/bin/opera',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/firefox',
    '/usr/bin/brave-browser',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launchBrowser(url) {
  console.log(`\n=============================================================`);
  console.log(`  OurMusic — Servidor Activo y Listo`);
  console.log(`  👉  Abre o haz clic en tu navegador: ${url}`);
  console.log(`=============================================================\n`);

  if (process.platform === 'win32') {
    const c = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
    return;
  }

  if (process.platform === 'darwin') {
    const c = spawn('open', [url], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
    return;
  }

  // Linux: 1. Intentar el navegador instalado directamente
  const browserBin = findLinuxBrowser();
  if (browserBin) {
    try {
      const b = spawn(browserBin, [url], { detached: true, stdio: 'ignore' });
      b.on('error', () => {});
      b.unref();
    } catch {
      // continuar
    }
  }

  // 2. Intentar también xdg-open / gio
  for (const cmd of ['gio', 'xdg-open']) {
    try {
      const args = cmd === 'gio' ? ['open', url] : [url];
      const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } catch {
      // continuar
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const webOnly = args.has('--web-only') || args.has('--web') || args.has('--browser');
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
    try {
      await app.close();
    } catch {
      // Ignorar errores al salir
    }
    process.exit(0);
  };

  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);

  if (!webOnly && process.platform === 'linux') {
    const guiBin = path.join(ROOT_DIR, 'bin', 'ourmusic-gui');
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    let guiLaunched = false;

    if (hasDisplay && fs.existsSync(guiBin)) {
      const startTime = Date.now();
      guiLaunched = true;
      const env = {
        ...process.env,
        GDK_BACKEND: process.env.GDK_BACKEND || 'wayland,x11',
        WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
        WEBKIT_DISABLE_COMPOSITING_MODE: '1',
        WEBKIT_DISABLE_DMABUF_RENDERER: '1',
      };
      const gui = spawn(guiBin, [app.baseUrl], { stdio: 'inherit', env });

      gui.on('error', (err) => {
        console.warn('[OurMusic] Error al lanzar ventana nativa GTK:', err.message);
        launchBrowser(app.baseUrl);
      });

      gui.on('close', (code) => {
        const elapsed = Date.now() - startTime;
        if (code !== 0 || elapsed < 2000) {
          console.warn(`[OurMusic] La ventana nativa GTK no pudo inicializarse (código ${code}).`);
          launchBrowser(app.baseUrl);
        } else {
          gracefulExit();
        }
      });
    }

    if (!guiLaunched) {
      launchBrowser(app.baseUrl);
    }
  } else if (!webOnly && (process.platform === 'win32' || winApp)) {
    launchWindowsAppWindow(app.baseUrl);
  } else {
    launchBrowser(app.baseUrl);
  }
}

main().catch((err) => {
  console.error('[OurMusic] Error fatal al iniciar:', err.message);
  process.exit(1);
});
