const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// WSL / headless GPU workarounds
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

// IPC: Save game state to disk
ipcMain.handle('save-game', async (_event, state) => {
  const fs = require('fs');
  const savePath = path.join(app.getPath('userData'), 'save.json');
  fs.writeFileSync(savePath, JSON.stringify(state, null, 2));
  return true;
});

// IPC: Load game state from disk
ipcMain.handle('load-game', async () => {
  const fs = require('fs');
  const savePath = path.join(app.getPath('userData'), 'save.json');
  if (fs.existsSync(savePath)) {
    return JSON.parse(fs.readFileSync(savePath, 'utf-8'));
  }
  return null;
});
