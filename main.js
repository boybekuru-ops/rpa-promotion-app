import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

// Start the Express backend
import './server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Create a promotion: Buy A get A free',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        autoHideMenuBar: true
    });

    // We rely on the Express server (server.js) to serve the React frontend from the /dist folder
    // Ensure you have run `npm run build` to generate the /dist folder
    mainWindow.loadURL('http://localhost:3004');

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Check for updates after the app is ready
    const GITHUB_TOKEN = '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';
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'boybekuru-ops',
        repo: 'rpa-promotion-app',
        token: GITHUB_TOKEN
    });

    const logPath = path.join(app.getPath('userData'), 'update-log.txt');
    const writeLog = (msg) => {
        const time = new Date().toISOString();
        fs.appendFileSync(logPath, `[${time}] ${msg}\n`);
    };

    writeLog('App started. Checking for updates...');
    autoUpdater.checkForUpdatesAndNotify();

    // Setup auto-updater events
    autoUpdater.on('checking-for-update', () => {
        writeLog('Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
        writeLog(`Update available: ${info.version}`);
    });

    autoUpdater.on('update-not-available', () => {
        writeLog('Update not available.');
    });

    autoUpdater.on('error', (err) => {
        writeLog(`Update error: ${err.stack || err}`);
        dialog.showMessageBox({
            type: 'error',
            title: 'Update Check Failed',
            message: `Error: ${err.message}`
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        writeLog(`Update downloaded: ${info.version}`);
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: 'A new version has been downloaded. Restart now?',
            buttons: ['Restart Now', 'Later']
        }).then((result) => {
            if (result.response === 0) autoUpdater.quitAndInstall();
        });
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
