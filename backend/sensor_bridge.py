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
        raise RuntimeError("pyserial port discovery is unavailable; install it with: pip install pyserial")

    ports = list(list_ports.comports())
    if not ports:
        raise RuntimeError("No serial ports found. Connect the Arduino and check Tools > Port in Arduino IDE.")

    def description(port):
        return " ".join(
            str(value or "")
            for value in (port.description, port.manufacturer, port.product, port.hwid)
        ).lower()

    named_arduino = [p for p in ports if "arduino" in description(p)]
    if len(named_arduino) == 1:
        return named_arduino[0].device
    if len(named_arduino) > 1:
        ports = named_arduino
    else:
        usb_serial = [
            p for p in ports
            if p.vid is not None
            and any(token in description(p) for token in (
                "usb", "serial", "ch340", "cp210", "ftdi", "uart",
            ))
            and not any(token in description(p) for token in (
                "bluetooth", "active management", "intel",
            ))
        ]
        if len(usb_serial) == 1:
            return usb_serial[0].device
        if usb_serial:
            ports = usb_serial
        else:
            raise RuntimeError(
                "Could not identify an Arduino USB serial port. "
                "Specify the port shown in Arduino IDE > Tools > Port with --port."
            )

    choices = ", ".join(f"{p.device} ({p.description})" for p in ports)
    raise RuntimeError(
        f"More than one possible Arduino port was found: {choices}. "
        "Specify the correct one with --port."
    )


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


def parse_status_line(line):
    text = (line or "").strip()
    if not text.startswith("#"):
        return {}
    status = {
        key: int(value)
        for key, value in re.findall(r"\b([A-Za-z]+)=(-?\d+)\b", text)
    }
    expected = {
        "sig", "thr", "beats", "amp", "ivl", "lock", "rejAmp",
        "rejIvl", "unstable", "valid", "resets",
    }
    return {key: value for key, value in status.items() if key in expected}


def send_sensor_status(server_url, token, status):
    payload = json.dumps({"status": status}).encode()
    req = request.Request(
        f"{server_url}/api/sensor-status",
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
        try:
            args.port = auto_detect_port()
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 2
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
                text = line.decode(errors="ignore")
                status = parse_status_line(text)
                if status:
                    try:
                        send_sensor_status(args.server, args.token, status)
                    except error.HTTPError as exc:
                        payload = exc.read().decode(errors="ignore")
                        print(f"Status update failed: {exc.code} {payload}", file=sys.stderr)
                    except Exception as exc:
                        print(f"Status update failed: {exc}", file=sys.stderr)
                    continue
                values = parse_line(text)
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
