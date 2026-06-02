# Technical Debt Audit - RUCKUS Unleashed WIPS Node-RED Bridge

This document provides a comprehensive technical debt audit of the JavaScript native `aioruckus` port running inside the Node-RED flow. It tracks architectural bottlenecks, transport vulnerabilities, HA lifecycle sync status, and refactoring pathways.

---

## Status Dashboard

| Category | Debt / Risk | Status | Resolution / Details |
| :--- | :--- | :--- | :--- |
| **1. Transport** | 1.1 SSL/TLS Bypass | ⚠️ REMAINING | Vulnerable to LAN MitM attacks; needs `RUCKUS_CA_CERT` |
| **1. Transport** | 1.2 Gzip Vulnerability | ⚠️ REMAINING | No gzip parser support; crashes if Ruckus forces gzip |
| **1. Transport** | 1.3 EOF-Framing Assumption | ⚠️ REMAINING | Relies on socket close; could hang on persistent Keep-Alive |
| **2. Resiliency**| 2.1 Admin Account Lockout | ⚠️ REMAINING | Brute-force loop risks locking controller on password changes |
| **2. Resiliency**| 2.2 Soft Failures (LWT Flaw) | ⚠️ REMAINING | HA entities stay "online" if AP controller goes offline |
| **3. Architecture**| 3.1 Sandboxed Code Monolith | ✅ **RESOLVED** | Decomposed into modular ES Modules under `src/` & built via `build.js` |
| **3. Architecture**| 3.2 Hardcoded Discovery Metadata| ✅ **RESOLVED** | Extracted device metadata and MQTT topic prefixes into `env.get()` |
| **4. Lifecycle** | 4.1 HA Birth & Reconnect Sync | ✅ **RESOLVED** | Implemented `homeassistant/status` birth & `status_monitor` reconnect sync |
| **5. Testing**     | 5.1 Manual Verification Dependency| ✅ **RESOLVED** | Added automated mock unit tests (`driver.test.mjs`) & `live_test.mjs` |

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

## 🏛️ 3. Flow Architecture & Maintainability Debt (Resolved)

### 3.1 Sandboxed Code Monolith
* **Resolution**: 
  - Decomposed all logic from [func.js](file:///Users/raphael/Desktop/RUCKUS-NR-REVIEW-AG/func.js) into 7 separate, clean, and testable ES Modules under the new `src/` directory.
  - Implemented [build.js](file:///Users/raphael/Desktop/RUCKUS-NR-REVIEW-AG/build.js) to automate concatenation, ESM syntax-stripping, syntax check, and injection directly into `flows/ruckus_wips.json`.

### 3.2 Hardcoded Discovery Metadata
* **Resolution**: 
  - Extracted RUCKUS device configuration names, identifiers, software version strings, support urls, and the MQTT base topic prefix into Node-RED configuration environment variables (`env.get()`) loaded dynamically inside `src/config.mjs`.

---

## 📡 4. HA & MQTT Lifecycle Sync Debt (Resolved)

### 4.1 Lack of Home Assistant Birth Message Tracking
* **Resolution**: 
  - Added an MQTT input node listening to `homeassistant/status` to republish Discovery configurations whenever Home Assistant starts up.
  - Added a Node-RED `status` monitor node wired directly to the MQTT publisher node. On successful connection/reconnection to the broker, it triggers a republish of the Discovery configuration to ensure registry sync even after MQTT broker crashes.

---

## 🧪 5. Testing & Validation Debt (Resolved)

### 5.1 Manual Verification Dependency
* **Resolution**: 
  - Created a local, automated unit test suite [tests/driver.test.mjs](file:///Users/raphael/Desktop/RUCKUS-NR-REVIEW-AG/tests/driver.test.mjs) utilizing Node.js's built-in test runner (`node --test`).
  - Added [tests/live_test.mjs](file:///Users/raphael/Desktop/RUCKUS-NR-REVIEW-AG/tests/live_test.mjs) as a real-device connectivity verification test tool.
  - Consolidated validation inside [test_syntax.sh](file:///Users/raphael/Desktop/RUCKUS-NR-REVIEW-AG/test_syntax.sh).
