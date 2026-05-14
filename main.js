import { app, BrowserWindow, dialog } from 'electron';
import path from 'path';
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
        title: 'RPA Promotion A A',
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
    autoUpdater.checkForUpdatesAndNotify();

    // Setup auto-updater events
    autoUpdater.on('update-available', () => {
        console.log('Update available.');
    });

    autoUpdater.on('update-downloaded', () => {
        dialog.showMessageBox({
            type: 'info',
            title: 'Update Ready',
            message: 'A new version of RPA Promotion has been downloaded. The application will restart to install the update.',
            buttons: ['Restart Now']
        }).then(() => {
            autoUpdater.quitAndInstall();
        });
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
