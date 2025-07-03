/*
=====================================================================
  REACH Robot Arm Firmware 
  Author: Micke Nicander Kuwahara
  Date: 2025-05
  Clean, memory-safe, efficient firmware for Robot Arm with minimal features.
  Works fine for both 5 and 6 servos, if 5 then Elbow will just be ignored.
=====================================================================
*/

#include <Adafruit_PWMServoDriver.h>

// === Configuration Constants ===
#define NUM_ACTIVE_SERVOS 6
#define SERVO_FREQUENCY 50
#define BAUD_RATE 9600
#define DEFAULT_BMD 2000
#define SINGLE_N_BMD 1000

// === Servo Calibration ===
const int pulseMin[NUM_ACTIVE_SERVOS] = {100, 130, 100, 100, 100, 100};
const int pulseMax[NUM_ACTIVE_SERVOS] = {500, 400, 500, 500, 500, 500};
const int maxAngle[NUM_ACTIVE_SERVOS] = {180, 180, 180, 180, 180, 80};
const int initAngle[NUM_ACTIVE_SERVOS] = {180, 180, 180, 110, 80, 80};

const char* armLocationNames[] = {"Base", "Shoulder", "Elbow", "Wrist_Tilt", "Wrist_Twist", "Claw_Grip"};

// === Servo State ===
struct RoboJoint {
  int minAngle, maxAngle, currentPosAngle;
  bool isInverted;
  RoboJoint(int minA = 0, int maxA = 180, int startA = 90, bool inv = false)
    : minAngle(minA), maxAngle(maxA), currentPosAngle(startA), isInverted(inv) {}
};

struct ServoMove {
  int servoIndex;
  int startAngle;
  int targetAngle;
};

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);
RoboJoint allJoints[NUM_ACTIVE_SERVOS];
ServoMove moves[NUM_ACTIVE_SERVOS];
int baseMovementDuration = DEFAULT_BMD;
bool suppressFeedback = false;

// === Preset Commands ===
const char* getPreset(const String& label) {
  if (label == "SLP") return "N480,N580,N3110,N1180,N0180";
  if (label == "CTR") return "N390,N190,N480,N090";
  if (label == "PLT") return "N0180,N1110,N3150";
  if (label == "PRT") return "N00,N1110,N3150";
  if (label == "PCT") return "N090,N1110,N3150";
  if (label == "PCL") return "N1180,N390,N480";
  if (label == "GRP") return "N520";
  if (label == "LFT") return "N1100,N3160";
  if (label == "REL") return "N580";
  return nullptr;
}

// === Core Setup ===
void setup() {
  Serial.begin(BAUD_RATE);
  pwm.begin();
  pwm.setPWMFreq(SERVO_FREQUENCY);
  for (int i = 0; i < NUM_ACTIVE_SERVOS; i++) {
    allJoints[i] = RoboJoint(0, maxAngle[i], initAngle[i]);
  }
  processCommand("SLP");
}

// === Main Loop ===
void loop() {
  if (Serial.available()) {
    String input = Serial.readStringUntil('\n');
    input.trim();
    processCommand(input);
  }
}

// === Utilities ===
int angleToPulse(int angle, int servo) {
  angle = constrain(angle, allJoints[servo].minAngle, allJoints[servo].maxAngle);
  if (allJoints[servo].isInverted) angle = 180 - angle;
  allJoints[servo].currentPosAngle = angle;
  return map(angle, 0, 180, pulseMin[servo], pulseMax[servo]);
}

float easeInOutQuad(float t) {
  return t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
}

void moveServoSmooth(int servoIndex, int targetAngle, int durationMs) {
  RoboJoint& joint = allJoints[servoIndex];
  int startAngle = joint.currentPosAngle;
  int steps = durationMs / 20;
  for (int i = 0; i <= steps; i++) {
    float t = (float)i / steps;
    float eased = easeInOutQuad(t);
    int interp = startAngle + (targetAngle - startAngle) * eased;
    pwm.setPWM(servoIndex, 0, angleToPulse(interp, servoIndex));
    delay(20);
  }

  sendAnglesJson();
}

void moveMultipleServos(ServoMove moves[], int count, int durationMs) {
  int maxDelta = 0;
  for (int i = 0; i < count; i++) {
    int delta = abs(moves[i].targetAngle - moves[i].startAngle);
    if (delta > maxDelta) maxDelta = delta;
  }
  int steps = map(maxDelta, 1, 180, 15, durationMs / 20);
  for (int i = 0; i <= steps; i++) {
    float t = (float)i / steps;
    float eased = easeInOutQuad(t);
    for (int j = 0; j < count; j++) {
      int angle = moves[j].startAngle + (moves[j].targetAngle - moves[j].startAngle) * eased;
      pwm.setPWM(moves[j].servoIndex, 0, angleToPulse(angle, moves[j].servoIndex));
    }
    delay(20);
  }

  sendAnglesJson();
}

// === Command Parser ===
void processCommand(String cmd) {
  cmd.trim();
  cmd.toUpperCase();

  if (cmd.startsWith("WAIT")) {
    int sec = cmd.substring(4).toInt();
    if (sec > 0) delay(sec * 1000);
    return;
  }

  if (cmd.startsWith("BMD")) {
    int dur = cmd.substring(3).toInt();
    if (dur > 0) baseMovementDuration = dur;
    return;
  }

  if (cmd.startsWith("MUTE")) {
    int val = cmd.substring(4).toInt();
    suppressFeedback = (val > 0);
    return;
  }

  if (cmd == "P") {
    sendAnglesJson();
    return;
  }


  if (cmd.length() == 2 && cmd.charAt(0) == 'P' && isDigit(cmd.charAt(1))) {
    int idx = cmd.charAt(1) - '0';
    if (idx >= 0 && idx < NUM_ACTIVE_SERVOS) {
      Serial.print("{\"servo\":"); Serial.print(idx);
      Serial.print(",\"name\":\""); Serial.print(armLocationNames[idx]);
      Serial.print("\",\"angle\":"); Serial.print(allJoints[idx].currentPosAngle);
      Serial.print(",\"pulse\":"); Serial.print(angleToPulse(allJoints[idx].currentPosAngle, idx));
      Serial.println("}");
    }
    return;
  }

  const char* preset = getPreset(cmd);
  if (preset != nullptr) cmd = preset;

  if (cmd.startsWith("N") && cmd.indexOf(',') != -1) {
    char buffer[80];
    cmd.toCharArray(buffer, sizeof(buffer));
    char* token = strtok(buffer, ",");
    int count = 0;
    bool used[NUM_ACTIVE_SERVOS] = {false};
    while (token && count < NUM_ACTIVE_SERVOS) {
      if (token[0] == 'N' && isDigit(token[1])) {
        int si = token[1] - '0';
        int ang = atoi(&token[2]);
        if (si >= 0 && si < NUM_ACTIVE_SERVOS && !used[si]) {
          moves[count].servoIndex = si;
          moves[count].startAngle = allJoints[si].currentPosAngle;
          moves[count].targetAngle = ang;
          used[si] = true;
          count++;
        }
      }
      token = strtok(NULL, ",");
    }
    if (count > 0) moveMultipleServos(moves, count, baseMovementDuration);
    return;
  }

  if (cmd.startsWith("N") && cmd.length() >= 3) {
    int si = cmd.substring(1, 2).toInt();
    int ang = cmd.substring(2).toInt();
    if (si >= 0 && si < NUM_ACTIVE_SERVOS) moveServoSmooth(si, ang, SINGLE_N_BMD);
    return;
  }

  Serial.println("{\"status\":\"error\",\"message\":\"Unknown command\"}");  
}

// === Return Servo Angles ===
void sendAnglesJson() {
  if (suppressFeedback) return;

  Serial.print("{\"status\":\"ok\",\"angles\":[");
  for (int i = 0; i < NUM_ACTIVE_SERVOS; i++) {
    Serial.print(allJoints[i].currentPosAngle);
    if (i < NUM_ACTIVE_SERVOS - 1) Serial.print(",");
  }
  Serial.println("]}");
}

