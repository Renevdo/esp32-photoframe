#ifndef SYNC_CLIENT_H
#define SYNC_CLIENT_H

#include <stdbool.h>

#include "esp_err.h"

// True when a sync server URL is configured (deploy-on-wake sync active).
bool sync_client_is_configured(void);

// Pull pending deployment ops from the staging server and apply them to the
// SD card, then acknowledge. Designed for the timer-wake path: bounded by
// SYNC_WAKE_BUDGET_SEC, silently returns ESP_OK when unconfigured, and
// returns an error (already logged) on any failure so the caller just
// continues the wake flow. WiFi must be connected.
esp_err_t sync_client_run(void);

#endif
