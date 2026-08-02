'use strict';
const Homey = require('homey');
const mqtt = require('mqtt');

const TOPICS = {
  probe1:'measure_temperature.probe1',
  probe2:'measure_temperature.probe2',
  probe3:'measure_temperature.probe3',
  probe4:'measure_temperature.probe4',
  bbq:'measure_temperature.bbq',
};

const DEFAULTS = {
  mqtt_host:'172.16.1.12',
  mqtt_port:1883,
  mqtt_username:'AT02',
  mqtt_password:'AT02',
  mqtt_base_topic:'at02',
  offline_timeout:180,
};

class AT02Device extends Homey.Device {
  async onInit() {
    this.client = null;
    this.offlineTimer = null;
    this.lastMessageAt = 0;
    await this.ensureCapabilities();
    await this.ensureSettings();
    await this.setCapabilityValue('alarm_generic', true).catch(this.error);
    await this.setUnavailable('Wachten op MQTT-verbinding').catch(this.error);
    this.connectMqtt();
    this.log('AT-02 apparaat v1.1.0 gestart');
  }

  async ensureCapabilities() {
    for (const capability of [...Object.values(TOPICS), 'alarm_generic']) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
  }

  async ensureSettings() {
    const current = this.getSettings();
    const missing = {};
    for (const [key,value] of Object.entries(DEFAULTS)) {
      if (current[key] === undefined || current[key] === null || current[key] === '') missing[key] = value;
    }
    if (Object.keys(missing).length) await this.setSettings(missing);
  }

  settings() {
    const s = {...DEFAULTS, ...this.getSettings()};
    return {
      host:String(s.mqtt_host).trim(),
      port:Number(s.mqtt_port),
      username:String(s.mqtt_username),
      password:String(s.mqtt_password),
      base:String(s.mqtt_base_topic).trim().replace(/^\/+|\/+$/g,''),
      timeout:Math.max(30,Number(s.offline_timeout))*1000,
    };
  }

  connectMqtt() {
    this.disconnectMqtt();
    const s = this.settings();
    const url = `mqtt://${s.host}:${s.port}`;
    this.log(`Verbinden met MQTT-broker ${url}`);
    this.client = mqtt.connect(url,{
      username:s.username,password:s.password,
      clientId:`homey-at02-${this.getData().id}`,
      clean:true,reconnectPeriod:5000,connectTimeout:10000,keepalive:30,
    });

    this.client.on('connect',()=>{
      const topic=`${s.base}/#`;
      this.log(`MQTT verbonden; abonneren op ${topic}`);
      this.client.subscribe(topic,{qos:0},error=>{
        if (error) return this.error('Abonneren mislukt',error);
        this.setAvailable().catch(this.error);
        this.setWarning(null).catch(this.error);
        this.armOfflineTimer();
      });
    });

    this.client.on('message',(topic,payload)=>this.handleMessage(topic,payload.toString()).catch(this.error));
    this.client.on('reconnect',()=>this.log('MQTT opnieuw verbinden...'));
    this.client.on('offline',()=>this.setUnavailable('MQTT-broker niet bereikbaar').catch(this.error));
    this.client.on('error',error=>this.error('MQTT-fout',error));
  }

  armOfflineTimer() {
    if (this.offlineTimer) this.homey.clearTimeout(this.offlineTimer);
    const {timeout}=this.settings();
    this.offlineTimer=this.homey.setTimeout(()=>{
      if (!this.lastMessageAt || Date.now()-this.lastMessageAt>=timeout) {
        this.setUnavailable('Geen recente gegevens van de ESP32-gateway').catch(this.error);
        this.setCapabilityValue('alarm_generic',true).catch(this.error);
      }
    },timeout+1000);
  }

  async handleMessage(topic,raw) {
    const s=this.settings();
    const prefix=`${s.base}/`;
    if (!topic.startsWith(prefix)) return;
    this.lastMessageAt=Date.now();
    this.armOfflineTimer();
    if (typeof this.setLastSeenAt==='function') await this.setLastSeenAt().catch(()=>{});
    const key=topic.slice(prefix.length);
    const value=raw.trim();
    this.log(`${topic} = ${value}`);

    if (TOPICS[key]) {
      await this.updateTemperature(TOPICS[key],value);
      await this.setAvailable();
      return;
    }

    if (key==='ble_status') {
      const connected=value.toLowerCase()==='connected';
      await this.setCapabilityValue('alarm_generic',!connected);
      if (connected) {
        await this.setAvailable();
        await this.setWarning(null);
      } else {
        await this.setWarning('ESP32 bereikbaar, maar AT-02 Bluetooth is verbroken');
      }
      return;
    }

    if (key==='status') {
      const online=value.toLowerCase()==='online';
      if (online) await this.setAvailable();
      else {
        await this.setCapabilityValue('alarm_generic',true);
        await this.setUnavailable('ESP32 AT-02-gateway is offline');
      }
    }
  }

  async updateTemperature(capability,value) {
    if (value.toLowerCase()==='unavailable') {
      await this.setCapabilityValue(capability,null);
      return;
    }
    const temp=Number.parseFloat(value.replace(',','.'));
    if (!Number.isFinite(temp)) return this.error(`Ongeldige temperatuur: ${value}`);
    await this.setCapabilityValue(capability,temp);
  }

  disconnectMqtt() {
    if (this.offlineTimer) {
      this.homey.clearTimeout(this.offlineTimer);
      this.offlineTimer=null;
    }
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client=null;
    }
  }

  async onSettings({changedKeys}) {
    if (changedKeys.some(k=>Object.keys(DEFAULTS).includes(k))) {
      this.homey.setTimeout(()=>this.connectMqtt(),500);
      return 'Instellingen opgeslagen; MQTT wordt opnieuw verbonden.';
    }
  }

  async onDeleted() { this.disconnectMqtt(); }
  async onUninit() { this.disconnectMqtt(); }
}
module.exports = AT02Device;
