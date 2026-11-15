'use strict';

const Homey = require('homey');
const mqtt = require('mqtt');

const CHANNELS = [
  { id: 'probe1', label: 'Probe 1' },
  { id: 'probe2', label: 'Probe 2' },
  { id: 'probe3', label: 'Probe 3' },
  { id: 'probe4', label: 'Probe 4' },
  { id: 'bbq', label: 'BBQ' },
];

const TOPICS = Object.freeze({
  probe1: 'measure_temperature.probe1',
  probe2: 'measure_temperature.probe2',
  probe3: 'measure_temperature.probe3',
  probe4: 'measure_temperature.probe4',
  bbq: 'measure_temperature.bbq',
});

const DEFAULTS = Object.freeze({
  mqtt_host: '172.16.1.12',
  mqtt_port: 1883,
  mqtt_username: 'AT02',
  mqtt_password: 'AT02',
  mqtt_base_topic: 'at02',
});

const DEFAULT_TARGETS = Object.freeze({
  probe1: 75.0,
  probe2: 75.0,
  probe3: 75.0,
  probe4: 75.0,
  bbq: 110.0,
});

class AT02Device extends Homey.Device {

  async onInit() {
    this.client = null;

    await this.ensureCapabilities();
    await this.ensureSettings();
    await this.ensureTargetValues();
    this.registerTargetListeners();

    await this.setCapabilityValue('alarm_generic', true)
      .catch(error => this.error(error));

    await this.setUnavailable('Wachten op MQTT-verbinding')
      .catch(error => this.error(error));

    this.connectMqtt();
    this.log('AT-02 apparaat v1.2.3 gestart');
  }

  targetCapability(channelId) {
    return `target_temperature.${channelId}`;
  }

  alarmCapability(channelId) {
    return `alarm_generic.${channelId}`;
  }

  async ensureCapabilities() {
    const required = [
      ...Object.values(TOPICS),
      'measure_signal_strength',
      'alarm_generic',
    ];

    for (const channel of CHANNELS) {
      required.push(this.targetCapability(channel.id));
      required.push(this.alarmCapability(channel.id));
    }

    for (const capability of required) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  async ensureTargetValues() {
    for (const channel of CHANNELS) {
      const targetCapability = this.targetCapability(channel.id);
      const alarmCapability = this.alarmCapability(channel.id);

      const target = this.getCapabilityValue(targetCapability);

      if (typeof target !== 'number' || !Number.isFinite(target)) {
        await this.setCapabilityValue(
          targetCapability,
          DEFAULT_TARGETS[channel.id],
        );
      }

      if (typeof this.getCapabilityValue(alarmCapability) !== 'boolean') {
        await this.setCapabilityValue(alarmCapability, false);
      }
    }
  }

  registerTargetListeners() {
    for (const channel of CHANNELS) {
      const targetCapability = this.targetCapability(channel.id);

      this.registerCapabilityListener(targetCapability, async value => {
        const target = Number(value);

        if (!Number.isFinite(target) || target < 0 || target > 250) {
          throw new Error('Doeltemperatuur moet tussen 0 en 250 °C liggen');
        }

        await this.setCapabilityValue(targetCapability, target);
        await this.updateTargetAlarm(channel.id);

        this.log(
          `Doeltemperatuur ${channel.label} ingesteld op ${target.toFixed(1)} °C`,
        );
      });
    }
  }

  async updateTargetAlarm(channelId) {
    const measureCapability = TOPICS[channelId];
    const targetCapability = this.targetCapability(channelId);
    const alarmCapability = this.alarmCapability(channelId);

    const current = this.getCapabilityValue(measureCapability);
    const target = this.getCapabilityValue(targetCapability);

    const reached = (
      typeof current === 'number'
      && Number.isFinite(current)
      && typeof target === 'number'
      && Number.isFinite(target)
      && current >= target
    );

    const previous = Boolean(this.getCapabilityValue(alarmCapability));

    if (previous !== reached) {
      await this.setCapabilityValue(alarmCapability, reached);

      if (reached) {
        this.log(
          `Doel bereikt ${channelId}: ${current.toFixed(1)} °C `
          + `(doel ${target.toFixed(1)} °C)`,
        );
      }
    }
  }

  async ensureSettings() {
    const current = this.getSettings();
    const missing = {};

    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (
        current[key] === undefined
        || current[key] === null
        || current[key] === ''
      ) {
        missing[key] = value;
      }
    }

    if (Object.keys(missing).length > 0) {
      await this.setSettings(missing);
    }
  }

  getMqttSettings() {
    const settings = {
      ...DEFAULTS,
      ...this.getSettings(),
    };

    return {
      host: String(settings.mqtt_host).trim(),
      port: Number(settings.mqtt_port),
      username: String(settings.mqtt_username),
      password: String(settings.mqtt_password),
      base: String(settings.mqtt_base_topic)
        .trim()
        .replace(/^\/+|\/+$/g, ''),
    };
  }

  connectMqtt() {
    this.disconnectMqtt();

    const settings = this.getMqttSettings();
    const brokerUrl = `mqtt://${settings.host}:${settings.port}`;

    this.log(`Verbinden met MQTT-broker ${brokerUrl}`);

    this.client = mqtt.connect(brokerUrl, {
      username: settings.username,
      password: settings.password,
      clientId: `homey-at02-${this.getData().id}`,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      keepalive: 30,
    });

    this.client.on('connect', () => {
      const topic = `${settings.base}/#`;

      this.log(`MQTT verbonden; abonneren op ${topic}`);

      this.client.subscribe(topic, { qos: 0 }, error => {
        if (error) {
          this.error('Abonneren op MQTT mislukt', error);
          return;
        }

        this.log(`Geabonneerd op ${topic}`);
      });
    });

    this.client.on('message', (topic, payload) => {
      this.handleMessage(topic, payload.toString())
        .catch(error => this.error(error));
    });

    this.client.on('reconnect', () => this.log('MQTT opnieuw verbinden...'));

    this.client.on('offline', () => {
      this.setUnavailable('MQTT-broker niet bereikbaar')
        .catch(error => this.error(error));
    });

    this.client.on('close', () => this.log('MQTT-verbinding gesloten'));
    this.client.on('error', error => this.error('MQTT-fout', error));
  }

  async handleMessage(topic, rawValue) {
    const settings = this.getMqttSettings();
    const prefix = `${settings.base}/`;

    if (!topic.startsWith(prefix)) {
      return;
    }

    const key = topic.slice(prefix.length);
    const value = rawValue.trim();

    this.log(`${topic} = ${value}`);

    if (TOPICS[key]) {
      await this.updateTemperature(TOPICS[key], value);
      await this.setAvailable();
      await this.updateTargetAlarm(key);
      return;
    }

    if (key === 'rssi') {
      const rssi = Number.parseInt(value, 10);

      if (Number.isFinite(rssi)) {
        await this.setCapabilityValue('measure_signal_strength', rssi);
        await this.setAvailable();

        let quality = 'zwak';
        if (rssi >= -55) quality = 'uitstekend';
        else if (rssi >= -67) quality = 'goed';
        else if (rssi >= -75) quality = 'redelijk';

        this.log(`Bluetooth RSSI: ${rssi} dBm (${quality})`);
      }

      return;
    }

    if (key === 'ble_status') {
      const connected = value.toLowerCase() === 'connected';

      await this.setCapabilityValue('alarm_generic', !connected);

      if (connected) {
        await this.setAvailable();
        await this.setWarning(null);
      } else {
        await this.setWarning(
          'ESP32 is bereikbaar, maar Bluetooth met de AT-02 is verbroken',
        );
      }

      return;
    }

    if (key === 'status') {
      const online = value.toLowerCase() === 'online';

      if (online) {
        await this.setAvailable();
      } else {
        await this.setCapabilityValue('alarm_generic', true);
        await this.setUnavailable('ESP32 AT-02-gateway is offline');
      }
    }
  }

  async updateTemperature(capability, value) {
    if (value.toLowerCase() === 'unavailable') {
      await this.setCapabilityValue(capability, null);
      return;
    }

    const temperature = Number.parseFloat(value.replace(',', '.'));

    if (!Number.isFinite(temperature)) {
      this.error(`Ongeldige temperatuur voor ${capability}: ${value}`);
      return;
    }

    await this.setCapabilityValue(capability, temperature);
  }

  disconnectMqtt() {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }
  }

  async onSettings({ changedKeys }) {
    const mqttSettings = [
      'mqtt_host',
      'mqtt_port',
      'mqtt_username',
      'mqtt_password',
      'mqtt_base_topic',
    ];

    if (changedKeys.some(key => mqttSettings.includes(key))) {
      this.homey.setTimeout(() => this.connectMqtt(), 500);

      return 'Instellingen opgeslagen; MQTT wordt opnieuw verbonden.';
    }

    return undefined;
  }

  async onDeleted() {
    this.disconnectMqtt();
  }

  async onUninit() {
    this.disconnectMqtt();
  }

}

module.exports = AT02Device;
