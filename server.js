import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { fetchSheetData } from './gsheet-controller.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let basePath = __dirname;
try {
    // Try to import electron dynamically
    const electron = await import('electron');
    if (electron && electron.app) {
        basePath = electron.app.getPath('userData');
        console.log('Running in Electron. Data path:', basePath);
    }
} catch (e) {
    // Not in electron
}

const USER_DATA_DIR = path.join(basePath, '.browser-data');

// --- Daily System Logging Setup ---
const LOG_DIR = path.join(basePath, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}
const app = express();
const PORT = 3004;

app.use(cors());
app.use(express.json());

// Serve static frontend files (for Electron / Production)
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
}

let robotStatus = 'IDLE'; // IDLE, RUNNING
let logs = [];
let progress = { current: 0, total: 0, percent: 0, startTime: null, duration: '0s' };
let browser = null;
let currentPage = null;
let currentClientIp = 'SYSTEM';

const addLog = (msg) => {
    const now = new Date();
    const time = now.toLocaleTimeString('th-TH', { hour12: false });
    const entry = `[${time}] ${msg}`;
    console.log(entry);
    logs.push(entry);
    if (logs.length > 100) logs.shift();

    // --- เขียนลงไฟล์ Daily Log ---
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const logFilePath = path.join(LOG_DIR, `robot_${dateStr}.log`);
    const fileContent = `[${time}] | IP: ${currentClientIp.padEnd(15)} | ${msg}\n`;
    fs.appendFile(logFilePath, fileContent, 'utf8', (err) => {
        if (err) console.error('Failed to write to log file:', err.message);
    });
};

const formatDuration = (ms) => {
    if (!ms) return '0s';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
};

const updateProgress = (current, total) => {
    progress.current = current;
    progress.total = total;
    progress.percent = total > 0 ? Math.round((current / total) * 100) : 0;
    if (progress.startTime) {
        progress.duration = formatDuration(Date.now() - progress.startTime);
    }
};

function getLocalBrowserPath() {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return undefined; // fallback to puppeteer's default
}

async function launchBrowser(headless = false) {
    if (browser) {
        try {
            await browser.version();
            return browser;
        } catch (e) {
            browser = null;
        }
    }

    addLog(`Launching browser (${headless ? 'headless' : 'headful'})...`);
    
    const execPath = getLocalBrowserPath();
    if (execPath) addLog(`Using local browser at: ${execPath}`);

    browser = await puppeteer.launch({
        executablePath: execPath,
        headless: headless ? 'new' : false,
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--start-maximized',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null
    });

    return browser;
}

// --- Helper: Set date-time value (robust Vuetify-compatible) ---
async function setDateTimeValue(page, inputElement, value, logCallback) {
    try {
        // Step 1: Set value via JavaScript at both DOM and Vue level
        await page.evaluate((el, val) => {
            // Set DOM value using native setter
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeSetter.call(el, val);

            // Fire events to notify Vue/Vuetify
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));

            // Try to find and update Vue component model
            let node = el;
            while (node) {
                if (node.__vue__) {
                    const vm = node.__vue__;
                    // Try common Vuetify date picker internal props
                    if (vm.$data && 'inputValue' in vm.$data) {
                        vm.$data.inputValue = val;
                    }
                    if (vm.$data && 'lazyValue' in vm.$data) {
                        vm.$data.lazyValue = val;
                    }
                    if (typeof vm.$emit === 'function') {
                        vm.$emit('input', val);
                        vm.$emit('change', val);
                    }
                    break;
                }
                node = node.parentElement;
            }

            // Fire blur to commit
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true
            }));
        }, inputElement, value);

        await new Promise(r => setTimeout(r, 500));

        // Step 2: Verify value was set; if not, fallback to direct typing
        const currentVal = await page.evaluate(el => el.value, inputElement);
        if (!currentVal || currentVal.trim() === '' || currentVal === 'DD/MM/YYYY hh:mm') {
            logCallback('  ↳ JS method didn\'t stick, trying direct typing...');
            await inputElement.click({ clickCount: 3 });
            await new Promise(r => setTimeout(r, 400));
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 200));
            await inputElement.type(value, { delay: 20 });
            await new Promise(r => setTimeout(r, 300));
        }

        // Step 3: Close any date picker popup with Escape
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 400));

        // Step 4: Press Tab to move focus away (commits the value)
        await page.keyboard.press('Tab');
        await new Promise(r => setTimeout(r, 400));

        // Step 5: Click a neutral area to fully defocus the date picker
        await page.evaluate(() => {
            // Click on form header or body to blur
            const neutral = document.querySelector('.v-card__title, .define-promotion, h3, h4');
            if (neutral) { neutral.click(); } else { document.body.click(); }
        });
        await new Promise(r => setTimeout(r, 800));

        return true;
    } catch (err) {
        logCallback(`  ↳ Date set error: ${err.message}`);
        return false;
    }
}

// --- Helper: Update Google Sheet status via Puppeteer (No-Reload Method) ---
// Uses URL hash navigation instead of page.goto() to avoid full page reloads
// which can trigger Google's bot detection and cause session logouts.
async function updateSheetStatus(sheetPage, rowIndex, status, logCallback, metaDataId = null) {
    try {
        logCallback(`[GSheet] Synchronization for Row ${rowIndex} started...`);

        // Navigate to a cell by changing the URL hash only (no full page reload)
        const navigateToCell = async (cellRef) => {
            logCallback(`  ↳ Navigating to cell ${cellRef} (hash navigation, no reload)...`);
            await sheetPage.evaluate((ref, gid) => {
                window.location.hash = `gid=${gid}&range=${ref}`;
            }, cellRef, config.sheetGid);
            await new Promise(r => setTimeout(r, 2000)); // Wait for Google Sheets to focus cell
        };

        if (metaDataId && metaDataId !== 'Not Found' && metaDataId.trim() !== '') {
            // 1. Navigate to H{rowIndex}, write Meta Data, then Tab to I{rowIndex}
            logCallback(`  ↳ Step 1: Writing Meta Data ID to Column H${rowIndex}...`);
            await navigateToCell(`H${rowIndex}`);
            await sheetPage.keyboard.press('Delete'); // Clear existing content
            await sheetPage.keyboard.type(metaDataId, { delay: 30 });
            // Tab commits H and moves cursor to I in the same row (no second navigation needed)
            await sheetPage.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 300));

            // 2. Write Status to I{rowIndex} (cursor is already here after Tab)
            logCallback(`  ↳ Step 2: Writing Status ("${status}") to Column I${rowIndex}...`);
            await sheetPage.keyboard.press('Delete');
            await sheetPage.keyboard.type(status, { delay: 30 });
            await sheetPage.keyboard.press('Enter');
        } else {
            // No Meta Data — navigate directly to I{rowIndex} and write Status
            logCallback(`  ↳ Writing Status ("${status}") to Column I${rowIndex}...`);
            await navigateToCell(`I${rowIndex}`);
            await sheetPage.keyboard.press('Delete');
            await sheetPage.keyboard.type(status, { delay: 30 });
            await sheetPage.keyboard.press('Enter');
        }

        await new Promise(r => setTimeout(r, 1500));
        logCallback(`[GSheet] ✅ Row ${rowIndex} synchronization completed.`);
        return true;
    } catch (err) {
        logCallback(`[GSheet] ❌ Error updating sheet: ${err.message}`);
        return false;
    }
}

// --- Helper: Search for dynamic template and click Copy Entry ---
async function searchAndCopyEntry(page, logCallback, templateId = '') {
    // ถ้า templateId ว่างเปล่า → หยุดทันที ไม่ Fallback เป็น "template"
    if (!templateId || templateId.trim() === '') {
        logCallback('⛔ Column A is empty — stopping this row. No fallback search will be performed.');
        return false;
    }
    const searchKey = templateId.trim();
    logCallback(`🔍 Searching for "${searchKey}"...`);
    await new Promise(r => setTimeout(r, 6000));

    const searchSelector = 'input[placeholder="Search"]';
    await page.waitForSelector(searchSelector, { timeout: 15000 });
    const searchInput = await page.$(searchSelector);

    if (!searchInput) {
        logCallback('❌ Search input not found.');
        return false;
    }

    await searchInput.click();
    await new Promise(r => setTimeout(r, 300));
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await searchInput.type(searchKey, { delay: 30 });
    await page.keyboard.press('Enter');
    logCallback(`✅ Search "${searchKey}" submitted.`);

    // Wait for results
    await new Promise(r => setTimeout(r, 4000));

    // Click Copy Entry button
    logCallback('📋 Looking for Copy Entry button...');
    const copyBtn = await page.evaluateHandle(() => {
        const buttons = document.querySelectorAll('.table-row-actions button, .table-row-actions .v-btn');
        for (const btn of buttons) {
            const tooltip = btn.getAttribute('data-original-title') || btn.getAttribute('title') || btn.textContent || '';
            const ariaLabel = btn.getAttribute('aria-label') || '';
            if (tooltip.toLowerCase().includes('copy') || ariaLabel.toLowerCase().includes('copy')) {
                return btn;
            }
        }
        const copyIcons = document.querySelectorAll('[class*="copy"], [data-icon="copy"], .mdi-content-copy');
        if (copyIcons.length > 0) {
            return copyIcons[0].closest('button') || copyIcons[0].closest('.v-btn') || copyIcons[0];
        }
        return null;
    });

    if (copyBtn && copyBtn.asElement()) {
        logCallback('✅ Copy Entry button found. Clicking...');
        await copyBtn.asElement().click();
        await new Promise(r => setTimeout(r, 5000));
        try {
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
        } catch (navErr) {
            // May not navigate
        }
        await new Promise(r => setTimeout(r, 3000));
        logCallback('✅ Clone form loaded.');
        return true;
    } else {
        logCallback('❌ Copy Entry button not found.');
        return false;
    }
}

// --- Helper: Paste data into the Clone Promotion form ---
async function pasteRowData(page, rowData, logCallback) {
    logCallback(`📝 Pasting data for row ${rowData.rowIndex}...`);

    // 1. Paste NAME (Column A)
    logCallback(`  ↳ NAME: "${rowData.name}"`);
    const nameInputs = await page.$$('.v-text-field input[type="text"]');
    if (nameInputs.length > 0) {
        await nameInputs[0].click({ clickCount: 3 });
        await new Promise(r => setTimeout(r, 150));
        await page.keyboard.press('Backspace');
        await nameInputs[0].type(rowData.name, { delay: 30 });
        await new Promise(r => setTimeout(r, 200));
        // Click away to commit NAME
        await page.keyboard.press('Tab');
        await new Promise(r => setTimeout(r, 150));
    } else {
        logCallback('  ❌ NAME input not found');
    }

    // 2. Paste DESCRIPTION (Column B)
    logCallback(`  ↳ DESCRIPTION: "${rowData.description}"`);
    const descInput = await page.$('input[placeholder*="descr"], input[placeholder*="Descr"], input[placeholder*="Add a"]');
    if (descInput) {
        await descInput.click({ clickCount: 3 });
        await new Promise(r => setTimeout(r, 150));
        await page.keyboard.press('Backspace');
        await descInput.type(rowData.description, { delay: 30 });
        await new Promise(r => setTimeout(r, 200));
        // Click away to commit DESCRIPTION
        await page.keyboard.press('Tab');
        await new Promise(r => setTimeout(r, 150));
    } else {
        // Fallback: try second text input
        if (nameInputs.length > 1) {
            await nameInputs[1].click({ clickCount: 3 });
            await new Promise(r => setTimeout(r, 150));
            await page.keyboard.press('Backspace');
            await nameInputs[1].type(rowData.description, { delay: 30 });
            await new Promise(r => setTimeout(r, 200));
            await page.keyboard.press('Tab');
            await new Promise(r => setTimeout(r, 150));
        } else {
            logCallback('  ❌ DESCRIPTION input not found');
        }
    }

    // 3. Paste START TIME (Column C)
    logCallback(`  ↳ START TIME: "${rowData.startTime}"`);
    const dateInputs = await page.$$('input[placeholder="DD/MM/YYYY hh:mm"]');
    if (dateInputs.length >= 1) {
        await setDateTimeValue(page, dateInputs[0], rowData.startTime, logCallback);
        logCallback('  ↳ START TIME committed. Waiting before END TIME...');
        await new Promise(r => setTimeout(r, 1500)); // Extra wait between date fields
    } else {
        logCallback('  ❌ START TIME input not found');
    }

    // 4. Paste END TIME (Column D)
    logCallback(`  ↳ END TIME: "${rowData.endTime}"`);
    // Re-query date inputs in case DOM changed after START TIME interaction
    const dateInputs2 = await page.$$('input[placeholder="DD/MM/YYYY hh:mm"]');
    if (dateInputs2.length >= 2) {
        await setDateTimeValue(page, dateInputs2[1], rowData.endTime, logCallback);
    } else {
        logCallback('  ❌ END TIME input not found');
    }

    // 5. Edit PRODUCT ARTICLE (Column F)
    if (rowData.productArticle) {
        logCallback(`  ↳ PRODUCT ARTICLE: "${rowData.productArticle}"`);
        try {
            // 5a: Click the Edit Entry (pencil) icon button
            logCallback('  ↳ Step 1: Clicking Edit Entry icon...');
            const editBtn = await page.evaluateHandle(() => {
                // Look for edit/pencil icon buttons in the PRODUCT ARTICLE area
                const allBtns = document.querySelectorAll('button, .v-btn');
                for (const btn of allBtns) {
                    const tooltip = btn.getAttribute('data-original-title') || btn.getAttribute('title') || '';
                    const ariaLabel = btn.getAttribute('aria-label') || '';
                    if (tooltip.toLowerCase().includes('edit entry') || ariaLabel.toLowerCase().includes('edit')) {
                        return btn;
                    }
                }
                // Fallback: look for pencil icon
                const pencilIcons = document.querySelectorAll('.mdi-pencil, [class*="pencil"], .v-icon.mdi-pencil');
                if (pencilIcons.length > 0) {
                    return pencilIcons[0].closest('button') || pencilIcons[0].closest('.v-btn') || pencilIcons[0];
                }
                return null;
            });

            if (editBtn && editBtn.asElement()) {
                await editBtn.asElement().click();
                logCallback('  ✅ Edit icon clicked.');
                await new Promise(r => setTimeout(r, 3000)); // Wait for SELECT ARTICLES dialog

                // 5b: Paste article number into the CORRECT input (Skip Search)
                logCallback('  ↳ Step 2: Selecting input (Skipping Search)...');
                const articleInput = await page.evaluateHandle(() => {
                    const inputs = document.querySelectorAll('.v-dialog--active input');
                    for (const input of inputs) {
                        const placeholder = (input.placeholder || '').toLowerCase();
                        if (placeholder.includes('search')) continue;
                        if (placeholder.includes('add value')) return input;
                    }
                    for (const input of inputs) {
                        if (!(input.placeholder || '').toLowerCase().includes('search')) return input;
                    }
                    return null;
                });

                if (articleInput && articleInput.asElement()) {
                    const el = articleInput.asElement();
                    await el.click({ clickCount: 3 });
                    await new Promise(r => setTimeout(r, 150));
                    await page.keyboard.press('Backspace');
                    await el.type(rowData.productArticle, { delay: 30 });
                    await page.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 1000));
                    logCallback('  ✅ Article number typed and committed.');
                } else {
                    logCallback('  ❌ Article input (Add value) not found in dialog.');
                }

                // 5d: Click the SELECT button
                logCallback('  ↳ Step 4: Clicking SELECT button...');
                await new Promise(r => setTimeout(r, 300));
                const selectBtn = await page.evaluateHandle(() => {
                    const buttons = document.querySelectorAll('.v-dialog--active button, .string-list-dialog button, button');
                    for (const btn of buttons) {
                        const text = btn.textContent.trim().toUpperCase();
                        if (text === 'SELECT') return btn;
                    }
                    return null;
                });

                if (selectBtn && selectBtn.asElement()) {
                    await selectBtn.asElement().click();
                    logCallback('  ✅ SELECT button clicked.');
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    logCallback('  ❌ SELECT button not found.');
                }
            } else {
                logCallback('  ❌ Edit Entry (pencil) icon not found.');
            }
        } catch (articleErr) {
            logCallback(`  ⚠️ Product Article step failed: ${articleErr.message}`);
        }
    }

    // 6. Edit ARTICLE LIST in Benefits section (Column F)
    if (rowData.benefitArticle) {
        logCallback(`  ↳ BENEFITS ARTICLE LIST: "${rowData.benefitArticle}"`);
        try {
            // 6a: Scroll to the Benefits section
            logCallback('  ↳ Step 1: Looking for Benefits section...');
            await page.evaluate(() => {
                const headers = document.querySelectorAll('h4, h3, .new-promotion_benefits-header');
                for (const h of headers) {
                    if (h.textContent.trim().toUpperCase().includes('BENEFITS')) {
                        h.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        return;
                    }
                }
            });
            await new Promise(r => setTimeout(r, 500));

            // 6b: Click the SECOND Edit Entry (pencil) icon on the page
            logCallback('  ↳ Step 2: Clicking Edit Entry icon in Benefits...');
            const benefitEditBtn = await page.evaluateHandle(() => {
                const allPencils = document.querySelectorAll('.mdi-pencil');
                if (allPencils.length >= 2) {
                    return allPencils[1].closest('button') || allPencils[1].closest('.v-btn') || allPencils[1];
                }
                return null;
            });

            if (benefitEditBtn && benefitEditBtn.asElement()) {
                await benefitEditBtn.asElement().click();
                logCallback('  ✅ Benefits Edit icon clicked.');
                await new Promise(r => setTimeout(r, 4000));

                // 6c: Paste benefit article number (Skip Search)
                logCallback('  ↳ Step 3: Selecting Benefits input (Skipping Search)...');
                const benefitInput = await page.evaluateHandle(() => {
                    const inputs = document.querySelectorAll('.v-dialog--active textarea, .v-dialog--active input');
                    for (const input of inputs) {
                        const placeholder = (input.placeholder || '').toLowerCase();
                        if (placeholder.includes('search')) continue;
                        if (placeholder.includes('add value')) return input;
                    }
                    for (const input of inputs) {
                        if (!(input.placeholder || '').toLowerCase().includes('search')) return input;
                    }
                    return null;
                });

                if (benefitInput && benefitInput.asElement()) {
                    const el = benefitInput.asElement();
                    await el.click({ clickCount: 3 });
                    await new Promise(r => setTimeout(r, 150));
                    await page.keyboard.press('Backspace');
                    await el.type(rowData.benefitArticle, { delay: 30 });
                    await page.keyboard.press('Enter');
                    await new Promise(r => setTimeout(r, 1000));
                    logCallback('  ✅ Benefits article number typed.');
                } else {
                    logCallback('  ❌ Benefits article input not found.');
                }

                // 6e: Click SELECT button
                logCallback('  ↳ Step 5: Clicking SELECT button...');
                await new Promise(r => setTimeout(r, 300));
                const benefitSelectBtn = await page.evaluateHandle(() => {
                    const dialog = document.querySelector('.v-dialog--active');
                    const container = dialog || document;
                    const buttons = container.querySelectorAll('button');
                    for (const btn of buttons) {
                        const span = btn.querySelector('.v-btn__content');
                        const text = (span ? span.textContent : btn.textContent).trim().toUpperCase();
                        if (text === 'SELECT' && btn.offsetParent !== null) return btn;
                    }
                    return null;
                });

                if (benefitSelectBtn && benefitSelectBtn.asElement()) {
                    await benefitSelectBtn.asElement().click();
                    logCallback('  ✅ Benefits SELECT clicked.');
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    logCallback('  ❌ Benefits SELECT button not found.');
                }
            } else {
                logCallback('  ❌ Benefits Edit Entry (pencil) icon not found.');
            }
        } catch (benefitErr) {
            logCallback(`  ⚠️ Benefits Article List step failed: ${benefitErr.message}`);
        }
    }

    // 7. Edit SELECTABLE ITEMS in Benefits section (Column F)
    if (rowData.selectableItems) {
        logCallback(`  ↳ SELECTABLE ITEMS: "${rowData.selectableItems}"`);
        try {
            logCallback('  ↳ Step 1: Searching for "Selectable Items" input...');
            const selectableInput = await page.evaluateHandle(() => {
                // Find Label by text
                const labels = document.querySelectorAll('label, .add-subtract_label');
                let targetLabel = null;
                for (const l of labels) {
                    if (l.textContent.toUpperCase().includes('SELECTABLE ITEMS')) {
                        targetLabel = l;
                        break;
                    }
                }

                if (targetLabel) {
                    // Find the input within the same container, but must be in the lower half of the screen
                    const container = targetLabel.closest('.add-subtract') || targetLabel.parentElement;
                    if (container) {
                        const input = container.querySelector('input');
                        if (input) {
                            const rect = input.getBoundingClientRect();
                            // Ensure it's in the lower part of the screen (> 500px) and visible
                            if (rect.top > 500 && rect.width > 0) {
                                input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                return input;
                            }
                        }
                    }
                }

                // Fallback: search for input in .add-subtract_fields that is in lower screen
                const fields = document.querySelectorAll('.add-subtract_fields input');
                for (const input of fields) {
                    const rect = input.getBoundingClientRect();
                    if (rect.top > 500 && rect.width > 0) {
                        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        return input;
                    }
                }
                return null;
            });

            if (selectableInput && selectableInput.asElement()) {
                const el = selectableInput.asElement();
                await el.click({ clickCount: 3 });
                await new Promise(r => setTimeout(r, 150));
                await page.keyboard.press('Backspace');
                await el.type(rowData.selectableItems, { delay: 30 });
                await page.keyboard.press('Tab');
                await new Promise(r => setTimeout(r, 300));
                logCallback('  ✅ Selectable Items updated.');
            } else {
                logCallback('  ❌ Selectable Items input not found (check scroll/screen position).');
            }
        } catch (selErr) {
            logCallback(`  ⚠️ Selectable Items step failed: ${selErr.message}`);
        }
    }
    await page.evaluate(() => { document.body.click(); });
    await new Promise(r => setTimeout(r, 300));

    logCallback(`✅ Row ${rowData.rowIndex} data pasted.`);
}

app.get('/api/status', (req, res) => {
    if (robotStatus === 'RUNNING' && progress.startTime) {
        progress.duration = formatDuration(Date.now() - progress.startTime);
    }
    res.json({
        status: robotStatus,
        logs: logs.slice(-20),
        progress: progress
    });
});

app.post('/api/login', async (req, res) => {
    if (robotStatus === 'RUNNING') {
        return res.status(400).json({ error: 'Robot is already running' });
    }

    currentClientIp = req.ip || req.connection.remoteAddress || 'UNKNOWN';
    const { headless } = req.body;
    const username = req.body.username || config.username;
    const password = req.body.password || config.password;
    const startRow = parseInt(req.body.startRow) || 2;

    robotStatus = 'RUNNING';
    // Reset Progress
    progress = { current: 0, total: 0, percent: 0, startTime: Date.now(), duration: '0s' };
    addLog('🚀 Starting Login process...');

    res.json({ message: 'Process started' });

    try {
        const browser = await launchBrowser(headless);
        const pages = await browser.pages();
        currentPage = pages.length > 0 ? pages[0] : await browser.newPage();

        await currentPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        if (username && password) {
            await currentPage.authenticate({ username, password });
            addLog(`🛡️ Authentication shield enabled for HTTP Auth (Username: ${username}).`);
        }

        // --- STEP 1: Login ---
        addLog('Navigating to Login page...');
        await currentPage.goto(config.loginUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Check if already logged in (cached session auto-redirected)
        const afterLoginUrl = await currentPage.url();
        let onPromotionsPage = false;

        if (afterLoginUrl.includes('access_token')) {
            addLog('🔄 Cached session detected. Verifying token...');
            const tokenMatch = afterLoginUrl.match(/access_token=([^&]+)/);
            const accessToken = tokenMatch ? tokenMatch[1] : '';

            const promotionsUrl = `https://backoffice.shopat24.com/bo-client/app/vue-bo/#/en/7online/marketing/promotions?access_token=${accessToken}&mcs=31`;
            await currentPage.goto(promotionsUrl, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            // Verify page actually loaded (not blank)
            try {
                await currentPage.waitForSelector('.nm-logoutButtonItem', { timeout: 10000 });
                addLog('✅ Cached session valid. Skipping login form.');
                onPromotionsPage = true;
            } catch (verifyErr) {
                addLog('⚠️ Cached token expired (blank page). Clearing cookies and logging in fresh...');
                // Clear cookies and retry
                const client = await currentPage.target().createCDPSession();
                await client.send('Network.clearBrowserCookies');
                await client.detach();

                // Navigate to login page again
                await currentPage.goto(config.loginUrl, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });
                // Normal login flow will continue below
            }
        }

        if (!onPromotionsPage && username && password) {
            addLog(`Attempting login for user: ${username}`);
            // โลจิกค้นหาแบบไดนามิค ไม่ต้องพึ่งพา class ที่เจาะจงเกินไป
            await currentPage.waitForSelector('input[type="text"], input[type="password"]', { timeout: 30000 });
            
            const textInputs = await currentPage.$$('input[type="text"], input[type="email"], input[autocomplete="username"]');
            const passInputs = await currentPage.$$('input[type="password"], input[autocomplete="current-password"]');

            if (textInputs.length > 0 && passInputs.length > 0) {
                // กรอก Username
                await textInputs[0].click({ clickCount: 3 });
                await currentPage.keyboard.press('Backspace');
                await textInputs[0].type(username, { delay: 50 });

                // กรอก Password
                await passInputs[0].click({ clickCount: 3 });
                await currentPage.keyboard.press('Backspace');
                await passInputs[0].type(password, { delay: 50 });

                addLog('Clicking Login button...');
                // ใช้ Javascript สแกนหาปุ่ม Login บนจอแล้วคลิก (กันเหนียว)
                await currentPage.evaluate(() => {
                    const buttons = document.querySelectorAll('button, div[class*="LoginButton"], input[type="submit"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || btn.value || '').trim().toLowerCase();
                        if (text.includes('login') || text.includes('เข้าสู่ระบบ') || btn.className.includes('LoginButton')) {
                            btn.click();
                            return;
                        }
                    }
                    if (buttons.length > 0) buttons[buttons.length - 1].click(); 
                });

                addLog('Waiting for login to complete...');
                await currentPage.waitForFunction(
                    () => window.location.href.includes('access_token'),
                    { timeout: 30000 }
                );
                addLog('✅ Login successful.');
                await new Promise(r => setTimeout(r, 3000));

                // --- STEP 2: Navigate to Promotions ---
                const freshUrl = await currentPage.url();
                const freshToken = freshUrl.match(/access_token=([^&]+)/);
                const freshAccessToken = freshToken ? freshToken[1] : '';
                addLog(`🔑 Extracted access_token: ${freshAccessToken.substring(0, 10)}...`);

                const freshPromotionsUrl = `https://backoffice.shopat24.com/bo-client/app/vue-bo/#/en/7online/marketing/promotions?access_token=${freshAccessToken}&mcs=31`;
                addLog('🔄 Navigating to Promotions page...');
                await currentPage.goto(freshPromotionsUrl, {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });
                addLog('✅ Navigated to Promotions page.');
                onPromotionsPage = true;
            } else {
                addLog('❌ Could not find login inputs.');
            }
        }

        if (onPromotionsPage) {
            // --- STEP 3: Fetch Google Sheet data ---
            let sheetRows = [];
            try {
                sheetRows = await fetchSheetData(addLog);
                // Apply Start Row filter
                if (startRow > 2) {
                    const beforeFilter = sheetRows.length;
                    sheetRows = sheetRows.filter(row => row.rowIndex >= startRow);
                    addLog(`🚀 Start Row = ${startRow} → Skipped ${beforeFilter - sheetRows.length} row(s) before row ${startRow}.`);
                }

                // Initialize Progress
                updateProgress(0, sheetRows.length);

            } catch (sheetErr) {
                addLog(`❌ Could not read Google Sheet: ${sheetErr.message}`);
            }

            if (sheetRows.length === 0) {
                addLog('⚠️ No rows found to process. Robot is stopping.');
                addLog('ℹ️ Please ensure Column J = "Yes" and Column I is blank or "Edit" in the Sheet.');
                updateProgress(0, 0);
                robotStatus = 'IDLE';
                return;
            } else {
                // --- STEP 4: Loop through each row ---
                addLog(`📊 Processing ${sheetRows.length} row(s) from Google Sheet...`);

                let sheetPage = null;
                try {
                    addLog('[GSheet] Opening Google Sheet tab...');
                    sheetPage = await browser.newPage();
                    const sheetUrl = `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit#gid=${config.sheetGid}`;
                    await sheetPage.goto(sheetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await new Promise(r => setTimeout(r, 3000));
                    addLog('[GSheet] ✅ Google Sheet tab ready.');
                } catch (sheetOpenErr) {
                    addLog(`[GSheet] ⚠️ Could not open Sheet tab: ${sheetOpenErr.message}`);
                }

                for (let i = 0; i < sheetRows.length; i++) {
                    const rowData = sheetRows[i];
                    addLog(`\n━━━ Row ${i + 1}/${sheetRows.length} (Sheet row ${rowData.rowIndex}) ━━━`);

                    await currentPage.bringToFront();

                    const copySuccess = await searchAndCopyEntry(currentPage, addLog, rowData.templateId);
                    if (!copySuccess) {
                        addLog(`❌ Could not copy entry for row ${rowData.rowIndex}. Skipping.`);
                        if (sheetPage) await updateSheetStatus(sheetPage, rowData.rowIndex, 'Failed', addLog);
                        continue;
                    }

                    await pasteRowData(currentPage, rowData, addLog);

                    addLog('🟢 Clicking ADD button...');
                    try {
                        const addBtn = await currentPage.evaluateHandle(() => {
                            const buttons = document.querySelectorAll('button, .v-btn');
                            for (const btn of buttons) {
                                const text = btn.textContent.trim().toUpperCase();
                                if (text === 'ADD' || text === 'เพิ่ม') return btn;
                            }
                            return null;
                        });

                        if (addBtn && addBtn.asElement()) {
                            await addBtn.asElement().click();
                            addLog('✅ ADD button clicked.');
                            await new Promise(r => setTimeout(r, 5000));
                            try {
                                await currentPage.waitForFunction(
                                    () => window.location.href.includes('promotions'),
                                    { timeout: 30000 }
                                );
                            } catch (e) {
                                // May already be on promotions
                            }
                            await new Promise(r => setTimeout(r, 3000));
                            addLog(`🔍 Verifying: Searching for "${rowData.name}"...`);
                            try {
                                const searchInput = await currentPage.waitForSelector('input[placeholder="Search"]', { timeout: 10000 });
                                if (searchInput) {
                                    await searchInput.click({ clickCount: 3 });
                                    await new Promise(r => setTimeout(r, 200));
                                    await currentPage.keyboard.press('Backspace');
                                    await searchInput.type(rowData.name, { delay: 30 });
                                    await currentPage.keyboard.press('Enter');
                                    await new Promise(r => setTimeout(r, 4000)); // Wait for search results

                                    addLog('  ↳ Step 1: Clicking on Promotion Name to open Quick View...');
                                    const nameClicked = await currentPage.evaluate((targetName) => {
                                        const elements = Array.from(document.querySelectorAll('span, div, td'));
                                        const target = elements.find(el => el.textContent.trim() === targetName);
                                        if (target) {
                                            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                            target.click();
                                            return true;
                                        }
                                        return false;
                                    }, rowData.name);

                                    if (nameClicked) {
                                        await new Promise(r => setTimeout(r, 3000));
                                        addLog('  ↳ Step 2: Extracting Meta Data ID...');
                                        const capturedId = await currentPage.evaluate(() => {
                                            // === CASCADE STRATEGY ===
                                            // Step 1: Search for exactly 10-digit number near "META DATA" label
                                            const items = Array.from(document.querySelectorAll('li, div, span'));
                                            for (let i = 0; i < items.length; i++) {
                                                const text = items[i].textContent.toUpperCase();
                                                if (text.includes('META DATA')) {
                                                    const match10 = text.match(/(?<!\d)\d{10}(?!\d)/);
                                                    if (match10) return match10[0];
                                                    // Check next 2 sibling elements
                                                    for (let j = 1; j <= 2; j++) {
                                                        if (items[i + j]) {
                                                            const nextMatch10 = items[i + j].textContent.trim().match(/(?<!\d)\d{10}(?!\d)/);
                                                            if (nextMatch10) return nextMatch10[0];
                                                        }
                                                    }
                                                }
                                            }
                                            // Step 2 (Fallback): Search for 5+ digit number near "META DATA" label
                                            for (let i = 0; i < items.length; i++) {
                                                const text = items[i].textContent.toUpperCase();
                                                if (text.includes('META DATA')) {
                                                    const matchAny = text.match(/\d{5,}/);
                                                    if (matchAny) return matchAny[0];
                                                    for (let j = 1; j <= 2; j++) {
                                                        if (items[i + j]) {
                                                            const nextMatchAny = items[i + j].textContent.trim().match(/\d{5,}/);
                                                            if (nextMatchAny) return nextMatchAny[0];
                                                        }
                                                    }
                                                }
                                            }
                                            return 'Not Found';
                                        });
                                        rowData.metaDataId = capturedId;
                                        addLog(`  ✅ META DATA ID: ${rowData.metaDataId}`);

                                        addLog('  ↳ Step 3: Closing Quick View (ESC)...');
                                        await currentPage.keyboard.press('Escape');
                                        await new Promise(r => setTimeout(r, 1000));
                                    }
                                }
                            } catch (searchErr) {
                                addLog(`  ⚠️ Verification flow failed (Non-critical): ${searchErr.message}`);
                            }

                            addLog(`✅ Row ${rowData.rowIndex} completed.`);

                            if (sheetPage) await updateSheetStatus(sheetPage, rowData.rowIndex, 'Success', addLog, rowData.metaDataId);
                        } else {
                            addLog('❌ ADD button not found.');
                            if (sheetPage) await updateSheetStatus(sheetPage, rowData.rowIndex, 'Failed', addLog);
                            break;
                        }
                    } catch (addErr) {
                        addLog(`⚠️ ADD step failed: ${addErr.message}`);
                        if (sheetPage) await updateSheetStatus(sheetPage, rowData.rowIndex, 'Failed', addLog);
                        break;
                    }

                    // Update Progress after each row
                    updateProgress(i + 1, sheetRows.length);
                }

                if (sheetPage) {
                    try { await sheetPage.close(); } catch (e) { }
                    addLog('[GSheet] ↳ Sheet tab closed.');
                }

                addLog(`\n🎉 All ${sheetRows.length} row(s) processed!`);
                addLog('⏳ Robot paused. Waiting for your review...');
            }
        }

        robotStatus = 'IDLE';
        addLog('✅ Task complete.');

    } catch (err) {
        addLog(`❌ Error: ${err.message}`);
        robotStatus = 'IDLE';
    }
});

app.post('/api/stop', async (req, res) => {
    currentClientIp = req.ip || req.connection.remoteAddress || 'UNKNOWN';
    addLog('🛑 Stop signal received. Closing browser...');
    if (browser) {
        try { await browser.close(); } catch (e) { }
        browser = null;
    }
    robotStatus = 'IDLE';
    res.json({ message: 'Robot stopped' });
});

app.listen(PORT, () => {
    console.log(`🚀 ShopAt24 Upload Server running on http://localhost:${PORT}`);
});
