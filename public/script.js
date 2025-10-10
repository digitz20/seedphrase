const startButton = document.getElementById('start');
const pauseButton = document.getElementById('pause');
const stopButton = document.getElementById('stop');
const lengthSelect = document.getElementById('length');

const mnemonicSpan = document.getElementById('mnemonic');
const currencySpan = document.getElementById('currency');
const addressSpan = document.getElementById('address');
const resultsTableBody = document.querySelector('#results-table tbody');

let eventSource;

function startEventSource() {
    if (eventSource) {
        eventSource.close();
    }

    eventSource = new EventSource('/events');

    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'progress') {
            mnemonicSpan.textContent = data.mnemonic;
            currencySpan.textContent = data.currency;
            addressSpan.textContent = data.address;
        } else if (data.type === 'found') {
            const newRow = resultsTableBody.insertRow();
            newRow.innerHTML = `
                <td>${data.mnemonic}</td>
                <td>${data.currency}</td>
                <td>${data.address}</td>
                <td>${data.token || 'N/A'}</td>
                <td>${data.balance}</td>
                <td>${data.balanceInUSD}</td>
            `;
        }
    };

    eventSource.onerror = (error) => {
        console.error('EventSource failed:', error);
        eventSource.close();
    };
}

startButton.addEventListener('click', () => {
    fetch('/start', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ length: lengthSelect.value })
    });
    startEventSource();
});

pauseButton.addEventListener('click', () => {
    fetch('/pause', { method: 'POST' });
});

stopButton.addEventListener('click', () => {
    fetch('/stop', { method: 'POST' });
    if (eventSource) {
        eventSource.close();
    }
});

const checkBalanceButton = document.getElementById('check-balance-btn');
const addressInput = document.getElementById('address-input');
const currencySelect = document.getElementById('currency-select');
const balanceTableBody = document.querySelector('#balance-table tbody');

checkBalanceButton.addEventListener('click', async () => {
    const address = addressInput.value;
    const currency = currencySelect.value;

    if (!address) {
        alert('Please enter an address.');
        return;
    }

    const response = await fetch('/check-balance', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ address, currency })
    });

    const data = await response.json();

    balanceTableBody.innerHTML = '';

    const nativeRow = balanceTableBody.insertRow();
    nativeRow.innerHTML = `
        <td>Native</td>
        <td>${data.native.balance}</td>
        <td>${data.native.balanceInUSD}</td>
    `;

    for (const token in data.tokens) {
        const tokenRow = balanceTableBody.insertRow();
        tokenRow.innerHTML = `
            <td>${token.toUpperCase()}</td>
            <td>${data.tokens[token].balance}</td>
            <td>${data.tokens[token].balanceInUSD}</td>
        `;
    }
});