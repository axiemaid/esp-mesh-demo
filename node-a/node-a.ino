/**
 * ESP-NOW Mesh Demo — Node A (Gateway)
 * 
 * - Connected to Mac Mini via USB serial
 * - Receives messages from agent via serial → forwards to Node B via ESP-NOW
 * - Receives confirmations from Node B via ESP-NOW → passes to agent via serial
 * 
 * Compatible with ESP32 Arduino Core 3.x
 */

#include <esp_now.h>
#include <WiFi.h>

#define LED_PIN 2
#define SERIAL_BAUD 115200
#define MAX_MSG_LEN 250

// *** REPLACE WITH NODE B's MAC ADDRESS AFTER FIRST FLASH ***
uint8_t nodeB_mac[] = {0x00, 0x70, 0x07, 0x0E, 0x6D, 0x14};

esp_now_peer_info_t peerInfo;

char serialBuf[MAX_MSG_LEN + 1];
int serialIdx = 0;

void blinkLED(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(delayMs);
    digitalWrite(LED_PIN, LOW);
    delay(delayMs);
  }
}

// ESP32 Arduino Core 3.x callback
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  const uint8_t *mac = info->src_addr;

  blinkLED(2, 50);

  char msg[251];
  int copyLen = len < 250 ? len : 250;
  memcpy(msg, data, copyLen);
  msg[copyLen] = '\0';

  // Forward confirmation to agent via serial (first line is the JSON)
  Serial.println(msg);
}

void onDataSent(const esp_now_send_info_t *info, esp_now_send_status_t status) {
  // silent
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  Serial.println("================================");
  Serial.println("  ESP-NOW Mesh Demo — Node A");
  Serial.println("================================");
  Serial.printf("  MAC: %s\n", WiFi.macAddress().c_str());
  Serial.printf("  Channel: %d\n", WiFi.channel());
  Serial.println("================================");

  blinkLED(3, 100);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ERR] ESP-NOW init failed!");
    return;
  }

  esp_now_register_recv_cb(onDataRecv);
  esp_now_register_send_cb(onDataSent);

  memcpy(peerInfo.peer_addr, nodeB_mac, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("[ERR] Failed to add Node B as peer");
    return;
  }

  Serial.println("[OK] Node A ready");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();

    if (c == '\n' || c == '\r') {
      if (serialIdx > 0) {
        serialBuf[serialIdx] = '\0';

        blinkLED(1, 50);

        esp_err_t result = esp_now_send(nodeB_mac, (uint8_t *)serialBuf, serialIdx);
        if (result != ESP_OK) {
          Serial.println("{\"error\":\"esp_now_send_failed\"}");
        }

        serialIdx = 0;
      }
    } else if (serialIdx < MAX_MSG_LEN) {
      serialBuf[serialIdx++] = c;
    }
  }

  delay(1);
}
