import { useCallback, useEffect, useRef, useState } from 'react'
import './style.css'

// API helper: sends JSON requests to the backend and attaches the auth token when available.
const api = async (path, options = {}, token) => {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: token } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const result = await response.json().catch(() => ({ error: 'Could not read the server response.' }))
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed.')
    error.status = response.status
    throw error
  }
  return result
}

// Status labels used for any metric: green = in range, amber = review, red = needs attention.
// Each metric also has user-facing text explaining why it matters, how to measure it, and spaceflight context.
const STATUS = ['In range', 'Check again', 'Needs attention']
const SENSOR_READING_MAX_AGE_MS = 35000

// Sensor history remains saved, but readings older than this are not shown as live values.
function isFreshSensorRecord(record) {
  if (!record?.ts) return false
  const age = Date.now() - new Date(record.ts).getTime()
  return Number.isFinite(age) && age >= 0 && age <= SENSOR_READING_MAX_AGE_MS
}

const METRIC_INFO = {
  hr: {
    icon: '♥',
    group: 'Circulation',
    why: 'Heart rate can shift with workload, sleep, stress, hydration, and adaptation to microgravity.',
    how: 'Sit quietly for a few minutes, then use the approved pulse measurement method and record beats per minute.',
    hazard: 'Fluid shifts and deconditioning can change cardiovascular responses in microgravity.',
  },
  sbp: {
    icon: '↕',
    group: 'Circulation',
    why: 'A blood-pressure reading helps the crew monitor cardiovascular adaptation and symptoms such as dizziness.',
    how: 'Use the onboard blood-pressure cuff as trained. Sit still with the cuff positioned as instructed.',
    hazard: 'Fluid redistribution and changes in conditioning may affect blood pressure and orthostatic tolerance.',
  },
  spo2: {
    icon: '◉',
    group: 'Breathing',
    why: 'Pulse oximetry estimates oxygen saturation and can add context when breathing or cabin-air symptoms occur.',
    how: 'Use the onboard pulse oximeter on a warm, still finger; follow its instructions and repeat unexpected readings.',
    hazard: 'Cabin atmosphere and equipment conditions matter. A home-style threshold is not a substitute for spacecraft protocol.',
  },
  temp: {
    icon: '♨',
    group: 'Whole body',
    why: 'Temperature can help identify illness or overheating, especially when considered with symptoms and repeat readings.',
    how: 'Use the approved thermometer and measurement site. Follow its instructions and record the time.',
    hazard: 'Workload, clothing, and cabin conditions can influence temperature and comfort.',
  },
  sleep: {
    icon: '☾',
    group: 'Recovery',
    why: 'Sleep duration and consistency influence attention, mood, recovery, and operational performance.',
    how: 'Enter estimated hours slept in the last sleep period using your sleep log.',
    hazard: 'Mission schedule, light cycles, workload, and noise may disrupt sleep.',
  },
  water: {
    icon: '⌁',
    group: 'Hydration',
    why: 'Tracking fluid intake supports hydration habits and gives context to symptoms and exercise recovery.',
    how: 'Enter the approximate amount consumed in the last 24 hours, in liters, using your intake log.',
    hazard: 'Fluid shifts and limited access to fluids can affect hydration; follow your crew hydration plan.',
  },
  exercise: {
    icon: '↗',
    group: 'Muscles & bones',
    why: 'Logging exercise helps the crew track countermeasure participation and recovery.',
    how: 'Enter minutes of completed exercise today, using your activity log.',
    hazard: 'Microgravity accelerates muscle and bone loss without the mission’s prescribed exercise countermeasures.',
  },
  stress: {
    icon: '◎',
    group: 'Wellbeing',
    why: 'A quick self-rating can make changes in stress easier to notice and discuss with crew support.',
    how: 'Rate how stressed you feel right now from 0 (none) to 10 (extreme).',
    hazard: 'Isolation, workload, sleep disruption, and distance from family can affect wellbeing.',
  },
}

// Groups health indicators by body system for the overview panel and body-map visualisation.
const BODY_SYSTEMS = [
  { id: 'circulation', label: 'Circulation', icon: '♥', metrics: ['hr', 'sbp'] },
  { id: 'breathing', label: 'Breathing & oxygen', icon: '◉', metrics: ['spo2'] },
  { id: 'temperature', label: 'Body temperature', icon: '♨', metrics: ['temp'] },
  { id: 'hydration', label: 'Hydration', icon: '⌁', metrics: ['water'] },
  { id: 'recovery', label: 'Sleep & wellbeing', icon: '☾', metrics: ['sleep', 'stress'] },
  { id: 'countermeasures', label: 'Muscles & bones', icon: '↗', metrics: ['exercise'] },
]

// Login screen: signs the user in or registers a new crew member before the dashboard loads.
function Login({ onOk }) {
  const [register, setRegister] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await api(register ? '/register' : '/login', {
        method: 'POST',
        body: { name, password },
      })
      onOk(result)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  return <main className="login-shell">
    <div className="login-orbit" aria-hidden="true">✦</div>
    <section className="card login-card">
      <div className="brand-mark">AV</div>
      <div className="eyebrow">CREW HEALTH CONSOLE · LEO</div>
      <h1>AstroVitals</h1>
      <p className="muted">{register ? 'Create a private crew profile.' : 'Sign in to your mission health log.'}</p>
      <label className="field-label" htmlFor="crew-name">Astronaut name</label>
      <input id="crew-name" autoComplete="username" value={name} onChange={event => setName(event.target.value)} />
      <label className="field-label" htmlFor="crew-password">Password</label>
      <input id="crew-password" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password}
        onChange={event => setPassword(event.target.value)} onKeyDown={event => event.key === 'Enter' && submit()} />
      {error && <div className="notice notice-danger" role="alert">{error}</div>}
      <button className="primary-button full-button" disabled={busy || !name.trim() || !password} onClick={submit}>
        {busy ? 'Connecting…' : register ? 'Create crew profile' : 'Enter health console'}
      </button>
      <button className="text-button" onClick={() => { setRegister(!register); setError('') }}>
        {register ? 'Already have a profile? Sign in' : 'New crew member? Create a profile'}
      </button>
      <p className="login-footnote">For crew self-monitoring and communication with your flight surgeon.</p>
    </section>
  </main>
}

// Small status badge used across the app to show whether a metric is in-range, borderline, or urgent.
function StatusPill({ level }) {
  return <span className={`status-pill status-${level}`}>{STATUS[level]}</span>
}

// Displays one health reading in a compact card with the current value and its reference band.
function MetricCard({ metricKey, setting, value, compact = false }) {
  const info = METRIC_INFO[metricKey] || {}
  const level = value === undefined || value === null || value === '' ? -1 : levelFor(setting, Number(value))
  return <article className={`metric-card ${compact ? 'metric-compact' : ''} ${level >= 0 ? `metric-level-${level}` : ''}`}>
    <div className="metric-card-top">
      <span className="metric-icon" aria-hidden="true">{info.icon || '·'}</span>
      <StatusPill level={level} />
    </div>
    <div className="metric-label">{setting.label}</div>
    <div className="metric-value">{level < 0 ? '—' : value}<span>{level < 0 ? 'No reading' : setting.unit}</span></div>
    <div className="metric-range">Reference {setting.ok[0]}–{setting.ok[1]} {setting.unit}</div>
  </article>
}

// Calculates a metric's state using the configured normal and warning thresholds.
function levelFor(setting, value) {
  if (!Number.isFinite(value)) return -1
  if (value >= setting.ok[0] && value <= setting.ok[1]) return 0
  if (value >= setting.warn[0] && value <= setting.warn[1]) return 1
  return 2
}

// Body-map view: lets the user switch between body systems and inspect the selected metric in detail.
function BodyMap({ cfg, values }) {
  const [selected, setSelected] = useState(BODY_SYSTEMS[0])
  const [metricKey, setMetricKey] = useState('hr')
  const selectedMetric = cfg[metricKey]
  const selectedValue = values[metricKey]
  const selectedLevel = selectedValue === undefined ? -1 : levelFor(selectedMetric, Number(selectedValue))
  const chooseSystem = system => {
    setSelected(system)
    setMetricKey(system.metrics[0])
  }
  return <section className="card body-card">
    <div className="section-heading">
      <div><div className="eyebrow">EXPLORE BY HEALTH SYSTEM</div><h2>Health systems</h2></div>
      <span className="subtle">Choose a system to explore its indicators</span>
    </div>
    <div className="body-layout">
      <div className="body-system-list" role="group" aria-label="Choose a health system">
        {BODY_SYSTEMS.map(system =>
          <button key={system.id} className={`system-option ${selected.id === system.id ? 'system-selected' : ''}`}
            aria-pressed={selected.id === system.id} onClick={() => chooseSystem(system)}>
            <span className="system-icon" aria-hidden="true">{system.icon}</span>
            <span className="system-option-label">{system.label}</span>
            <span className="system-option-count">{system.metrics.length} {system.metrics.length === 1 ? 'indicator' : 'indicators'}</span>
          </button>
        )}
      </div>
      <div className="body-insight">
        <div className="body-insight-top">
          <div><div className="eyebrow">{selected.label.toUpperCase()}</div><h3>{selectedMetric.label}</h3></div>
          <StatusPill level={selectedLevel} />
        </div>
        <div className="metric-switcher" aria-label="Choose a body-system metric">
          {selected.metrics.map(key => <button key={key} className={metricKey === key ? 'selected' : ''} onClick={() => setMetricKey(key)}>{cfg[key].label}</button>)}
        </div>
        <div className="reading-highlight">
          <span>{selectedValue === undefined ? 'No reading recorded' : `${selectedValue} ${selectedMetric.unit}`}</span>
          {selectedValue !== undefined && <small>Reference {selectedMetric.ok[0]}–{selectedMetric.ok[1]} {selectedMetric.unit}</small>}
        </div>
        <p>{METRIC_INFO[metricKey]?.why}</p>
        <div className="how-box"><b>How to check in space</b><span>{METRIC_INFO[metricKey]?.how}</span></div>
        <div className="hazard-note"><b>Spaceflight context</b><span>{METRIC_INFO[metricKey]?.hazard}</span></div>
      </div>
    </div>
  </section>
}

// Overview dashboard: summarises the latest check-in, flags readings needing review, and routes users to actions.
function Dashboard({ cfg, records, prediction, onNavigate }) {
  const latest = records[records.length - 1]
  const values = { ...(latest?.vals || {}) }
  if (latest?.mode === 'sensor' && !isFreshSensorRecord(latest)) delete values.hr
  const readings = Object.keys(values).length
  const attention = Object.entries(values).filter(([key, value]) => levelFor(cfg[key], Number(value)) > 0)
  const critical = attention.some(([key, value]) => levelFor(cfg[key], Number(value)) === 2)
  const overviewStatus = critical ? 'Needs attention' : attention.length ? 'Review readings' : readings ? 'All checked readings in range' : 'No current readings'
  const dateLabel = latest ? latest.ts.replace('T', ' · ') : 'No check-in recorded'
  const forecastWarnings = Object.entries(prediction).filter(([, item]) => item.cross || item.unusual)
  const top = critical
    ? 'One or more readings are outside the configured check range.'
    : attention.length
      ? 'A reading is outside its reference band. Recheck it and follow your crew protocol.'
      : latest && readings
        ? 'Your latest check-in is logged. Keep following the mission health routine.'
        : 'Start with the readings you can take now. You can save a partial check-in.'
  return <div className="dashboard">
    <section className="welcome-panel">
      <div>
        <div className="eyebrow">MISSION HEALTH · PERSONAL CHECK-IN</div>
        <h1>Your health, at a glance.</h1>
        <p>{top}</p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={() => onNavigate('record')}>{latest ? 'Log a new check-in' : 'Start your first check-in'} <span aria-hidden="true">→</span></button>
          <span className={`overall-status ${critical ? 'overall-danger' : attention.length ? 'overall-warn' : ''}`}><i />{overviewStatus}</span>
        </div>
      </div>
      <div className="orbit-art" aria-hidden="true">
        <div className="orbit-ring orbit-ring-one" /><div className="orbit-ring orbit-ring-two" />
        <div className="planet">✦</div><span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" />
      </div>
    </section>

    <div className="summary-strip">
      <div><span className="summary-icon">◷</span><div><small>LAST CHECK-IN</small><b>{dateLabel}</b></div></div>
      <div><span className="summary-icon">▦</span><div><small>READINGS LOGGED</small><b>{readings} of {Object.keys(cfg).length} indicators</b></div></div>
      <div><span className="summary-icon">⌁</span><div><small>INPUT METHOD</small><b>{latest?.mode === 'sensor' ? 'Pulse sensor' : latest ? 'Crew entered' : 'Manual entry'}</b></div></div>
    </div>

    {attention.length > 0 && <section className={`notice ${critical ? 'notice-danger' : 'notice-warn'}`} role="status">
      <b>{critical ? 'Review now' : 'Recheck recommended'}</b>
      <span>{attention.map(([key]) => cfg[key].label).join(' · ')}. Repeat the measurement if unexpected and follow your flight surgeon’s protocol.</span>
      <button className="inline-link" onClick={() => onNavigate('event')}>Report a symptom →</button>
    </section>}

    <section className="metrics-section">
      <div className="section-heading">
        <div><div className="eyebrow">YOUR LATEST READINGS</div><h2>Health indicators</h2></div>
        <button className="quiet-button" onClick={() => onNavigate('history')}>View history <span aria-hidden="true">→</span></button>
      </div>
      <div className="metric-grid">{Object.entries(cfg).map(([key, setting]) =>
        <MetricCard key={key} metricKey={key} setting={setting} value={values[key]} compact />
      )}</div>
    </section>

    <BodyMap cfg={cfg} values={values} />

    <div className="dashboard-bottom">
      <section className="card routine-card">
        <div className="eyebrow">MISSION ROUTINE</div><h2>Small habits, steady data.</h2>
        <p>Consistent logs help you and the flight surgeon notice changes over time. Only enter measurements you actually took.</p>
        <ul className="routine-list">
          <li><span>01</span>Take readings with the onboard equipment and method you were trained to use.</li>
          <li><span>02</span>Record sleep, fluid intake, exercise, and stress from your daily log.</li>
          <li><span>03</span>Recheck unexpected values and note symptoms or mission context.</li>
        </ul>
      </section>
      <section className="card trend-card">
        <div className="eyebrow">TREND CHECK</div><h2>Looking beyond today</h2>
        {forecastWarnings.length
          ? <div className="trend-list">{forecastWarnings.map(([key, item]) =>
            <div className="trend-row" key={key}><span>{cfg[key].label}</span><b>{item.cross ? `Outside range in ~${item.cross} records` : 'Unusual recent change'}</b></div>)}</div>
          : <p>{Object.keys(prediction).length ? 'No notable trend flagged by the simple record-based forecast.' : 'Add at least three check-ins to see a simple trend estimate.'}</p>}
        <p className="tiny-note">A trend estimate is not a diagnosis or a prediction of clinical risk.</p>
      </section>
    </div>

    <section className="safety-banner">
      <span className="safety-symbol">!</span>
      <div><b>Symptoms matter more than a green number.</b><span>For chest pain, severe breathing trouble, fainting, sudden vision loss, or rapidly worsening symptoms, notify the crew and contact the flight surgeon immediately. Do not wait for an app assessment.</span></div>
      <button className="quiet-button" onClick={() => onNavigate('event')}>Get symptom guidance →</button>
    </section>
  </div>
}

// Manual check-in form: captures one or more values and posts them to the API as a new record.
function Record({ cfg, token, records, onDone }) {
  const last = records[records.length - 1]?.vals || {}
  const latestSensorRecord = [...records].reverse().find(record => record.mode === 'sensor' && record.vals?.hr !== undefined)
  const [inputMode, setInputMode] = useState('manual')
  const [values, setValues] = useState({})
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const setLastValues = () => setValues(Object.fromEntries(Object.entries(last).map(([key, value]) => [key, String(value)])))
  const submit = async event => {
    event.preventDefault()
    setError('')
    const entered = Object.fromEntries(Object.entries(values)
      .filter(([key]) => inputMode !== 'sensor' || key !== 'hr')
      .filter(([, value]) => value.trim() !== '')
      .map(([key, value]) => [key, Number(value)]))
    if (!Object.keys(entered).length) {
      setError(inputMode === 'sensor'
        ? 'Sensor heart-rate readings are saved automatically. Enter at least one other value to save a manual check-in.'
        : 'Enter at least one measurement or daily-log value before saving.')
      return
    }
    if (Object.entries(entered).some(([key, value]) => !Number.isFinite(value) || value < cfg[key].min || value > cfg[key].max)) {
      setError('Check the values: each entry must be within its displayed equipment/log range.')
      return
    }
    setBusy(true)
    try {
      setResult(await api('/records', { method: 'POST', body: { mode: 'manual', values: entered } }, token))
      await onDone()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  return <div className="page-content">
    <div className="page-intro"><div className="eyebrow">CREW HEALTH LOG</div><h1>Record a check-in</h1><p>Enter only values you have measured or logged. A partial check-in is okay.</p></div>
    <div className="input-mode-switch" role="group" aria-label="Resting heart-rate input method">
      <span>Resting heart rate:</span>
      <button type="button" aria-pressed={inputMode === 'manual'} className={inputMode === 'manual' ? 'mode-selected' : ''}
        onClick={() => setInputMode('manual')}>Manual</button>
      <button type="button" aria-pressed={inputMode === 'sensor'} className={inputMode === 'sensor' ? 'mode-selected' : ''}
        onClick={() => setInputMode('sensor')}>Sensor</button>
    </div>
    <form className="card record-card" onSubmit={submit}>
      <div className="form-top">
        <div><h2>Today’s indicators</h2><p className="muted">Use onboard equipment and your mission logs. Reference bands are simplified cues, not individualized medical limits.</p></div>
        {Object.keys(last).length > 0 && <button className="quiet-button" type="button" onClick={setLastValues}>Use last values to recheck</button>}
      </div>
      <div className="measure-grid">{Object.entries(cfg).map(([key, setting]) => {
        const info = METRIC_INFO[key]
        const enteredValue = values[key]
        const sensorConnected = isFreshSensorRecord(latestSensorRecord)
        const sensorValue = key === 'hr' && inputMode === 'sensor' && sensorConnected ? latestSensorRecord.vals.hr : undefined
        const displayedValue = key === 'hr' && inputMode === 'sensor' ? sensorValue : enteredValue
        const level = displayedValue === undefined || displayedValue === '' ? -1 : levelFor(setting, Number(displayedValue))
        return <div className="measure-field" key={key}>
          <div className="measure-heading"><span className="metric-icon">{info?.icon}</span><div><label htmlFor={`measure-${key}`}>{setting.label}</label><span>{key === 'hr' && inputMode === 'sensor' ? 'Pulse sensor · saved automatically' : info?.group}</span></div></div>
          <div className="input-with-unit">
            {key === 'hr' && inputMode === 'sensor'
              ? <input id={`measure-${key}`} type="number" value={sensorValue ?? ''} placeholder="Waiting for sensor…" readOnly aria-label="Latest sensor heart rate" />
              : <input id={`measure-${key}`} type="number" step="any" min={setting.min} max={setting.max} placeholder="—"
                value={enteredValue ?? ''} onChange={event => setValues({ ...values, [key]: event.target.value })} />}
            <span>{setting.unit}</span>
          </div>
          {key === 'hr' && inputMode === 'sensor' && <div className="measure-range">
            {sensorConnected
              ? <>Latest 30-second average received {latestSensorRecord.ts.replace('T', ' · ')}. A new sensor average is saved every 30 seconds.</>
              : latestSensorRecord
                ? <>No fresh sensor signal. Last reading was {latestSensorRecord.ts.replace('T', ' · ')}.</>
                : 'No sensor reading yet. Connect the Arduino and run the serial bridge.'}
          </div>}
          <div className="measure-range">Reference {setting.ok[0]}–{setting.ok[1]} · allowed entry {setting.min}–{setting.max}</div>
          <details className="measure-help"><summary>How to measure / log</summary><p>{info?.how}</p><p>{info?.why}</p></details>
          {level > 0 && <div className={`field-cue cue-${level}`}>Outside the reference band — verify the reading and follow crew protocol.</div>}
        </div>
      })}</div>
      {error && <div className="notice notice-danger" role="alert">{error}</div>}
      <div className="form-footer"><span>Values are saved to your private crew profile.</span><button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save check-in'} <span aria-hidden="true">→</span></button></div>
      {result && <div className={`save-result ${result.alerts.length ? 'save-attention' : 'save-ok'}`} role="status">
        <b>{result.alerts.length ? 'Check-in saved · readings to review' : 'Check-in saved'}</b>
        <span>{result.alerts.length ? 'Recheck unexpected readings and follow your mission protocol.' : 'No entered values are outside the simplified reference bands.'}</span>
        {result.alerts.map((alert, index) => <p key={`${alert.k || alert.label}-${index}`}>{alert.msg}</p>)}
      </div>}
    </form>
    <div className="info-columns">
      <div className="card info-card"><div className="eyebrow">WHY TRACK THIS?</div><h3>Changes are more useful than a single number.</h3><p>Microgravity can shift body fluids and affect cardiovascular function, muscle and bone conditioning, sleep, and wellbeing. Repeated, correctly taken readings help show patterns to discuss with the flight surgeon.</p></div>
      <div className="card info-card"><div className="eyebrow">WHEN TO ESCALATE</div><h3>Follow your mission’s medical protocol.</h3><p>This tool cannot decide if you are fit for duty or provide individualized treatment. Significant symptoms or concerning results need crew/flight-surgeon review, even when other readings look normal.</p></div>
    </div>
  </div>
}

// Trend chart: plots historical values with a simple forecast overlay and reference band shading.
function Chart({ points, forecast, setting }) {
  if (!points.length) return <div className="empty-chart">No recorded readings for this indicator yet.</div>
  const all = [...points, ...forecast, setting.ok[0], setting.ok[1]]
  const minimum = Math.min(...all)
  const maximum = Math.max(...all)
  const pad = (maximum - minimum) * 0.14 || 1
  const width = 720
  const height = 235
  const count = points.length + forecast.length
  const x = index => 46 + index * (width - 66) / Math.max(count - 1, 1)
  const y = value => height - 28 - (value - (minimum - pad)) / (maximum - minimum + 2 * pad) * (height - 52)
  const path = entries => entries.map(([index, value], pointIndex) => `${pointIndex ? 'L' : 'M'}${x(index)},${y(value)}`).join(' ')
  const actual = points.map((value, index) => [index, value])
  const predicted = forecast.length ? [[points.length - 1, points[points.length - 1]], ...forecast.map((value, index) => [points.length + index, value])] : []
  return <div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`History chart for ${setting.label}`}>
    <rect x="46" y={y(setting.ok[1])} width={width - 66} height={y(setting.ok[0]) - y(setting.ok[1])} rx="5" fill="#61d6ad" opacity=".1" />
    {[0, 1, 2, 3].map(index => <line key={index} x1="46" x2={width - 20} y1={28 + index * 55} y2={28 + index * 55} className="chart-gridline" />)}
    <path d={path(actual)} className="chart-line" />
    {predicted.length > 1 && <path d={path(predicted)} className="chart-forecast" />}
    {actual.map(([index, value]) => <circle key={index} cx={x(index)} cy={y(value)} r="4" className={`chart-point point-${levelFor(setting, value)}`} />)}
    <text x="5" y="34" className="chart-axis">{maximum.toFixed(1)}</text>
    <text x="5" y={height - 24} className="chart-axis">{minimum.toFixed(1)}</text>
    <text x="48" y={height - 7} className="chart-axis">Oldest</text>
    <text x={width - 70} y={height - 7} className="chart-axis">Latest →</text>
  </svg></div>
}

// History tab: compares a selected metric over time and shows recent check-in entries.
function History({ cfg, records, prediction }) {
  const [metricKey, setMetricKey] = useState('hr')
  const setting = cfg[metricKey]
  const points = records.filter(record => metricKey in record.vals).slice(-30)
  return <div className="page-content">
    <div className="page-intro"><div className="eyebrow">YOUR MISSION LOG</div><h1>Patterns over time</h1><p>Compare your recorded measurements and daily logs. Trends are informational, not diagnostic.</p></div>
    <section className="card history-card">
      <div className="history-heading"><div><div className="eyebrow">INDICATOR HISTORY</div><h2>{setting.label}</h2></div>
        <select aria-label="Select health indicator" value={metricKey} onChange={event => setMetricKey(event.target.value)}>
          {Object.entries(cfg).map(([key, item]) => <option key={key} value={key}>{item.label} ({item.unit})</option>)}
        </select>
      </div>
      <div className="chart-legend"><span><i className="legend-recorded" />Recorded</span><span><i className="legend-forecast" />Simple trend estimate</span><span><i className="legend-range" />Reference band</span></div>
      <Chart points={points.map(record => Number(record.vals[metricKey]))} forecast={prediction[metricKey]?.forecast || []} setting={setting} />
      <div className="history-summary"><span><b>{points.length}</b> recorded entries</span><span>Reference band: {setting.ok[0]}–{setting.ok[1]} {setting.unit}</span></div>
    </section>
    <section className="card history-table-card">
      <div className="section-heading"><div><div className="eyebrow">RECENT ENTRIES</div><h2>Check-in history</h2></div></div>
      {points.length ? <div className="table-scroll"><table><thead><tr><th>Date & time</th><th>Entry method</th><th>Reading</th><th>Reference check</th></tr></thead>
        <tbody>{[...points].reverse().map(record => {
          const value = Number(record.vals[metricKey])
          return <tr key={record.id}><td>{record.ts.replace('T', ' · ')}</td><td>{record.mode === 'sensor' ? 'Pulse sensor' : 'Crew entered'}</td><td>{value} {setting.unit}</td><td><StatusPill level={levelFor(setting, value)} /></td></tr>
        })}</tbody></table></div> : <p className="muted empty-table">No readings logged yet. Record a check-in to start your history.</p>}
    </section>
  </div>
}

// Symptom guidance screen: lets the user describe symptoms and optionally include current readings.
function Events({ cfg, records, events, token, onDone }) {
  const latestValues = records[records.length - 1]?.vals || {}
  const [text, setText] = useState('')
  const [values, setValues] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async event => {
    event.preventDefault()
    if (!text.trim()) return
    setError('')
    setBusy(true)
    const currentValues = Object.fromEntries(Object.entries({ ...latestValues, ...values })
      .filter(([, value]) => value !== '' && value !== undefined)
      .map(([key, value]) => [key, Number(value)]))
    try {
      setResult(await api('/events', { method: 'POST', body: { text: text.trim(), values: currentValues } }, token))
      await onDone()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }
  return <div className="page-content">
    <div className="page-intro"><div className="eyebrow">CREW SUPPORT</div><h1>Symptoms & guidance</h1><p>Describe what you notice and get a prompt to support communication with the crew medical team.</p></div>
    <div className="safety-banner event-safety"><span className="safety-symbol">!</span><div><b>Do not wait for app guidance in an emergency.</b><span>For chest pain, severe trouble breathing, fainting, sudden vision loss, or rapidly worsening symptoms, alert the crew and flight surgeon immediately.</span></div></div>
    <form className="card event-form" onSubmit={submit}>
      <div className="eyebrow">NEW OCCURRENCE</div><h2>What are you experiencing?</h2>
      <label className="field-label" htmlFor="symptom-description">Symptoms and when they began</label>
      <textarea id="symptom-description" placeholder="Describe what you feel, when it started, and whether it is changing…" value={text} onChange={event => setText(event.target.value)} />
      <div className="form-top event-measure-top"><div><h3>Current readings (optional)</h3><p className="muted">Update any values you just measured. Unchanged values come from your latest saved check-in.</p></div></div>
      <div className="event-value-grid">{Object.entries(cfg).map(([key, setting]) => <label key={key}>{setting.label}<div className="input-with-unit">
        <input type="number" step="any" min={setting.min} max={setting.max} placeholder={latestValues[key] ?? '—'} value={values[key] ?? ''}
          onChange={event => setValues({ ...values, [key]: event.target.value })} />
        <span>{setting.unit}</span>
      </div></label>)}</div>
      {error && <div className="notice notice-danger" role="alert">{error}</div>}
      <button className="primary-button" disabled={busy || !text.trim()}>{busy ? 'Preparing guidance…' : 'Review guidance'} <span aria-hidden="true">→</span></button>
      {result && <section className={`guidance-result ${result.urgent ? 'guidance-urgent' : ''}`} aria-live="polite">
        <div className="eyebrow">{result.urgent ? 'PROMPT CREW / FLIGHT SURGEON NOW' : 'DISCUSS WITH YOUR CREW AS NEEDED'}</div>
        <h3>{result.titles.join(' · ')}</h3>
        <p>{result.urgent ? 'This tool cannot assess an emergency. Contact your crew and flight surgeon immediately and follow your mission protocol.' : 'These are general prompts, not a diagnosis or a treatment plan. Follow your onboard medical procedures.'}</p>
        {result.steps.map((step, index) => <div className="guidance-step" key={`${step}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span>{step}</div>)}
        {result.alerts.length > 0 && <div className="guidance-alerts">{result.alerts.map((alert, index) => <div key={`${alert.k || alert.label}-${index}`} className="notice notice-warn">{alert.msg}</div>)}</div>}
      </section>}
    </form>
    <section className="card past-events"><div className="eyebrow">LOGGED OCCURRENCES</div><h2>Previous notes</h2>
      {events.length ? <div className="event-list">{events.map((item, index) => <article key={`${item.ts}-${index}`}>
        <div className="event-date">{item.ts.replace('T', ' · ')}</div><p>{item.text}</p><b>{item.advice.titles.join(' · ')}</b>
      </article>)}</div> : <p className="muted">No occurrences recorded yet.</p>}
    </section>
  </div>
}

// Root app shell: keeps auth state, active tab, and fetched API data in one place.
export default function App() {
  const [token, setToken] = useState(sessionStorage.tok || '')
  const [user, setUser] = useState(sessionStorage.user || '')
  const [tab, setTab] = useState('dashboard')
  const [cfg, setCfg] = useState(null)
  const [records, setRecords] = useState([])
  const recordsRef = useRef(records)
  const [prediction, setPrediction] = useState({})
  const [events, setEvents] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [, setFreshnessClock] = useState(Date.now())
  const logout = () => {
    sessionStorage.removeItem('tok')
    sessionStorage.removeItem('user')
    setToken('')
    setUser('')
    setCfg(null)
  }
  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const [config, savedRecords, forecast, savedEvents] = await Promise.all([
        api('/config'),
        api('/records', {}, token),
        api('/predict', {}, token),
        api('/events', {}, token),
      ])
      setCfg(config)
      setRecords(savedRecords)
      setPrediction(forecast)
      setEvents(savedEvents)
    } catch (requestError) {
      if (requestError.status === 401) logout()
      else setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [token])
  useEffect(() => { load() }, [load])
  useEffect(() => { recordsRef.current = records }, [records])
  useEffect(() => {
    if (!token) return
    let active = true
    let refreshing = false
    let freshnessTimer
    const refreshRecords = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const latestId = recordsRef.current.length ? recordsRef.current[recordsRef.current.length - 1].id : 0
        const newRecords = await api(`/records?after=${latestId}`, {}, token)
        if (active && newRecords.length) {
          setRecords(current => [...current, ...newRecords])
        }
      } catch (requestError) {
        if (!active) return
        if (requestError.status === 401) {
          sessionStorage.removeItem('tok')
          sessionStorage.removeItem('user')
          setToken('')
          setUser('')
          setCfg(null)
        } else {
          setError(requestError.message)
        }
      } finally {
        refreshing = false
        if (active) setFreshnessClock(Date.now())
        if (active) freshnessTimer = window.setTimeout(refreshRecords, 1000)
      }
    }
    freshnessTimer = window.setTimeout(refreshRecords, 1000)
    return () => {
      active = false
      window.clearTimeout(freshnessTimer)
    }
  }, [token])
  const navigate = nextTab => setTab(nextTab)
  if (!token) return <Login onOk={result => {
    sessionStorage.tok = result.token
    sessionStorage.user = result.name
    setToken(result.token)
    setUser(result.name)
  }} />
  if (!cfg) return <main className="app-shell"><div className="loading-panel">
    {error ? <><div className="notice notice-danger">{error}</div><button className="primary-button" onClick={load}>Try again</button></> : <><div className="loading-orbit" /><p>Connecting to mission health log…</p></>}
  </div></main>
  const tabs = [
    { id: 'dashboard', label: 'Overview', icon: '⌂' },
    { id: 'record', label: 'Check-in', icon: '＋' },
    { id: 'history', label: 'Trends', icon: '⌁' },
    { id: 'event', label: 'Symptoms', icon: '♡' },
  ]
  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('dashboard') }}>
        <span className="brand-mark">AV</span><span>ASTRO<span>VITALS</span><small>CREW HEALTH CONSOLE</small></span>
      </a>
      <nav className="main-nav" aria-label="Main navigation">
        {tabs.map(item => <button key={item.id} className={tab === item.id ? 'nav-active' : ''} onClick={() => navigate(item.id)}>
          <span aria-hidden="true">{item.icon}</span>{item.label}
        </button>)}
      </nav>
      <div className="crew-profile"><span className="crew-avatar">✦</span><span><small>CREW MEMBER</small><b>{user}</b></span>
        <button className="logout-button" onClick={logout} aria-label="Log out">↗</button>
      </div>
    </header>
    <main className="main-content">
      {error && <div className="notice notice-danger" role="alert">{error}<button className="inline-link" onClick={load}>Retry</button></div>}
      {loading && cfg && <div className="sync-indicator"><span /> Syncing crew log…</div>}
      {tab === 'dashboard' && <Dashboard cfg={cfg} records={records} prediction={prediction} onNavigate={navigate} />}
      {tab === 'record' && <Record cfg={cfg} token={token} records={records} onDone={load} />}
      {tab === 'history' && <History cfg={cfg} records={records} prediction={prediction} />}
      {tab === 'event' && <Events cfg={cfg} records={records} events={events} token={token} onDone={load} />}
      <footer className="app-footer"><span>AstroVitals · Crew self-monitoring prototype</span><span>Not a medical device · Follow mission medical protocols</span></footer>
    </main>
  </div>
}
