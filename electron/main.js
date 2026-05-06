'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const { startServer } = require('../src/server');

let mainWindow = null;
let recoveryServer = null;

async function createWindow() {
  const result = await startServer({
    port: 0,
    open: false,
    log: false,
  });
  recoveryServer = result.server;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: 'Codex 侧边栏恢复工具',
    backgroundColor: '#f6f7f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(result.url);
}

function closeServer() {
  if (!recoveryServer) return;
  recoveryServer.close();
  recoveryServer = null;
}

app.whenReady().then(() => {
  createWindow().catch((error) => {
    dialog.showErrorBox('Codex 侧边栏恢复工具启动失败', error.message);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        dialog.showErrorBox('Codex 侧边栏恢复工具启动失败', error.message);
      });
    }
  });
});

app.on('before-quit', closeServer);

app.on('window-all-closed', () => {
  closeServer();
  if (process.platform !== 'darwin') app.quit();
});
