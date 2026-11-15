# AstroVitals (local)
Terminal 1 (Python 3.8+, no packages needed):
    cd backend && python server.py        # API on http://127.0.0.1:8000, data in astro.db
Terminal 2 (Node 18+, internet only for the first npm install):
    cd frontend && npm install && npm run dev   # open http://localhost:5173

Arduino / sensor bridge (optional):
    cd backend
    python -m pip install -r requirements.txt
    python sensor_bridge.py --port COM3 --baud 115200 --user astronaut

The bridge asks for the account password securely, reads JSON heart-rate readings from the Arduino over USB serial,
and saves every valid BPM update it receives. Change COM3 to the board's port in Arduino IDE > Tools > Port.

Arduino sketch:
    Open arduino/PulseSensorAstroVitals/PulseSensorAstroVitals.ino in Arduino IDE, select a compatible ATmega328P
    board (for example Arduino Uno), select the board's port, and upload. The sketch sends one JSON line per
    qualified BPM update to the Serial Monitor/bridge, for example {"hr": 72}. It requires a pulse amplitude
    threshold and five stable beat intervals before reporting. No reading is sent when beats are not detected.

Keep the Arduino Serial Monitor closed while the bridge is running because only one program can use the serial port.
The Check-in page refreshes sensor readings automatically. Its heart-rate source switch affects only resting heart
rate; other health values remain available for manual entry. Each detected beat creates a record, so the database
will grow quickly during continuous sensor use. The UI treats sensor BPM as stale after five seconds without a new
record; older readings remain in history.
