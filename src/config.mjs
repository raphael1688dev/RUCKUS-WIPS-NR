export const HOST = typeof env !== 'undefined' ? (env.get('RUCKUS_HOST') || 'ruckus.raphaelchen.org') : 'ruckus.raphaelchen.org';
export const USER = typeof env !== 'undefined' ? (env.get('RUCKUS_USER') || 'admin') : 'admin';
export const PASS = typeof env !== 'undefined' ? (env.get('RUCKUS_PASS') || 'CHANGE_ME') : 'CHANGE_ME';
export const ENABLE_UNBLOCK = typeof env !== 'undefined' ? ((env.get('RUCKUS_ENABLE_UNBLOCK') || 'true') === 'true') : true;

// Additional environment variables requested by Section 3.2:
export const MQTT_BASE_TOPIC = typeof env !== 'undefined' ? (env.get('RUCKUS_MQTT_BASE_TOPIC') || 'ruckus_wips') : 'ruckus_wips';
export const DEVICE_IDENTIFIER = typeof env !== 'undefined' ? (env.get('RUCKUS_DEVICE_IDENTIFIER') || 'ruckus_wips_main') : 'ruckus_wips_main';
export const DEVICE_NAME = typeof env !== 'undefined' ? (env.get('RUCKUS_DEVICE_NAME') || 'RUCKUS Unleashed WIPS') : 'RUCKUS Unleashed WIPS';
export const DEVICE_MODEL = typeof env !== 'undefined' ? (env.get('RUCKUS_DEVICE_MODEL') || 'Unleashed WIPS (via Node-RED)') : 'Unleashed WIPS (via Node-RED)';
export const SW_VERSION = typeof env !== 'undefined' ? (env.get('RUCKUS_SW_VERSION') || '1.1.0') : '1.1.0';
export const SUPPORT_URL = typeof env !== 'undefined' ? (env.get('RUCKUS_SUPPORT_URL') || 'https://github.com/raphael1688dev/RUCKUS-NR') : 'https://github.com/raphael1688dev/RUCKUS-NR';

export const DEVICE = {
  identifiers: [DEVICE_IDENTIFIER],
  name: DEVICE_NAME,
  manufacturer: 'Ruckus Networks',
  model: DEVICE_MODEL,
  configuration_url: `https://${HOST}/`,
};

export const ORIGIN = {
  name: 'ruckus_wips_nodered',
  sw_version: SW_VERSION,
  support_url: SUPPORT_URL,
};
