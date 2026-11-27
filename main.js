// OneRoot ERP desktop app: opens the live ERP in its own window.
// Settings come from config.json (next to the installed app, in resources/): the ERP address, and
// kiosk mode for POS counters (full screen, no way out except Alt+F4).
const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

function loadConfig() {
  // receiptPrinter: the printer's name as Windows shows it (e.g. "Essae PR-55"); empty = the default printer
  const defaults = { url: 'https://erp.oneroot.farm', kiosk: false, receiptPrinter: '' };
  // Installed: resources/config.json (editable after install); while developing: the project's config.json
  const candidates = [path.join(process.resourcesPath || '', 'config.json'), path.join(__dirname, 'config.json')];
  for (const file of candidates) {
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* try the next one */
    }
  }
  return defaults;
}

const config = loadConfig();
const erpOrigin = new URL(config.url).origin;
let win = null;

// One window only: opening the app again brings the running one to the front
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
}

function createWindow() {
  Menu.setApplicationMenu(null);
  // Clear out any print preview PDFs left from a previous run
  fs.rm(previewDir, { recursive: true, force: true }, () => undefined);
  win = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    kiosk: !!config.kiosk,
    title: 'OneRoot ERP',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (!config.kiosk) win.maximize();
  win.once('ready-to-show', () => win.show());

  // Links to other sites (WhatsApp, maps, Tally help…) open in the normal browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(erpOrigin)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(erpOrigin) && !url.startsWith('file:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // No internet / server down: a friendly page with a Retry button instead of a blank window
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation aborted (normal)
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: url || config.url } });
  });

  // Print buttons in the ERP open the print preview window instead of the bare Windows print dialog
  win.webContents.on('dom-ready', () => {
    if (win.webContents.getURL().startsWith(erpOrigin)) win.webContents.executeJavaScript(PRINT_HOOK).catch(() => undefined);
  });

  // F5 / Ctrl+R reload, Ctrl+Shift+I developer tools (for support), Ctrl+P prints like the browser
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'f5' || (input.control && key === 'r')) {
      win.webContents.reload();
      e.preventDefault();
    } else if (input.control && !input.shift && key === 'p') {
      win.webContents.executeJavaScript('window.print()').catch(() => undefined);
      e.preventDefault();
    } else if (input.control && input.shift && key === 'i') {
      win.webContents.toggleDevTools();
      e.preventDefault();
    }
  });

  win.loadURL(config.url);
  win.on('closed', () => {
    win = null;
  });
}

/**
 * Receipt printing from the ERP (lib/print.ts): the page already shows only the receipt, so it is sent straight to the
 * receipt printer — no dialog — on a page exactly the receipt's size, with no margins. The size goes to the driver as a
 * custom paper size, so there is no blank paper after the bill and the cutter cuts right after the last line.
 */
ipcMain.handle('print-receipt', (event, opts) => {
  // Only the ERP itself may print
  const from = event.senderFrame?.url ?? '';
  if (!from.startsWith(erpOrigin)) return { ok: false, error: 'Not allowed from this page' };
  const widthMm = Number(opts?.widthMm);
  const heightMm = Number(opts?.heightMm);
  if (!(widthMm > 20 && widthMm < 120 && heightMm > 10 && heightMm < 5000)) return { ok: false, error: 'Bad receipt size' };
  return new Promise((resolve) => {
    event.sender.print(
      {
        silent: true,
        printBackground: true,
        deviceName: config.receiptPrinter || undefined,
        margins: { marginType: 'none' },
        // Electron takes the page size in microns
        pageSize: { width: Math.round(widthMm * 1000), height: Math.round(heightMm * 1000) },
        scaleFactor: 100,
      },
      (ok, error) => resolve({ ok, error: ok ? undefined : String(error || 'Print failed') }),
    );
  });
});

/**
 * Electron's window.print() goes straight to the Windows print dialog, which has no preview ("This app doesn't support
 * print preview"). So the ERP's window.print() is replaced: the page, already set up for printing by lib/print.ts, is
 * turned into a PDF exactly as it would print (as the backend's PO PDF does) and shown in a preview window, whose
 * toolbar prints or saves it. `afterprint` fires once the PDF is made, so the ERP puts the page back as before.
 * Thermal receipts keep the direct print dialog: a counter doesn't want an extra window for every bill.
 */
const PRINT_HOOK = `(() => {
  if (window.__onerootPrintHook || !window.onerootDesktop || !window.onerootDesktop.printPreview) return;
  window.__onerootPrintHook = true;
  const nativePrint = window.print.bind(window);
  let busy = false;
  window.print = () => {
    if (document.body && document.body.dataset.print === 'thermal') return nativePrint();
    if (busy) return;
    busy = true;
    window.dispatchEvent(new Event('beforeprint'));
    window.onerootDesktop
      .printPreview(document.title)
      .then((r) => { if (r && r.ok === false) alert('Print preview failed: ' + r.error); })
      .catch((e) => alert('Print preview failed: ' + (e && e.message ? e.message : e)))
      .finally(() => { busy = false; window.dispatchEvent(new Event('afterprint')); });
  };
})();`;

const previewDir = path.join(app.getPath('temp'), 'oneroot-erp-print');

ipcMain.handle('print-preview', async (event, title) => {
  // Only the ERP itself may print
  const from = event.senderFrame?.url ?? '';
  if (!from.startsWith(erpOrigin)) return { ok: false, error: 'Not allowed from this page' };
  try {
    // Page size and margins from the ERP's own print CSS (@page), the same as the browser's print
    const pdf = await event.sender.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    // The page title is the suggested file name (lib/print.ts sets it, e.g. PO-26-27-00004)
    const name = String(title || 'OneRoot').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 80) || 'OneRoot';
    // A folder per preview, so the viewer's title and its Save button show the plain name (PO-26-27-00004.pdf)
    const dir = path.join(previewDir, String(Date.now()));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.pdf`);
    fs.writeFileSync(file, pdf);

    const preview = new BrowserWindow({
      width: 1000,
      height: 760,
      parent: BrowserWindow.fromWebContents(event.sender) || undefined,
      title: `Print preview - ${name}`,
      icon: path.join(__dirname, 'build', 'icon.png'),
      autoHideMenuBar: true,
      backgroundColor: '#525659',
      // plugins: Chromium's PDF viewer (pages, zoom, print and save buttons)
      webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    preview.setMenu(null);
    preview.webContents.on('page-title-updated', (e) => e.preventDefault());
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    preview.on('closed', () => fs.rm(dir, { recursive: true, force: true }, () => undefined));
    await preview.loadFile(file);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

app.on('window-all-closed', () => app.quit());
