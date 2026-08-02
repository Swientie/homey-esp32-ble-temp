'use strict';
const Homey = require('homey');
class AT02Driver extends Homey.Driver {
  async onInit() { this.log('AT-02 driver v1.1.0 gestart'); }
  async onPair(session) {
    session.setHandler('list_devices', async () => [{
      name:'AT-02 BBQ',
      data:{id:'at02-bbq-gateway'},
      settings:{mqtt_host:'172.16.1.12',mqtt_port:1883,mqtt_username:'AT02',mqtt_password:'AT02',mqtt_base_topic:'at02',offline_timeout:180}
    }]);
  }
}
module.exports = AT02Driver;
