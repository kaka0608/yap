const axios = require('axios');
const dotenv = require('dotenv');
const readline = require('readline');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { Ed25519Keypair } = require("@mysten/sui.js/keypairs/ed25519");

dotenv.config();

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  white: "\x1b[37m",
  bold: "\x1b[1m"
};

const logger = {
  info: (msg) => console.log(`${colors.green}[✓] ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}[⚠] ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}[✗] ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}[✅] ${msg}${colors.reset}`),
  loading: (msg) => console.log(`${colors.cyan}[⟳] ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.white}[➤] ${msg}${colors.reset}`),
  banner: () => {
    console.log(`${colors.cyan}${colors.bold}`);
    console.log(`---------------------------------------------`);
    console.log(`  Tusky Testnet Bot - Airdrop Insiders `);
    console.log(`---------------------------------------------${colors.reset}`);
    console.log();
  }
};

const DEFAULT_IMAGE_URL = 'https://picsum.photos/800/600';
const API_BASE_URL = "https://dev-api.tusky.io";
const SEED_FILE = "seed.txt";

const loadSeedPhrases = () => {
  try {
    const data = fs.readFileSync(SEED_FILE, 'utf8');
    const seeds = data.split("\n").map(seed => seed.trim()).filter(seed => seed.split(" ").length >= 12);
    const keypairs = seeds.map(seed => {
      try {
        return Ed25519Keypair.deriveKeypair(seed);
      } catch (error) {
        logger.error(`Invalid seed phrase: ${seed.slice(0, 10)}...`);
        return null;
      }
    }).filter(kp => kp !== null);
    
    if (keypairs.length === 0) throw new Error("No valid seed phrases in seed.txt");
    logger.info(`Loaded ${keypairs.length} seed phrases from seed.txt`);
    return keypairs;
  } catch (error) {
    logger.error(`Failed to load seed phrases: ${error.message}`);
    return [];
  }
};

const loginAccount = async (keypair, proxyUrl, axiosInstance) => {
  try {
    const address = keypair.getPublicKey().toSuiAddress();
    
    const challengeUrl = `${API_BASE_URL}/auth/create-challenge`;
    const challengePayload = { address: address };
    const challengeResponse = await axiosInstance.post(challengeUrl, challengePayload);
    
    if (!challengeResponse.data || !challengeResponse.data.nonce) {
      throw new Error("Invalid challenge response: No nonce received");
    }
    const nonce = challengeResponse.data.nonce;
    
    const message = `tusky:connect:${nonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const signatureObj = await keypair.signPersonalMessage(messageBytes);
    const signature = signatureObj.signature;
    
    const verifyUrl = `${API_BASE_URL}/auth/verify-challenge`;
    const verifyPayload = {
      address: address,
      signature: signature
    };
    const verifyResponse = await axiosInstance.post(verifyUrl, verifyPayload);
    
    if (!verifyResponse.data.idToken) {
      throw new Error("No idToken received in verify response");
    }
    
    const idToken = verifyResponse.data.idToken;
    logger.success(`Account ${address.slice(0, 6)}...${address.slice(-4)}: Logged in successfully`);
    return idToken;
  } catch (error) {
    logger.error(`Login error: ${error.message}`);
    throw error;
  }
};

const generateRandomUserAgent = () => {
  const browsers = ['Brave', 'Chrome', 'Firefox', 'Safari'];
  const platforms = ['Windows', 'Macintosh', 'Linux'];
  const versions = ['138', '139', '140'];
  const browser = browsers[Math.floor(Math.random() * browsers.length)];
  const platform = platforms[Math.floor(Math.random() * platforms.length)];
  const version = versions[Math.floor(Math.random() * versions.length)];
  return `"Not)A;Brand";v="8", "Chromium";v="${version}", "${browser}";v="${version}"`;
};

const getCommonHeaders = (authToken = null) => ({
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'content-type': 'application/json',
  'priority': 'u=1, i',
  'sdk-version': 'Tusky-SDK/0.31.0',
  'sec-ch-ua': generateRandomUserAgent(),
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'sec-gpc': '1',
  'Referer': 'https://testnet.app.tusky.io/',
  ...(authToken ? { 'authorization': `Bearer ${authToken}` } : {}),
  'client-name': 'Tusky-App/dev'
});

const loadProxies = () => {
  try {
    const proxies = fs.readFileSync('proxies.txt', 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')); 
    logger.info(`Loaded ${proxies.length} proxies from proxies.txt`);
    return proxies;
  } catch (error) {
    logger.warn('No proxies found in proxies.txt or file does not exist. Using direct mode.');
    return [];
  }
};

const createAgent = (proxyUrl) => {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else if (proxyUrl.startsWith("http") || proxyUrl.startsWith("https")) {
    return new HttpsProxyAgent(proxyUrl);
  }
  throw new Error(`Unsupported proxy protocol: ${proxyUrl}`);
};

const createAxiosInstance = (proxyUrl = null) => {
  if (proxyUrl) {
    try {
      const agent = createAgent(proxyUrl);
      logger.info(`Using proxy: ${proxyUrl}`);
      return axios.create({
        httpsAgent: agent,
        httpAgent: agent
      });
    } catch (error) {
      logger.warn(`Invalid proxy format: ${proxyUrl}. Falling back to direct mode.`);
      return axios.create();
    }
  }
  logger.info('Using direct mode (no proxy)');
  return axios.create();
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const loadTokens = () => {
  const tokens = [];
  let i = 1;
  while (process.env[`token_${i}`]) {
    const token = process.env[`token_${i}`];
    if (token) {
      logger.info(`Loaded token ${i}: ${token.slice(0, 20)}...`);
      tokens.push({ idToken: token });
    } else {
      logger.error(`Invalid token for token_${i}`);
    }
    i++;
  }
  return tokens;
};

const fetchStorageInfo = async (idToken, axiosInstance) => {
  logger.step(`Fetching storage information`);
  try {
    const response = await axiosInstance.get('https://dev-api.tusky.io/storage?', {
      headers: getCommonHeaders(idToken)
    });
    const { storageAvailable, storageTotal } = response.data;
    logger.info(`Storage Available: ${storageAvailable} bytes (~${(storageAvailable / 1000000).toFixed(2)} MB)`);
    logger.info(`Storage Total: ${storageTotal} bytes (~${(storageTotal / 1000000).toFixed(2)} MB)`);
    return { storageAvailable, storageTotal };
  } catch (error) {
    if (error.response && error.response.status === 401) {
      throw new Error('Invalid token (401 Unauthorized)');
    }
    logger.error(`Failed to fetch storage info: ${error.message}`);
    throw error;
  }
};

const fetchVaults = async (idToken, axiosInstance) => {
  logger.step(`Fetching active, non-encrypted vaults`);
  try {
    const response = await axiosInstance.get('https://dev-api.tusky.io/vaults?status=active&limit=1000', {
      headers: getCommonHeaders(idToken)
    });
    const vaults = response.data.items.filter(vault => !vault.encrypted && vault.status === 'active');
    if (vaults.length === 0) {
      logger.error('No active, non-encrypted vaults found');
      return [];
    }
    logger.info(`Found ${vaults.length} active, non-encrypted vaults`);
    return vaults.map(vault => vault.id);
  } catch (error) {
    logger.error(`Failed to fetch vaults: ${error.message}`);
    throw error;
  }
};

const uploadFile = async (idToken, vaultId, axiosInstance) => {
  logger.step(`Uploading file to vault ${vaultId}`);

  const imageResponse = await axios.get(DEFAULT_IMAGE_URL, { responseType: 'arraybuffer' });
  const imageBuffer = Buffer.from(imageResponse.data);
  const fileName = `image_${Date.now()}.jpg`;
  const fileSize = imageBuffer.length;
  const mimeType = 'image/jpeg';

  const uploadMetadata = {
    vaultId: Buffer.from(vaultId).toString('base64'),
    parentId: Buffer.from(vaultId).toString('base64'),
    relativePath: Buffer.from('null').toString('base64'),
    name: Buffer.from(fileName).toString('base64'),
    type: Buffer.from(mimeType).toString('base64'),
    filetype: Buffer.from(mimeType).toString('base64'),
    filename: Buffer.from(fileName).toString('base64')
  };

  const uploadHeaders = {
    ...getCommonHeaders(idToken),
    'content-type': 'application/offset+octet-stream',
    'tus-resumable': '1.0.0',
    'upload-length': fileSize.toString(),
    'upload-metadata': Object.entries(uploadMetadata).map(([k, v]) => `${k} ${v}`).join(',')
  };

  try {
    const uploadResponse = await axiosInstance.post('https://dev-api.tusky.io/uploads', imageBuffer, { headers: uploadHeaders });
    const uploadId = uploadResponse.data.uploadId;
    logger.success(`File uploaded, ID: ${uploadId}`);
    return uploadId;
  } catch (error) {
    logger.error(`Failed to upload file: ${error.message}`);
    throw error;
  }
};

const processAccount = async (keypair, proxies, proxyIndex, numberOfUploads) => {
  let currentProxyIndex = proxyIndex;
  
  try {
    const proxyUrl = proxies.length > 0 ? proxies[currentProxyIndex % proxies.length] : null;
    const axiosInstance = createAxiosInstance(proxyUrl);
    currentProxyIndex++;

    // Direct login with seed phrase
    const idToken = await loginAccount(keypair, proxyUrl, axiosInstance);
    
    await fetchStorageInfo(idToken, axiosInstance);
    const vaultIds = await fetchVaults(idToken, axiosInstance);
    
    for (const vaultId of vaultIds) {
      logger.step(`Processing vault ${vaultId}`);
      for (let i = 0; i < numberOfUploads; i++) {
        logger.step(`Upload ${i + 1} of ${numberOfUploads} to vault ${vaultId}`);
        await uploadFile(idToken, vaultId, axiosInstance);
        logger.success(`Upload ${i + 1} completed`);
        
        // Only add delay between uploads, not after last one
        if (i < numberOfUploads - 1) {
          const delay = Math.floor(Math.random() * 15000) + 20000; // 20-35 sec
          logger.loading(`Waiting ${(delay/1000).toFixed(2)} seconds before next upload...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    return currentProxyIndex;
  } catch (error) {
    logger.error(`Error processing account: ${error.message}`);
    throw error;
  }
};

const main = async () => {
  logger.banner();
  
  const keypairs = loadSeedPhrases();
  const proxies = loadProxies();
  let proxyIndex = 0;

  if (keypairs.length === 0) {
    logger.error('No valid seed phrases found');
    return;
  }

  const numberOfUploads = await new Promise((resolve) => {
    rl.question('Enter the number of uploads to perform: ', (answer) => {
      resolve(parseInt(answer, 10) || 1);
    });
  });
  logger.info(`Will perform ${numberOfUploads} uploads`);

  const runCycle = async () => {
    for (let i = 0; i < keypairs.length; i++) {
      try {
        proxyIndex = await processAccount(keypairs[i], proxies, proxyIndex, numberOfUploads);
      } catch (error) {
        continue;
      }
    }

    logger.success('All accounts processed. Restarting in 24 hours...');
    setTimeout(runCycle, 24 * 60 * 60 * 1000); // Restart after 24 hours
  };

  await runCycle(); // Initial run
  rl.close(); // Close readline after setup
};

main().catch((error) => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1); // Exit if unrecoverable error
});