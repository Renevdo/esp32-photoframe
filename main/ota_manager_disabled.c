#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_log.h"
#include "ota_manager.h"

// Stand-in for ota_manager.c on builds without OTA partitions: reports the
// running version and refuses every check or update.

static const char *TAG = "ota_manager";

static ota_status_t ota_status;

esp_err_t ota_manager_init(void)
{
    memset(&ota_status, 0, sizeof(ota_status));
    ota_status.state = OTA_STATE_IDLE;
    snprintf(ota_status.current_version, sizeof(ota_status.current_version), "%s",
             esp_app_get_description()->version);
    ESP_LOGI(TAG, "OTA disabled in this build, firmware version: %s", ota_status.current_version);
    return ESP_OK;
}

esp_err_t ota_check_for_update(bool *update_available, int timeout)
{
    (void) timeout;
    if (update_available) {
        *update_available = false;
    }
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t ota_start_update(void)
{
    return ESP_ERR_NOT_SUPPORTED;
}

void ota_get_status(ota_status_t *status)
{
    if (status) {
        memcpy(status, &ota_status, sizeof(ota_status));
    }
}

const char *ota_get_current_version(void)
{
    return ota_status.current_version;
}

bool ota_should_check_daily(void)
{
    return false;
}

void ota_update_last_check_time(void) {}
