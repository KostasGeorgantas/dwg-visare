const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let pendingFiles = [];
let pageLoaded = false;

// Argument som slutar på .dwg (när man dubbelklickar eller markerar flera filer i Utforskaren)
function filesFromArgs(argv) {
  return argv.slice(1).filter((a) => /\.dwg$/i.test(a) && fs.existsSync(a));
}

function sendFile(filePath) {
  if (!filePath) return;
  if (!win || !pageLoaded) {
    pendingFiles.push(filePath);
    return;
  }
  try {
    const data = fs.readFileSync(filePath);
    win.webContents.send('file-opened', { name: path.basename(filePath), data, filePath });
  } catch (err) {
    dialog.showErrorBox('Kunde inte öppna filen', `${filePath}\n\n${err.message}`);
  }
}

async function openDialog() {
  const res = await dialog.showOpenDialog(win, {
    title: 'Öppna ritning',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'AutoCAD-ritningar', extensions: ['dwg'] },
      { name: 'Alla filer', extensions: ['*'] }
    ]
  });
  if (!res.canceled) res.filePaths.forEach(sendFile);
}

function print() {
  win.webContents.send('before-print');
  // Låt ritningen hinna ritas om för utskrift innan dialogen öppnas
  setTimeout(() => {
    win.webContents.print({ silent: false, printBackground: true }, () => {
      win.webContents.send('after-print');
    });
  }, 150);
}

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send(ch);
  const template = [
    {
      label: 'Arkiv',
      submenu: [
        { label: 'Öppna…', accelerator: 'CmdOrCtrl+O', click: openDialog },
        { label: 'Stäng flik', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { type: 'separator' },
        { label: 'Skriv ut…', accelerator: 'CmdOrCtrl+P', click: print },
        { type: 'separator' },
        { label: 'Avsluta', role: 'quit' }
      ]
    },
    {
      label: 'Visa',
      submenu: [
        { label: 'Zooma in', accelerator: 'CmdOrCtrl+Plus', click: send('zoom-in') },
        { label: 'Zooma ut', accelerator: 'CmdOrCtrl+-', click: send('zoom-out') },
        { label: 'Hela ritningen', accelerator: 'CmdOrCtrl+0', click: send('zoom-fit') },
        { type: 'separator' },
        { label: 'Stödlinjer av/på', accelerator: 'CmdOrCtrl+G', click: send('toggle-guides') },
        { label: 'Linjetjocklek av/på', accelerator: 'CmdOrCtrl+L', click: send('toggle-lineweights') },
        { label: 'Byt bakgrund (mörk/ljus)', accelerator: 'CmdOrCtrl+B', click: send('toggle-bg') },
        { type: 'separator' },
        { label: 'Nästa flik', accelerator: 'CmdOrCtrl+PageDown', click: send('next-tab') },
        { label: 'Föregående flik', accelerator: 'CmdOrCtrl+PageUp', click: send('prev-tab') },
        { type: 'separator' },
        { label: 'Helskärm', role: 'togglefullscreen' },
        { label: 'Utvecklarverktyg', role: 'toggleDevTools', visible: false }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 420,
    title: 'DWG-visare',
    backgroundColor: '#1b1f24',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    pageLoaded = true;
    const files = pendingFiles;
    pendingFiles = [];
    files.forEach(sendFile);
  });
}

ipcMain.handle('open-dialog', openDialog);
ipcMain.handle('print', print);
ipcMain.handle('set-title', (_e, title) => win && win.setTitle(title));
// Typsnittsfiler som ritningens textstilar pekar på (t.ex. arial.ttf). Söks i
// ritningens mapp och i Windows typsnittsmappar. Bara typsnittsfiler läses.
const FONT_EXT = ['.ttf', '.ttc', '.otf'];
function fontDirs(drawingPath) {
  const dirs = [];
  if (drawingPath) dirs.push(path.dirname(drawingPath));
  const windir = process.env.WINDIR || 'C:\\Windows';
  dirs.push(path.join(windir, 'Fonts'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  // Extra mappar, t.ex. AutoCAD:s typsnittsmapp, kan anges med DWG_FONT_DIRS (separerade med ;)
  for (const d of (process.env.DWG_FONT_DIRS || '').split(';')) if (d) dirs.push(d);
  return dirs;
}
ipcMain.handle('read-font', (_e, fontFile, drawingPath) => {
  const base = path.basename(String(fontFile || '').replace(/\\/g, '/'));
  if (!base) return null;
  const ext = path.extname(base).toLowerCase();
  const names = ext ? (FONT_EXT.includes(ext) ? [base] : []) : FONT_EXT.map((x) => base + x);
  for (const dir of fontDirs(drawingPath)) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isFile()) return fs.readFileSync(p);
      } catch { /* finns inte här */ }
    }
  }
  return null;
});

// Externa referenser (xref). Söks som AutoCAD gör: först den sparade sökvägen
// (absolut eller relativ till ritningen), sedan samma filnamn i ritningens mapp
// och i mappar angivna i DWG_XREF_DIRS. Bara .dwg-filer läses.
function xrefCandidates(xrefPath, hostPath) {
  let p = String(xrefPath || '').trim();
  if (!p) return [];
  if (process.platform !== 'win32') p = p.replace(/\\/g, '/');
  if (!/\.dwg$/i.test(p)) p += '.dwg';
  const hostDir = hostPath ? path.dirname(hostPath) : '';
  const base = path.basename(p);
  const list = [];
  if (path.isAbsolute(p)) list.push(p);
  else if (hostDir) list.push(path.resolve(hostDir, p));
  if (hostDir) list.push(path.join(hostDir, base));
  for (const d of (process.env.DWG_XREF_DIRS || '').split(';')) if (d) list.push(path.join(d, base));
  return [...new Set(list)];
}
ipcMain.handle('read-xref', (_e, xrefPath, hostPath) => {
  for (const p of xrefCandidates(xrefPath, hostPath)) {
    try {
      if (fs.statSync(p).isFile()) return { data: fs.readFileSync(p), filePath: p };
    } catch { /* finns inte här */ }
  }
  return null;
});

ipcMain.handle('read-wasm', () => {
  // asarUnpack lägger wasm-filen bredvid app.asar
  const p = path.join(__dirname, 'src', 'vendor', 'wasm', 'libredwg-web.wasm');
  return fs.readFileSync(p.replace('app.asar', 'app.asar.unpacked'));
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      filesFromArgs(argv).forEach(sendFile);
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    pendingFiles.push(...filesFromArgs(process.argv));
  });

  app.on('window-all-closed', () => app.quit());
}
