#include "sync_client.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "album_manager.h"
#include "config.h"
#include "config_manager.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "sync_ops.h"
#include "utils.h"

static const char *TAG = "sync_client";

#define SYNC_NVS_NAMESPACE "sync"
#define SYNC_NVS_SEQ_KEY "last_seq"
#define SYNC_CHANGES_MAX_LEN (32 * 1024)
#define SYNC_HTTP_TIMEOUT_MS 15000

bool sync_client_is_configured(void)
{
    return config_manager_get_sync_server_url()[0] != '\0';
}

static int64_t load_last_seq(void)
{
    nvs_handle_t handle;
    int64_t seq = 0;
    if (nvs_open(SYNC_NVS_NAMESPACE, NVS_READONLY, &handle) == ESP_OK) {
        nvs_get_i64(handle, SYNC_NVS_SEQ_KEY, &seq);
        nvs_close(handle);
    }
    return seq;
}

static void store_last_seq(int64_t seq)
{
    nvs_handle_t handle;
    if (nvs_open(SYNC_NVS_NAMESPACE, NVS_READWRITE, &handle) == ESP_OK) {
        nvs_set_i64(handle, SYNC_NVS_SEQ_KEY, seq);
        nvs_commit(handle);
        nvs_close(handle);
    }
}

// GET url into buf (NUL-terminated). Returns the HTTP status or -1 on error.
static int http_get_to_buffer(const char *url, char *buf, size_t buf_len)
{
    esp_http_client_config_t config = {
        .url = url,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        return -1;
    }
    int status = -1;
    if (esp_http_client_open(client, 0) == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int total = 0;
        while (total < (int) buf_len - 1) {
            int r = esp_http_client_read(client, buf + total, buf_len - 1 - total);
            if (r <= 0) {
                break;
            }
            total += r;
        }
        buf[total] = '\0';
        status = esp_http_client_get_status_code(client);
    }
    esp_http_client_cleanup(client);
    return status;
}

// Max on-SD path for a synced file: album path + '/' + validated file name.
#define SYNC_FILE_PATH_LEN (256 + SYNC_NAME_MAX_LEN + 2)

// Download url to path atomically (temp file + rename).
static esp_err_t download_to_file(const char *url, const char *path)
{
    char tmp_path[SYNC_FILE_PATH_LEN + 8];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", path);

    FILE *f = fopen(tmp_path, "wb");
    if (!f) {
        ESP_LOGE(TAG, "Cannot open %s for writing", tmp_path);
        return ESP_FAIL;
    }

    esp_http_client_config_t config = {
        .url = url,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    esp_err_t err = ESP_FAIL;
    if (client && esp_http_client_open(client, 0) == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int status = esp_http_client_get_status_code(client);
        if (status == 200) {
            char chunk[2048];
            int r;
            err = ESP_OK;
            while ((r = esp_http_client_read(client, chunk, sizeof(chunk))) > 0) {
                if (fwrite(chunk, 1, r, f) != (size_t) r) {
                    ESP_LOGE(TAG, "Write to %s failed (SD full?)", tmp_path);
                    err = ESP_FAIL;
                    break;
                }
            }
            if (r < 0) {
                err = ESP_FAIL;
            }
        } else {
            ESP_LOGE(TAG, "Download %s -> HTTP %d", url, status);
        }
    }
    if (client) {
        esp_http_client_cleanup(client);
    }
    fclose(f);

    if (err == ESP_OK && rename(tmp_path, path) != 0) {
        ESP_LOGE(TAG, "Rename %s -> %s failed", tmp_path, path);
        err = ESP_FAIL;
    }
    if (err != ESP_OK) {
        unlink(tmp_path);
    }
    return err;
}

// Percent-encode a path segment for URLs (RFC 3986 unreserved set).
static void url_encode_segment(const char *src, char *dst, size_t dst_len)
{
    static const char hex[] = "0123456789ABCDEF";
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 4 < dst_len; i++) {
        unsigned char c = (unsigned char) src[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            dst[j++] = c;
        } else {
            dst[j++] = '%';
            dst[j++] = hex[c >> 4];
            dst[j++] = hex[c & 0x0F];
        }
    }
    dst[j] = '\0';
}

static esp_err_t apply_put(const char *base_url, const sync_op_t *op)
{
    char album_path[256];
    if (album_manager_get_album_path(op->album, album_path, sizeof(album_path)) != ESP_OK) {
        return ESP_FAIL;
    }

    struct stat st;
    bool album_created = false;
    if (stat(album_path, &st) != 0) {
        if (mkdir(album_path, 0755) != 0) {
            ESP_LOGE(TAG, "mkdir %s failed", album_path);
            return ESP_FAIL;
        }
        album_created = true;
    }

    char file_path[SYNC_FILE_PATH_LEN];
    snprintf(file_path, sizeof(file_path), "%s/%s", album_path, op->file);

    // Resume optimization: skip files already present with the expected size
    // (a previous wake may have applied this op but ran out of budget before
    // acking).
    if (stat(file_path, &st) == 0 && st.st_size == op->size) {
        ESP_LOGI(TAG, "Skip %s/%s (already present)", op->album, op->file);
        return ESP_OK;
    }

    char enc_album[SYNC_NAME_MAX_LEN * 3];
    char enc_file[SYNC_NAME_MAX_LEN * 3];
    url_encode_segment(op->album, enc_album, sizeof(enc_album));
    url_encode_segment(op->file, enc_file, sizeof(enc_file));

    char url[SYNC_SERVER_URL_MAX_LEN + sizeof(enc_album) + sizeof(enc_file) + 32];
    snprintf(url, sizeof(url), "%s/api/sync/file/%s/%s", base_url, enc_album, enc_file);

    esp_err_t err = download_to_file(url, file_path);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Synced %s/%s (%ld bytes)", op->album, op->file, (long) op->size);
        if (album_created) {
            album_manager_set_album_enabled(op->album, true);
        }
    }
    return err;
}

static esp_err_t apply_op(const char *base_url, const sync_op_t *op)
{
    switch (op->type) {
    case SYNC_OP_PUT:
        return apply_put(base_url, op);
    case SYNC_OP_DELETE: {
        char album_path[256];
        if (album_manager_get_album_path(op->album, album_path, sizeof(album_path)) != ESP_OK) {
            return ESP_FAIL;
        }
        char file_path[SYNC_FILE_PATH_LEN];
        snprintf(file_path, sizeof(file_path), "%s/%s", album_path, op->file);
        if (unlink(file_path) != 0) {
            ESP_LOGW(TAG, "Delete %s: already gone", file_path);
        }
        return ESP_OK;
    }
    case SYNC_OP_RMDIR:
        // Removes the album directory and its enabled flag. Failure is not
        // fatal: the album may hold files the server never managed.
        album_manager_delete_album(op->album);
        return ESP_OK;
    }
    return ESP_FAIL;
}

static esp_err_t post_ack(const char *base_url, int64_t seq)
{
    char url[SYNC_SERVER_URL_MAX_LEN + 32];
    snprintf(url, sizeof(url), "%s/api/sync/ack", base_url);

    char body[128];
    snprintf(body, sizeof(body), "{\"device\":\"%s\",\"seq\":%lld}", get_device_id(),
             (long long) seq);

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));
    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    return (err == ESP_OK && status == 200) ? ESP_OK : ESP_FAIL;
}

esp_err_t sync_client_run(void)
{
    if (!sync_client_is_configured()) {
        return ESP_OK;
    }
    // Trailing slashes are stripped by the config setter, so URL building
    // below can blindly append "/api/...".
    const char *base_url = config_manager_get_sync_server_url();

    int64_t start_us = esp_timer_get_time();
    int64_t last_seq = load_last_seq();

    char url[SYNC_SERVER_URL_MAX_LEN + 96];
    snprintf(url, sizeof(url), "%s/api/sync/changes?since=%lld&device=%s", base_url,
             (long long) last_seq, get_device_id());

    char *buf = malloc(SYNC_CHANGES_MAX_LEN);
    if (!buf) {
        return ESP_ERR_NO_MEM;
    }
    int status = http_get_to_buffer(url, buf, SYNC_CHANGES_MAX_LEN);
    if (status < 0) {
        ESP_LOGI(TAG, "Sync server unreachable, skipping");
        free(buf);
        return ESP_FAIL;
    }

    sync_changes_t *changes = malloc(sizeof(sync_changes_t));
    if (!changes) {
        free(buf);
        return ESP_ERR_NO_MEM;
    }

    esp_err_t result = ESP_FAIL;
    if (!sync_ops_parse(buf, changes)) {
        ESP_LOGE(TAG, "Malformed sync response (HTTP %d)", status);
        goto done;
    }

    if (status == 409 && changes->reset) {
        ESP_LOGW(TAG, "Server signalled reset, restarting from seq 0");
        store_last_seq(0);
        result = ESP_OK;  // next wake does the full resync
        goto done;
    }
    if (status != 200) {
        ESP_LOGE(TAG, "Sync changes -> HTTP %d", status);
        goto done;
    }

    if (changes->op_count == 0) {
        ESP_LOGI(TAG, "Sync up to date (seq %lld)", (long long) changes->latest_seq);
        if (changes->latest_seq != last_seq) {
            store_last_seq(changes->latest_seq);
        }
        result = ESP_OK;
        goto done;
    }

    ESP_LOGI(TAG, "Applying %d sync ops (seq %lld -> %lld)", changes->op_count,
             (long long) last_seq, (long long) changes->latest_seq);

    for (int i = 0; i < changes->op_count; i++) {
        if ((esp_timer_get_time() - start_us) / 1000000 > SYNC_WAKE_BUDGET_SEC) {
            ESP_LOGW(TAG, "Sync budget exhausted after %d/%d ops, resuming next wake", i,
                     changes->op_count);
            utils_set_last_fetch_error("Album sync paused (budget), resumes next wake");
            goto done;  // no ack: the same ops return next wake, size-skip resumes
        }
        if (apply_op(base_url, &changes->ops[i]) != ESP_OK) {
            ESP_LOGE(TAG, "Sync op %d failed, aborting this wake", i);
            utils_set_last_fetch_error("Album sync failed, retries next wake");
            goto done;
        }
    }

    if (post_ack(base_url, changes->latest_seq) == ESP_OK) {
        store_last_seq(changes->latest_seq);
        ESP_LOGI(TAG, "Sync complete at seq %lld", (long long) changes->latest_seq);
        result = ESP_OK;
    } else {
        ESP_LOGW(TAG, "Ack failed; ops applied, will re-verify next wake");
    }

done:
    free(changes);
    free(buf);
    return result;
}
