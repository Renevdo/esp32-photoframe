#include "sync_ops.h"

#include <string.h>

#include "cJSON.h"

bool sync_name_is_safe(const char *name)
{
    if (!name) {
        return false;
    }
    size_t len = strlen(name);
    if (len == 0 || len >= SYNC_NAME_MAX_LEN) {
        return false;
    }
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
        return false;
    }
    if (strchr(name, '/') || strchr(name, '\\')) {
        return false;
    }
    return true;
}

static bool copy_name(char *dst, const cJSON *item)
{
    if (!cJSON_IsString(item) || !sync_name_is_safe(item->valuestring)) {
        return false;
    }
    strncpy(dst, item->valuestring, SYNC_NAME_MAX_LEN - 1);
    dst[SYNC_NAME_MAX_LEN - 1] = '\0';
    return true;
}

bool sync_ops_parse(const char *json, sync_changes_t *out)
{
    memset(out, 0, sizeof(*out));

    cJSON *root = cJSON_Parse(json);
    if (!root) {
        return false;
    }

    bool ok = false;
    cJSON *reset = cJSON_GetObjectItem(root, "reset");
    if (cJSON_IsTrue(reset)) {
        out->reset = true;
        ok = true;
        goto done;
    }

    cJSON *seq = cJSON_GetObjectItem(root, "latest_seq");
    if (!cJSON_IsNumber(seq)) {
        goto done;
    }
    out->latest_seq = (int64_t) seq->valuedouble;

    cJSON *ops = cJSON_GetObjectItem(root, "ops");
    if (!cJSON_IsArray(ops)) {
        goto done;
    }
    if (cJSON_GetArraySize(ops) > SYNC_MAX_OPS) {
        goto done;
    }

    cJSON *op_json = NULL;
    cJSON_ArrayForEach(op_json, ops)
    {
        sync_op_t *op = &out->ops[out->op_count];
        op->size = -1;

        cJSON *type = cJSON_GetObjectItem(op_json, "op");
        if (!cJSON_IsString(type)) {
            goto done;
        }
        if (strcmp(type->valuestring, "put") == 0) {
            op->type = SYNC_OP_PUT;
        } else if (strcmp(type->valuestring, "delete") == 0) {
            op->type = SYNC_OP_DELETE;
        } else if (strcmp(type->valuestring, "rmdir") == 0) {
            op->type = SYNC_OP_RMDIR;
        } else {
            goto done;
        }

        if (!copy_name(op->album, cJSON_GetObjectItem(op_json, "album"))) {
            goto done;
        }
        if (op->type != SYNC_OP_RMDIR) {
            if (!copy_name(op->file, cJSON_GetObjectItem(op_json, "file"))) {
                goto done;
            }
        }
        if (op->type == SYNC_OP_PUT) {
            cJSON *size = cJSON_GetObjectItem(op_json, "size");
            if (!cJSON_IsNumber(size) || size->valuedouble < 0) {
                goto done;
            }
            op->size = (int32_t) size->valuedouble;
        }
        out->op_count++;
    }
    ok = true;

done:
    cJSON_Delete(root);
    if (!ok) {
        memset(out, 0, sizeof(*out));
    }
    return ok;
}
