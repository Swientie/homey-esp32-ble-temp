/*
  AT-02 Gateway v1.1 RSSI
  ESP32 Dev Module

  Functies:
  - Bluetooth LE koppeling met AT-02 / ToGrill
  - Probe 1 t/m 4 + BBQ/interne temperatuur
  - WiFi
  - MQTT
  - Webdashboard
  - JSON API
  - OTA-update via Arduino IDE

  Benodigde libraries:
  - NimBLE-Arduino
  - PubSubClient

  Ingebouwd in ESP32 core:
  - WiFi
  - WebServer
  - ArduinoOTA
*/

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>
#include <NimBLEDevice.h>

// ======================================================
// AANPASSEN
// ======================================================

static const char* WIFI_SSID = "IoT Netwerk";
static const char* WIFI_PASSWORD = "psjk7yqDbvsg";

// MQTT
static const char* MQTT_HOST = "172.16.1.12";
static const uint16_t MQTT_PORT = 1883;
static const char* MQTT_USER = "AT02";
static const char* MQTT_PASSWORD = "AT02";

// ======================================================
// VASTE INSTELLINGEN
// ======================================================

static const char* HOSTNAME = "at02-gateway";
static const char* MQTT_CLIENT_ID = "ESP32-AT02-Gateway";
static const char* MQTT_BASE = "at02";
static const char* TARGET_NAME = "AT-02";

static const uint32_t SCAN_TIME_MS = 15000;
static const uint32_t BLE_RECONNECT_DELAY_MS = 3000;
static const uint32_t WIFI_RETRY_MS = 10000;
static const uint32_t MQTT_RETRY_MS = 5000;

// ======================================================
// GLOBALE OBJECTEN
// ======================================================

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
WebServer webServer(80);

static const NimBLEAdvertisedDevice* targetDevice = nullptr;
static NimBLEClient* bleClient = nullptr;

static bool bleConnectRequested = false;
static bool bleScanning = false;
static uint32_t nextBleScanAt = 0;
static uint32_t nextWifiRetryAt = 0;
static uint32_t nextMqttRetryAt = 0;

static bool probeConnected[4] = {false, false, false, false};
static float probeTemperature[4] = {NAN, NAN, NAN, NAN};

static bool bbqConnected = false;
static float bbqTemperature = NAN;

static int bleRssi = 0;
static bool bleOnline = false;

static const uint8_t HANDSHAKE_1[] = {
  0x55, 0xAA, 0x00, 0x03, 0xA0, 0x00, 0x00, 0x5C
};

static const uint8_t HANDSHAKE_2[] = {
  0x55, 0xAA, 0x00, 0x02, 0xA1, 0x00, 0x5C
};

// ======================================================
// HULPFUNCTIES
// ======================================================

String temperatureText(bool connected, float value) {
  if (!connected || isnan(value)) {
    return "--";
  }

  return String(value, 1) + " °C";
}

String jsonTemperature(bool connected, float value) {
  if (!connected || isnan(value)) {
    return "null";
  }

  return String(value, 1);
}

void mqttPublish(const String& topic, const String& payload, bool retained = true) {
  if (!mqttClient.connected()) {
    return;
  }

  mqttClient.publish(topic.c_str(), payload.c_str(), retained);

  Serial.print("MQTT ");
  Serial.print(topic);
  Serial.print(" = ");
  Serial.println(payload);
}

void publishAllValues() {
  mqttPublish(String(MQTT_BASE) + "/status", "online");
  mqttPublish(String(MQTT_BASE) + "/ble_status", bleOnline ? "connected" : "disconnected");
  mqttPublish(String(MQTT_BASE) + "/rssi", String(bleRssi));

  for (uint8_t i = 0; i < 4; i++) {
    const String topic = String(MQTT_BASE) + "/probe" + String(i + 1);

    if (probeConnected[i] && !isnan(probeTemperature[i])) {
      mqttPublish(topic, String(probeTemperature[i], 1));
    } else {
      mqttPublish(topic, "unavailable");
    }
  }

  if (bbqConnected && !isnan(bbqTemperature)) {
    mqttPublish(String(MQTT_BASE) + "/bbq", String(bbqTemperature, 1));
  } else {
    mqttPublish(String(MQTT_BASE) + "/bbq", "unavailable");
  }
}

void showValuesOnSerial() {
  Serial.println();
  Serial.println("============================");

  for (uint8_t i = 0; i < 4; i++) {
    Serial.print("Probe ");
    Serial.print(i + 1);
    Serial.print(": ");
    Serial.println(temperatureText(probeConnected[i], probeTemperature[i]));
  }

  Serial.print("BBQ    : ");
  Serial.println(temperatureText(bbqConnected, bbqTemperature));

  Serial.print("BLE    : ");
  Serial.println(bleOnline ? "verbonden" : "niet verbonden");

  Serial.print("RSSI   : ");
  Serial.println(bleRssi);

  Serial.println("============================");
}

// ======================================================
// WEBINTERFACE
// ======================================================

String buildDashboardHtml() {
  String html;

  html.reserve(5000);

  html += F(
    "<!doctype html><html lang='nl'><head>"
    "<meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1'>"
    "<meta http-equiv='refresh' content='5'>"
    "<title>AT-02 Gateway</title>"
    "<style>"
    "body{font-family:Arial,sans-serif;background:#111;color:#eee;margin:0;padding:20px}"
    ".wrap{max-width:800px;margin:auto}"
    "h1{margin-bottom:8px}"
    ".status{color:#aaa;margin-bottom:20px}"
    ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}"
    ".card{background:#1e1e1e;border-radius:14px;padding:18px;box-shadow:0 2px 12px #0008}"
    ".label{font-size:15px;color:#aaa}"
    ".value{font-size:34px;font-weight:bold;margin-top:8px}"
    ".ok{color:#62d26f}.bad{color:#ff6b6b}"
    ".small{font-size:14px;color:#aaa;margin-top:24px;line-height:1.6}"
    "a{color:#65a9ff}"
    "</style></head><body><div class='wrap'>"
  );

  html += "<h1>AT-02 BBQ Gateway</h1>";

  html += "<div class='status'>";
  html += "WiFi: ";
  html += (WiFi.status() == WL_CONNECTED ? "verbonden" : "niet verbonden");
  html += " | IP: ";
  html += WiFi.localIP().toString();
  html += " | MQTT: ";
  html += (mqttClient.connected() ? "verbonden" : "niet verbonden");
  html += " | BLE: ";
  html += (bleOnline ? "verbonden" : "niet verbonden");
  html += "</div>";

  html += "<div class='grid'>";

  for (uint8_t i = 0; i < 4; i++) {
    html += "<div class='card'>";
    html += "<div class='label'>Probe ";
    html += String(i + 1);
    html += "</div><div class='value'>";
    html += temperatureText(probeConnected[i], probeTemperature[i]);
    html += "</div></div>";
  }

  html += "<div class='card'>";
  html += "<div class='label'>BBQ / omgeving</div>";
  html += "<div class='value'>";
  html += temperatureText(bbqConnected, bbqTemperature);
  html += "</div></div>";

  html += "<div class='card'>";
  html += "<div class='label'>Bluetooth RSSI</div>";
  html += "<div class='value'>";
  html += String(bleRssi);
  html += " dBm</div></div>";

  html += "</div>";

  html += "<div class='small'>";
  html += "JSON API: <a href='/api/status'>/api/status</a><br>";
  html += "Hostname: ";
  html += HOSTNAME;
  html += "<br>Firmware: AT-02 Gateway v1.1 RSSI";
  html += "</div>";

  html += "</div></body></html>";

  return html;
}

void handleRoot() {
  webServer.send(200, "text/html; charset=utf-8", buildDashboardHtml());
}

void handleApiStatus() {
  String json = "{";

  json += "\"wifi_connected\":";
  json += (WiFi.status() == WL_CONNECTED ? "true" : "false");

  json += ",\"ip\":\"";
  json += WiFi.localIP().toString();
  json += "\"";

  json += ",\"mqtt_connected\":";
  json += (mqttClient.connected() ? "true" : "false");

  json += ",\"ble_connected\":";
  json += (bleOnline ? "true" : "false");

  json += ",\"ble_rssi\":";
  json += String(bleRssi);

  for (uint8_t i = 0; i < 4; i++) {
    json += ",\"probe";
    json += String(i + 1);
    json += "\":";
    json += jsonTemperature(probeConnected[i], probeTemperature[i]);
  }

  json += ",\"bbq\":";
  json += jsonTemperature(bbqConnected, bbqTemperature);

  json += "}";

  webServer.send(200, "application/json", json);
}

void setupWebServer() {
  webServer.on("/", HTTP_GET, handleRoot);
  webServer.on("/api/status", HTTP_GET, handleApiStatus);

  webServer.onNotFound([]() {
    webServer.send(404, "text/plain", "Niet gevonden");
  });

  webServer.begin();

  Serial.println("Webserver gestart op poort 80.");
}

// ======================================================
// WIFI / MQTT / OTA
// ======================================================

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  Serial.print("Verbinden met WiFi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const uint32_t startedAt = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startedAt < 20000
  ) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi verbonden. IP-adres: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi-verbinding mislukt.");
  }
}

void connectMqtt() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) {
    return;
  }

  Serial.print("Verbinden met MQTT... ");

  const bool connected = mqttClient.connect(
    MQTT_CLIENT_ID,
    MQTT_USER,
    MQTT_PASSWORD,
    (String(MQTT_BASE) + "/status").c_str(),
    0,
    true,
    "offline"
  );

  if (connected) {
    Serial.println("gelukt");
    publishAllValues();
  } else {
    Serial.print("mislukt, code ");
    Serial.println(mqttClient.state());
  }
}

void setupOta() {
  ArduinoOTA.setHostname(HOSTNAME);

  ArduinoOTA.onStart([]() {
    Serial.println("OTA-update gestart.");
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("\nOTA-update voltooid.");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("OTA: %u%%\r", (progress * 100U) / total);
  });

  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("OTA-fout %u\n", error);
  });

  ArduinoOTA.begin();

  Serial.println("OTA actief.");
}

// ======================================================
// AT-02 PAKKET DECODER
// ======================================================

void decodeTemperaturePacket(const uint8_t* data, size_t length) {
  if (length != 20) {
    return;
  }

  if (
    data[0] != 0x55 ||
    data[1] != 0xAA ||
    data[4] != 0xA1
  ) {
    return;
  }

  bool changed = false;

  for (uint8_t i = 0; i < 4; i++) {
    const size_t index = 5 + (i * 2);
    const uint8_t highByte = data[index];
    const uint8_t lowByte = data[index + 1];

    const bool connected =
      !(highByte == 0xFF && lowByte == 0xFF);

    const float newTemperature = connected
      ? static_cast<float>(
          (static_cast<uint16_t>(highByte) << 8) | lowByte
        ) / 10.0f
      : NAN;

    if (
      connected != probeConnected[i] ||
      (
        connected &&
        (
          isnan(probeTemperature[i]) ||
          fabs(newTemperature - probeTemperature[i]) >= 0.05f
        )
      )
    ) {
      changed = true;
    }

    probeConnected[i] = connected;
    probeTemperature[i] = newTemperature;
  }

  const uint8_t bbqHigh = data[17];
  const uint8_t bbqLow = data[18];

  const bool newBbqConnected =
    !(bbqHigh == 0xFF && bbqLow == 0xFF);

  const float newBbqTemperature = newBbqConnected
    ? static_cast<float>(
        (static_cast<uint16_t>(bbqHigh) << 8) | bbqLow
      ) / 10.0f
    : NAN;

  if (
    newBbqConnected != bbqConnected ||
    (
      newBbqConnected &&
      (
        isnan(bbqTemperature) ||
        fabs(newBbqTemperature - bbqTemperature) >= 0.05f
      )
    )
  ) {
    changed = true;
  }

  bbqConnected = newBbqConnected;
  bbqTemperature = newBbqTemperature;

  if (changed) {
    showValuesOnSerial();
    publishAllValues();
  }
}

void notificationCallback(
  NimBLERemoteCharacteristic* characteristic,
  uint8_t* data,
  size_t length,
  bool isNotify
) {
  decodeTemperaturePacket(data, length);
}

// ======================================================
// BLE
// ======================================================

class ClientCallbacks : public NimBLEClientCallbacks {
  void onConnect(NimBLEClient* connectedClient) override {
    bleOnline = true;
    bleRssi = connectedClient->getRssi();

    Serial.println("BLE-verbinding tot stand gebracht.");

    publishAllValues();
  }

  void onDisconnect(
    NimBLEClient* disconnectedClient,
    int reason
  ) override {
    Serial.print("BLE-verbinding verbroken. Reden: ");
    Serial.println(reason);

    bleOnline = false;
    bleRssi = 0;

    publishAllValues();

    bleClient = disconnectedClient;
    targetDevice = nullptr;
    bleConnectRequested = false;
    nextBleScanAt = millis() + BLE_RECONNECT_DELAY_MS;
  }
};

ClientCallbacks clientCallbacks;

class ScanCallbacks : public NimBLEScanCallbacks {
  void onResult(
    const NimBLEAdvertisedDevice* advertisedDevice
  ) override {
    if (!advertisedDevice->haveName()) {
      return;
    }

    if (advertisedDevice->getName() != TARGET_NAME) {
      return;
    }

    Serial.println("AT-02 gevonden.");

    Serial.print("MAC: ");
    Serial.println(
      advertisedDevice->getAddress().toString().c_str()
    );

    Serial.print("RSSI: ");
    Serial.println(advertisedDevice->getRSSI());

    targetDevice = advertisedDevice;
    bleConnectRequested = true;

    NimBLEDevice::getScan()->stop();
  }

  void onScanEnd(
    const NimBLEScanResults& results,
    int reason
  ) override {
    bleScanning = false;

    if (!bleConnectRequested) {
      Serial.println("AT-02 niet gevonden; nieuwe poging volgt.");
      nextBleScanAt = millis() + BLE_RECONNECT_DELAY_MS;
    }
  }
};

ScanCallbacks scanCallbacks;

void startBleScan() {
  if (bleScanning) {
    return;
  }

  Serial.println("Zoeken naar AT-02...");

  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->clearResults();

  bleScanning = true;

  if (!scan->start(SCAN_TIME_MS, false, true)) {
    bleScanning = false;
    Serial.println("BLE-scan kon niet worden gestart.");
    nextBleScanAt = millis() + BLE_RECONNECT_DELAY_MS;
  }
}

NimBLERemoteCharacteristic* discoverAndSubscribe(
  NimBLEClient* connectedClient
) {
  NimBLERemoteCharacteristic* writeCharacteristic = nullptr;

  const auto& services = connectedClient->getServices(true);

  for (NimBLERemoteService* service : services) {
    const auto& characteristics =
      service->getCharacteristics(true);

    for (
      NimBLERemoteCharacteristic* characteristic
      : characteristics
    ) {
      if (
        characteristic->canWrite() ||
        characteristic->canWriteNoResponse()
      ) {
        writeCharacteristic = characteristic;
      }

      if (characteristic->canNotify()) {
        characteristic->subscribe(
          true,
          notificationCallback
        );
      } else if (characteristic->canIndicate()) {
        characteristic->subscribe(
          false,
          notificationCallback
        );
      }
    }
  }

  return writeCharacteristic;
}

bool sendHandshake(
  NimBLERemoteCharacteristic* writeCharacteristic
) {
  if (writeCharacteristic == nullptr) {
    Serial.println("Geen schrijfcharacteristic gevonden.");
    return false;
  }

  const bool firstSent = writeCharacteristic->writeValue(
    HANDSHAKE_1,
    sizeof(HANDSHAKE_1),
    false
  );

  delay(250);

  const bool secondSent = writeCharacteristic->writeValue(
    HANDSHAKE_2,
    sizeof(HANDSHAKE_2),
    false
  );

  if (firstSent && secondSent) {
    Serial.println("Handshake geslaagd.");
    return true;
  }

  Serial.println("Handshake mislukt.");
  return false;
}

bool connectToAt02() {
  if (targetDevice == nullptr) {
    return false;
  }

  Serial.println("Verbinden met AT-02...");

  bleClient = NimBLEDevice::getDisconnectedClient();

  if (bleClient == nullptr) {
    bleClient = NimBLEDevice::createClient();

    if (bleClient == nullptr) {
      Serial.println("BLE-client kon niet worden gemaakt.");
      return false;
    }

    bleClient->setClientCallbacks(&clientCallbacks, false);
    bleClient->setConnectionParams(12, 24, 0, 150);
    bleClient->setConnectTimeout(10000);
  }

  if (!bleClient->connect(targetDevice)) {
    Serial.println("BLE-verbinding mislukt.");

    NimBLEDevice::deleteClient(bleClient);
    bleClient = nullptr;

    return false;
  }

  bleOnline = true;
  bleRssi = bleClient->getRssi();

  NimBLERemoteCharacteristic* writeCharacteristic =
    discoverAndSubscribe(bleClient);

  delay(500);
  sendHandshake(writeCharacteristic);

  Serial.println("Wachten op temperatuurgegevens.");

  publishAllValues();

  return true;
}

// ======================================================
// SETUP / LOOP
// ======================================================

void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println();
  Serial.println("AT-02 Gateway v1.1 RSSI");

  connectWiFi();

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setBufferSize(256);

  connectMqtt();

  setupWebServer();
  setupOta();

  NimBLEDevice::init("ESP32-AT02-Gateway");
  NimBLEDevice::setPower(3);

  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&scanCallbacks, false);
  scan->setActiveScan(true);
  scan->setInterval(100);
  scan->setWindow(100);

  nextBleScanAt = millis();
}

void loop() {
  const uint32_t now = millis();

  if (
    WiFi.status() != WL_CONNECTED &&
    now >= nextWifiRetryAt
  ) {
    nextWifiRetryAt = now + WIFI_RETRY_MS;
    connectWiFi();
  }

  if (
    !mqttClient.connected() &&
    now >= nextMqttRetryAt
  ) {
    nextMqttRetryAt = now + MQTT_RETRY_MS;
    connectMqtt();
  }

  mqttClient.loop();
  webServer.handleClient();
  ArduinoOTA.handle();

  if (
    bleConnectRequested &&
    targetDevice != nullptr &&
    (
      bleClient == nullptr ||
      !bleClient->isConnected()
    )
  ) {
    bleConnectRequested = false;

    if (!connectToAt02()) {
      targetDevice = nullptr;
      nextBleScanAt =
        millis() + BLE_RECONNECT_DELAY_MS;
    }
  }

  if (
    !bleScanning &&
    (
      bleClient == nullptr ||
      !bleClient->isConnected()
    ) &&
    now >= nextBleScanAt
  ) {
    startBleScan();
  }

  if (
    bleClient != nullptr &&
    bleClient->isConnected()
  ) {
    static uint32_t nextRssiUpdateAt = 0;

    if (now >= nextRssiUpdateAt) {
      nextRssiUpdateAt = now + 10000;
      bleRssi = bleClient->getRssi();

      if (mqttClient.connected()) {
        mqttPublish(String(MQTT_BASE) + "/rssi", String(bleRssi));
      }

      Serial.print("Bluetooth RSSI: ");
      Serial.print(bleRssi);
      Serial.println(" dBm");
    }
  }

  delay(10);
}
