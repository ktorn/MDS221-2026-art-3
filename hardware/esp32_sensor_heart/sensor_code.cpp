#define USE_ARDUINO_INTERRUPTS true
#include <PulseSensorPlayground.h>

#include "sensor_code.h"

const int PULSE_SENSOR_PIN = 1;
const int LED_PIN = 48;
const int THRESHOLD = 550;

static PulseSensorPlayground pulseSensor;
static bool gSensorReady = false;

bool sensorCodeBegin() {
  pulseSensor.analogInput(PULSE_SENSOR_PIN);
  pulseSensor.blinkOnPulse(LED_PIN);
  pulseSensor.setThreshold(THRESHOLD);

  gSensorReady = pulseSensor.begin();
  if (gSensorReady) {
    Serial.println("PulseSensor object created successfully!");
  } else {
    Serial.println("PulseSensor not detected!");
  }

  delay(100);
  Serial.println("Sensor setup complete!");
  return gSensorReady;
}

void sensorCodeUpdate() {
  // Interrupt-driven; no per-loop tick required.
}

int sensorCodeGetBpm() {
  if (!gSensorReady) return 0;
  return pulseSensor.getBeatsPerMinute();
}

bool sensorCodeSawBeat() {
  if (!gSensorReady) return false;
  return pulseSensor.sawStartOfBeat();
}
