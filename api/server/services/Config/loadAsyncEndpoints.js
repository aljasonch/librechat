const path = require('path');
const fs = require('fs');
const { logger } = require('@librechat/data-schemas');
const { loadServiceKey, isUserProvided } = require('@librechat/api');
const { config } = require('./EndpointService');

async function loadAsyncEndpoints() {
  let serviceKey, googleUserProvides;
  const { googleKey } = config;

  /** Check if GOOGLE_KEY is provided at all(including 'user_provided') */
  const isGoogleKeyProvided = googleKey && googleKey.trim() !== '';

  if (isGoogleKeyProvided) {
    /** If GOOGLE_KEY is provided, check if it's user_provided */
    googleUserProvides = isUserProvided(googleKey);
  } else {
    /** Only attempt to load service key if GOOGLE_KEY is not provided */
    const configuredServiceKeyPath = process.env.GOOGLE_SERVICE_KEY_FILE?.trim();
    const defaultServiceKeyPath = path.join(__dirname, '../../..', 'data', 'auth.json');
    const serviceKeyPath = configuredServiceKeyPath || defaultServiceKeyPath;

    try {
      if (configuredServiceKeyPath || fs.existsSync(defaultServiceKeyPath)) {
        serviceKey = await loadServiceKey(serviceKeyPath);
      }
    } catch (error) {
      logger.error('Error loading service key', error);
      serviceKey = null;
    }
  }

  const google = serviceKey || isGoogleKeyProvided ? { userProvide: googleUserProvides } : false;

  return { google };
}

module.exports = loadAsyncEndpoints;
