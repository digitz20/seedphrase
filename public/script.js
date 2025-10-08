document.getElementById('start').addEventListener('click', () => {
    fetch('/start', { method: 'POST' });
});

document.getElementById('pause').addEventListener('click', () => {
    fetch('/pause', { method: 'POST' });
});

document.getElementById('stop').addEventListener('click', () => {
    fetch('/stop', { method: 'POST' });
});

const resultsDiv = document.getElementById('results');
const eventSource = new EventSource('/events');

eventSource.onmessage = function(event) {
    resultsDiv.innerHTML += `<p>${event.data}</p>`;
};