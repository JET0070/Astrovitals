#!/usr/bin/env python3
"""Bridge script for Arduino/Pulse Sensor readings.

This script listens to a serial device (Arduino COM port / USB serial) and forwards
parsed health readings to the AstroVitals API as sensor-mode records.

Examples:
  python sensor_bridge.py --port COM3 --baud 115200 --user astro --password secret
  python sensor_bridge.py --port /dev/ttyUSB0 --server http://127.0.0.1:8000 --token YOUR_TOKEN

The bridge accepts either JSON payloads or simple text like:
  {"mode":"sensor","values":{"hr":72}}
  BPM: 72
  hr=72
"""

import argparse
import getpass
import json
import re
import sys
from urllib import request, error

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    serial = None
    list_ports = None


def auto_detect_port():
    if list_ports is None:
        return "COM3"

    ports = list(list_ports.comports())
    if not ports:
        return "COM3"

    preferred = []
    for port in ports:
        name = getattr(port, "device", str(port))
        lower = name.lower()
        if any(token in lower for token in ("arduino", "usbserial", "ttyusb", "ttyacm", "com")):
            preferred.append(name)

    if preferred:
        return preferred[0]
    return ports[0].device


def login(server_url, username, password):
    payload = json.dumps({"name": username, "password": password}).encode()
    req = request.Request(
        f"{server_url}/api/login",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with request.urlopen(req, timeout=10) as response:
        data = json.loads(response.read().decode())
    if not data.get("token"):
        raise RuntimeError("Login response did not include a token")
    return data["token"]


def send_sensor_values(server_url, token, values):
    payload = json.dumps({"mode": "sensor", "values": values}).encode()
    req = request.Request(
        f"{server_url}/api/records",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": token,
        },
        method="POST",
    )
    with request.urlopen(req, timeout=10) as response:
        return json.loads(response.read().decode())


def parse_line(line):
    text = (line or "").strip()
    if not text:
        return {}

    values = {}
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            if isinstance(obj.get("values"), dict):
                values = obj["values"]
            elif "hr" in obj:
                values = {"hr": obj["hr"]}
    except (TypeError, ValueError):
        values = {}

    if not values:
        match = re.search(r"(?i)\b(?:heart\s*[- ]?rate|bpm)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)", text)
        if match:
            values = {"hr": match.group(1)}

    try:
        bpm = float(values.get("hr"))
    except (TypeError, ValueError):
        return {}
    if not 30 <= bpm <= 180:
        return {}
    return {"hr": bpm}


def main():
    parser = argparse.ArgumentParser(description="Bridge an Arduino pulse sensor to AstroVitals")
    parser.add_argument("--port", default="AUTO", help="Serial port such as COM3 or /dev/ttyUSB0; default AUTO finds the Arduino automatically")
    parser.add_argument("--baud", type=int, default=115200, help="Serial baud rate")
    parser.add_argument("--server", default="http://127.0.0.1:8000", help="AstroVitals server URL")
    parser.add_argument("--token", help="Existing AstroVitals auth token. If omitted, use --user and --password.")
    parser.add_argument("--user", help="Astronaut username used for login when --token is not provided")
    parser.add_argument("--password", help="Astronaut password; if omitted, it is requested securely")
    args = parser.parse_args()

    if serial is None:
        print("pyserial is required. Install it with: pip install pyserial", file=sys.stderr)
        return 1

    if args.port.upper() == "AUTO":
        args.port = auto_detect_port()
        print(f"Auto-detected serial port: {args.port}")

    if not args.token:
        if not args.user or not args.password:
            if not args.user:
                print("Provide either --token or --user.", file=sys.stderr)
                return 2
            args.password = getpass.getpass("AstroVitals password: ")
        if not args.password:
            print("Password cannot be empty.", file=sys.stderr)
            return 2
        args.token = login(args.server, args.user, args.password)

    print(f"Connected to {args.server}; saving every valid serial reading.")

    try:
        import serial as pyserial
        with pyserial.Serial(args.port, args.baud, timeout=1) as port:
            print(f"Listening on {args.port} at {args.baud} baud...")
            while True:
                line = port.readline()
                if not line:
                    continue
                values = parse_line(line.decode(errors="ignore"))
                if not values:
                    continue
                try:
                    result = send_sensor_values(args.server, args.token, values)
                    print(f"Saved sensor values: {values} -> {result}")
                except error.HTTPError as exc:
                    payload = exc.read().decode(errors="ignore")
                    print(f"Send failed: {exc.code} {payload}", file=sys.stderr)
                    if exc.code == 401 and args.user and args.password:
                        try:
                            args.token = login(args.server, args.user, args.password)
                            result = send_sensor_values(args.server, args.token, values)
                            print(f"Reauthenticated and saved: {result}")
                        except Exception as retry_error:
                            print(f"Reauth failed: {retry_error}", file=sys.stderr)
                except Exception as exc:
                    print(f"Send failed: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"Could not open serial port {args.port}: {exc}", file=sys.stderr)
        return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
