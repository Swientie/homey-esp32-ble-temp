'use strict';
const Homey = require('homey');
class AT02App extends Homey.App {
  async onInit() { this.log('AT-02 BBQ app v1.1.0 gestart'); }
}
module.exports = AT02App;
