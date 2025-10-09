const resultsDiv = document.getElementById('results');
const progressDiv = document.getElementById('progress');

document.getElementById('start').addEventListener('click', () => {
    const length = document.getElementById('mnemonic-length').value;
    fetch('/start', { 
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ length })
    });
});

document.getElementById('pause').addEventListener('click', () => {
    fetch('/pause', { method: 'POST' });
});

document.getElementById('stop').addEventListener('click', () => {
    fetch('/stop', { method: 'POST' });
});

document.getElementById('check-balance').addEventListener('click', async () => {
    const address = document.getElementById('manual-address').value;
    const currency = document.getElementById('manual-currency').value;
    const response = await fetch('/check-balance', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ address, currency })
    });
    const data = await response.json();
    const item = document.createElement('div');
    item.className = 'result-item';
    item.innerHTML = `<strong>Address:</strong> ${address}<br><strong>Balance:</strong> ${data.balance} (${data.balanceInUSD} USD)`;
    resultsDiv.appendChild(item);
});

const eventSource = new EventSource('/events');

eventSource.onmessage = function(event) {
    const data = JSON.parse(event.data);

    if (data.balance > 0) {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `<strong>Mnemonic:</strong> ${data.mnemonic}<br><strong>Address:</strong> ${data.address}<br><strong>Balance:</strong> ${data.balance} (${data.balanceInUSD} USD)`;
        
        const copyButton = document.createElement('button');
        copyButton.textContent = 'Copy Mnemonic';
        copyButton.onclick = () => {
            navigator.clipboard.writeText(data.mnemonic);
            copyButton.textContent = 'Copied!';
            setTimeout(() => {
                copyButton.textContent = 'Copy Mnemonic';
            }, 2000);
        };

        item.appendChild(copyButton);
        resultsDiv.appendChild(item);
        resultsDiv.scrollTop = resultsDiv.scrollHeight;
    } else {
        const item = document.createElement('div');
        item.className = 'progress-item';
        item.innerHTML = `<strong>Mnemonic:</strong> ${data.mnemonic}<br><strong>Address:</strong> ${data.address}<br><strong>Balance:</strong> ${data.balance}`;
        progressDiv.appendChild(item);
        progressDiv.scrollTop = progressDiv.scrollHeight;
    }
};