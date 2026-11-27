// Gives the ERP page safe calls into the desktop app: print the receipt silently at its exact size, and show a
// document in a print preview window (Electron has no print preview of its own; see main.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onerootDesktop', {
  /** opts: { widthMm, heightMm } — the receipt page size worked out by the ERP (lib/print.ts) */
  printReceipt: (opts) => ipcRenderer.invoke('print-receipt', opts),
  /** The page as it prints now, as a PDF in a preview window; title = the suggested file name */
  printPreview: (title) => ipcRenderer.invoke('print-preview', String(title || '')),
});
