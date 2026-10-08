#pragma once

#include <stddef.h>

#include "esp_err.h"

// Decide how fetches from `url` (https://host[:port][/path]) will trust the
// server. A server the built-in CA bundle verifies needs no pin, and any
// stored one is cleared; otherwise the server's own CA is pinned, trust on
// first use: the issuer it sends, or the certificate itself when it is
// self-signed. The stored pin is persisted with config_manager_touch_config.
//
// On failure returns ESP_FAIL and, if `err_out` is non-NULL, copies a
// human-readable error into it (NUL-terminated), truncated to `err_out_len`.
// The stored pin is not modified on failure.
esp_err_t cert_pin_fetch_and_store(const char *url, char *err_out, size_t err_out_len);

// Clear any pinned cert.
void cert_pin_clear(void);
