/**
 * ESP-NOW Mesh Demo — Node B (Relay/Endpoint)
 * 
 * - Listens for ESP-NOW messages from Node A
 * - Blinks LED on receipt
 * - Sends confirmation back to Node A via ESP-NOW
 * - No serial connection to computer needed (just USB power)
 * 
 * Compatible with ESP32 Arduino Core 3.x
 */

#include <esp_now.h>
#include <WiFi.h>

#define LED_PIN 2

// *** REPLACE WITH NODE A's MAC ADDRESS AFTER FIRST FLASH ***
uint8_t nodeA_mac[] = {0x00, 0x70, 0x07, 0x0D, 0x73, 0x18};

esp_now_peer_info_t peerInfo;

void blinkLED(int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(delayMs);
    digitalWrite(LED_PIN, LOW);
    delay(delayMs);
  }
}

// ESP32 Arduino Core 3.x callback signatures
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  const uint8_t *mac = info->src_addr;

  blinkLED(3, 100);

  char msg[251];
  int copyLen = len < 250 ? len : 250;
  memcpy(msg, data, copyLen);
  msg[copyLen] = '\0';
  Serial.printf("[RECV] From %02X:%02X:%02X:%02X:%02X:%02X: %s\n",
    mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], msg);

  // Build confirmation JSON
  char confirm[250];
  snprintf(confirm, sizeof(confirm),
    "{\"status\":\"delivered\",\"from\":\"%s\",\"rssi\":%d,\"ms\":%lu}",
    WiFi.macAddress().c_str(),
    WiFi.RSSI(),
    millis()
  );

  esp_err_t result = esp_now_send(nodeA_mac, (uint8_t *)confirm, strlen(confirm));
  Serial.printf("[SEND] Confirmation %s\n", result == ESP_OK ? "sent" : "FAILED");
}

void onDataSent(const esp_now_send_info_t *info, esp_now_send_status_t status) {
  Serial.printf("[STATUS] Send: %s\n", status == ESP_NOW_SEND_SUCCESS ? "OK" : "FAIL");
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  Serial.println("================================");
  Serial.println("  ESP-NOW Mesh Demo — Node B");
  Serial.println("================================");
  Serial.printf("  MAC: %s\n", WiFi.macAddress().c_str());
  Serial.printf("  Channel: %d\n", WiFi.channel());
  Serial.println("================================");

  blinkLED(5, 100);

  if (esp_now_init() != ESP_OK) {
    Serial.println("[ERR] ESP-NOW init failed!");
    return;
  }

  esp_now_register_recv_cb(onDataRecv);
  esp_now_register_send_cb(onDataSent);

  memcpy(peerInfo.peer_addr, nodeA_mac, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("[ERR] Failed to add Node A as peer");
    return;
  }

  Serial.println("[OK] Node B ready — waiting for messages...");
}

void loop() {
  delay(10);
}
