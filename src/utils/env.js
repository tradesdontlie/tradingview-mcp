// Validate environment variables on startup
export function validateEnv() {
  const required = ['NODE_ENV'];
  const optional = ['GOOGLE_ANALYTICS_ID', 'SENTRY_DSN'];

  const missing = required.filter(key => !process.env[key]);
  if (missing.length) {
    console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    console.error('❌ Invalid PORT (must be 1024-65535)');
    process.exit(1);
  }

  return {
    port,
    env: process.env.NODE_ENV || 'production',
    analytics: process.env.GOOGLE_ANALYTICS_ID || null,
    sentry: process.env.SENTRY_DSN || null,
  };
}

// Cache layer for expensive operations
export class Cache {
  constructor(ttl = 60000) {
    this.ttl = ttl;
    this.data = new Map();
  }

  set(key, value) {
    this.data.set(key, { value, expiry: Date.now() + this.ttl });
  }

  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  }

  clear() {
    this.data.clear();
  }
}

// Error tracking helper
export function trackError(err, context = {}) {
  const errorData = {
    timestamp: new Date().toISOString(),
    message: err.message,
    stack: err.stack,
    ...context,
  };

  // Log locally
  if (process.env.NODE_ENV === 'development') {
    console.error('🔴 Error tracked:', errorData);
  }

  // Send to Sentry if configured
  if (process.env.SENTRY_DSN) {
    // Sentry integration would go here
    // For now just log the intent
  }

  return errorData;
}

// User-friendly error messages
export function getErrorMessage(err, userContext = '') {
  const messages = {
    'ECONNREFUSED': 'Cannot connect to TradingView. Is it running with CDP enabled?',
    'ENOTFOUND': 'Network error. Check your connection.',
    'ETIMEDOUT': 'Request timed out. Try again.',
    'Missing input': 'Please provide required parameters.',
    'Missing required fields': 'Some required fields are missing.',
  };

  for (const [key, msg] of Object.entries(messages)) {
    if (err.message.includes(key)) return msg;
  }

  return process.env.NODE_ENV === 'development'
    ? err.message
    : 'An error occurred. Please try again.';
}
