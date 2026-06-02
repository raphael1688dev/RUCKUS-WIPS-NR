# Technical Debt Audit - RUCKUS Unleashed WIPS Node-RED Bridge

This document provides a comprehensive technical debt audit of the JavaScript native `aioruckus` port running inside the Node-RED flow. It highlights architectural bottlenecks, transport vulnerabilities, HA lifecycle sync failures, and actionable refactoring pathways.

---

## 🔒 1. Security & Transport Layer Debt (High Priority)

### 1.1 SSL/TLS Certificate Validation Bypass (`rejectUnauthorized: false`)
* **The Debt**: To connect to Ruckus Unleashed's default self-signed SSL certificate, `rawReq()` passes `rejectUnauthorized: false` to `tls.connect()`.
* **Impact**:
  - The connection is vulnerable to Man-in-the-Middle (MitM) attacks on the local network. A compromised device on the same LAN could intercept the admin credentials (`RUCKUS_USER` and `RUCKUS_PASS`) in transit.
* **Remediation**:
  - Add support for an optional `RUCKUS_CA_CERT` environment variable. If set, feed the custom CA certificate to `tls.connect()` and set `rejectUnauthorized: true` to enforce secure verification.

### 1.2 Gzip Compression Vulnerability
* **The Debt**: The hand-rolled HTTP/1.0 parser (`rawReq()`) cannot decode gzip or deflate compression. It relies on the headers `Accept-Encoding: identity` and the XML body parameter `enable-gzip='0'` to request uncompressed content.
* **Impact**:
  - If a future Unleashed firmware upgrade ignores these parameters and enforces gzip content encoding, the parser will fail. The compressed bytes will be fed directly into `xml2js`, causing a crash and putting the flow into a permanent failure state.
* **Remediation**:
  - Implement a check for the `content-encoding` header in `rawReq()`. If it contains `gzip`, throw a descriptive error immediately (e.g., `"Unleashed forced gzip encoding, which is unsupported"`) rather than attempting to parse the corrupt string. Alternatively, add Node.js's built-in `zlib` library to the node modules list and conditionally decompress the buffer.

### 1.3 Strict HTTP/1.0 EOF-Framing Assumption
* **The Debt**: The raw socket parser assumes HTTP/1.0 framing where the server signals the end of the body by closing the TCP socket (`Connection: close`). 
* **Impact**:
  - If Ruckus Unleashed forces persistent connections (`Keep-Alive`) or fails to close the socket cleanly, the parser will hang until the 15-second socket timeout (`socket.setTimeout`) expires, blocking the poll queue.
* **Remediation**:
  - Parse the `Content-Length` header if present. Stop reading from the socket and resolve the promise as soon as the accumulated body matches `Content-Length`, rather than waiting for the socket to close.

---

## 🔑 2. Error Handling & Resiliency Debt (Medium Priority)

### 2.1 Admin Account Lockout Risk (Brute Force Loop)
* **The Debt**: If the controller's administrator password changes, the scheduled polling logic will fail to login (`LOGIN_INCORRECT`) and throw an error. However, the background poll continues to run every 30 seconds.
* **Impact**:
  - The flow will hammer the login endpoint with invalid credentials 120 times an hour, which is likely to trigger Unleashed's security brute-force protection and lock out the admin account.
* **Remediation**:
  - Implement a cool-down lockout counter in `context`. If `login()` fails with a credential error, set a cool-down timestamp (e.g., 10 minutes) and bypass all poll/login attempts until the cool-down expires.

### 2.2 Soft Failures & State Reporting Integrity (LWT Flaw)
* **The Debt**: If the Ruckus controller goes offline (e.g., during firmware upgrades or power cuts), `fn_ruckus` sets its node status to red and logs `poll failed`, but does **not** notify Home Assistant.
* **Impact**:
  - The MQTT availability topic (`ruckus_wips/status`) remains `online` (since it is only updated when Node-RED itself disconnects). Home Assistant entities will display stale state values as active instead of becoming `unavailable`.
* **Remediation**:
  - Track sequential poll failures in `context`. If the poll fails 3 times consecutively, actively publish `offline` to `ruckus_wips/status` to mark entities unavailable in HA, and publish `online` only when a poll succeeds again.

---

## 🏛️ 3. Flow Architecture & Maintainability Debt (Medium Priority)

### 3.1 Sandboxed Code Monolith
* **The Debt**: All WIPS driver functions (networking, XML parsing, cookie jar, pagination, diff logic, discovery payload construction, and command routing) are housed in a single 500+ line JavaScript block inside Node-RED's Function Node.
* **Impact**:
  - Precludes standard unit testing and is highly unergonomic to maintain or edit in Node-RED's small text UI window.
* **Remediation**:
  - Decompose the monolith into linked subflow nodes (e.g., separate Auth, Query, Diff, and Command nodes) or maintain the source files separately under a `src/` directory and use a build script to generate the final flow JSON.

### 3.2 Hardcoded Discovery Metadata
* **The Debt**: Discovery configuration metadata (such as device names, origin links, and software version strings) are hardcoded inside the `discoveryMessages()` helper function in `func.js`.
* **Impact**:
  - Hard to share or customize without editing deep lines of JavaScript code.
* **Remediation**:
  - Extract these properties into Node-RED environment variables (e.g., `env.get('RUCKUS_DEVICE_NAME')`), keeping `func.js` entirely generic.

---

## 📡 4. HA & MQTT Lifecycle Sync Debt (Medium-Low Priority)

### 4.1 Lack of Home Assistant Birth Message Tracking
* **The Debt**: The discovery payloads and `online` birth messages are published exactly once on Node-RED startup (`context.get('discoveryPublished')`).
* **Impact**:
  - If the MQTT broker restarts and loses its retained message cache, or if Home Assistant is reinstalled/cleared, the entities will disappear from Home Assistant and will not return until Node-RED itself is restarted or redeployed.
* **Remediation**:
  - Add an `mqtt in` node subscribed to `homeassistant/status` (the topic HA publishes `online` to when it finishes starting up). When a birth message is received, reset the `discoveryPublished` flag to force-republish all discovery configurations.

---

## 🧪 5. Testing & Validation Debt (Low Priority)

### 5.1 Manual Verification Dependency
* **The Debt**: There is no mock environment or automated unit test suite for the JavaScript driver.
* **Impact**:
  - Verifying a change requires importing the flow JSON onto the live Node-RED host and physically interacting with the HA environment or triggering simulated MQTT packets, making regression testing slow and error-prone.
* **Remediation**:
  - Create a test script in the repo that mocks Node-RED's global sandbox objects (`node`, `context`, `env`) and runs unit tests using a test framework (e.g., `mocha` or `jest`) against `func.js` or `extracted_logic.js`.
