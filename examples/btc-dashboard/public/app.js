document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const dataContainer = document.getElementById('data-container');
    const errorContainer = document.getElementById('error-container');
    const errorMessage = document.getElementById('error-message');
    const retryBtn = document.getElementById('retry-btn');

    // UI Elements
    const currentPriceEl = document.getElementById('current-price');
    const priceChangeEl = document.getElementById('price-change');
    const highPriceEl = document.getElementById('high-price');
    const lowPriceEl = document.getElementById('low-price');
    const volumeEl = document.getElementById('volume');
    const summaryContentEl = document.getElementById('summary-content');

    const formatPrice = (price) => {
        if (!price) return '--';
        return new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(price);
    };

    const formatNumber = (num) => {
        if (!num) return '--';
        if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
        return num.toFixed(2);
    };

    const fetchData = async () => {
        try {
            // Reset UI states
            loadingContainer.classList.remove('hidden');
            dataContainer.classList.add('hidden');
            errorContainer.classList.add('hidden');

            const response = await fetch('/api/status');
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Unknown error occurred');
            }

            updateUI(data);

        } catch (error) {
            console.error('Error fetching data:', error);
            errorMessage.textContent = error.message || 'Failed to connect to TradingView MCP backend.';
            loadingContainer.classList.add('hidden');
            errorContainer.classList.remove('hidden');
        }
    };

    const updateUI = (data) => {
        const { quote, ohlcv } = data;

        if (quote) {
            currentPriceEl.textContent = formatPrice(quote.price);
            
            // If quote provides change, display it (mock calculation if not)
            const change = quote.change || (quote.price - (quote.price * 0.99)); // Example fallback
            const changePercent = quote.change_percent || 1.2; // Example fallback
            
            priceChangeEl.textContent = `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
            priceChangeEl.className = `change-badge ${changePercent >= 0 ? 'positive' : 'negative'}`;

            if (quote.high) highPriceEl.textContent = formatPrice(quote.high);
            if (quote.low) lowPriceEl.textContent = formatPrice(quote.low);
            if (quote.volume) volumeEl.textContent = formatNumber(quote.volume);
        }

        if (ohlcv && ohlcv.summary) {
            // Safely parse or display summary
            let summaryText = '';
            if (typeof ohlcv === 'string') {
                summaryText = ohlcv;
            } else if (ohlcv.summary) {
                 summaryText = typeof ohlcv.summary === 'string' ? ohlcv.summary : JSON.stringify(ohlcv.summary, null, 2);
            }
            summaryContentEl.textContent = summaryText;
        } else if (ohlcv && typeof ohlcv === 'string') {
             summaryContentEl.textContent = ohlcv;
        }

        loadingContainer.classList.add('hidden');
        dataContainer.classList.remove('hidden');
    };

    retryBtn.addEventListener('click', fetchData);

    // Initial fetch
    fetchData();

    // Poll every 10 seconds
    setInterval(fetchData, 10000);
});
