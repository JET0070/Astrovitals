#include <avr/interrupt.h>

// ---------------- Configuration ----------------
// Set to 1 to stream the raw signal (for Arduino Serial Plotter) instead of JSON.
#define DEBUG_RAW 0
// Set to 1 to print one "#..." status line per second showing which gate rejects beats.
// The web app must ignore lines starting with '#'. Set back to 0 when done.
#define DEBUG_STATUS 1

const int pulsePin = A0;
const int blinkPin = 13;

// Tune against the real sensor using DEBUG_RAW / DEBUG_STATUS (amp= field).
const int minPulseAmplitude = 35;
// Reject saturated/clipped signals (ADC is 0-1023).
const int maxPulseAmplitude = 900;

// Keep in sync with the heart-rate range accepted by the app and API.
const int minBpm = 30;
const int maxBpm = 180;
const unsigned long minIntervalMs = 60000UL / maxBpm;
const unsigned long maxIntervalMs = 60000UL / minBpm;

const int intervalHistorySize = 5;
const int stableIntervalsRequired = 5;     // consecutive good beats before output
const unsigned long maxSpreadPercent = 30; // max (longest - shortest) / average
const unsigned int minWindowSamples = 5;   // reject windows with only a few isolated detections
const int maxBadPulsesBeforeReset = 3;     // consecutive bad pulses before the lock is wiped

const unsigned long measurementWindowMs = 30000;

// ---------------- Shared state (ISR <-> loop) ----------------
volatile int BPM = 0;            // last validated BPM, 0 = none
volatile boolean newValidBeat = false;
volatile int Signal = 0;
volatile int IBI = 600;
volatile boolean Pulse = false;
volatile unsigned long sampleCounter = 0;
volatile unsigned long lastBeatTime = 0;
volatile int P = 512;
volatile int T = 512;
volatile int thresh = 525;
volatile boolean firstBeat = true;
volatile unsigned long pendingInterval = 0;
volatile unsigned long lastQualifiedBeatTime = 0;
volatile unsigned int intervalHistory[intervalHistorySize];
volatile int intervalCount = 0;
volatile int intervalIndex = 0;
volatile int badPulseStreak = 0;

// Debug counters (written by the ISR, read by loop with interrupts off).
volatile unsigned int dbgRising = 0;    // threshold crossings accepted as a beat start
volatile unsigned int dbgRejAmp = 0;    // pulses rejected: amplitude out of range
volatile unsigned int dbgRejIvl = 0;    // pulses rejected: interval out of range
volatile unsigned int dbgUnstable = 0;  // lock complete but intervals too spread out
volatile unsigned int dbgValid = 0;     // validated BPM outputs
volatile unsigned int dbgResets = 0;    // full detector resets (timeout or bad streak)
volatile int dbgAmp = 0;                // amplitude of the last pulse
volatile unsigned long dbgIvl = 0;      // last candidate interval (ms)

// ---------------- Loop-side state ----------------
unsigned long measurementWindowStart = 0;
unsigned long bpmTotal = 0;
unsigned int bpmCount = 0;

void setup() {
  pinMode(blinkPin, OUTPUT);
  Serial.begin(115200);
  Signal = analogRead(pulsePin);
  P = Signal;
  T = Signal;
  thresh = Signal;
  measurementWindowStart = millis();
  interruptSetup();
}

void loop() {
#if DEBUG_RAW
  // Raw signal at ~50 Hz for the Serial Plotter.
  static unsigned long t = 0;
  if (millis() - t >= 20) {
    t = millis();
    int s;
    noInterrupts();
    s = Signal;
    interrupts();
    Serial.println(s);
  }
#else
  if (newValidBeat) {
    noInterrupts();
    const int bpm = BPM;
    newValidBeat = false;
    interrupts();
    if (bpm >= minBpm && bpm <= maxBpm) {
      bpmTotal += bpm;
      bpmCount++;
    }
  }

#if DEBUG_STATUS
  static unsigned long lastStatus = 0;
  if (millis() - lastStatus >= 1000) {
    lastStatus = millis();
    noInterrupts();
    const unsigned int rising = dbgRising, rejAmp = dbgRejAmp, rejIvl = dbgRejIvl;
    const unsigned int unstable = dbgUnstable, valid = dbgValid, resets = dbgResets;
    const int amp = dbgAmp, sig = Signal, th = thresh, cnt = intervalCount;
    const unsigned long ivl = dbgIvl;
    interrupts();
    Serial.print("#sig="); Serial.print(sig);
    Serial.print(" thr="); Serial.print(th);
    Serial.print(" beats="); Serial.print(rising);
    Serial.print(" amp="); Serial.print(amp);
    Serial.print(" ivl="); Serial.print(ivl);
    Serial.print(" lock="); Serial.print(cnt);
    Serial.print(" rejAmp="); Serial.print(rejAmp);
    Serial.print(" rejIvl="); Serial.print(rejIvl);
    Serial.print(" unstable="); Serial.print(unstable);
    Serial.print(" valid="); Serial.print(valid);
    Serial.print(" resets="); Serial.println(resets);
  }
#endif

  if (millis() - measurementWindowStart >= measurementWindowMs) {
    const unsigned long now = millis();
    const bool ok = bpmCount >= minWindowSamples;
    Serial.print("{\"hr\":");
    if (ok) {
      Serial.print((bpmTotal + bpmCount / 2) / bpmCount);
    } else {
      Serial.print("null");
    }
    Serial.println("}");
    measurementWindowStart = now;
    bpmTotal = 0;
    bpmCount = 0;
  }
#endif
}

void interruptSetup() {
  // Timer2 compare interrupt at 500 Hz (one sample every 2 ms), for ATmega328P boards
  // running at 16 MHz. On an 8 MHz board this runs at 250 Hz and all timings double.
  TCCR2A = 0x02;
  TCCR2B = 0x06;
  OCR2A = 0x7C;
  TIMSK2 = 0x02;
  sei();
}

// Clears everything so a fresh lock is required.
static void resetDetector() {
  thresh = Signal;
  P = Signal;
  T = Signal;
  BPM = 0;
  newValidBeat = false;
  IBI = 600;
  lastBeatTime = sampleCounter;
  lastQualifiedBeatTime = sampleCounter;
  firstBeat = true;
  pendingInterval = 0;
  intervalCount = 0;
  intervalIndex = 0;
  badPulseStreak = 0;
  Pulse = false;
  digitalWrite(blinkPin, LOW);
  dbgResets++;
}

// A bad pulse is ignored; only a streak of them wipes the lock.
static void registerBadPulse() {
  badPulseStreak++;
  if (badPulseStreak >= maxBadPulsesBeforeReset) {
    intervalCount = 0;
    intervalIndex = 0;
    firstBeat = true;
    badPulseStreak = 0;
    dbgResets++;
  }
}

ISR(TIMER2_COMPA_vect) {
  Signal = analogRead(pulsePin);
  sampleCounter += 2;
  const unsigned long N = sampleCounter - lastBeatTime;

  if (Signal < thresh && N > (IBI / 5) * 3 && Signal < T) {
    T = Signal;
  }

  if (Signal > thresh && Signal > P) {
    P = Signal;
  }

  // Beat detected on rising edge through the threshold.
  if (N > 250 && Signal > thresh && !Pulse && N > (IBI / 5) * 3) {
    Pulse = true;
    digitalWrite(blinkPin, HIGH);
    const unsigned long candidate = sampleCounter - lastBeatTime;
    lastBeatTime = sampleCounter;
    pendingInterval = firstBeat ? 0 : candidate;
    firstBeat = false;
    dbgRising++;
  }

  // Validate the pulse amplitude at its falling edge before accepting its interval.
  if (Signal < thresh && Pulse) {
    digitalWrite(blinkPin, LOW);
    Pulse = false;
    const int pulseAmplitude = P > T ? P - T : 0;
    thresh = pulseAmplitude / 2 + T;
    P = thresh;
    T = thresh;
    dbgAmp = pulseAmplitude;

    const unsigned long candidate = pendingInterval;
    pendingInterval = 0;
    if (candidate > 0) dbgIvl = candidate;
    const bool amplitudeOk = pulseAmplitude >= minPulseAmplitude &&
                             pulseAmplitude <= maxPulseAmplitude;
    if (!amplitudeOk) {
      dbgRejAmp++;
      registerBadPulse();
    } else {
      lastQualifiedBeatTime = sampleCounter;
      bool intervalOk = true;
      if (candidate > 0) {
        if (candidate >= minIntervalMs && candidate <= maxIntervalMs) {
          IBI = (int)candidate;
          intervalHistory[intervalIndex] = (unsigned int)candidate;
          intervalIndex = (intervalIndex + 1) % intervalHistorySize;
          if (intervalCount < intervalHistorySize) {
            intervalCount++;
          }
        } else {
          intervalOk = false;
          dbgRejIvl++;
          registerBadPulse();
        }
      }
      if (intervalOk) badPulseStreak = 0;

      if (intervalOk && intervalCount >= stableIntervalsRequired) {
        unsigned int shortest = 65535;
        unsigned int longest = 0;
        unsigned long total = 0;
        for (int i = 0; i < intervalCount; i++) {
          const unsigned int v = intervalHistory[i];
          if (v < shortest) shortest = v;
          if (v > longest) longest = v;
          total += v;
        }
        const unsigned long average = total / intervalCount;
        const bool stable = (longest - shortest) <= (average * maxSpreadPercent / 100UL);

        if (!stable) {
          dbgUnstable++;
        } else if (average > 0) {
          const int bpm = (int)(60000UL / average);
          if (bpm >= minBpm && bpm <= maxBpm) {
            BPM = bpm;
            newValidBeat = true;
            dbgValid++;
          }
        }
      }
    }
  }

  // Noise crossings do not keep the detector alive without qualified pulses.
  if (sampleCounter - lastQualifiedBeatTime > 2500) {
    resetDetector();
  }
}