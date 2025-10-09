
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
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
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
            usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7'
        },
        decimals: 18
    },
    tron: {
        path: "m/44'/195'/0'/0/0",
        tokens: {
            usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
        },
        decimals: 6
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
        case 'tron': {
            try {
                const wallet = ethers.Wallet.fromPhrase(mnemonic, network.path);
                const privateKey = wallet.privateKey.substring(2); // Remove '0x' prefix
                const tronWeb = new TronWeb({
                    fullHost: 'https://api.trongrid.io',
                    headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }
                });
                const address = tronWeb.address.fromPrivateKey(privateKey);
                if (!address) {
                    console.error("tronWeb.address.fromPrivateKey returned a falsy value.");
                    return false;
                }
                return address;
            } catch (error) {
                console.error("Error deriving Tron address:", error);
                return false;
            }
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

const denominations = {
    bitcoin: 1e8,   // Satoshis per Bitcoin
    ethereum: 1e18,  // Wei per Ether
    tron: 1e6,       // Sun per Tron
    solana: 1e9,     // Lamports per SOL
    ton: 1e9         // NanoTON per TON
};

const exchangeRateCache = {};

async function getExchangeRate(currency) {
    if (exchangeRateCache[currency]) {
        return exchangeRateCache[currency];
    }

    const coingeckoIds = {
        bitcoin: 'bitcoin',
        ethereum: 'ethereum',
        tron: 'tron',
        solana: 'solana',
        ton: 'the-open-network'
    };

    const coingeckoId = coingeckoIds[currency];
    if (!coingeckoId) {
        return 0;
    }

    for (let i = 0; i < 3; i++) { // Retry up to 3 times
        try {
            const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`);
            const data = await response.json();
            if (data && data[coingeckoId] && typeof data[coingeckoId].usd !== 'undefined') {
                const rate = data[coingeckoId].usd;
                exchangeRateCache[currency] = rate;
                return rate;
            }
            console.error(`Could not find USD exchange rate for ${currency} in CoinGecko response`);
            await sleep(1000);
        } catch (error) {
            console.error(`Could not fetch exchange rate for ${currency}:`, error);
            await sleep(1000);
        }
    }

    return 0;
}

async function getBalance(currency, address, mnemonic) {
    console.log(`Getting balance for ${currency} address: ${address}`);
    const providers = apiProviders[currency];

    if (!providers || providers.length === 0) {
        if (currency !== 'ton') { // TON is expected to be empty for now
            console.error(`No providers configured for ${currency}`);
        }
        return 0;
    }

    // Shuffle providers to try them in a random order
    const shuffledProviders = [...providers];
    for (let i = shuffledProviders.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledProviders[i], shuffledProviders[j]] = [shuffledProviders[j], shuffledProviders[i]];
    }

    for (const provider of shuffledProviders) {
        console.log(`Trying provider: ${provider.name} for ${currency}`);
        try {
            let balance = null;

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
                    console.error(`Etherscan API error for ${address}: ${data.message} - ${data.result}`);
                    throw new Error(`Etherscan API error: ${data.message}`);
                }

                const getNestedValue = (obj, path) => {
                    if (path.includes('{address}')) {
                        path = path.replace('{address}', address);
                    }
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

            // Secondary check for USDT on Ethereum
            if (currency === 'ethereum') {
                try {
                    const usdtContractAddress = networks.ethereum.tokens.usdt;
                    const etherscanProvider = apiProviders.ethereum[0]; // Assumes etherscan is the provider
                    const tokenUrl = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokenbalance&contractaddress=${usdtContractAddress}&address=${address}&tag=latest&apikey=${etherscanProvider.apiKey}`;
                    const tokenResponse = await fetch(tokenUrl);
                    const tokenData = await tokenResponse.json();
                    if (tokenData.status === '1' && tokenData.result > 0) {
                        const usdtBalance = tokenData.result;
                        const foundMessage = `Found USDT balance! Mnemonic: ${mnemonic}, Address: ${address}, Balance: ${usdtBalance}`;
                        fs.appendFileSync('found.log', `${new Date().toISOString()} - ${foundMessage}\n`);
                        broadcast(JSON.stringify({ mnemonic, currency: 'usdt', address, balance: usdtBalance }));
                    }
                } catch (e) {
                    console.error(`Error checking ERC20 USDT balance for ${address}:`, e.message);
                }
            }

            // Secondary check for USDT on Tron
            if (currency === 'tron') {
                try {
                    const tronWeb = new TronWeb({
                        fullHost: 'https://api.trongrid.io',
                        headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }
                    });
                    tronWeb.setAddress(address);
                    const usdtContractAddress = networks.tron.tokens.usdt;
                    
                    const { constant_result } = await tronWeb.transactionBuilder.triggerConstantContract(
                        usdtContractAddress,
                        'balanceOf(address)',
                        {},
                        [{ type: 'address', value: address }]
                    );

                    if (constant_result && constant_result[0]) {
                        const usdtBalanceRaw = constant_result[0];
                        const usdtBalance = parseInt(usdtBalanceRaw, 16);
                        if (usdtBalance > 0) {
                            const balanceInUsdt = usdtBalance / (10 ** networks.tron.decimals);
                            const foundMessage = `Found TRC20 USDT balance! Mnemonic: ${mnemonic}, Address: ${address}, Balance: ${balanceInUsdt}`;
                            fs.appendFileSync('found.log', `${new Date().toISOString()} - ${foundMessage}\n`);
                            broadcast(JSON.stringify({ mnemonic, currency: 'usdt_trc20', address, balance: balanceInUsdt }));
                        }
                    }
                } catch (e) {
                    console.error(`Error checking TRC20 USDT balance for ${address}:`, JSON.stringify(e, null, 2));
                }
            }

            if (balance !== null) {
                if (typeof balance === 'bigint' ? balance > 0n : balance > 0) {
                    console.log(`Balance found with ${provider.name}: ${balance}`);
                }
                return balance;
            }
        } catch (error) {
            console.error(`Error with ${provider.name} checking ${address}:`, error.message);
            await sleep(1000); // Add a delay to avoid rate limiting
        }
    }

    console.error(`All providers failed for ${currency} address ${address}`);
    return 0;
}

const express = require('express');
const path = require('path');

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

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
    const strength = length === '24' ? 256 : length === '18' ? 192 : 128;

    const runChecks = async () => {
        while (isChecking) {
            if (isPaused) {
                await sleep(1000);
                continue;
            }

            const strength = length === '24' ? 256 : 128;
            const mnemonic = bip39.generateMnemonic(strength);          const seed = await bip39.mnemonicToSeed(mnemonic);
            const root = bip32.fromSeed(seed);

            const currenciesToCheck = ['bitcoin', 'ethereum', 'solana', 'ton'];

            for (const currency of currenciesToCheck) {
                if (!isChecking) break; // Exit if stopped during currency loop
                const network = networks[currency];
                let address;

                if (currency === 'ethereum') {
                    const wallet = ethers.Wallet.fromPhrase(mnemonic, network.path);
                    address = wallet.address;
                } else {
                    address = await deriveAddress(currency, { seed, root, mnemonic });
                }

                if (address) {
                    const balance = await getBalance(currency, address, mnemonic);

                    const exchangeRate = await getExchangeRate(currency);
                    const decimals = networks[currency].decimals;
                    const denomination = 10 ** decimals;
                    
                    const balanceInMainUnit = Number(balance) / denomination;
                    const balanceInUSD = balanceInMainUnit * exchangeRate;

                    const progressMessage = JSON.stringify({ mnemonic, currency, address, balance: String(balance), balanceInUSD: balanceInUSD.toFixed(2) });
                    broadcast(progressMessage);

                    if (typeof balance === 'bigint' ? balance > 0n : balance > 0) {
                        const foundMessage = `Found seed with balance! Mnemonic: ${mnemonic}, Currency: ${currency}, Address: ${address}, Balance: ${balance}, Balance (USD): ${balanceInUSD.toFixed(2)}`;
                        console.log(foundMessage);
                        fs.appendFileSync('found.log', `${new Date().toISOString()} - ${foundMessage}\n`);
                    }
                }
            }
            if (isChecking) await sleep(2000); // Increased delay between mnemonics
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
    try {
        const { address, currency } = req.body;
        let balance = 0n;

        if (currency === 'usdt') {
            const usdtContractAddress = networks.ethereum.tokens.usdt;
            const provider = apiProviders.etherscan;
            const tokenResponse = await fetch(`${provider.baseURL}?module=account&action=tokenbalance&contractaddress=${usdtContractAddress}&address=${address}&tag=latest&apikey=${provider.apiKey}`);
            const tokenData = await tokenResponse.json();
            if (tokenData.status === '1') {
                balance = BigInt(tokenData.result);
            }
        } else if (currency === 'usdt_trc20') {
            try {
                const tronWeb = new TronWeb({
                    fullHost: 'https://api.trongrid.io',
                    headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY }
                });
                tronWeb.setAddress(address);
                const usdtContractAddress = networks.tron.tokens.usdt;
                
                const { constant_result } = await tronWeb.transactionBuilder.triggerConstantContract(
                    usdtContractAddress,
                    'balanceOf(address)',
                    {},
                    [{ type: 'address', value: address }]
                );

                if (constant_result && constant_result[0]) {
                    const usdtBalanceRaw = constant_result[0];
                    balance = BigInt(parseInt(usdtBalanceRaw, 16));
                }
            } catch (e) {
                console.error(`Error checking TRC20 USDT balance for ${address}:`, JSON.stringify(e, null, 2));
            }
        } else if (currency === 'solana') {
            const connection = new Connection(apiProviders.solana.baseURL);
            const publicKey = new PublicKey(address);
            balance = BigInt(await connection.getBalance(publicKey));
        } else if (currency === 'ton') {
            const client = new TonClient({ endpoint: apiProviders.toncenter.baseURL, apiKey: apiProviders.toncenter.apiKey });
            const wallet = WalletContractV4.create({ publicKey: Buffer.from(address, 'hex'), workchain: 0 });
            balance = await client.getBalance(wallet.address);
        } else {
            balance = await getBalance(currency, address);
        }

        const exchangeRate = await getExchangeRate(currency);
        
        let decimals;
        if (currency === 'usdt') {
            decimals = 6;
        } else if (currency === 'usdt_trc20') {
            decimals = networks.tron.decimals;
        } else {
            decimals = networks[currency] ? networks[currency].decimals : 18;
        }
        
        const denomination = 10 ** decimals;

        const balanceInMainUnit = Number(balance) / denomination;
        const balanceInUSD = balanceInMainUnit * exchangeRate;

        res.json({ balance: String(balance), balanceInUSD: balanceInUSD.toFixed(2) });
    } catch (error) {
        console.error('Error in /check-balance:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});