"""AstroVitals local API – Python stdlib only (no pip install). Run: python server.py"""
import json, sqlite3, hashlib, secrets, random, re, math, datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# Database file for astronauts, check-in records, and symptom event history.
DB = "astro.db"
# In-memory login sessions. Each token maps to a user id and is cleared when the server restarts.
TOKENS = {}  # token -> user_id (in memory, cleared on restart)

# Helper to build a metric definition object.
# Each key stores:
# - label: friendly name shown in the UI
# - unit: measurement unit displayed in forms and charts
# - min/max: hard allowed range for input validation
# - d: default value used when there is no saved reading yet
# - ok: normal range that is considered healthy / acceptable
# - warn: caution range that triggers a "check again" warning
# - lo/hi: guidance text shown when value is too low or too high

def I(label, unit, mn, mx, d, ok, warn, lo, hi):
    return dict(label=label, unit=unit, min=mn, max=mx, d=d, ok=ok, warn=warn, lo=lo, hi=hi)

# Metric definitions used by the backend and frontend.
# These are the reference values the app checks against for each health metric.
# If you want to change safe ranges, adjust the entries below.
IND = {
 # hr: resting heart rate in beats per minute.
 # ok = normal range, warn = caution range, lo/hi = explanation when below/above range.
 "hr": I("Resting heart rate","bpm",30,180,62,(50,90),(45,105),"Slow pulse: stop intense exercise, sit, recheck in 10 min.","Fast pulse: rest, drink water, slow breathing for 5 min, check cabin CO2."),
 # sbp: systolic blood pressure in mmHg.
 "sbp": I("Systolic blood pressure","mmHg",70,200,115,(95,130),(85,145),"Low pressure: lie down, drink fluids and salt as prescribed, stand up slowly.","High pressure: rest, cut salt, recheck in 15 min."),
 # spo2: blood oxygen saturation percentage.
 "spo2": I("Blood oxygen (SpO2)","%",80,100,98,(95,100),(92,100),"Low oxygen: check cabin O2/CO2, rest, use oxygen if available.","—"),
 # temp: body temperature in degrees Celsius.
 "temp": I("Body temperature","°C",34,41,36.8,(36.1,37.5),(35.5,38.0),"Low temperature: warm clothing, warm drink, check cabin temperature.","Fever or heat stress: reduce activity, hydrate, check cooling and cabin temperature."),
 # sleep: hours of sleep per night.
 "sleep": I("Sleep","h/night",0,12,7,(7,10),(6,12),"Short sleep: fix your sleep window, dim lights 1h before bed, limit caffeine.","Oversleeping: keep a regular schedule and morning light."),
 # water: daily fluid intake in litres.
 "water": I("Fluid intake","L/day",0,5,2.5,(2,4),(1.5,5),"Low fluids (kidney-stone risk): drink a glass every hour.","—"),
 # exercise: exercise minutes per day.
 "exercise": I("Exercise","min/day",0,300,120,(90,300),(45,300),"Too little exercise: bone and muscle loss speeds up. Do your resistance + cardio session.","—"),
 # stress: self-reported stress score out of 10.
 "stress": I("Stress level","/10",0,10,3,(0,5),(0,7),"—","High stress: breathing exercise, call family/crew, schedule free time."),
}
RULES = [
 (r"chest|palpitation|faint|pass(ed)? out|can.?t breathe|short of breath|vision loss|blind", "Red-flag symptom", ["Stop activity now and notify the crew.","Contact the flight surgeon immediately and send your readings."], True),
 (r"headache|migraine", "Headache", ["Check cabin CO2 first (common cause).","Hydrate, rest, review last night's sleep.","If it persists >24h or comes with vision change, call the flight surgeon."], False),
 (r"nausea|dizz|vertigo|motion", "Nausea / dizziness", ["Limit head movements for a while.","Hydrate and eat light.","Stand up slowly (blood pools in the legs after exercise)."], False),
 (r"vision|blur|eye|sight", "Vision change (possible SANS)", ["Do the near/far vision chart now and note the result.","Send the result to the ground; vision changes can progress silently."], False),
 (r"back|spine|pain.*(neck|shoulder)", "Back / neck pain", ["Spine elongates in microgravity: do stretching and core exercises.","Review posture in the sleeping station."], False),
 (r"flank|urine|kidney|stone", "Urinary / flank pain", ["Increase fluids immediately.","Possible kidney stone: contact the flight surgeon."], False),
 (r"cough|breath|lung|throat", "Breathing / throat", ["Check cabin air and dust filters.","Monitor SpO2 every 30 min."], False),
 (r"sleep|insomnia|tired|fatigue", "Sleep / fatigue", ["Keep fixed sleep and light cycles.","Avoid screens and caffeine before bed."], False),
 (r"sad|anxious|lonely|angry|stress|mood", "Mood / isolation", ["Talk with the crew or schedule a private family call.","Do a 5-min breathing exercise.","Persisting low mood: talk to the psychological support team."], False),
]

# Open a SQLite connection to the local database.
def db():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

# Create the required database tables on startup if they do not exist.
# users: astronaut profiles and passwords
# records: all saved health check-ins
# events: symptom reports and generated guidance

def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, salt TEXT, pw TEXT);
    CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, uid INT, ts TEXT, mode TEXT, vals TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, uid INT, ts TEXT, text TEXT, vals TEXT, advice TEXT);
    """); c.commit(); c.close()

# Hash a password with PBKDF2-HMAC-SHA256 using a random per-user salt.
def hp(pw, salt): return hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 100_000).hex()

# Determine whether the value is in the normal band, warning band, or outside both.
def level(k, v):
    s = IND[k]
    if s["ok"][0] <= v <= s["ok"][1]: return 0
    return 1 if s["warn"][0] <= v <= s["warn"][1] else 2

# Build a list of health alerts for any readings outside the normal range.
def alerts(vals):
    out = []
    for k, v in vals.items():
        lv = level(k, v)
        if lv:
            s = IND[k]; low = v < s["ok"][0]
            out.append(dict(k=k, label=s["label"], level=lv, value=v, msg=f'{s["label"]} too {"low" if low else "high"} ({v} {s["unit"]}). ' + s["lo" if low else "hi"]))
    return out

# Remove invalid or empty values and clamp each one into its allowed min/max range.
def clean(vals):
    r = {}
    for k, v in (vals or {}).items():
        if k in IND and v not in ("", None):
            r[k] = max(IND[k]["min"], min(IND[k]["max"], float(v)))
    return r

# Return the last saved check-in values for the user; if none exist, use default starting values.
def last_vals(uid):
    row = db().execute("SELECT vals FROM records WHERE uid=? ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
    return json.loads(row["vals"]) if row else {k: s["d"] for k, s in IND.items()}

# Simulate a generated data set for auto-mode records.
# This is used to demonstrate trend/check-in behavior without a real hardware sensor.
def generate(uid):
    base = last_vals(uid); out = {}
    for k, s in IND.items():
        sd = (s["max"] - s["min"]) * 0.02
        v = base.get(k, s["d"]) + random.gauss(0, sd)
        if k == "exercise": v -= 1.5          # slow drift to show prediction
        if k == "sleep": v -= 0.04
        if random.random() < 0.05: v += random.choice([-1, 1]) * sd * 6   # rare spike
        out[k] = round(max(s["min"], min(s["max"], v)), 1)
    return out

# Simple trend prediction based on recent saved records.
# It fits a line to recent history and flags unusual changes or forecast crossing outside the safe bands.
def predict(uid, n=14, horizon=7):
    rows = db().execute("SELECT ts, vals FROM records WHERE uid=? ORDER BY id DESC LIMIT ?", (uid, n)).fetchall()[::-1]
    res = {}
    for k, s in IND.items():
        ys = [json.loads(r["vals"])[k] for r in rows if k in json.loads(r["vals"])]
        if len(ys) < 3: continue
        m = len(ys); xs = range(m); mx = sum(xs) / m; my = sum(ys) / m
        sxx = sum((x - mx) ** 2 for x in xs); slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
        icpt = my - slope * mx
        fc = [round(icpt + slope * (m + i), 2) for i in range(horizon)]
        sd = math.sqrt(sum((y - my) ** 2 for y in ys) / m); z = (ys[-1] - my) / sd if sd else 0
        cross = next((i + 1 for i, f in enumerate(fc) if level(k, f) > 0), None)
        res[k] = dict(slope=round(slope, 3), forecast=fc, unusual=abs(z) > 2, z=round(z, 2), cross=cross,
                      trend="stable" if abs(slope) < (s["max"] - s["min"]) * 0.002 else ("rising" if slope > 0 else "falling"))
    return res

# Turn a symptom description into structured guidance.
# It checks for keywords such as chest pain, nausea, vision changes, or stress and combines them with the current metric alerts.
def analyze(text, vals):
    steps, titles, urgent = [], [], False
    for rx, title, adv, u in RULES:
        if re.search(rx, text, re.I):
            titles.append(title); steps += adv; urgent = urgent or u
    al = alerts(vals)
    if any(a["level"] == 2 for a in al): urgent = True
    if not titles: titles = ["General discomfort"]; steps = ["Rest, hydrate and log how it evolves over 24h.", "Describe it in more detail if it persists."]
    return dict(titles=titles, steps=steps, alerts=al, urgent=urgent)

# Helper to normalise sensor payloads coming from external devices.
# Accepts either a nested {"values": {...}} object or a flat key/value JSON payload.
def sensor_values_from_payload(payload):
    if not isinstance(payload, dict):
        return {}
    values = payload.get("values") if isinstance(payload.get("values"), dict) else payload
    try:
        bpm = float(values.get("hr"))
    except (TypeError, ValueError):
        return {}
    return {"hr": bpm} if math.isfinite(bpm) and IND["hr"]["min"] <= bpm <= IND["hr"]["max"] else {}

# HTTP server for the AstroVitals API. Each endpoint manages auth, records, predictions, and symptom events.
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or "{}")
    def uid(self): return TOKENS.get(self.headers.get("Authorization", ""))
    def do_GET(self): self.route("GET")
    def do_POST(self): self.route("POST")
    def route(self, m):
        try:
            request_url = urlsplit(self.path); p = request_url.path; query = parse_qs(request_url.query); u = self.uid()

            # /api/config: publish metric definitions to the frontend so it can display labels, units, and ranges.
            if p == "/api/config": return self.send(200, IND)

            # /api/register: create a new user with a random salt and hashed password.
            if p == "/api/register" and m == "POST":
                b = self.body(); name, pw = b.get("name", "").strip(), b.get("password", "")
                if len(name) < 2 or len(pw) < 4: return self.send(400, {"error": "Name ≥2 and password ≥4 characters"})
                salt = secrets.token_hex(8); c = db()
                try: c.execute("INSERT INTO users(name,salt,pw) VALUES(?,?,?)", (name, salt, hp(pw, salt))); c.commit()
                except sqlite3.IntegrityError: return self.send(400, {"error": "Astronaut already registered"})
                p = "/api/login"; self._b = b

            # /api/login: verify user credentials and return a session token.
            if p == "/api/login":
                b = getattr(self, "_b", None) or self.body()
                r = db().execute("SELECT * FROM users WHERE name=?", (b.get("name", "").strip(),)).fetchone()
                if not r or hp(b.get("password", ""), r["salt"]) != r["pw"]: return self.send(401, {"error": "Wrong name or password"})
                t = secrets.token_hex(16); TOKENS[t] = r["id"]; return self.send(200, {"token": t, "name": r["name"]})

            # All routes below require a valid auth token.
            if not u: return self.send(401, {"error": "Login required"})

            # /api/records GET: return all saved health records for this user.
            # Optional after=<record id> returns only records added after that id for efficient live updates.
            if p == "/api/records" and m == "GET":
                after = int(query.get("after", ["0"])[0])
                rows = db().execute("SELECT id,ts,mode,vals FROM records WHERE uid=? AND id>? ORDER BY id", (u, after)).fetchall()
                return self.send(200, [dict(id=r["id"], ts=r["ts"], mode=r["mode"], vals=json.loads(r["vals"])) for r in rows])

            # /api/records POST: save a new check-in.
            # mode can be:
            # - manual: values entered by the user in the app
            # - auto: generated sample data for demo/testing
            # - sensor: values sent by Arduino or other hardware devices
            if p == "/api/records" and m == "POST":
                b = self.body(); mode = b.get("mode", "manual")
                if mode == "auto":
                    vals = generate(u)
                elif mode == "sensor":
                    vals = sensor_values_from_payload(b)
                    if not vals:
                        return self.send(400, {"error": "Sensor reading rejected; expected a heart-rate value between 30 and 180 bpm"})
                else:
                    vals = clean(b.get("values"))
                if not vals: return self.send(400, {"error": "No values provided"})
                c = db(); c.execute("INSERT INTO records(uid,ts,mode,vals) VALUES(?,?,?,?)", (u, dt.datetime.now().isoformat(timespec="seconds"), mode, json.dumps(vals))); c.commit()
                return self.send(200, {"vals": vals, "alerts": alerts(vals)})

            # /api/predict: return the recent trend forecast for each metric.
            if p == "/api/predict": return self.send(200, predict(u))

            # /api/events GET: list historical symptom reports for this user.
            if p == "/api/events" and m == "GET":
                rows = db().execute("SELECT ts,text,vals,advice FROM events WHERE uid=? ORDER BY id DESC", (u,)).fetchall()
                return self.send(200, [dict(ts=r["ts"], text=r["text"], vals=json.loads(r["vals"]), advice=json.loads(r["advice"])) for r in rows])

            # /api/events POST: receive a symptom description and associated readings, then compute guidance.
            if p == "/api/events" and m == "POST":
                b = self.body(); vals = clean(b.get("values")); a = analyze(b.get("text", ""), vals)
                c = db(); c.execute("INSERT INTO events(uid,ts,text,vals,advice) VALUES(?,?,?,?,?)", (u, dt.datetime.now().isoformat(timespec="minutes"), b.get("text", ""), json.dumps(vals), json.dumps(a))); c.commit()
                return self.send(200, a)

            # Unknown path.
            self.send(404, {"error": "Not found"})
        except Exception as e:
            self.send(500, {"error": str(e)})

if __name__ == "__main__":
    init(); print("AstroVitals API on http://127.0.0.1:8000")
    ThreadingHTTPServer(("127.0.0.1", 8000), H).serve_forever()
