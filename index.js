
require('dotenv').config();
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { ECPairFactory } = require('ecpair');
const { ethers } = require('ethers');
const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const crypto = require('crypto');

const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

const networks = {
    bitcoin: {
        lib: bitcoin.networks.bitcoin,
        path: "m/44'/0'/0'/0/0",
    },
    ethereum: {
        path: "m/44'/60'/0'/0/0",
    },
    litecoin: {
        lib: bitcoin.networks.litecoin,
        path: "m/44'/2'/0'/0/0",
    },
    dogecoin: {
        lib: {
            messagePrefix: '\x19Dogecoin Signed Message:\n',
            bip32: {
                public: 0x02facafd,
                private: 0x02fac398
            },
            pubKeyHash: 0x1e,
            scriptHash: 0x16,
            wif: 0x9e
        },
        path: "m/44'/3'/0'/0/0",
    }
};

const apiProviders = {
    etherscan: {
        baseURL: 'https://api.etherscan.io/api',
        apiKey: process.env.ETHERSCAN_API_KEY
    },
    blockcypher: {
        baseURL: 'https://api.blockcypher.com/v1',
        apiKey: process.env.BLOCKCYPHER_TOKEN
    },
    blockstream: {
        baseURL: 'https://blockstream.info/api'
    },
    cryptoapis: {
        baseURL: 'https://rest.cryptoapis.io/v2',
        apiKey: process.env.CRYPTOAPIS_API_KEY
    },
    moralis: {
        baseURL: 'https://deep-index.moralis.io/api/v2.2',
        apiKey: process.env.MORALIS_API_KEY
    },
    bitquery: {
        baseURL: 'https://graphql.bitquery.io',
        apiKey: process.env.BITQUERY_API_KEY
    },
    blockchair: {
        baseURL: 'https://api.blockchair.com'
    },
    covalent: {
        baseURL: 'https://api.covalenthq.com/v1',
        apiKey: process.env.COVALENT_API_KEY
    }
};

const apiConfig = {
    bitcoin: {
        providers: ['blockchair', 'blockstream', 'cryptoapis', 'blockcypher']
    },
    ethereum: {
        providers: ['blockchair', 'covalent', 'etherscan', 'moralis', 'bitquery']
    },
    litecoin: {
        providers: ['blockchair', 'cryptoapis', 'blockcypher']
    },
    dogecoin: {
        providers: ['blockchair', 'blockcypher']
    }
};



const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getBalance(currency, address) {
    console.log(`Getting balance for ${currency} address: ${address}`);
    const providers = [...apiConfig[currency].providers];
    for (let i = providers.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [providers[i], providers[j]] = [providers[j], providers[i]];
    }

    for (const providerName of providers) {
        console.log(`Trying provider: ${providerName}`);
        try {
            let balance = 0;
            const provider = apiProviders[providerName];
            switch (providerName) {
                case 'blockchair':
                    {
                        const apiKey = process.env.BLOCKCHAIR_API_KEY;
                        let url = `${provider.baseURL}/${currency}/dashboards/address/${address}`;
                        if (apiKey) {
                            url += `?key=${apiKey}`;
                        }
                        const response = await fetch(url);
                        const data = await response.json();
                        console.log('Blockchair API response:', JSON.stringify(data, null, 2));
                        if (data && data.data && data.data[address]) {
                            balance = data.data[address].address.balance;
                        }
                    }
                    break;
                case 'etherscan':
                    if (currency === 'ethereum') {
                        const response = await fetch(`${provider.baseURL}?module=account&action=balance&address=${address}&tag=latest&apikey=${provider.apiKey}`);
                        const data = await response.json();
                        if (data.status === '1') {
                            balance = data.result;
                        }
                    }
                    break;
                case 'blockcypher':
                    {
                        const response = await fetch(`${provider.baseURL}/${currency.toLowerCase()}/main/addrs/${address}/balance`);
                        const data = await response.json();
                        if (data.balance) {
                            balance = data.balance;
                        }
                    }
                    break;
                case 'blockstream':
                    if (currency === 'bitcoin') {
                        const response = await fetch(`${provider.baseURL}/address/${address}/utxo`);
                        const utxos = await response.json();
                        balance = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
                    }
                    break;
                case 'cryptoapis':
                    {
                        const response = await fetch(`${provider.baseURL}/blockchain-data/${currency.toLowerCase()}/mainnet/addresses/${address}/balance`, {
                            headers: { 'X-API-Key': provider.apiKey }
                        });
                        const data = await response.json();
                        if (data.data && data.data.item) {
                            balance = data.data.item.confirmedBalance.amount;
                        }
                    }
                    break;
                case 'moralis':
                    if (currency === 'ethereum') {
                        const response = await fetch(`${provider.baseURL}/${address}/balance`, {
                            headers: { 'X-API-Key': provider.apiKey }
                        });
                        const data = await response.json();
                        if (data.balance) {
                            balance = data.balance;
                        }
                    }
                    break;
                case 'bitquery':
                    if (currency === 'ethereum') {
                        const query = `
                            query ($address: String!) {
                                ethereum(network: mainnet) {
                                    address(address: {is: $address}) {
                                        balance
                                    }
                                }
                            }
                        `;
                        const variables = { address };
                        const response = await fetch(provider.baseURL, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'X-API-KEY': provider.apiKey
                            },
                            body: JSON.stringify({ query, variables })
                        });
                        const data = await response.json();
                        if (data.data.ethereum.address[0]) {
                            balance = data.data.ethereum.address[0].balance;
                        }
                    }
                    break;
                case 'covalent':
                    if (currency === 'ethereum') {
                        const response = await fetch(`${provider.baseURL}/1/address/${address}/balances_v2/?key=${provider.apiKey}`);
                        const data = await response.json();
                        if (data.data.items) {
                            const ethItem = data.data.items.find(item => item.contract_ticker_symbol === 'ETH');
                            if (ethItem) {
                                balance = ethItem.balance;
                            }
                        }
                    }
                    break;
            }
            console.log(`Balance found with ${providerName}: ${balance}`);
            return balance;
        } catch (error) {
            console.error(`Error with ${providerName} checking ${address}:`, error.message);
        }
    }

    console.error(`All providers failed for ${currency} address ${address}`);
    return 0;
}

const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

let clients = [];
let checkingInterval;
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
    isPaused = false;
    if (!checkingInterval) {
        checkingInterval = setInterval(async () => {
            if (isPaused) return;

            const mnemonic = bip39.generateMnemonic();
            const seed = await bip39.mnemonicToSeed(mnemonic);
            const root = bip32.fromSeed(seed);

            for (const currency in networks) {
                const network = networks[currency];
                let address;

                if (currency === 'ethereum') {
                    const wallet = ethers.Wallet.fromPhrase(mnemonic, network.path);
                    address = wallet.address;
                } else {
                    const child = root.derivePath(network.path);
                    const { address: p2pkhAddress } = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network: network.lib });
                    address = p2pkhAddress;
                }

                const balance = await getBalance(currency, address);

                if (balance > 0) {
                    const foundMessage = `Found seed with balance! Mnemonic: ${mnemonic}, Currency: ${currency}, Address: ${address}, Balance: ${balance}`;
                    broadcast(foundMessage);
                    fs.appendFileSync('found.log', `${new Date().toISOString()} - ${foundMessage}\n`);
                }
            }
        }, 1000);
    }
    res.status(200).send();
});

app.post('/pause', (req, res) => {
    isPaused = true;
    res.status(200).send();
});

app.post('/stop', (req, res) => {
    clearInterval(checkingInterval);
    checkingInterval = null;
    res.status(200).send();
});