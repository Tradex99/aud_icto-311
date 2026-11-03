const { firefox } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const https = require('https');
const execPromise = util.promisify(exec);

// --- Helper function to download JSON from GitHub ---
async function downloadFromGitHub(url, destination) {
  console.log(`Downloading latest tempmail_accounts.json from: ${url}`);
  return new Promise((resolve, reject) => {
    const file = require('fs').createWriteStream(destination);
    https.get(url, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file. Status Code: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('Downloaded and saved:', destination);
        resolve();
      });
    }).on('error', err => {
      reject(err);
    });
  });
}

// --- Helper utilities ---
async function isElementVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function waitForVisibility(locator, timeout = 60000) {
  try {
    await locator.waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const sourcePath = path.join(__dirname, '../Creator', 'tempmail_accounts.json');
  const destPath = path.join(__dirname, 'tempmail_accounts.json');
  const renamedPath = path.join(__dirname, 'tempmail_2.json');
  const githubURL = 'https://raw.githubusercontent.com/henrygreen311/speter-octo/main/Creator/tempmail_accounts.json';
  let accounts;

  try {
    try {
      let data;
      try {
        data = await fs.readFile(renamedPath, 'utf8');
        console.log('Loaded existing tempmail_2.json');
      } catch {
        data = await fs.readFile(destPath, 'utf8');
        console.log('Loaded existing tempmail_accounts.json');
      }
      accounts = JSON.parse(data);
    } catch {
      console.log('No local tempmail file found. Downloading from GitHub...');
      await downloadFromGitHub(githubURL, renamedPath);
      const data = await fs.readFile(renamedPath, 'utf8');
      accounts = JSON.parse(data);
      console.log('Downloaded tempmail_accounts.json ➜ tempmail_2.json');
    }
  } catch (error) {
    console.error('Error handling tempmail files:', error);
    return;
  }

  let validAccounts = Object.values(accounts).filter(a => a.register === 'yes');

  if (validAccounts.length === 0) {
    console.log('No accounts with register: yes found. Downloading latest file from GitHub...');
    try {
      await downloadFromGitHub(githubURL, renamedPath);
      const data = await fs.readFile(renamedPath, 'utf8');
      accounts = JSON.parse(data);
      validAccounts = Object.values(accounts).filter(a => a.register === 'yes');
      if (validAccounts.length === 0) {
        console.error('Still no accounts with register: yes after downloading new file.');
        return;
      }
    } catch (copyError) {
      console.error('Error downloading tempmail_2.json from GitHub:', copyError);
      return;
    }
  }

  const randomIndex = Math.floor(Math.random() * validAccounts.length);
  const selectedAccount = validAccounts[randomIndex];
  console.log(`Randomly selected account #${randomIndex + 1} of ${validAccounts.length}`);
  console.log('Selected email:', selectedAccount.address);
  console.log('Selected password:', selectedAccount.password);

  delete accounts[selectedAccount.address];
  await fs.writeFile(renamedPath, JSON.stringify(accounts, null, 2));

  let userAgent;
  try {
    const userAgents = await fs.readFile(path.join(__dirname, '../Creator', 'user_agents.txt'), 'utf8');
    const list = userAgents.split('\n').filter(u => u.trim());
    userAgent = list[Math.floor(Math.random() * list.length)];
    console.log('Selected user agent:', userAgent);
  } catch (error) {
    console.error('Error reading user_agents.txt:', error);
    return;
  }

  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 720 },
    javaScriptEnabled: true,
    bypassCSP: true,
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    }
  });

  const page = await context.newPage();

  await page.route('**/*', async route => {
    await new Promise(res => setTimeout(res, Math.random() * 100));
    route.continue();
  });

  try {
    // --- Login sequence ---
    await page.goto('https://audius.co/signin', { waitUntil: 'load', timeout: 60000 });
    await page.fill('input[aria-label="Email"]', selectedAccount.address);
    await page.fill('input[aria-label="Password"]', selectedAccount.password);

    console.log('Waiting 1s before clicking Sign In button...');
    await page.waitForTimeout(1000);
    await page.click('//*[@id="root"]/div[1]/div/div[1]/div/form/div[4]/button');

    try {
      await page.waitForURL('https://audius.co/signin/confirm-email', { waitUntil: 'load', timeout: 60000 });
      await page.waitForTimeout(2000);
    } catch { }

    // --- OTP retrieval ---
    let otp;
    try {
      const { stdout } = await execPromise(`python3 ../Creator/tempmail.py inbox ${selectedAccount.address}`);
      const otpMatch = stdout.match(/\d{3}\s\d{3}/);
      if (!otpMatch) throw new Error('OTP not found');
      otp = otpMatch[0];
      console.log('Retrieved OTP:', otp);
    } catch (error) {
      console.error('Error executing tempmail.py:', error);
      await browser.close();
      return;
    }

    await page.fill('input[aria-label="Code"]', otp);
    await page.waitForTimeout(1000);
    await page.click('//*[@id="root"]/div[1]/div/div[1]/form/div[3]/button');

    try {
      await page.waitForURL('https://audius.co/feed', { waitUntil: 'load', timeout: 60000 });
      console.log('Login success: feed page loaded.');
    } catch {
      const currentUrl = page.url();
      if (!currentUrl.includes('https://audius.co/feed')) {
        console.error('Failed to reach feed page, current URL:', currentUrl);
        await browser.close();
        return;
      }
    }

    // --- Navigate to target URL ---
    const targetUrl = (await fs.readFile(path.join(__dirname, 'url_2.txt'), 'utf8')).trim();
    if (!targetUrl.startsWith('http')) throw new Error('Invalid URL format in url_2.txt');
    console.log('Navigating to target URL:', targetUrl);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // --- Click first button ---
const firstButton = page.locator('button.harmony-o8n1vb');

try {
  // Wait up to 20s for the button to exist in the DOM
  await firstButton.waitFor({ state: 'attached', timeout: 20000 });
  console.log('First button attached to DOM.');

  // Wait up to 5s for it to become visible
  await firstButton.waitFor({ state: 'visible', timeout: 5000 });
  console.log('First button is visible — clicking...');
  await firstButton.click();
} catch {
  console.warn('First button did not appear within 20s.');
}

    // --- Wait for modal container ---
const modalContainer = page.locator('xpath=//div[@role="dialog"]');
if (await waitForVisibility(modalContainer, 30000)) {
  console.log('Modal container appeared.');

  // --- Click modal button by class ---
  const modalButton = page.locator('button.harmony-1p95fbe');
  if (await waitForVisibility(modalButton, 15000)) {
    console.log('Clicking modal button first time...');
    await modalButton.click();

    // --- Repeat up to 2 more times every 20s if button still exists ---
    const maxRetries = 2; // already clicked once
    for (let i = 1; i <= maxRetries; i++) {
      console.log(`Waiting 20s before retry #${i}...`);
      await page.waitForTimeout(30000);

      const count = await modalButton.count();
      if (count === 0) {
        console.log('Modal button no longer found. Stopping retries.');
        break;
      }

      console.log(`Retry #${i}: Clicking modal button again...`);
      await modalButton.click();
    }

    console.log('Modal button click sequence complete.');

  } else {
    console.warn('Modal button did not appear within 15s.');
  }
} else {
  console.warn('Modal container did not appear within 30s. Skipping modal button click.');
}

    console.log('Target URL processed script complete.');
    await browser.close();

  } catch (error) {
    console.error('Fatal error in script:', error.message);
    try { await browser.close(); } catch { }
  }
})();
