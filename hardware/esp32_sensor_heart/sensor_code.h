#pragma once

// PulseSensor on GPIO1; on-board LED on GPIO48.
// Requires PulseSensorPlayground library (Arduino Library Manager).

bool sensorCodeBegin();
void sensorCodeUpdate();
int sensorCodeGetBpm();
bool sensorCodeSawBeat();
