const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');

// WSL / headless GPU workarounds
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow;
let userDataPath;
let chosenSourceId = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 900,
    title: 'Clicktrack',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  userDataPath = app.getPath('userData');

  // Use chosen source if set, otherwise fall back to first screen
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const source = chosenSourceId
      ? sources.find((s) => s.id === chosenSourceId) || sources[0]
      : sources[0];
    if (source) {
      callback({ video: source, audio: 'loopback' });
    } else {
      callback(null);
    }
  }, { useSystemPicker: false });

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// --- IPC: Save/Load Game State ---
ipcMain.handle('save-game', async (_event, state) => {
  const savePath = path.join(userDataPath, 'save.json');
  fs.writeFileSync(savePath, JSON.stringify(state, null, 2));
  return true;
});

ipcMain.handle('load-game', async () => {
  const savePath = path.join(userDataPath, 'save.json');
  if (fs.existsSync(savePath)) {
    return JSON.parse(fs.readFileSync(savePath, 'utf-8'));
  }
  return null;
});

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 200, height: 120 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('set-source', (_event, id) => {
  chosenSourceId = id;
  return true;
});
