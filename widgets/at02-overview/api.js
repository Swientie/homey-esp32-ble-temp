'use strict';

module.exports = {
  async getStatus({ homey, query }) {
    const driver = homey.drivers.getDriver('at02');
    const devices = driver.getDevices();

    let device = null;

    if (query.deviceId) {
      device = devices.find(item => item.getId() === query.deviceId);
    }

    if (!device) {
      [device] = devices;
    }

    if (!device) {
      return {
        found: false,
        available: false,
        name: 'AT-02 BBQ',
        probes: [null, null, null, null],
        bbq: null,
        connectionLost: true,
        updatedAt: Date.now(),
      };
    }

    const read = capability => {
      if (!device.hasCapability(capability)) return null;
      const value = device.getCapabilityValue(capability);
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };

    return {
      found: true,
      available: device.getAvailable(),
      name: device.getName(),
      probes: [
        read('measure_temperature.probe1'),
        read('measure_temperature.probe2'),
        read('measure_temperature.probe3'),
        read('measure_temperature.probe4'),
      ],
      bbq: read('measure_temperature.bbq'),
      connectionLost: Boolean(device.getCapabilityValue('alarm_generic')),
      updatedAt: Date.now(),
    };
  },
};
