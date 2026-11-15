# AstroVitals (local)
Terminal 1 (Python 3.8+, no packages needed):
    cd backend && python server.py        # API on http://127.0.0.1:8000, data in astro.db
Terminal 2 (Node 18+, internet only for the first npm install):
    cd frontend && npm install && npm run dev   # open http://localhost:5173

Arduino / sensor bridge (optional; keep the API running in Terminal 1):
    cd backend
    python -m pip install -r requirements.txt
    python sensor_bridge.py --user astronaut

The bridge asks for the account password securely, auto-detects the Arduino's serial port, and saves each 30-second
average. If auto-detection selects the wrong port, specify it with --port COM3 (use the port shown in Arduino IDE >
Tools > Port). The API must be running at http://127.0.0.1:8000 or the bridge will report connection errors.

Arduino sketch:
    Open arduino/PulseSensorAstroVitals/PulseSensorAstroVitals.ino in Arduino IDE, select a compatible ATmega328P
    board (for example Arduino Uno), select the board's port, and upload. The sketch averages qualified BPM
    readings over 30 seconds, then sends one JSON line such as {"hr": 72} and immediately starts the next window.
    It validates each pulse's amplitude and interval, and requires five stable intervals before reporting.
    It accepts 30–180 BPM as a broad software plausibility range, not a normal resting range, and ignores
    out-of-range intervals. A window needs at least five validated BPM samples; otherwise it sends {"hr": null}.
    With DEBUG_RAW set to 1, the sketch instead outputs raw signal samples about 50 times per second, not BPM.

Keep the Arduino Serial Monitor closed while the bridge is running because only one program can use the serial port.
The Check-in page refreshes sensor readings automatically. Its heart-rate source switch affects only resting heart
rate; other health values remain available for manual entry. The UI keeps a sensor average available until the next
30-second reading is due, with a small allowance for serial/network delay. Older readings remain in history.
