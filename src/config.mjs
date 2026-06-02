export const CONFIG = {
  get HOST() { return typeof env !== 'undefined' ? (env.get('RUCKUS_HOST') || 'ruckus.raphaelchen.org') : 'ruckus.raphaelchen.org'; },
  get USER() { return typeof env !== 'undefined' ? (env.get('RUCKUS_USER') || 'admin') : 'admin'; },
  get PASS() { return typeof env !== 'undefined' ? (env.get('RUCKUS_PASS') || 'CHANGE_ME') : 'CHANGE_ME'; },
  get ENABLE_UNBLOCK() { return typeof env !== 'undefined' ? ((env.get('RUCKUS_ENABLE_UNBLOCK') || 'true') === 'true') : true; },
  get CA_CERT() { return typeof env !== 'undefined' ? (env.get('RUCKUS_CA_CERT') || '') : ''; },
  get MQTT_BASE_TOPIC() { return typeof env !== 'undefined' ? (env.get('RUCKUS_MQTT_BASE_TOPIC') || 'ruckus_wips') : 'ruckus_wips'; }
};

export const DEVICE = {
  get identifiers() {
    const id = typeof env !== 'undefined' ? (env.get('RUCKUS_DEVICE_IDENTIFIER') || 'ruckus_wips_main') : 'ruckus_wips_main';
    return [id];
  },
  get name() {
    return typeof env !== 'undefined' ? (env.get('RUCKUS_DEVICE_NAME') || 'RUCKUS Unleashed WIPS') : 'RUCKUS Unleashed WIPS';
  },
  manufacturer: 'Ruckus Networks',
  get model() {
    return typeof env !== 'undefined' ? (env.get('RUCKUS_DEVICE_MODEL') || 'Unleashed WIPS (via Node-RED)') : 'Unleashed WIPS (via Node-RED)';
  },
  get configuration_url() {
    return `https://${CONFIG.HOST}/`;
  }
};

export const ORIGIN = {
  name: 'ruckus_wips_nodered',
  get sw_version() {
    return typeof env !== 'undefined' ? (env.get('RUCKUS_SW_VERSION') || '1.1.0') : '1.1.0';
  },
  get support_url() {
    return typeof env !== 'undefined' ? (env.get('RUCKUS_SUPPORT_URL') || 'https://github.com/raphael1688dev/RUCKUS-NR') : 'https://github.com/raphael1688dev/RUCKUS-NR';
  }
};
