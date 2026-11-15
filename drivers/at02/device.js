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

const COOKING_PROFILES = Object.freeze({
  manual: { label: 'Handmatig', probeTarget: null, bbqTarget: null },
  steak_rare: { label: 'Steak rare', probeTarget: 50.0, bbqTarget: 220.0 },
  steak_medium_rare: { label: 'Steak medium rare', probeTarget: 54.0, bbqTarget: 220.0 },
  steak_medium: { label: 'Steak medium', probeTarget: 58.0, bbqTarget: 220.0 },
  chicken: { label: 'Kip', probeTarget: 75.0, bbqTarget: 180.0 },
  pulled_pork: { label: 'Pulled pork', probeTarget: 93.0, bbqTarget: 120.0 },
  brisket: { label: 'Brisket', probeTarget: 94.0, bbqTarget: 120.0 },
  ribs: { label: 'Spareribs', probeTarget: 90.0, bbqTarget: 120.0 },
  salmon: { label: 'Zalm', probeTarget: 52.0, bbqTarget: 180.0 },
  pizza: { label: 'Pizza', probeTarget: null, bbqTarget: 250.0 },
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
    this.sessionStartedAt = null;
    this.sessionTimer = null;
    this.sessionStartTemperature = null;
    this.notifiedTargets = new Set();
    this.probeHistory = new Map();
    this.lastEstimateNotificationAt = null;
    this.lastBbqTemperature = null;
    this.lastBbqTimestamp = null;
    this.bleConnected = false;
    this.gatewayOnline = false;

    await this.ensureCapabilities();
    await this.ensureSettings();
    await this.ensureProfileValues();
    await this.ensureSessionValues();
    await this.ensureAssistantValues();
    await this.ensureOverviewValues();
    await this.ensurePitmasterValues();
    await this.updateLiveOverview();
    await this.ensureTargetValues();
    this.registerTargetListeners();
    this.registerProfileListeners();
    this.registerSessionListener();
    await this.resumeSession();

    await this.setCapabilityValue('alarm_generic', true)
      .catch(error => this.error(error));

    await this.setCapabilityValue('bbq_status', 'connecting')
      .catch(error => this.error(error));

    await this.setUnavailable('Wachten op MQTT-verbinding')
      .catch(error => this.error(error));

    this.connectMqtt();
    this.log('AT-02 apparaat v2.0.0 gestart');
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
      'cooking_profile',
      'selected_profile',
      'active_probe',
      'session_active',
      'session_duration',
      'pitmaster_overview',
      'session_summary',
      'signal_quality',
      'remaining_difference',
      'live_summary',
      'target_summary',
      'progress_display',
      'rate_status',
      'remaining_time_text',
      'cooking_progress',
      'temperature_rate',
      'remaining_time',
      'bbq_status',
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

  async ensureProfileValues() {
    const profile = this.getCapabilityValue('cooking_profile');
    const activeProbe = this.getCapabilityValue('active_probe');

    if (!Object.prototype.hasOwnProperty.call(COOKING_PROFILES, profile)) {
      await this.setCapabilityValue('cooking_profile', 'manual');
      await this.setCapabilityValue('selected_profile', 'manual');
    }

    const selectedProfile = this.getCapabilityValue('selected_profile');

    if (!Object.prototype.hasOwnProperty.call(COOKING_PROFILES, selectedProfile)) {
      await this.setCapabilityValue(
        'selected_profile',
        Object.prototype.hasOwnProperty.call(COOKING_PROFILES, profile)
          ? profile
          : 'manual',
      );
    }

    if (!['probe1', 'probe2', 'probe3', 'probe4'].includes(activeProbe)) {
      await this.setCapabilityValue('active_probe', 'probe1');
    }
  }

  registerProfileListeners() {
    this.registerCapabilityListener('active_probe', async value => {
      if (!['probe1', 'probe2', 'probe3', 'probe4'].includes(value)) {
        throw new Error('Ongeldige probe');
      }

      await this.setCapabilityValue('active_probe', value);

      const currentProfile = this.getCapabilityValue('cooking_profile');

      if (currentProfile && currentProfile !== 'manual') {
        await this.applyCookingProfile(currentProfile);
      }

      await this.updateLiveOverview();
      this.log(`Actieve probe ingesteld op ${value}`);
    });

    this.registerCapabilityListener('cooking_profile', async value => {
      if (!Object.prototype.hasOwnProperty.call(COOKING_PROFILES, value)) {
        throw new Error('Onbekend bereidingsprofiel');
      }

      await this.setCapabilityValue('cooking_profile', value);
      await this.setCapabilityValue('selected_profile', value);
      await this.applyCookingProfile(value);
      await this.updateLiveOverview();

      if (value !== 'manual' && !this.getCapabilityValue('session_active')) {
        await this.startSession();
      }
    });
  }

  async ensureSessionValues() {
    const active = this.getCapabilityValue('session_active');
    const duration = this.getCapabilityValue('session_duration');

    if (typeof active !== 'boolean') {
      await this.setCapabilityValue('session_active', false);
    }

    if (typeof duration !== 'number' || !Number.isFinite(duration)) {
      await this.setCapabilityValue('session_duration', 0);
    }
  }

  async ensureAssistantValues() {
    const defaults = {
      cooking_progress: 0,
      temperature_rate: 0,
      remaining_time: 0,
    };

    for (const [capability, value] of Object.entries(defaults)) {
      const current = this.getCapabilityValue(capability);

      if (typeof current !== 'number' || !Number.isFinite(current)) {
        await this.setCapabilityValue(capability, value);
      }
    }
  }

  async ensurePitmasterValues() {
    const defaults = {
      pitmaster_overview: 'Geen actieve BBQ-sessie',
      session_summary: 'Sessie niet gestart',
      signal_quality: 'unknown',
      remaining_difference: 0,
    };

    for (const [capability, value] of Object.entries(defaults)) {
      const current = this.getCapabilityValue(capability);

      if (
        current === null
        || current === undefined
        || current === ''
      ) {
        await this.setCapabilityValue(capability, value);
      }
    }
  }

  getSignalQuality(rssi) {
    if (typeof rssi !== 'number' || !Number.isFinite(rssi)) {
      return 'unknown';
    }

    if (rssi >= -55) return 'excellent';
    if (rssi >= -67) return 'good';
    if (rssi >= -75) return 'fair';
    return 'weak';
  }

  async updatePitmasterOverview() {
    const activeProbe = this.getCapabilityValue('active_probe') || 'probe1';
    const probeLabel = activeProbe.replace('probe', 'Probe ');
    const probeCurrent = this.getCapabilityValue(TOPICS[activeProbe]);
    const probeTarget = this.getCapabilityValue(
      this.targetCapability(activeProbe),
    );
    const bbqCurrent = this.getCapabilityValue(TOPICS.bbq);
    const bbqTarget = this.getCapabilityValue(
      this.targetCapability('bbq'),
    );
    const profileId = this.getCapabilityValue('selected_profile') || 'manual';
    const profile = COOKING_PROFILES[profileId] || COOKING_PROFILES.manual;
    const status = this.getCapabilityValue('bbq_status') || 'connecting';
    const progress = this.getCapabilityValue('cooking_progress') || 0;
    const remainingMinutes = this.getCapabilityValue('remaining_time') || 0;
    const sessionMinutes = this.getCapabilityValue('session_duration') || 0;
    const sessionActive = Boolean(
      this.getCapabilityValue('session_active'),
    );

    const currentText = (
      typeof probeCurrent === 'number'
      && Number.isFinite(probeCurrent)
    ) ? probeCurrent.toFixed(1) : '--';

    const targetText = (
      typeof probeTarget === 'number'
      && Number.isFinite(probeTarget)
    ) ? probeTarget.toFixed(1) : '--';

    const bbqCurrentText = (
      typeof bbqCurrent === 'number'
      && Number.isFinite(bbqCurrent)
    ) ? bbqCurrent.toFixed(1) : '--';

    const bbqTargetText = (
      typeof bbqTarget === 'number'
      && Number.isFinite(bbqTarget)
    ) ? bbqTarget.toFixed(1) : '--';

    const remainingDegrees = (
      typeof probeCurrent === 'number'
      && Number.isFinite(probeCurrent)
      && typeof probeTarget === 'number'
      && Number.isFinite(probeTarget)
    ) ? Math.max(0, probeTarget - probeCurrent) : 0;

    await this.setCapabilityValue(
      'remaining_difference',
      Number(remainingDegrees.toFixed(1)),
    );

    const etaText = remainingMinutes > 0
      ? `nog ±${this.formatDuration(remainingMinutes)}`
      : 'tijd nog onbekend';

    const statusLabels = {
      offline: 'Offline',
      connecting: 'Verbinden',
      off: 'Uit',
      starting: 'Opstarten',
      warming: 'Opwarmen',
      almost_ready: 'Bijna klaar',
      ready: 'Gereed',
      grilling: 'Grillen',
      cooling: 'Afkoelen',
    };

    const statusText = statusLabels[status] || status;

    await this.setCapabilityValue(
      'pitmaster_overview',
      `${profile.label} • ${statusText} • ${probeLabel} ${currentText}/${targetText} °C`
      + ` • BBQ ${bbqCurrentText}/${bbqTargetText} °C • ${Math.round(progress)}% • ${etaText}`,
    );

    const sessionText = sessionActive
      ? `${profile.label} actief • ${this.formatDuration(sessionMinutes)}`
      : `${profile.label} • sessie gestopt op ${this.formatDuration(sessionMinutes)}`;

    await this.setCapabilityValue('session_summary', sessionText);
  }

  async ensureOverviewValues() {
    const defaults = {
      live_summary: 'Geen actieve meting',
      target_summary: 'Geen doelen ingesteld',
      progress_display: '░░░░░░░░░░ 0%',
      rate_status: 'unknown',
      remaining_time_text: 'Onbekend',
    };

    for (const [capability, value] of Object.entries(defaults)) {
      const current = this.getCapabilityValue(capability);

      if (
        current === null
        || current === undefined
        || current === ''
      ) {
        await this.setCapabilityValue(capability, value);
      }
    }
  }

  buildProgressBar(progress) {
    const normalized = Math.max(0, Math.min(100, Math.round(progress)));
    const filled = Math.round(normalized / 10);

    return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${normalized}%`;
  }

  async updateLiveOverview() {
    const activeProbe = this.getCapabilityValue('active_probe') || 'probe1';
    const probeNumber = activeProbe.replace('probe', '');
    const current = this.getCapabilityValue(TOPICS[activeProbe]);
    const probeTarget = this.getCapabilityValue(this.targetCapability(activeProbe));
    const bbqCurrent = this.getCapabilityValue(TOPICS.bbq);
    const bbqTarget = this.getCapabilityValue(this.targetCapability('bbq'));
    const profileId = this.getCapabilityValue('selected_profile') || 'manual';
    const profile = COOKING_PROFILES[profileId] || COOKING_PROFILES.manual;
    const progress = this.getCapabilityValue('cooking_progress') || 0;
    const rate = this.getCapabilityValue('temperature_rate') || 0;
    const remainingMinutes = this.getCapabilityValue('remaining_time') || 0;

    const probeCurrentText = (
      typeof current === 'number' && Number.isFinite(current)
    ) ? `${current.toFixed(1)} °C` : '--';

    const probeTargetText = (
      typeof probeTarget === 'number' && Number.isFinite(probeTarget)
    ) ? `${probeTarget.toFixed(1)} °C` : '--';

    const bbqCurrentText = (
      typeof bbqCurrent === 'number' && Number.isFinite(bbqCurrent)
    ) ? `${bbqCurrent.toFixed(1)} °C` : '--';

    const bbqTargetText = (
      typeof bbqTarget === 'number' && Number.isFinite(bbqTarget)
    ) ? `${bbqTarget.toFixed(1)} °C` : '--';

    await this.setCapabilityValue(
      'live_summary',
      `${profile.label} • Probe ${probeNumber}: ${probeCurrentText} / ${probeTargetText}`,
    );

    await this.setCapabilityValue(
      'target_summary',
      `BBQ ${bbqCurrentText} / ${bbqTargetText}`,
    );

    await this.setCapabilityValue(
      'progress_display',
      this.buildProgressBar(progress),
    );

    let rateStatus = 'stable';

    if (rate > 0.2) {
      rateStatus = 'rising';
    } else if (rate < -0.2) {
      rateStatus = 'falling';
    } else if (
      !this.getCapabilityValue('session_active')
      || this.probeHistory.size === 0
    ) {
      rateStatus = 'unknown';
    }

    await this.setCapabilityValue('rate_status', rateStatus);

    const remainingText = (
      remainingMinutes > 0
    ) ? `Nog ±${this.formatDuration(remainingMinutes)}` : 'Onbekend';

    await this.setCapabilityValue(
      'remaining_time_text',
      remainingText,
    );

    await this.updatePitmasterOverview();
  }

  formatDuration(minutes) {
    const value = Math.max(0, Math.round(minutes));

    if (value < 60) {
      return value === 1 ? '1 minuut' : `${value} minuten`;
    }

    const hours = Math.floor(value / 60);
    const remainingMinutes = value % 60;

    if (remainingMinutes === 0) {
      return hours === 1 ? '1 uur' : `${hours} uur`;
    }

    return `${hours} uur ${remainingMinutes} min`;
  }

  async resetAssistantValues() {
    this.probeHistory.clear();
    this.sessionStartTemperature = null;
    this.lastEstimateNotificationAt = null;

    await this.setCapabilityValue('cooking_progress', 0);
    await this.setCapabilityValue('temperature_rate', 0);
    await this.setCapabilityValue('remaining_time', 0);
    await this.setCapabilityValue('rate_status', 'unknown');
    await this.setCapabilityValue('remaining_time_text', 'Onbekend');
    await this.setCapabilityValue('progress_display', '░░░░░░░░░░ 0%');
  }

  async updateCookingAssistant(probeId) {
    const activeProbe = this.getCapabilityValue('active_probe') || 'probe1';

    if (probeId !== activeProbe) {
      return;
    }

    const current = this.getCapabilityValue(TOPICS[activeProbe]);
    const target = this.getCapabilityValue(this.targetCapability(activeProbe));

    if (
      typeof current !== 'number'
      || !Number.isFinite(current)
      || typeof target !== 'number'
      || !Number.isFinite(target)
      || target <= 0
    ) {
      return;
    }

    const now = Date.now();
    const history = this.probeHistory.get(activeProbe) || [];
    history.push({ timestamp: now, temperature: current });

    const recentHistory = history
      .filter(item => now - item.timestamp <= 15 * 60 * 1000)
      .slice(-30);

    this.probeHistory.set(activeProbe, recentHistory);

    if (
      typeof this.sessionStartTemperature !== 'number'
      || !Number.isFinite(this.sessionStartTemperature)
    ) {
      this.sessionStartTemperature = current;
    }

    const sessionStartTemperature = this.sessionStartTemperature;

    const denominator = target - sessionStartTemperature;
    const progress = denominator > 0
      ? Math.max(
        0,
        Math.min(
          100,
          ((current - sessionStartTemperature) / denominator) * 100,
        ),
      )
      : current >= target ? 100 : 0;

    await this.setCapabilityValue(
      'cooking_progress',
      Math.round(progress),
    );

    let ratePerMinute = 0;

    if (recentHistory.length >= 2) {
      const first = recentHistory[0];
      const last = recentHistory[recentHistory.length - 1];
      const elapsedMinutes = (last.timestamp - first.timestamp) / 60000;

      if (elapsedMinutes >= 1) {
        ratePerMinute = (
          last.temperature - first.temperature
        ) / elapsedMinutes;
      }
    }

    await this.setCapabilityValue(
      'temperature_rate',
      Number(ratePerMinute.toFixed(1)),
    );

    let remainingMinutes = 0;

    if (current < target && ratePerMinute > 0.1) {
      remainingMinutes = Math.min(
        1440,
        Math.max(1, Math.round((target - current) / ratePerMinute)),
      );
    }

    await this.setCapabilityValue(
      'remaining_time',
      remainingMinutes,
    );

    await this.updateLiveOverview();

    if (
      this.getCapabilityValue('session_active')
      && remainingMinutes > 0
      && remainingMinutes <= 30
      && (
        this.lastEstimateNotificationAt === null
        || now - this.lastEstimateNotificationAt >= 15 * 60 * 1000
      )
    ) {
      const profileId = this.getCapabilityValue('selected_profile') || 'manual';
      const profile = COOKING_PROFILES[profileId] || COOKING_PROFILES.manual;

      await this.createTimelineNotification(
        `⏳ **${profile.label}** is naar schatting over **${this.formatDuration(remainingMinutes)}** klaar. `
        + `${activeProbe.replace('probe', 'Probe ')} is nu **${current.toFixed(1)} °C**.`,
      );

      this.lastEstimateNotificationAt = now;
    }
  }

  registerSessionListener() {
    this.registerCapabilityListener('session_active', async value => {
      if (value) {
        await this.startSession();
      } else {
        await this.stopSession();
      }
    });
  }

  async startSession() {
    this.sessionStartedAt = Date.now();
    this.notifiedTargets.clear();
    await this.resetAssistantValues();
    await this.setStoreValue('sessionStartedAt', this.sessionStartedAt);

    await this.setCapabilityValue('session_active', true);
    await this.setCapabilityValue('session_duration', 0);

    this.startSessionTimer();

    const profileId = this.getCapabilityValue('selected_profile') || 'manual';
    const profile = COOKING_PROFILES[profileId] || COOKING_PROFILES.manual;
    const activeProbe = this.getCapabilityValue('active_probe') || 'probe1';

    await this.createTimelineNotification(
      `🔥 BBQ-sessie gestart: **${profile.label}** met **${activeProbe.replace('probe', 'Probe ')}**.`,
    );

    await this.updatePitmasterOverview();
    this.log('BBQ-sessie gestart');
  }

  async stopSession() {
    this.stopSessionTimer();
    await this.updateSessionDuration();

    this.sessionStartedAt = null;
    this.sessionStartTemperature = null;
    this.notifiedTargets = new Set();
    this.probeHistory = new Map();
    this.lastEstimateNotificationAt = null;
    await this.unsetStoreValue('sessionStartedAt').catch(error => this.error(error));

    const duration = this.getCapabilityValue('session_duration') || 0;
    const profileId = this.getCapabilityValue('selected_profile') || 'manual';
    const profile = COOKING_PROFILES[profileId] || COOKING_PROFILES.manual;

    await this.setCapabilityValue('session_active', false);

    await this.createTimelineNotification(
      `⏱ BBQ-sessie **${profile.label}** gestopt na **${duration} minuten**.`,
    );

    await this.updatePitmasterOverview();
    this.log('BBQ-sessie gestopt');
  }

  startSessionTimer() {
    this.stopSessionTimer();

    this.sessionTimer = this.homey.setInterval(() => {
      this.updateSessionDuration()
        .then(() => this.updatePitmasterOverview())
        .catch(error => this.error(error));
    }, 60000);
  }

  stopSessionTimer() {
    if (this.sessionTimer) {
      this.homey.clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  // Na een herstart van de app (bijv. update of Homey-reboot) loopt een
  // actieve sessie gewoon door in plaats van te bevriezen.
  async resumeSession() {
    if (!this.getCapabilityValue('session_active')) {
      return;
    }

    let startedAt = this.getStoreValue('sessionStartedAt');

    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
      const minutes = this.getCapabilityValue('session_duration') || 0;
      startedAt = Date.now() - minutes * 60000;
      await this.setStoreValue('sessionStartedAt', startedAt);
    }

    this.sessionStartedAt = startedAt;
    this.startSessionTimer();
    await this.updateSessionDuration();
    this.log('Actieve BBQ-sessie hervat na herstart');
  }

  async updateSessionDuration() {
    if (typeof this.sessionStartedAt !== 'number') {
      return;
    }

    const minutes = Math.max(
      0,
      Math.floor((Date.now() - this.sessionStartedAt) / 60000),
    );

    await this.setCapabilityValue('session_duration', minutes);
  }

  async createTimelineNotification(message) {
    try {
      await this.homey.notifications.createNotification({
        excerpt: message,
      });
    } catch (error) {
      this.error('Homey-melding kon niet worden gemaakt', error);
    }
  }

  async notifyTargetReached(channelId, current, target) {
    if (!this.getCapabilityValue('session_active')) {
      return;
    }

    if (this.notifiedTargets.has(channelId)) {
      return;
    }

    this.notifiedTargets.add(channelId);

    const profileId = this.getCapabilityValue('selected_profile') || 'manual';
    const profile = COOKING_PROFILES[profileId] || COOKING_PROFILES.manual;

    const channelLabel = channelId === 'bbq'
      ? 'BBQ'
      : channelId.replace('probe', 'Probe ');

    const icon = channelId === 'bbq' ? '🔥' : '🥩';

    const message = channelId === 'bbq'
      ? `${icon} **BBQ op temperatuur voor ${profile.label}**: ${current.toFixed(1)} °C `
        + `(doel ${target.toFixed(1)} °C).`
      : `${icon} **${profile.label} is klaar**. ${channelLabel} is ${current.toFixed(1)} °C `
        + `(doel ${target.toFixed(1)} °C).`;

    await this.createTimelineNotification(message);
  }

  async applyCookingProfile(profileId) {
    const profile = COOKING_PROFILES[profileId];

    if (!profile) {
      throw new Error('Onbekend bereidingsprofiel');
    }

    if (profileId === 'manual') {
      this.log('Bereidingsprofiel ingesteld op Handmatig');
      return;
    }

    const activeProbe = this.getCapabilityValue('active_probe') || 'probe1';

    if (
      typeof profile.probeTarget === 'number'
      && Number.isFinite(profile.probeTarget)
    ) {
      await this.setCapabilityValue(
        this.targetCapability(activeProbe),
        profile.probeTarget,
      );
      await this.updateTargetAlarm(activeProbe);
    }

    if (
      typeof profile.bbqTarget === 'number'
      && Number.isFinite(profile.bbqTarget)
    ) {
      await this.setCapabilityValue(
        this.targetCapability('bbq'),
        profile.bbqTarget,
      );
      await this.updateTargetAlarm('bbq');
    }

    await this.updateSmartStatus();

    const probeText = profile.probeTarget === null
      ? 'geen kerndoel'
      : `${profile.probeTarget.toFixed(1)} °C op ${activeProbe}`;

    const bbqText = profile.bbqTarget === null
      ? 'geen BBQ-doel'
      : `${profile.bbqTarget.toFixed(1)} °C BBQ`;

    this.log(
      `Profiel ${profile.label} toegepast: ${probeText}, ${bbqText}`,
    );
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
        await this.updateSmartStatus();
        await this.updateLiveOverview();

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

        await this.notifyTargetReached(channelId, current, target);
      }
    }
  }

  getConnectedProbeIds() {
    return ['probe1', 'probe2', 'probe3', 'probe4'].filter(probeId => {
      const value = this.getCapabilityValue(TOPICS[probeId]);
      return typeof value === 'number' && Number.isFinite(value);
    });
  }

  async updateSmartStatus() {
    let nextStatus = 'connecting';

    if (!this.gatewayOnline || !this.bleConnected) {
      nextStatus = 'offline';
    } else {
      const bbqTemperature = this.getCapabilityValue(TOPICS.bbq);
      const bbqTarget = this.getCapabilityValue(this.targetCapability('bbq'));
      const connectedProbes = this.getConnectedProbeIds();

      const probeStates = connectedProbes.map(probeId => {
        const current = this.getCapabilityValue(TOPICS[probeId]);
        const target = this.getCapabilityValue(this.targetCapability(probeId));

        return {
          current,
          target,
          remaining: (
            typeof current === 'number'
            && Number.isFinite(current)
            && typeof target === 'number'
            && Number.isFinite(target)
          ) ? target - current : null,
          reached: Boolean(
            this.getCapabilityValue(this.alarmCapability(probeId)),
          ),
        };
      });

      const allConnectedProbesReady = (
        probeStates.length > 0
        && probeStates.every(state => state.reached)
      );

      const anyProbeAlmostReady = probeStates.some(state => (
        typeof state.remaining === 'number'
        && state.remaining > 0
        && state.remaining <= 5
      ));

      const bbqReady = Boolean(
        this.getCapabilityValue(this.alarmCapability('bbq')),
      );

      if (
        typeof bbqTemperature !== 'number'
        || !Number.isFinite(bbqTemperature)
      ) {
        nextStatus = 'connecting';
      } else if (bbqTemperature < 40) {
        nextStatus = 'off';
      } else if (allConnectedProbesReady) {
        nextStatus = 'ready';
      } else if (anyProbeAlmostReady) {
        nextStatus = 'almost_ready';
      } else if (
        typeof bbqTarget === 'number'
        && Number.isFinite(bbqTarget)
      ) {
        const now = Date.now();
        let ratePerMinute = null;

        if (
          typeof this.lastBbqTemperature === 'number'
          && Number.isFinite(this.lastBbqTemperature)
          && typeof this.lastBbqTimestamp === 'number'
        ) {
          const elapsedMinutes = Math.max(
            (now - this.lastBbqTimestamp) / 60000,
            0.01,
          );

          ratePerMinute = (
            bbqTemperature - this.lastBbqTemperature
          ) / elapsedMinutes;
        }

        if (
          typeof ratePerMinute === 'number'
          && ratePerMinute < -0.5
          && bbqTemperature < bbqTarget - 5
        ) {
          nextStatus = 'cooling';
        } else if (bbqTemperature < 80) {
          nextStatus = 'starting';
        } else if (bbqTemperature < bbqTarget - 10) {
          nextStatus = 'warming';
        } else if (bbqTemperature < bbqTarget) {
          nextStatus = 'almost_ready';
        } else if (bbqReady) {
          nextStatus = connectedProbes.length > 0
            ? 'grilling'
            : 'ready';
        } else {
          nextStatus = 'grilling';
        }

        this.lastBbqTemperature = bbqTemperature;
        this.lastBbqTimestamp = now;
      } else {
        nextStatus = bbqTemperature < 80
          ? 'starting'
          : 'grilling';
      }
    }

    const previousStatus = this.getCapabilityValue('bbq_status');

    if (previousStatus !== nextStatus) {
      await this.setCapabilityValue('bbq_status', nextStatus);
      await this.updatePitmasterOverview();
      this.log(`Slimme BBQ-status: ${nextStatus}`);
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

    this.client.on('reconnect', () => {
      this.log('MQTT opnieuw verbinden...');
      this.setCapabilityValue('bbq_status', 'connecting')
        .catch(error => this.error(error));
    });

    this.client.on('offline', () => {
      this.gatewayOnline = false;

      this.setUnavailable('MQTT-broker niet bereikbaar')
        .catch(error => this.error(error));

      this.updateSmartStatus().catch(error => this.error(error));
    });

    this.client.on('close', () => {
      this.log('MQTT-verbinding gesloten');
    });

    this.client.on('error', error => {
      this.error('MQTT-fout', error);
    });
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
      await this.updateCookingAssistant(key);
      await this.updateLiveOverview();
      await this.updateSmartStatus();
      return;
    }

    if (key === 'rssi') {
      const rssi = Number.parseInt(value, 10);

      if (Number.isFinite(rssi)) {
        await this.setCapabilityValue('measure_signal_strength', rssi);
        await this.setCapabilityValue(
          'signal_quality',
          this.getSignalQuality(rssi),
        );
        await this.setAvailable();
      }

      return;
    }

    if (key === 'ble_status') {
      this.bleConnected = value.toLowerCase() === 'connected';

      await this.setCapabilityValue(
        'alarm_generic',
        !this.bleConnected,
      );

      if (this.bleConnected) {
        await this.setAvailable();
        await this.setWarning(null);
      } else {
        await this.setWarning(
          'ESP32 is bereikbaar, maar Bluetooth met de AT-02 is verbroken',
        );
      }

      await this.updateSmartStatus();
      return;
    }

    if (key === 'status') {
      this.gatewayOnline = value.toLowerCase() === 'online';

      if (this.gatewayOnline) {
        await this.setAvailable();
      } else {
        await this.setCapabilityValue('alarm_generic', true);
        await this.setUnavailable('ESP32 AT-02-gateway is offline');
      }

      await this.updateSmartStatus();
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
    this.stopSessionTimer();
    this.disconnectMqtt();
  }

  async onUninit() {
    this.stopSessionTimer();
    this.disconnectMqtt();
  }

}

module.exports = AT02Device;
