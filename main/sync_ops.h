#ifndef SYNC_OPS_H
#define SYNC_OPS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SYNC_NAME_MAX_LEN 64
#define SYNC_MAX_OPS 256

typedef enum {
    SYNC_OP_PUT,
    SYNC_OP_DELETE,
    SYNC_OP_RMDIR,
} sync_op_type_t;

typedef struct {
    sync_op_type_t type;
    char album[SYNC_NAME_MAX_LEN];
    char file[SYNC_NAME_MAX_LEN];  // empty for rmdir
    int32_t size;                  // put only, -1 otherwise
} sync_op_t;

typedef struct {
    int64_t latest_seq;
    bool reset;
    int op_count;
    sync_op_t ops[SYNC_MAX_OPS];
} sync_changes_t;

// Parse the /api/sync/changes JSON response. Returns false on malformed
// JSON, unknown op types, unsafe names (slash, dots, empty, too long), or
// more than SYNC_MAX_OPS ops.
bool sync_ops_parse(const char *json, sync_changes_t *out);

// Validate a single path segment received from the network.
bool sync_name_is_safe(const char *name);

#endif
