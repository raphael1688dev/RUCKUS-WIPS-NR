import { DEVICE, ORIGIN, MQTT_BASE_TOPIC } from './config.mjs';

export function discoveryMessages() {
  const avail = { availability_topic: `${MQTT_BASE_TOPIC}/status`, payload_available: 'online', payload_not_available: 'offline' };
  
  const makeSensor = (suffix, name, icon, stateTopic, countTemplate, attrTemplate) => ({
    topic: `homeassistant/sensor/ruckus_wips_${suffix}/config`,
    payload: JSON.stringify({
      name,
      unique_id: `ruckus_wips_${suffix}`,
      state_topic: stateTopic,
      value_template: countTemplate,
      json_attributes_topic: stateTopic,
      json_attributes_template: attrTemplate,
      state_class: 'measurement',
      icon,
      device: DEVICE,
      origin: ORIGIN,
      ...avail,
    }),
    retain: true,
    qos: 1,
  });

  const sensorConfig = (suffix, name, icon) => makeSensor(
    suffix, name, icon, `${MQTT_BASE_TOPIC}/state/${suffix}`, 
    '{{ value_json.count }}', 
    '{{ {"rogues": value_json.rogues, "last_updated": value_json.last_updated} | tojson }}'
  );

  const eventConfig = {
    topic: `homeassistant/event/ruckus_wips_new_rogue/config`,
    payload: JSON.stringify({
      name: 'New rogue detected',
      unique_id: 'ruckus_wips_new_rogue',
      state_topic: `${MQTT_BASE_TOPIC}/event/new_rogue`,
      event_types: ['new_rogue'],
      device: DEVICE,
      origin: ORIGIN,
      ...avail,
    }),
    retain: true,
    qos: 1,
  };

  return [
    sensorConfig('active',  'RUCKUS WIPS active rogues',  'mdi:access-point-network'),
    sensorConfig('blocked', 'RUCKUS WIPS blocked rogues', 'mdi:access-point-off'),
    sensorConfig('total',   'RUCKUS WIPS rogues total',   'mdi:access-point-network'),
    eventConfig
  ];
}
