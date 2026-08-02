'use strict';

const Homey = require('homey');
const mqtt = require('mqtt');

const PROBES = [1, 2, 3, 4];
const TOPICS = {
  probe1: 'measure_temperature.probe1',
  probe2: 'measure_temperature.probe2',
  probe3: 'measure_temperature.probe3',
  probe4: 'measure_temperature.probe4',
  bbq: 'measure_temperature.bbq',
};
const DEFAULTS = {
  mqtt_host: '172.16.1.12',
  mqtt_port: 1883,
  mqtt_username: 'AT02',
  mqtt_password: 'AT02',
  mqtt_base_topic: 'at02',
};
const DEFAULT_TARGET = 75.0;

class AT02Device extends Homey.Device {

  async onInit() {
    this.client = null;
    await this.ensureCapabilities();
    await this.ensureSettings();
    await this.ensureTargets();
    this.registerTargetListeners();
    await this.setCapabilityValue('alarm_generic', true).catch(error => this.error(error));
    await this.setUnavailable('Wachten op MQTT-verbinding').catch(error => this.error(error));
    this.connectMqtt();
    this.log('AT-02 apparaat v1.2.1 gestart');
  }

  async ensureCapabilities() {
    const required = [...Object.values(TOPICS), 'alarm_generic'];
    for (const probe of PROBES) {
      required.push(`target_temperature.probe${probe}`);
      required.push(`alarm_temperature.probe${probe}`);
    }
    for (const capability of required) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
  }

  async ensureTargets() {
    for (const probe of PROBES) {
      const targetCap = `target_temperature.probe${probe}`;
      const alarmCap = `alarm_temperature.probe${probe}`;
      const target = this.getCapabilityValue(targetCap);
      if (typeof target !== 'number' || !Number.isFinite(target)) {
        await this.setCapabilityValue(targetCap, DEFAULT_TARGET);
      }
      if (typeof this.getCapabilityValue(alarmCap) !== 'boolean') {
        await this.setCapabilityValue(alarmCap, false);
      }
    }
  }

  registerTargetListeners() {
    for (const probe of PROBES) {
      const targetCap = `target_temperature.probe${probe}`;
      this.registerCapabilityListener(targetCap, async value => {
        const target = Number(value);
        if (!Number.isFinite(target)) throw new Error('Ongeldige doeltemperatuur');
        await this.setCapabilityValue(targetCap, target);
        await this.updateTargetAlarm(probe);
        this.log(`Doeltemperatuur probe ${probe}: ${target.toFixed(1)} °C`);
      });
    }
  }

  async updateTargetAlarm(probe) {
    const current = this.getCapabilityValue(`measure_temperature.probe${probe}`);
    const target = this.getCapabilityValue(`target_temperature.probe${probe}`);
    const alarmCap = `alarm_temperature.probe${probe}`;
    const reached = (
      typeof current === 'number' && Number.isFinite(current)
      && typeof target === 'number' && Number.isFinite(target)
      && current >= target
    );
    if (Boolean(this.getCapabilityValue(alarmCap)) !== reached) {
      await this.setCapabilityValue(alarmCap, reached);
      if (reached) {
        this.log(`Doel bereikt probe ${probe}: ${current.toFixed(1)} °C`);
      }
    }
  }

  async ensureSettings() {
    const current = this.getSettings();
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (current[key] === undefined || current[key] === null || current[key] === '') {
        missing[key] = value;
      }
    }
    if (Object.keys(missing).length) await this.setSettings(missing);
  }

  getMqttSettings() {
    const s = {...DEFAULTS, ...this.getSettings()};
    return {
      host:String(s.mqtt_host).trim(),
      port:Number(s.mqtt_port),
      username:String(s.mqtt_username),
      password:String(s.mqtt_password),
      base:String(s.mqtt_base_topic).trim().replace(/^\/+|\/+$/g,''),
    };
  }

  connectMqtt() {
    this.disconnectMqtt();
    const s = this.getMqttSettings();
    const url = `mqtt://${s.host}:${s.port}`;
    this.log(`Verbinden met MQTT-broker ${url}`);
    this.client = mqtt.connect(url, {
      username:s.username,
      password:s.password,
      clientId:`homey-at02-${this.getData().id}`,
      clean:true,
      reconnectPeriod:5000,
      connectTimeout:10000,
      keepalive:30,
    });

    this.client.on('connect', () => {
      const topic = `${s.base}/#`;
      this.log(`MQTT verbonden; abonneren op ${topic}`);
      this.client.subscribe(topic, {qos:0}, error => {
        if (error) return this.error('Abonneren op MQTT mislukt', error);
        this.log(`Geabonneerd op ${topic}`);
      });
    });

    this.client.on('message', (topic, payload) => {
      this.handleMessage(topic, payload.toString()).catch(error => this.error(error));
    });
    this.client.on('reconnect', () => this.log('MQTT opnieuw verbinden...'));
    this.client.on('offline', () => this.setUnavailable('MQTT-broker niet bereikbaar').catch(error => this.error(error)));
    this.client.on('close', () => this.log('MQTT-verbinding gesloten'));
    this.client.on('error', error => this.error('MQTT-fout', error));
  }

  async handleMessage(topic, rawValue) {
    const s = this.getMqttSettings();
    const prefix = `${s.base}/`;
    if (!topic.startsWith(prefix)) return;

    const key = topic.slice(prefix.length);
    const value = rawValue.trim();
    this.log(`${topic} = ${value}`);

    if (TOPICS[key]) {
      await this.updateTemperature(TOPICS[key], value);
      await this.setAvailable();
      const match = /^probe([1-4])$/.exec(key);
      if (match) await this.updateTargetAlarm(Number(match[1]));
      return;
    }

    if (key === 'ble_status') {
      const connected = value.toLowerCase() === 'connected';
      await this.setCapabilityValue('alarm_generic', !connected);
      if (connected) {
        await this.setAvailable();
        await this.setWarning(null);
      } else {
        await this.setWarning('ESP32 is bereikbaar, maar Bluetooth met de AT-02 is verbroken');
      }
      return;
    }

    if (key === 'status') {
      const online = value.toLowerCase() === 'online';
      if (online) await this.setAvailable();
      else {
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

  async onSettings({changedKeys}) {
    const mqttSettings = ['mqtt_host','mqtt_port','mqtt_username','mqtt_password','mqtt_base_topic'];
    if (changedKeys.some(key => mqttSettings.includes(key))) {
      this.homey.setTimeout(() => this.connectMqtt(), 500);
      return 'Instellingen opgeslagen; MQTT wordt opnieuw verbonden.';
    }
    return undefined;
  }

  async onDeleted() { this.disconnectMqtt(); }
  async onUninit() { this.disconnectMqtt(); }
}

module.exports = AT02Device;
